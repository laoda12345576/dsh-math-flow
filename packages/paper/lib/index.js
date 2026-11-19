/**
 * dsh-plugin-paper — 论文获取层（cordis 胶水）
 *
 * 五个工具，对应一条"能不能拿到、拿到的是不是真的"的完整链路：
 *
 *   paper_search   多源检索（OpenAlex / Crossref / arXiv / zbMATH），去重合并
 *   paper_resolve  定位合法全文（Unpaywall / OpenAlex locations / arXiv 预印本）
 *   paper_fetch    抓取并抽正文（直连 → r.jina.ai → 本地 PDF 解析，三级降级）
 *   paper_verify   参考文献审计（标题相似度 + 年份/作者一致性，防幻觉）
 *   paper_ledger   本地台账（refs/ledger.jsonl），记录每次获取用了哪条路径
 *
 * 策略由 core.checkPolicy 强制：盗版镜像在入口和**重定向后**各查一次。
 *
 * @module dsh-plugin-paper
 */

import { resolveDefineTool } from './toolkit.js'
import {
  DEFAULTS,
  VERSION,
  searchAll,
  resolveOpenAccess,
  fetchDocument,
  httpGet,
  extractPdfText,
  saveDocument,
  verifyReference,
  appendLedger,
  readLedger,
  listRefs,
  checkPolicy,
} from './core.js'

/** 插件名（出现在插件清单里）。 */
export const name = 'paper'

/**
 * 硬依赖。`tools` 必须声明而不是运行时探测：apply 阶段注册表还没挂好，
 * 用 ctx.get('tools') 拿到 undefined，随后会被"防御性跳过"，插件看着起来了但工具不存在。
 */
export const inject = ['systemPrompt', 'tools']

const CONF = {
  timeoutMs: DEFAULTS.timeoutMs,
  downloadTimeoutMs: DEFAULTS.downloadTimeoutMs,
  maxChars: DEFAULTS.maxChars,
  email: '',
  saveDir: '',
  allowRepost: false,
  readerProxy: DEFAULTS.readerProxy,
  injectPrompt: true,
  ledgerInPrompt: false,
}

/** 给模型的固定提示：只在配置打开时注入，控制 token 成本。 */
const PROMPT_TEXT = [
  '论文获取纪律（paper 插件）：',
  '1) 找文献先用 paper_search（OpenAlex/Crossref/arXiv/zbMATH），不要凭记忆报引用；',
  '2) 付费期刊先用 paper_resolve 找 arXiv 预印本或机构仓储的合法开放版；',
  '3) 拿到 PDF 用 paper_fetch 抽正文，它自带 pdftotext/pypdf 与文本代理降级；',
  '4) 写进正文的每条引用，先过 paper_verify，未验证的一律标注"未核实"；',
  '5) 不访问 Sci-Hub/LibGen 等盗版镜像（插件会直接拒绝）。',
].join('\n')

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 注册上下文。
 * @param {Record<string, unknown>} [config] - 行配置。
 * @returns {Promise<void>} 完成。
 */
export async function apply(ctx, config = {}) {
  const cfg = { ...CONF, ...(config !== null && typeof config === 'object' ? config : {}) }
  const num = (v, d, min = 0) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d)
  const opt = {
    timeoutMs: num(cfg.timeoutMs, CONF.timeoutMs, 3000),
    downloadTimeoutMs: num(cfg.downloadTimeoutMs, CONF.downloadTimeoutMs, 5000),
    maxChars: num(cfg.maxChars, CONF.maxChars, 500),
    email: typeof cfg.email === 'string' ? cfg.email.trim() : '',
    saveDir: typeof cfg.saveDir === 'string' ? cfg.saveDir : '',
    allowRepost: cfg.allowRepost === true,
    readerProxy: typeof cfg.readerProxy === 'string' ? cfg.readerProxy.trim() : DEFAULTS.readerProxy,
  }
  const cwd = process.cwd()
  const dir = opt.saveDir || ''

  // ---- 提示段（可选） ------------------------------------------------------
  if (cfg.injectPrompt !== false) {
    try {
      const host = ctx?.systemPrompt?.ctx ?? ctx
      host.systemPrompt.section({ name: 'dsh-plugin-paper', order: 5150, interpolate: false, text: () => PROMPT_TEXT })
    } catch (error) {
      console.error(`[${name}] 提示段注入失败（不影响工具）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const tools = ctx.tools
  if (tools === undefined || typeof tools.register !== 'function') {
    console.error(`[${name}] tools 服务不可用，工具未注册`)
    return
  }
  const { defineTool } = await resolveDefineTool()
  const textOut = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const output = { schema: { type: 'json' }, render: (_a, v) => textOut(v) }

  // ---- 1. 检索 ------------------------------------------------------------
  tools.register(
    defineTool({
      name: 'paper_search',
      description:
        '多源论文检索。一次并行查 OpenAlex（覆盖最广、自带开放获取标记）、Crossref（元数据最权威）、arXiv（预印本全文）、zbMATH（数学专门库，含评论）。' +
        '结果按 DOI/标题相似度去重合并，openalex 结果带 oa_url 说明哪里能免费下。' +
        '用途：找某问题的文献、确认一篇论文是否存在、看某个方向谁做过。不要凭记忆报引用，先查这里。',
      parameters: {
        query: { type: 'string', description: '检索词。用问题名/定理名/论文标题，比用作者名准。' },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['openalex', 'crossref', 'arxiv', 'zbmath'] },
          description: '要查的源，默认 openalex+crossref+arxiv。数学问题加上 zbmath。',
        },
        limit: { type: 'integer', description: '每源返回条数，默认 8，上限 25。' },
        year_from: { type: 'integer', description: '只要这一年之后的（可选）。' },
      },
      output,
      async execute(args) {
        const query = String(args?.query || '').trim()
        if (!query) return { ok: false, reason: 'query 不能为空' }
        const sources = Array.isArray(args?.sources) && args.sources.length ? args.sources.map(String) : ['openalex', 'crossref', 'arxiv']
        const r = await searchAll(query, {
          sources,
          limit: num(args?.limit, 8, 1),
          yearFrom: args?.year_from ? Number(args.year_from) : null,
          email: opt.email,
          allowRepost: opt.allowRepost,
        })
        return { ok: true, elapsed_note: '多源并行', ...r, policy: '仅合法公开渠道；盗版镜像自动排除' }
      },
    })
  )

  // ---- 2. 定位开放版本 ----------------------------------------------------
  tools.register(
    defineTool({
      name: 'paper_resolve',
      description:
        '给一篇论文找**合法免费全文**：查 Unpaywall（需配置真实邮箱）、OpenAlex 的全部 locations（含机构仓储）、arXiv 预印本。' +
        '按"预印本/仓储优先、出版社次之"排序，每个候选标明来源与许可。' +
        '付费墙打不开时先调这个，而不是硬碰出版社页面。盗版镜像会被排除并说明原因。',
      parameters: {
        doi: { type: 'string', description: 'DOI（可带 https://doi.org/ 前缀）。' },
        arxiv_id: { type: 'string', description: 'arXiv 编号，如 2105.05250。' },
        title: { type: 'string', description: '论文标题（无 DOI 时用，会做相似度 >=0.88 的严格匹配）。' },
      },
      output,
      async execute(args) {
        const doi = args?.doi ? String(args.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim() : null
        if (!doi && !args?.arxiv_id && !args?.title) return { ok: false, reason: '至少要给 doi、arxiv_id、title 之一' }
        const r = await resolveOpenAccess({ doi, arxiv_id: args?.arxiv_id || null, title: args?.title || null, email: opt.email, allowRepost: opt.allowRepost })
        return {
          ok: r.candidates.length > 0,
          ...r,
          next: r.candidates.length ? '接下来用 paper_fetch 传候选 url 抓正文。' : '没有开放版本：可试机构仓储、作者主页，或（如果只是要结论）用 paper_search 的摘要。',
        }
      },
    })
  )

  // ---- 3. 抓取 + 抽正文 ---------------------------------------------------
  tools.register(
    defineTool({
      name: 'paper_fetch',
      description:
        '抓一篇论文/网页的正文并抽成文本，三级降级：① 直连（PDF 就地用 pdftotext / pypdf 解析，HTML 去标签）② r.jina.ai 文本代理（绕反爬、PDF 也能转文本）③ 报告失败原因供换渠道。' +
        '正文落盘到 refs/<slug>.txt，原始 PDF 落盘为 refs/<slug>.pdf，并自动记台账。' +
        '返回的 text 是**截断后**的前若干字符（默认 12000），完整全文在 saved.txt 指向的文件里。',
      parameters: {
        url: { type: 'string', description: '文档 URL（paper_resolve 给的候选，或 arXiv PDF 直链）。' },
        title: { type: 'string', description: '用于命名落盘文件（可选）。' },
        max_chars: { type: 'integer', description: '返回正文的字符上限，默认 12000。' },
        timeout_ms: { type: 'integer', description: '下载超时（毫秒）。arXiv 大 PDF 偶尔很慢，默认 70000。' },
        save: { type: 'boolean', description: '是否落盘，默认 true。' },
      },
      output,
      async execute(args) {
        const url = String(args?.url || '').trim()
        if (!/^https?:\/\//i.test(url)) return { ok: false, reason: '需要 http(s) URL' }

        const pol = checkPolicy(url, { allowRepost: opt.allowRepost })
        if (!pol.allowed) return { ok: false, refused: true, reason: pol.reason }

        const doc = await fetchDocument(url, { allowRepost: opt.allowRepost, timeoutMs: num(args?.timeout_ms, opt.downloadTimeoutMs, 5000), readerTemplate: opt.readerProxy })
        if (!doc.ok) {
          return {
            ok: false,
            url,
            reason: doc.reason || '抓取失败',
            tried: doc.tried,
            hint: '换一个候选：paper_resolve 通常能给出多个 URL（arXiv / 仓储 / 出版社），逐个试。',
          }
        }

        const maxChars = num(args?.max_chars, opt.maxChars, 500)
        const head = doc.text.slice(0, maxChars)
        const out = {
          ok: true,
          url,
          via: doc.via,
          chars_total: doc.chars ?? doc.text.length,
          chars_returned: head.length,
          truncated: (doc.chars ?? doc.text.length) > head.length,
          tier: pol.tier,
          tried: doc.tried,
        }

        if (args?.save !== false) {
          // 原始 PDF 字节由 fetchDocument 直接带回来（它下载时已经拿到了），不再重复抓取
          const saved = saveDocument({
            dir,
            title: args?.title || (doc.text.split('\n').find((l) => l.trim().length > 12) || 'document').slice(0, 80),
            url,
            buffer: doc.buffer || null,
            text: doc.text,
            via: doc.via,
            meta: { tier: pol.tier },
          })
          out.saved = saved
        }

        out.text = head
        out.next = out.truncated ? `正文共 ${out.chars_total} 字符，完整内容见 saved.files 里的 .txt；需要中间某段可以再调 paper_fetch 换 max_chars 或直接读文件。` : undefined
        return out
      },
    })
  )

  // ---- 4. 引用审计 -------------------------------------------------------
  tools.register(
    defineTool({
      name: 'paper_verify',
      description:
        '核验一条参考文献是否真实存在，防"编文献"。给自由文本（如 "Berry 1990 Points at rational distance..."）或 DOI/标题，' +
        '它会去 Crossref + arXiv 找最接近的记录，算标题相似度，并检查年份、作者是否一致。' +
        '判定：verified（>=0.9 吻合）/ probable（0.7 到 0.9，需人工核对）/ not_found（<0.7，视为未验证，不要写进正文）。' +
        '把要写进文档的每一条引用都过一遍——这一步比多找十篇论文更能提升可信度。',
      parameters: {
        reference: { type: 'string', description: '引用原文，越完整越好（作者 年份 标题 期刊）。' },
        title: { type: 'string', description: '已知标题时直接给（可选，优先于从 reference 里猜）。' },
        doi: { type: 'string', description: '已知 DOI 时直接给（可选，命中即权威）。' },
        authors: { type: 'string', description: '已知作者（可选，用于一致性检查）。' },
        year: { type: 'integer', description: '已知年份（可选，用于一致性检查）。' },
      },
      output,
      async execute(args) {
        if (!args?.reference && !args?.title && !args?.doi) return { ok: false, reason: '至少给 reference、title、doi 之一' }
        const r = await verifyReference({
          text: args?.reference || '',
          title: args?.title || null,
          doi: args?.doi ? String(args.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null,
          authors: args?.authors || null,
          year: args?.year || null,
          email: opt.email,
        })
        return { ok: true, ...r }
      },
    })
  )

  // ---- 5. 台账 -----------------------------------------------------------
  tools.register(
    defineTool({
      name: 'paper_ledger',
      description:
        '查看/追加本地文献台账（refs/ledger.jsonl）。每次 paper_fetch 都会自动记一行（url、路径、降级到哪一步、字节数）。' +
        'action=list 列出已下载的文献文件；action=read 看最近记录；action=note 手动记一条判断（比如"这篇 PDF 是扫描件，无文字层"）。' +
        '用途：跨会话知道"上次到底从哪拿到的"，避免重复试错。',
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'note'], description: '动作，默认 read。' },
        limit: { type: 'integer', description: 'action=read 时返回条数，默认 20。' },
        note: { type: 'string', description: 'action=note 时写的内容。' },
        target: { type: 'string', description: 'action=note 时对应的文献标识（URL 或标题）。' },
      },
      output,
      async execute(args) {
        const action = String(args?.action || 'read')
        if (action === 'list') {
          const files = listRefs(dir)
          return { ok: true, action, dir: dir || `${cwd}\\refs`, count: files.length, files: files.slice(-50) }
        }
        if (action === 'note') {
          const note = String(args?.note || '').trim()
          if (!note) return { ok: false, reason: 'note 不能为空' }
          const r = appendLedger(dir, { action: 'note', target: args?.target || null, note })
          return { ok: r.ok, action, ...r }
        }
        const r = readLedger(dir, num(args?.limit, 20, 1))
        return { ok: r.ok, action: 'read', path: r.path, count: r.entries?.length ?? 0, entries: r.entries ?? [], reason: r.reason }
      },
    })
  )

  // ---- 6. 通道自检 -------------------------------------------------------
  tools.register(
    defineTool({
      name: 'paper_channels',
      description:
        '自检各条通道当前是否可用（OpenAlex / Crossref / arXiv / zbMATH / Unpaywall / r.jina.ai）以及本机 PDF 解析后端（pdftotext / pypdf）。' +
        '在"明明有网却抓不到"时先跑它：能立刻区分是网络问题、限流、还是解析后端缺失。',
      parameters: {},
      output,
      async execute() {
        const probe = async (label, url) => {
          const r = await httpGet(url, { timeoutMs: 15000, as: 'text' })
          return { channel: label, ok: r.ok, status: r.status || null, ms: r.ms || null, reason: r.reason || null }
        }
        const jobs = [
          probe('openalex', 'https://api.openalex.org/works?search=test&per-page=1'),
          probe('crossref', 'https://api.crossref.org/works?rows=1'),
          probe('arxiv-api', 'http://export.arxiv.org/api/query?search_query=all:test&max_results=1'),
          probe('zbmath', 'https://api.zbmath.org/v1/document/_search?search_string=test&results_per_page=1'),
          probe('wayback', 'https://web.archive.org/web/2024/https://example.com'),
        ]
        // 文本代理是可选级：关掉时不探测，避免每次都白等一个必定超时的连接
        if (opt.readerProxy) jobs.push(probe('reader-proxy', opt.readerProxy.replace('{url}', 'https://example.com')))
        const channels = await Promise.all(jobs)
        // PDF 后端自检：造一个最小 PDF 头，看命令行是否在
        const backends = (() => {
          try {
            const probeBuf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
            const r = extractPdfText(probeBuf)
            return { tried: r.tried, any_native: r.tried.length > 0 }
          } catch (e) {
            return { tried: [], error: e instanceof Error ? e.message : String(e) }
          }
        })()
        return {
          ok: true,
          version: VERSION,
          channels,
          // 抓取降级链的实际顺序（直接告诉模型：代理挂了不代表抓不到，Wayback 还在）
          fetch_chain: ['direct(pdf→pdftotext/pypdf, html→strip)', 'wayback(快照)', opt.readerProxy ? `reader-proxy(${opt.readerProxy})` : '(文本代理已关闭)'],
          pdf_backends: backends,
          unpaywall: opt.email ? { configured: true, email: opt.email.replace(/^(.).*@/, '$1***@') } : { configured: false, note: '未配置 email，Unpaywall 已跳过（OpenAlex 仍可用）' },
          policy: { allowRepost: opt.allowRepost, blocked: ['sci-hub', 'libgen', 'z-library', 'pdfdrive 等镜像'] },
        }
      },
    })
  )

  console.log(
    `[${name}] 论文获取层已就绪：6 个工具（search/resolve/fetch/verify/ledger/channels）；` +
      `落盘=${dir || `${cwd}\\refs`}；邮箱=${opt.email ? '已配置' : '未配置(跳过 Unpaywall)'}；` +
      `转载站=${opt.allowRepost ? '允许' : '拒绝'}`
  )
}
