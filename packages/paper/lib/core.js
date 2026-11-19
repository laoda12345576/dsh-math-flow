/**
 * dsh-plugin-paper — 核心逻辑层（不依赖 cordis，可被 node 直接调用测试）
 *
 * 设计依据来自一次实机运行的反向分析：那次任务在 22 次网页操作里，靠
 * 「换访问路径 + 降级」而不是任何特权通道，拿到了 3 篇付费期刊论文的合法开放版本。
 * 本文件把那套人工摸索固化成可复用函数：
 *
 *   检索(多源) → 定位开放版本(Unpaywall/OpenAlex/arXiv) → 抓取(直连→Reader→本地解析)
 *   → 抽取(PDF→文本，三后端) → 审计(参考文献是否真实存在) → 记账(ledger.jsonl)
 *
 * 一条硬约束贯穿全部函数：只走合法公开渠道。盗版镜像（Sci-Hub / LibGen / Z-Library 等）
 * 在 checkPolicy() 里被拒绝，并且**重定向后再查一次**——合法站点跳到镜像站也会被拦。
 *
 * @module dsh-plugin-paper/core
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'

export const VERSION = '0.1.1'

const UA = `dsh-plugin-paper/${VERSION} (legitimate academic access)`

export const DEFAULTS = {
  // 元数据接口（OpenAlex / Crossref / arXiv API）的超时。
  timeoutMs: 25000,
  // 下载正文的超时。真实的坑：arXiv 偶尔 200 之后慢慢吐 1.8MB，25s 会掐断，
  // 而元数据接口 25s 已经宽裕。这两类请求不该共用同一个预算。
  downloadTimeoutMs: 70000,
  // 文本代理模板。{url} 会被替换成目标地址；设为 '' 关闭这一级。
  // 本机实测 r.jina.ai 被 DNS 劫持（解析到 Facebook 网段），所以它只作为最后一级，
  // 真正承担兜底的是 Wayback。换自建代理时改这里即可。
  readerProxy: 'https://r.jina.ai/{url}',
  // 单个文件最大下载体积。超过就当异常，不解析。
  maxBytes: 48 * 1024 * 1024,
  // 返回给模型的正文上限（字符）。全文落盘，正文只回一段，避免把上下文撑爆。
  maxChars: 12000,
  // Unpaywall 要求真实邮箱，test@example.com 会被 422 拒。留空则跳过 Unpaywall，
  // 只走 OpenAlex（它不要求邮箱，覆盖率也够）。
  email: '',
  // 下载与解析产物的落地目录。空 = <workspace>/refs
  saveDir: '',
  // 是否允许访问"用户上传转载站"（doc88/docin/道客巴巴一类）。默认不允许：
  // 这类站点的版本不受作者控制，且经常是残缺件。
  allowRepost: false,
}

// ---------------------------------------------------------------------------
// 访问策略
// ---------------------------------------------------------------------------

/** 盗版镜像：一律拒绝，不提供任何绕过。 */
const PIRATE = [
  /(^|\.)sci-hub\./i,
  /(^|\.)scihub\./i,
  /(^|\.)libgen\./i,
  /(^|\.)library\.lol/i,
  /(^|\.)z-lib\./i,
  /(^|\.)zlibrary\./i,
  /(^|\.)1lib\./i,
  /(^|\.)pdfdrive\./i,
  /(^|\.)booksc\./i,
  /(^|\.)annex\.st/i,
  /(^|\.)magazinelib\./i,
  /(^|\.)sci-hub\.se/i,
]

/** 用户上传转载站：默认拒绝（版本不可信），可通过 allowRepost 放开。 */
const REPOST = [
  /(^|\.)doc88\.com/i,
  /(^|\.)docin\.com/i,
  /(^|\.)book118\.com/i,
  /(^|\.)wenku\.baidu\.com/i,
  /(^|\.)paperzz\./i,
  /(^|\.)taodocs\./i,
]

/** 已知的合法开放渠道，用于给候选 URL 打标签、排序。 */
const REPOSITORY = [
  /(^|\.)arxiv\.org/i,
  /(^|\.)numdam\.org/i,
  /(^|\.)eudml\.org/i,
  /(^|\.)zbmath\.org/i,
  /(^|\.)euclid\./i,
  /(^|\.)projecteuclid\.org/i,
  /(^|\.)matwbn\.icm\.edu\.pl/i,
  /(^|\.)impan\.pl/i,
  /(^|\.)ams\.org/i,
  /(^|\.)semanticscholar\.org/i,
  /(^|\.)openalex\.org/i,
  /(^|\.)core\.ac\.uk/i,
  /(^|\.)hal\.science/i,
  /(^|\.)zenodo\.org/i,
  /(^|\.)osf\.io/i,
  /(^|\.)ncbi\.nlm\.nih\.gov/i,
  /(^|\.)researchgate\.net/i,
  /(^|\.)scholarworks\./i,
  /(^|\.)digital\.library\./i,
  /\.edu(\/|$)/i,
]

/**
 * 判断一个 URL 是否允许访问。
 * @param {string} url - 待检查的 URL。
 * @param {{allowRepost?: boolean}} [opts] - 策略开关。
 * @returns {{allowed: boolean, tier: string, host: string, reason?: string}} 判定结果。
 */
export function checkPolicy(url, opts = {}) {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return { allowed: false, tier: 'invalid', host: '', reason: '不是合法 URL' }
  }
  if (PIRATE.some((re) => re.test(host))) {
    return {
      allowed: false,
      tier: 'pirate',
      host,
      reason:
        `${host} 属于盗版论文镜像。本插件只走合法公开渠道，不会访问它；` +
        '请改用 paper_resolve 找 arXiv 预印本、机构仓储或出版社的开放版本。',
    }
  }
  if (REPOST.some((re) => re.test(host)) && !opts.allowRepost) {
    return {
      allowed: false,
      tier: 'repost',
      host,
      reason: `${host} 是用户上传转载站，版本不受作者控制，默认不采用（需要的话把 allowRepost 设为 true）。`,
    }
  }
  const tier = REPOSITORY.some((re) => re.test(host)) ? 'repository' : 'publisher'
  return { allowed: true, tier, host }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 带超时、体积上限与策略检查的 GET。
 *
 * 重定向**手动跟随**（`redirect: 'manual'`），每一跳在**发出请求之前**先过策略。
 * 这不只是形式主义：用 `follow` 时浏览器栈会先把请求发给 sci-hub，再回头检查
 * 最终地址——那时数据已经出网了，而且一旦目标 DNS 不通，这个防护分支根本测不到
 * （测试会"假通过"）。手动跟随让拒绝发生在连接之前，也让防护可被测。
 *
 * @param {string} url - 目标地址。
 * @param {object} [opts] - 选项。
 * @returns {Promise<object>} 结果，永不抛异常。
 */
export async function httpGet(url, opts = {}) {
  const { timeoutMs = DEFAULTS.timeoutMs, maxBytes = DEFAULTS.maxBytes, allowRepost = false, headers = {}, as = 'auto', maxHops = 6 } = opts
  const pre = checkPolicy(url, { allowRepost })
  if (!pre.allowed) return { ok: false, refused: true, url, reason: pre.reason, tier: pre.tier }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  const hops = []
  let current = url
  try {
    for (let i = 0; i <= maxHops; i++) {
      const pol = checkPolicy(current, { allowRepost })
      if (!pol.allowed) {
        return {
          ok: false,
          refused: true,
          url,
          finalUrl: current,
          tier: pol.tier,
          hops,
          reason: `${i === 0 ? '' : '重定向到被拒绝的站点：'}${pol.reason}`,
        }
      }
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/html, application/pdf, application/xml, text/plain;q=0.9, */*;q=0.8',
          ...headers,
        },
      })

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        if (!loc) return { ok: false, url, finalUrl: current, status: res.status, reason: '重定向缺少 Location 头', hops }
        let next
        try {
          next = new URL(loc, current).href
        } catch {
          return { ok: false, url, finalUrl: current, status: res.status, reason: `无法解析重定向目标：${loc}`, hops }
        }
        hops.push({ from: current, status: res.status, to: next })
        current = next
        continue
      }

      const contentType = String(res.headers.get('content-type') || '').toLowerCase()
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) {
        return { ok: false, url, finalUrl: current, status: res.status, contentType, bytes: buf.length, reason: `超过体积上限 ${maxBytes} 字节`, hops }
      }
      const isPdf = contentType.includes('pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-'
      const wantText = as === 'text' || (!isPdf && as === 'auto')
      return {
        ok: res.ok,
        status: res.status,
        url,
        finalUrl: current,
        contentType,
        bytes: buf.length,
        isPdf,
        ms: Date.now() - started,
        tier: pol.tier,
        hops,
        buffer: buf,
        text: wantText && !isPdf ? buf.toString('utf8') : undefined,
      }
    }
    return { ok: false, url, finalUrl: current, reason: `重定向超过 ${maxHops} 跳`, hops }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, url, finalUrl: current, reason: msg.includes('abort') ? `超时 ${timeoutMs}ms` : msg, ms: Date.now() - started, hops }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测下载元信息：最终地址、总字节数、是否支持 Range。
 *
 * 只请求 `bytes=0-0`（1 个字节），成本近乎为零，但能拿到三件关键信息：
 * 真正会响应内容的地址（跳过重定向）、Content-Range 里的总长、以及
 * 服务器认不认续传。没有这三样就没法做断点续传——不知道"还差多少"。
 *
 * @param {string} url - 目标地址。
 * @param {object} [opts] - {allowRepost, timeoutMs, maxHops}
 * @returns {Promise<object>} {ok, finalUrl, total, acceptRanges, contentType, status, hops}
 */
export async function probeDownload(url, opts = {}) {
  const { allowRepost = false, timeoutMs = 20000, maxHops = 6 } = opts
  const pol0 = checkPolicy(url, { allowRepost })
  if (!pol0.allowed) return { ok: false, refused: true, url, reason: pol0.reason }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const hops = []
  let current = url
  try {
    for (let i = 0; i <= maxHops; i++) {
      const pol = checkPolicy(current, { allowRepost })
      if (!pol.allowed) return { ok: false, refused: true, url, finalUrl: current, hops, reason: pol.reason }
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: '*/*', range: 'bytes=0-0' },
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        try { await res.body?.cancel() } catch { /* ignore */ }
        if (!loc) return { ok: false, url, finalUrl: current, status: res.status, hops, reason: '重定向缺少 Location 头' }
        let next
        try { next = new URL(loc, current).href } catch {
          return { ok: false, url, finalUrl: current, status: res.status, hops, reason: `无法解析重定向目标：${loc}` }
        }
        hops.push({ from: current, status: res.status, to: next })
        current = next
        continue
      }
      const cr = String(res.headers.get('content-range') || '')
      const crTotal = /\/(\d+)\s*$/.exec(cr)
      const clen = Number(res.headers.get('content-length') || 0)
      const total = crTotal ? Number(crTotal[1]) : res.status === 200 && clen > 0 ? clen : null
      const acceptRanges =
        String(res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes') || res.status === 206
      const contentType = String(res.headers.get('content-type') || '').toLowerCase()
      try { await res.body?.cancel() } catch { /* ignore */ }
      return {
        ok: res.ok || res.status === 206,
        url,
        finalUrl: current,
        total,
        acceptRanges,
        contentType,
        status: res.status,
        tier: pol.tier,
        hops,
        ms: Date.now() - 0,
      }
    }
    return { ok: false, url, finalUrl: current, hops, reason: `重定向超过 ${maxHops} 跳` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, url, finalUrl: current, hops, reason: msg.includes('abort') ? `探测超时 ${timeoutMs}ms` : msg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 断点续传下载：一轮拿不完就带着 `Range: bytes=<已有字节>-` 接着要。
 *
 * 为什么必须有这一级：真实的失败长这样——服务器 200、Content-Length 1.88 MB、
 * 60 秒只吐出 103 KB 就断。一次性下载在这种站上永远不可能成功，
 * 哪怕把超时调到 10 分钟也只是赌。但服务器明确支持 Range 时，
 * 断十次、续十次，每轮只要求"前进一点"，最终一定能拿全。
 *
 * 空转保护：连续 3 轮一个字节都没增加就放弃，避免对着死站白等。
 *
 * @param {string} url - 目标地址（应是 probeDownload 确认过的 finalUrl）。
 * @param {object} [opts] - {allowRepost, timeoutMs, maxRounds, maxBytes, onProgress}
 * @returns {Promise<object>} {ok, buffer, bytes, total, rounds, reason}
 */
export async function resumeDownload(url, opts = {}) {
  const { allowRepost = false, timeoutMs = 45000, maxRounds = 20, maxBytes = DEFAULTS.maxBytes } = opts
  const meta = await probeDownload(url, { allowRepost, timeoutMs: Math.min(timeoutMs, 25000) })
  if (!meta.ok) return { ok: false, url, reason: meta.reason, stage: 'probe', refused: meta.refused }
  if (meta.refused) return { ok: false, url, refused: true, reason: meta.reason }

  const target = meta.finalUrl
  const total = meta.total
  const rounds = []
  let buf = Buffer.alloc(0)

  for (let r = 0; r < maxRounds; r++) {
    if (total && buf.length >= total) break
    if (buf.length >= maxBytes) return { ok: false, url, reason: `超过体积上限 ${maxBytes} 字节`, bytes: buf.length, rounds }
    // 服务器不支持 Range 时续传无从谈起：第二轮开始只会重发全量，
    // 再循环下去就是把同一个慢下载重复无数次。直接收手。
    if (r > 0 && !meta.acceptRanges) break

    const headers = { 'user-agent': UA, accept: '*/*' }
    if (buf.length && meta.acceptRanges) headers.range = `bytes=${buf.length}-`

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const t0 = Date.now()
    const before = buf.length
    const chunks = []
    let got = 0
    let status = null
    let err = null
    let exhausted = false

    try {
      const res = await fetch(target, { signal: ctrl.signal, redirect: 'manual', headers })
      status = res.status
      if (status === 416) { exhausted = true } else if (status >= 300 && status < 400) {
        throw new Error('下载中被重定向，请重新探测')
      } else {
        // 服务器忽略 Range 回了 200 全量：丢掉已有部分重新收，且本轮之后不再续传。
        if (buf.length && status === 200) buf = Buffer.alloc(0)
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          chunks.push(Buffer.from(value))
          got += value.length
          if (buf.length + got > maxBytes) {
            try { await reader.cancel() } catch { /* ignore */ }
            throw new Error(`超过体积上限 ${maxBytes} 字节`)
          }
        }
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }

    if (got) buf = Buffer.concat([buf, ...chunks])
    rounds.push({
      round: r,
      status,
      added: got,
      have: buf.length,
      total,
      ms: Date.now() - t0,
      need: total ? Math.max(0, total - buf.length) : null,
      error: err,
    })

    if (exhausted) break
    if (!err && got >= 0 && (total ? buf.length >= total : true)) break
    if (buf.length === before && r > 0) {
      const idle = rounds.filter((x) => x.added === 0).length
      if (idle >= 3) break
    }
    if (err && /超过体积上限/.test(err)) return { ok: false, url, reason: err, bytes: buf.length, rounds }
  }

  const complete = total ? buf.length >= total : buf.length > 0 && rounds.every((x) => !x.error)
  return {
    ok: complete && buf.length > 0,
    url,
    finalUrl: target,
    buffer: buf,
    bytes: buf.length,
    total,
    acceptRanges: meta.acceptRanges,
    contentType: meta.contentType,
    complete,
    rounds,
    reason: complete ? null : `续传未完成：${buf.length}${total ? '/' + total : ''} 字节`,
  }
}

/** 取 JSON，失败返回 {ok:false}。 */
export async function getJson(url, opts = {}) {
  const r = await httpGet(url, { ...opts, as: 'text', headers: { accept: 'application/json', ...(opts.headers || {}) } })
  if (!r.ok || !r.text) return { ...r, json: null }
  try {
    return { ...r, json: JSON.parse(r.text) }
  } catch {
    return { ...r, ok: false, json: null, reason: `返回内容不是 JSON（前 120 字符：${r.text.slice(0, 120)}）` }
  }
}

// ---------------------------------------------------------------------------
// HTML / 文本清洗
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' }

/**
 * 从 HTML 里抽出可读文本。
 * @param {string} html - HTML 原文。
 * @returns {string} 纯文本。
 */
export function htmlToText(html) {
  if (typeof html !== 'string') return ''
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    const v = ENTITIES[g.toLowerCase()]
    return v === undefined ? m : v
  })
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

// ---------------------------------------------------------------------------
// PDF 文本抽取：三后端依次尝试
// ---------------------------------------------------------------------------

const PY_SCRIPT = [
  'import sys',
  'try:',
  '    import pypdf',
  'except Exception:',
  '    sys.exit(3)',
  'try:',
  '    sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
  'except Exception:',
  '    pass',
  'r = pypdf.PdfReader(sys.argv[1])',
  'parts = []',
  'for p in r.pages:',
  '    try:',
  '        parts.append(p.extract_text() or "")',
  '    except Exception:',
  '        parts.append("")',
  'sys.stdout.write("\\n".join(parts))',
].join('\n')

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { timeout: 120000, maxBuffer: 96 * 1024 * 1024, windowsHide: true })
  if (r.error) return { ok: false, reason: r.error.message }
  if (r.status !== 0) return { ok: false, reason: `exit ${r.status}: ${String(r.stderr || '').slice(0, 200)}` }
  return { ok: true, text: String(r.stdout || '') }
}

/**
 * 把 PDF 二进制抽成文本。依次尝试 pdftotext（最快、版式好）→ python/pypdf（最兼容）。
 * @param {Buffer} buffer - PDF 二进制。
 * @returns {{text: string, via: string|null, tried: string[]}} 抽取结果；抽不出时 text 为空串。
 */
export function extractPdfText(buffer) {
  const tried = []
  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'dshpaper-'))
    const file = join(dir, 'in.pdf')
    writeFileSync(file, buffer)

    // 后端 1：poppler 的 pdftotext（MiKTeX 自带，实测最快）
    tried.push('pdftotext')
    const poppler = runCapture('pdftotext', ['-layout', '-q', '-enc', 'UTF-8', file, '-'])
    if (poppler.ok && poppler.text.trim().length > 200) {
      return { text: cleanPdfText(poppler.text), via: 'pdftotext', tried }
    }

    // 后端 2：python + pypdf
    tried.push('pypdf')
    for (const py of ['python', 'python3', 'py']) {
      const res = runCapture(py, ['-c', PY_SCRIPT, file])
      if (res.ok && res.text.trim().length > 200) {
        return { text: cleanPdfText(res.text), via: `pypdf(${py})`, tried }
      }
      if (res.ok === false && /ENOENT/.test(res.reason || '')) continue
    }

    // 后端 3：保留 pdftotext 的短输出（可能是扫描件，只有少量文字层）
    if (poppler.ok && poppler.text.trim().length > 0) {
      return { text: cleanPdfText(poppler.text), via: 'pdftotext(partial)', tried }
    }
    return { text: '', via: null, tried }
  } catch (error) {
    return { text: '', via: null, tried, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/** 修掉 PDF 抽取常见的连字/断词问题，保留段落结构。 */
export function cleanPdfText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00ad\s*\n/g, '') // 软连字符断词
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2') // 行末连字符
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// 抓取：四级降级链
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 死通道短路
// ---------------------------------------------------------------------------

/**
 * 记录"这个主机在本环境下连不上"，10 分钟内不再重试。
 *
 * 起因是实测：本机 r.jina.ai 与 web.archive.org 都被网络层阻断（10s 后 connect
 * timeout）。如果不记住，每抓一次失败页面就要白等 20 秒去试两个必死的降级级，
 * 而且日志里看起来和"反爬失败"一模一样。记住它，失败一次就够。
 */
const DEAD = new Map()
const DEAD_TTL_MS = 10 * 60 * 1000

function hostOf(u) {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}

/** 该主机是否在"近期连不上"名单里。 */
export function isKnownDead(u) {
  const h = hostOf(u)
  const until = DEAD.get(h)
  return typeof until === 'number' && until > Date.now()
}

/** 标记该主机近期连不上。 */
export function markDead(u) {
  const h = hostOf(u)
  if (h) DEAD.set(h, Date.now() + DEAD_TTL_MS)
}

/** 清空死通道名单（自检工具用）。 */
export function clearDead() {
  DEAD.clear()
}

const CONNECT_FAIL = /fetch failed|connect timeout|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|超时/i

/**
 * 抓一篇文档的正文，按降级链推进：
 *   1. 直连（PDF 就地解析 / HTML 去标签）
 *   2. Wayback 快照
 *   3. 可配置文本代理（默认 r.jina.ai）
 *   4. 返回已拿到的部分 + 每一级的失败原因（供上层换渠道）
 * @param {string} url - 文档地址。
 * @param {object} [opts] - 选项。
 * @returns {Promise<object>} {ok, via, text, bytes, tried, ...}
 */
export async function fetchDocument(url, opts = {}) {
  const { allowRepost = false, timeoutMs = DEFAULTS.downloadTimeoutMs, readerTemplate = DEFAULTS.readerProxy } = opts
  const tried = []

  // 直连：先用 probe 确认"还差多少字节 + 认不认 Range"，能续传就续传。
  //
  // 这一步替代了原来的一次性 httpGet。理由来自实测：ijgeometry 上的 1.88 MB PDF
  // 60 秒只吐 103 KB，无论超时给多长，单次请求都拿不全；但它支持 Range，
  // 分段续十几轮就能完。对普通站点，第一轮直接读完，行为与一次性下载一致。
  const dl = await resumeDownload(url, { allowRepost, timeoutMs })
  if (dl.refused) return { ok: false, refused: true, url, reason: dl.reason, tried }

  let direct
  if (!dl.ok && (dl.stage === 'probe' || !dl.total)) {
    // 探测就没通过（或是拿不到总长的怪物响应）：退回一次性下载，别让 probe 误伤。
    const once = await httpGet(url, { allowRepost, timeoutMs })
    tried.push({ step: 'direct-once', ok: once.ok, status: once.status, bytes: once.bytes, ms: once.ms, reason: once.reason })
    direct = once
    if (direct.refused) return { ok: false, refused: true, url, reason: direct.reason, tried }
  } else {
    direct = {
      ok: dl.ok,
      status: dl.rounds?.[0]?.status ?? null,
      bytes: dl.bytes,
      ms: (dl.rounds || []).reduce((a, x) => a + (x.ms || 0), 0),
      finalUrl: dl.finalUrl,
      contentType: dl.contentType,
      isPdf: /pdf/.test(dl.contentType || '') || (dl.buffer ? dl.buffer.subarray(0, 5).toString('latin1') === '%PDF-' : false),
      buffer: dl.buffer,
      reason: dl.reason,
    }
    tried.push({
      step: 'direct',
      ok: direct.ok,
      status: direct.status,
      bytes: direct.bytes,
      total: dl.total,
      resumed: (dl.rounds || []).length > 1,
      rounds: (dl.rounds || []).length,
      ms: direct.ms,
      reason: direct.reason,
    })
  }
  if (direct.refused) return { ok: false, refused: true, url, reason: direct.reason, tried }
  if (direct.ok && !direct.isPdf && direct.buffer && !direct.text) direct.text = direct.buffer.toString('utf8')

  if (direct.ok && direct.isPdf) {
    const ex = extractPdfText(direct.buffer)
    tried.push({ step: 'pdf-parse', ok: ex.text.length > 0, via: ex.via, chars: ex.text.length })
    if (ex.text.length > 300) {
      // 把原始字节一起带回去：调用方要落盘时不必再下载一次（真实调用里那是一次
      // 多余的 800KB～2MB 抓取，而且会给 arXiv 制造无意义的重复请求）。
      return { ok: true, via: `direct+${ex.via}`, url, finalUrl: direct.finalUrl, bytes: direct.bytes, chars: ex.text.length, text: ex.text, tried, buffer: direct.buffer, contentType: direct.contentType }
    }
  }
  if (direct.ok && !direct.isPdf && direct.text) {
    const text = htmlToText(direct.text)
    tried.push({ step: 'html-strip', chars: text.length })
    if (text.length > 400) {
      return { ok: true, via: 'direct+html', url, finalUrl: direct.finalUrl, bytes: direct.bytes, chars: text.length, text, tried }
    }
  }

  // 降级 2：Wayback 快照。
  //
  // 为什么把 Wayback 排在文本代理前面：本机的 r.jina.ai **被 DNS 劫持**
  // （解析到 108.160.169.174 / 2a03:2880::/32，Facebook 段，连接必然超时），实测
  // 两次都是 10s connect timeout。把这条件写进代码注释，是因为"代理挂了"和
  // "网站反爬"在日志里长得一模一样，不写下来下次还会误判。
  const wbUrl = `https://web.archive.org/web/2024/${url}`
  if (isKnownDead(wbUrl)) {
    tried.push({ step: 'wayback', skipped: '该主机 10 分钟内已确认连不上' })
  } else {
    const wb = await httpGet(wbUrl, { timeoutMs: Math.max(timeoutMs, 40000) })
    tried.push({ step: 'wayback', ok: wb.ok, status: wb.status, bytes: wb.bytes, ms: wb.ms, reason: wb.reason })
    if (!wb.ok && CONNECT_FAIL.test(String(wb.reason || ''))) markDead(wbUrl)
    if (wb.ok && wb.isPdf) {
      const ex = extractPdfText(wb.buffer)
      tried.push({ step: 'wayback-pdf-parse', ok: ex.text.length > 0, via: ex.via, chars: ex.text.length })
      if (ex.text.length > 300) {
        return { ok: true, via: `wayback+${ex.via}`, url, finalUrl: wb.finalUrl, bytes: wb.bytes, chars: ex.text.length, text: ex.text, tried, buffer: wb.buffer, snapshot: true }
      }
    }
    if (wb.ok && !wb.isPdf && wb.text) {
      const text = htmlToText(wb.text)
      tried.push({ step: 'wayback-html', chars: text.length })
      if (text.length > 400) {
        return { ok: true, via: 'wayback+html', url, finalUrl: wb.finalUrl, bytes: wb.bytes, chars: text.length, text, tried, snapshot: true }
      }
    }
  }

  // 降级 3：可配置的文本代理（默认 r.jina.ai；本机不可达时可换成自建的或留空关闭）
  if (readerTemplate) {
    const readerUrl = readerTemplate.replace('{url}', url)
    if (isKnownDead(readerUrl)) {
      tried.push({ step: 'reader-proxy', skipped: '该主机 10 分钟内已确认连不上' })
    } else {
      const jina = await httpGet(readerUrl, { timeoutMs: Math.max(timeoutMs, 40000), as: 'text' })
      tried.push({ step: 'reader-proxy', target: readerUrl.slice(0, 60), ok: jina.ok, status: jina.status, bytes: jina.bytes, ms: jina.ms, reason: jina.reason })
      if (!jina.ok && CONNECT_FAIL.test(String(jina.reason || ''))) markDead(readerUrl)
      if (jina.ok && jina.text && jina.text.trim().length > 400) {
        return { ok: true, via: 'reader-proxy', url, reader: readerUrl, bytes: jina.bytes, chars: jina.text.length, text: htmlToText(jina.text), tried }
      }
    }
  }

  const why = direct.refused ? direct.reason : direct.ok ? '内容过短（可能是扫描件、需要 JS 的页面、或错误页）' : `HTTP ${direct.status || '?'} ${direct.reason || ''}`.trim()
  return { ok: false, url, reason: why, tried }
}

// ---------------------------------------------------------------------------
// 多源检索
// ---------------------------------------------------------------------------

/** 统一结果形状，保证下游不用分情况处理。 */
function rec(o) {
  return {
    title: (o.title || '').replace(/\s+/g, ' ').trim(),
    authors: Array.isArray(o.authors) ? o.authors.slice(0, 8) : [],
    year: o.year || null,
    venue: o.venue || null,
    doi: o.doi || null,
    arxiv_id: o.arxiv_id || null,
    url: o.url || null,
    oa_url: o.oa_url || null,
    oa_status: o.oa_status || null,
    license: o.license || null,
    cited_by: Number.isFinite(o.cited_by) ? o.cited_by : null,
    type: o.type || null,
    source: o.source,
    abstract: o.abstract ? String(o.abstract).replace(/\s+/g, ' ').slice(0, 400) : null,
  }
}

/** OpenAlex：无需 key，覆盖最广，自带 OA 定位。 */
export async function searchOpenAlex(query, { limit = 8, yearFrom = null, email = '' } = {}) {
  const p = new URLSearchParams({ search: query, 'per-page': String(Math.min(limit, 25)) })
  if (email) p.set('mailto', email)
  if (yearFrom) p.set('filter', `from_publication_date:${yearFrom}-01-01`)
  const r = await getJson(`https://api.openalex.org/works?${p}`)
  if (!r.json) return { source: 'openalex', ok: false, reason: r.reason || `HTTP ${r.status}`, results: [] }
  const results = (r.json.results || []).map((w) =>
    rec({
      title: w.title || w.display_name,
      authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
      year: w.publication_year,
      venue: w.primary_location?.source?.display_name || null,
      doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null,
      url: w.doi || w.id,
      oa_url: w.best_oa_location?.pdf_url || w.best_oa_location?.landing_page_url || null,
      oa_status: w.open_access?.oa_status || null,
      license: w.best_oa_location?.license || null,
      cited_by: w.cited_by_count,
      type: w.type,
      source: 'openalex',
    })
  )
  return { source: 'openalex', ok: true, results }
}

/** Crossref：元数据最权威，负责给引用"验明正身"。 */
export async function searchCrossref(query, { limit = 8, email = '' } = {}) {
  const p = new URLSearchParams({ 'query.bibliographic': query, rows: String(Math.min(limit, 25)) })
  if (email) p.set('mailto', email)
  const r = await getJson(`https://api.crossref.org/works?${p}`)
  if (!r.json) return { source: 'crossref', ok: false, reason: r.reason || `HTTP ${r.status}`, results: [] }
  const items = r.json.message?.items || []
  const results = items.map((w) => {
    const pdf = (w.link || []).find((l) => String(l['content-type']).includes('pdf'))
    const issued = w.issued?.['date-parts']?.[0]?.[0] ?? w['published-print']?.['date-parts']?.[0]?.[0] ?? null
    return rec({
      title: (w.title || [])[0],
      authors: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
      year: issued,
      venue: (w['container-title'] || [])[0] || null,
      doi: w.DOI || null,
      url: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : null),
      oa_url: pdf ? pdf.URL : null,
      license: (w.license || [])[0]?.URL || null,
      cited_by: w['is-referenced-by-count'],
      type: w.type,
      source: 'crossref',
    })
  })
  return { source: 'crossref', ok: true, results }
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'on', 'for', 'and', 'in', 'to', 'with', 'from', 'by', 'at', 'as', 'is', 'are', 'via'])

/**
 * 把自然语言查询转成 arXiv 的布尔检索式。
 *
 * 之前直接拼 `all:"整句"`，实测对一个 8 词的长查询返回 **0 条**——短语检索要求
 * 原文逐字出现，太严。改成"去停用词 + 逐词 AND"，命中率高得多；词数很少时才用短语。
 * @param {string} q - 查询字符串。
 * @returns {string} 已编码的 search_query。
 */
export function arxivQuery(q) {
  const raw = String(q || '').replace(/\\[a-z]+\{[^}]*\}/g, ' ')
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  const uniq = [...new Set(tokens)].slice(0, 8)
  if (uniq.length === 0) return `all:${encodeURIComponent(raw.trim().slice(0, 80))}`
  if (uniq.length === 1) return `all:${encodeURIComponent(uniq[0])}`
  // 注意：'%2B' 与 '+' 在 arXiv 语义不同，这里必须拼字面 '+AND+'，不能交给 URLSearchParams
  return uniq.map((t) => `all:${encodeURIComponent(t)}`).join('+AND+')
}

/** arXiv：预印本，几乎总能拿到全文。 */
export async function searchArxiv(query, { limit = 8 } = {}) {
  const p = new URLSearchParams({ start: '0', max_results: String(Math.min(limit, 25)), sortBy: 'relevance' })
  const r = await httpGet(`http://export.arxiv.org/api/query?search_query=${arxivQuery(query)}&${p}`, { as: 'text', timeoutMs: 30000 })
  if (!r.ok || !r.text) return { source: 'arxiv', ok: false, reason: r.reason || `HTTP ${r.status}`, results: [] }
  const entries = [...String(r.text).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
  const pick = (s, tag) => {
    const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].replace(/\s+/g, ' ').trim() : null
  }
  const results = entries.map((e) => {
    const idUrl = pick(e, 'id') || ''
    const aid = (idUrl.match(/abs\/([^v]+)(v\d+)?$/) || [])[1] || null
    const names = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim())
    return rec({
      title: pick(e, 'title'),
      authors: names,
      year: (pick(e, 'published') || '').slice(0, 4) ? Number((pick(e, 'published') || '').slice(0, 4)) : null,
      venue: 'arXiv preprint',
      doi: pick(e, 'arxiv:doi'),
      arxiv_id: aid,
      url: idUrl,
      oa_url: aid ? `https://arxiv.org/pdf/${aid}` : null,
      oa_status: 'preprint',
      license: null,
      cited_by: null,
      type: 'preprint',
      abstract: pick(e, 'summary'),
      source: 'arxiv',
    })
  })
  return { source: 'arxiv', ok: true, results }
}

/** zbMATH：数学专门库，评论（review）常直接给出定理级判断。 */
export async function searchZbmath(query, { limit = 6 } = {}) {
  const p = new URLSearchParams({ search_string: String(query), results_per_page: String(Math.min(limit, 20)) })
  const r = await getJson(`https://api.zbmath.org/v1/document/_search?${p}`)
  if (!r.json) return { source: 'zbmath', ok: false, reason: r.reason || `HTTP ${r.status}`, results: [] }
  const arr = r.json.result || r.json.results || []
  const results = arr.map((d) =>
    rec({
      title: d.title?.title || d.title || '',
      authors: (d.contributors?.authors || []).map((a) => a.name).filter(Boolean),
      year: d.year || null,
      venue: (d.sourceSeries || [])[0]?.short_title || null,
      doi: d.identifier || null,
      url: d.links?.[0]?.identifier || d.zbmath_url || null,
      oa_url: (d.links || []).find((l) => /pdf|full|free/i.test(String(l.type || '')))?.identifier || null,
      source: 'zbmath',
    })
  )
  return { source: 'zbmath', ok: true, results, review: arr[0]?.editorial_contributions?.[0]?.text || null }
}

/** 标题归一化，用于去重与相似度。纯数字 token（年份、卷号）一律丢掉，否则会压低匹配。 */
export function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\\[a-z]+\{[^}]*\}/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^\d+$/.test(t))
    .join(' ')
    .replace(/\b(a|an|the|of|on|for|and|in|to|with|from|by)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 标题相似度 0–1。
 *
 * 用 Dice 系数而不是"较短集合的覆盖率"：覆盖率会把**更长**的假标题判成高分
 * （假标题把真标题整个包含进去时覆盖率恒为 1）。防幻觉场景下这种宽容有害。
 * @param {string} a - 标题 A。
 * @param {string} b - 标题 B。
 * @returns {number} 0–1。
 */
export function titleSimilarity(a, b) {
  const A = new Set(normTitle(a).split(' ').filter(Boolean))
  const B = new Set(normTitle(b).split(' ').filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const dice = (2 * inter) / (A.size + B.size)
  const lenPenalty = 1 - Math.min(0.2, (Math.abs(A.size - B.size) / Math.max(A.size, B.size)) * 0.2)
  return Math.max(0, Math.min(1, dice * lenPenalty))
}

/**
 * 从一条"乱引用"里猜出可能的标题候选。
 *
 * 真实调用里引用长这样：`Yang Ji, Several special cases of a square problem, 2021`。
 * 把整串当标题去比，相似度会被作者名和年份拉到 0.5 以下，真文献也会被判成不存在。
 * 所以生成多个候选、分别打分取最高。
 * @param {string} raw - 引用原文。
 * @returns {string[]} 候选标题（均 >=3 词）。
 */
export function titleCandidates(raw) {
  const s = String(raw || '')
    .replace(/\\[a-z]+\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const out = []
  const push = (t) => {
    const v = String(t || '')
      .replace(/^[\s,;:.()[\]{}'"]+|[\s,;:.()[\]{}'"]+$/g, '')
      .trim()
    if (!v || v.split(/\s+/).length < 3 || v.length > 260) return
    if (!out.some((x) => titleSimilarity(x, v) > 0.98)) out.push(v)
  }
  const quoted = s.match(/[“"「『']([^”"」』']{10,220})[”"」』']/)
  if (quoted) push(quoted[1])
  const afterYear = s.match(/\b(19|20)\d{2}[a-z]?[).,;:\s-]+(.{10,220})$/)
  if (afterYear) push(afterYear[2])
  const seg = s.split(',')
  if (seg.length > 1 && /^[A-Z][\w.'’-]*(\s+[A-Z][\w.'’-]*){0,4}(\s*(,|and|&)\s*[A-Z][\w.'’-]*(\s+[A-Z][\w.'’-]*){0,3})*$/.test(seg[0].trim())) {
    push(seg.slice(1).join(','))
  }
  push(s.replace(/\b(19|20)\d{2}\b[\s\S]*$/, ''))
  const parts = s.split(/[,;]/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 3)
  if (parts.length) push(parts.reduce((a, b) => (a.length >= b.length ? a : b)))
  return out
}

/**
 * 多源并行检索 + 去重合并。
 * @param {string} query - 检索词。
 * @param {object} [opts] - {sources, limit, yearFrom, email}
 * @returns {Promise<object>} 各源状态 + 合并结果。
 */
export async function searchAll(query, opts = {}) {
  const { sources = ['openalex', 'crossref', 'arxiv'], limit = 8, yearFrom = null, email = '', allowRepost = false } = opts
  const jobs = []
  if (sources.includes('openalex')) jobs.push(searchOpenAlex(query, { limit, yearFrom, email }))
  if (sources.includes('crossref')) jobs.push(searchCrossref(query, { limit, email }))
  if (sources.includes('arxiv')) jobs.push(searchArxiv(query, { limit }))
  if (sources.includes('zbmath')) jobs.push(searchZbmath(query, { limit }))

  const settled = await Promise.all(jobs.map((j) => j.catch((e) => ({ source: '?', ok: false, reason: String(e && e.message), results: [] }))))
  const sourcesState = settled.map((s) => ({ source: s.source, ok: s.ok, reason: s.reason || null, count: s.results.length }))

  // 合并去重：同标题取相似度 > 0.92 视为同一条，优先保留有 OA 链接的。
  const merged = []
  for (const s of settled) {
    for (const r of s.results) {
      if (!r.title) continue
      const hit = merged.find((m) => (r.doi && m.doi && m.doi.toLowerCase() === r.doi.toLowerCase()) || titleSimilarity(m.title, r.title) > 0.92)
      if (!hit) {
        merged.push({ ...r, also_in: [r.source] })
        continue
      }
      hit.also_in.push(r.source)
      if (!hit.oa_url && r.oa_url) hit.oa_url = r.oa_url
      if (!hit.doi && r.doi) hit.doi = r.doi
      if (!hit.arxiv_id && r.arxiv_id) hit.arxiv_id = r.arxiv_id
      hit.cited_by = Math.max(hit.cited_by || 0, r.cited_by || 0) || hit.cited_by
    }
  }
  merged.sort((a, b) => (b.oa_url ? 1 : 0) - (a.oa_url ? 1 : 0) || (b.cited_by || 0) - (a.cited_by || 0))
  for (const m of merged) {
    const pol = m.oa_url ? checkPolicy(m.oa_url, { allowRepost }) : null
    m.oa_allowed = pol ? pol.allowed : null
    if (pol && !pol.allowed) m.oa_url = null
  }
  return { query, sources: sourcesState, count: merged.length, results: merged }
}

// ---------------------------------------------------------------------------
// 开放版本定位
// ---------------------------------------------------------------------------

/**
 * 给一篇论文找合法全文：Unpaywall（需真实邮箱）+ OpenAlex 全量 locations + arXiv 预印本。
 * @param {object} target - {doi, arxiv_id, title, email, allowRepost}
 * @returns {Promise<object>} 候选清单（已排序、已过策略）。
 */
export async function resolveOpenAccess({ doi = null, arxiv_id = null, title = null, email = '', allowRepost = false } = {}) {
  const cands = []
  const notes = []

  if (doi && email && !/example\.(com|org)$/i.test(email)) {
    const r = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`)
    if (r.json) {
      const best = r.json.best_oa_location
      for (const loc of [best, ...(r.json.oa_locations || [])].filter(Boolean)) {
        const u = loc.url_for_pdf || loc.url
        if (u) cands.push({ url: u, via: 'unpaywall', version: loc.version || null, license: loc.license || null, host: loc.host_type || null })
      }
      if (r.json.is_oa === false) notes.push('Unpaywall: 该 DOI 没有登记开放版本。')
    } else {
      notes.push(`Unpaywall 查询失败：${r.reason || r.status}`)
    }
  } else if (doi) {
    notes.push('未配置真实邮箱，跳过 Unpaywall（它要求邮箱；OpenAlex 仍会查）。')
  }

  // OpenAlex：无论有没有 DOI 都能查，且 locations 覆盖机构仓储
  const oaUrl = doi
    ? `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`
    : title
      ? `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=3`
      : null
  if (oaUrl) {
    const r = await getJson(oaUrl + (oaUrl.includes('?') ? '&' : '?') + (email ? `mailto=${encodeURIComponent(email)}` : ''))
    const work = r.json?.results ? r.json.results[0] : r.json
    if (work) {
      for (const loc of [work.best_oa_location, ...(work.locations || [])].filter(Boolean)) {
        const u = loc.pdf_url || loc.landing_page_url
        if (u) cands.push({ url: u, via: 'openalex', version: loc.version || null, license: loc.license || null, host: loc.source?.display_name || null })
      }
      if (!work.best_oa_location) notes.push('OpenAlex: 没有记录到开放获取位置（可能只有付费版）。')
      if (work.primary_location?.source?.display_name) notes.push(`发表在：${work.primary_location.source.display_name}（${work.publication_year || '?'}）`)
    }
  }

  // arXiv：有 id 直接拼；只有标题就按标题搜，且要求高相似度才算（避免拿错论文）
  if (arxiv_id) {
    cands.push({ url: `https://arxiv.org/pdf/${arxiv_id}`, via: 'arxiv(id)', version: 'preprint', license: null, host: 'arXiv' })
    cands.push({ url: `https://arxiv.org/abs/${arxiv_id}`, via: 'arxiv(id)', version: 'preprint', license: null, host: 'arXiv' })
  } else if (title) {
    const s = await searchArxiv(title, { limit: 4 })
    for (const r of s.results) {
      const sim = titleSimilarity(title, r.title)
      if (sim >= 0.88 && r.arxiv_id) {
        cands.push({ url: `https://arxiv.org/pdf/${r.arxiv_id}`, via: `arxiv(title sim=${sim.toFixed(2)})`, version: 'preprint', license: null, host: 'arXiv' })
      }
    }
    if (cands.length === 0) notes.push('arXiv: 标题匹配度不足 0.88，没有自动采用（避免给错论文）。')
  }

  // 去重 + 过策略 + 排序：预印本/仓储优先（稳定可下），出版社次之
  const seen = new Set()
  const clean = []
  for (const c of cands) {
    const key = c.url.replace(/[#?].*$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    const pol = checkPolicy(c.url, { allowRepost })
    if (!pol.allowed) {
      notes.push(`已排除 1 个候选：${pol.reason}`)
      continue
    }
    clean.push({ ...c, tier: pol.tier, host_name: pol.host })
  }
  const rank = (c) => (/arxiv|numdam|eudml|projecteuclid|core\.ac|zenodo|osf|\.edu/i.test(c.url) ? 0 : c.tier === 'repository' ? 1 : 2)
  clean.sort((a, b) => rank(a) - rank(b))

  return { doi, arxiv_id, title, candidates: clean, notes }
}

// ---------------------------------------------------------------------------
// 参考文献审计（防幻觉的核心）
// ---------------------------------------------------------------------------

/**
 * 验证一条引用是否真实存在，并给出匹配证据。
 * 判定：score>=0.9 verified；0.7–0.9 probable；<0.7 not_found（可能是幻觉或转引失真）。
 * @param {object} ref - {text, doi, title, authors, year, email}
 * @returns {Promise<object>} 判定 + 最佳证据 + 备选。
 */
export async function verifyReference({ text = '', doi = null, title = null, authors = null, year = null, email = '' } = {}) {
  const raw = String(text || '').trim()
  const guesses = title ? [title, ...titleCandidates(raw)] : titleCandidates(raw)
  if (guesses.length === 0 && !doi) return { verdict: 'not_found', score: 0, reason: '没有可用的标题或 DOI，无法核验。' }

  // 打分口径：一条记录与任意一个候选标题的最高相似度。取最高而不是取"整串"，
  // 是因为整串里混着作者名和年份，会把真文献压到 0.5 以下。
  const scoreOf = (t) => {
    let best = 0
    for (const g of guesses) best = Math.max(best, titleSimilarity(g, t))
    return best
  }
  const primary = guesses.length ? guesses.reduce((a, b) => (a.split(/\s+/).length >= b.split(/\s+/).length ? a : b)) : ''

  const cands = []
  if (doi) {
    const r = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    if (r.json?.message) {
      const w = r.json.message
      const t = (w.title || [])[0] || ''
      cands.push({
        title: t,
        authors: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
        year: w.issued?.['date-parts']?.[0]?.[0] ?? null,
        venue: (w['container-title'] || [])[0] || null,
        doi: w.DOI,
        url: w.URL,
        score: guesses.length ? scoreOf(t) : 1,
        source: 'crossref(doi)',
        doi_ok: true,
      })
    } else {
      // DOI 在 Crossref 查不到：可能是 arXiv DOI 或注册在别处，仍继续按标题查
      cands.push({ title: '', score: 0, source: 'crossref(doi)', missing_doi: doi })
    }
  }

  if (raw || primary) {
    // Crossref 的 bibliographic 查询天生能啃"作者+年份+标题"的乱串，所以直接喂整串；
    // arXiv 的布尔检索没法处理作者名，喂最长的那个候选标题。
    const [cr, ax] = await Promise.all([searchCrossref(raw || primary, { limit: 6, email }), searchArxiv(primary || raw, { limit: 6 })])
    for (const r of cr.results) cands.push({ title: r.title, authors: r.authors, year: r.year, venue: r.venue, doi: r.doi, url: r.url, oa_url: r.oa_url, score: scoreOf(r.title), source: 'crossref' })
    for (const r of ax.results) cands.push({ title: r.title, authors: r.authors, year: r.year, venue: r.venue, doi: r.doi, arxiv_id: r.arxiv_id, url: r.url, oa_url: r.oa_url, score: scoreOf(r.title), source: 'arxiv' })
  }

  // 同一篇被两个源返回时只留最高分那条，但记住另一源也证实了它
  const uniq = []
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    if (!c.title) {
      uniq.push(c)
      continue
    }
    const hit = uniq.find((u) => u.title && titleSimilarity(u.title, c.title) > 0.95)
    if (hit) {
      hit.also_in = [...new Set([...(hit.also_in || [hit.source]), c.source])]
      continue
    }
    uniq.push({ ...c, also_in: [c.source] })
  }

  const best = uniq[0]
  if (!best || best.score === 0) {
    return { verdict: 'not_found', score: 0, query_title: primary, reason: 'Crossref 与 arXiv 都没有匹配到。这条引用可能不存在、或转引时标题被改写。', candidates: uniq.slice(0, 3) }
  }

  // 年份/作者一致性检查（引用里带了才查，避免误杀）
  const yearNum = Number(year) || Number((raw.match(/\b(19|20)\d{2}\b/) || [])[0]) || null
  const flags = []
  if (yearNum && best.year && Math.abs(best.year - yearNum) > 1) flags.push(`年份不符：引用写 ${yearNum}，实际 ${best.year}`)
  if (authors && best.authors?.length) {
    const a = String(authors).toLowerCase().split(/[\s,;]+/).filter((x) => x.length > 2)
    const b = best.authors.join(' ').toLowerCase()
    if (a.length && !a.some((x) => b.includes(x))) flags.push(`作者不符：引用写 ${authors}，实际 ${best.authors.slice(0, 3).join(', ')}`)
  }

  const verdict = best.score >= 0.9 ? (flags.length ? 'verified_with_flags' : 'verified') : best.score >= 0.75 ? 'probable' : 'not_found'
  return {
    verdict,
    score: Number(best.score.toFixed(3)),
    query_title: primary,
    best,
    flags,
    candidates: uniq.slice(0, 5),
    note:
      verdict === 'verified'
        ? '标题高度吻合，可以当作真实文献使用。'
        : verdict === 'probable'
          ? '标题近似但不完全一致，引用前请人工核对卷期页码，或在正文里标注"转引"。'
          : '匹配度过低，视为未验证；不要把它写进正文。',
  }
}

// ---------------------------------------------------------------------------
// 本地归档与台账
// ---------------------------------------------------------------------------

/** 把标题变成安全的文件名。 */
export function slugify(s, max = 60) {
  return String(s || 'doc')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'doc'
}

/** 解析落地目录。 */
export function resolveDir(dir, cwd) {
  const base = dir && String(dir).trim() ? String(dir) : join(cwd || process.cwd(), 'refs')
  if (!existsSync(base)) mkdirSync(base, { recursive: true })
  return base
}

/** 追加一行台账（jsonl，只增不改）。 */
export function appendLedger(dir, entry) {
  try {
    const d = resolveDir(dir)
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
    appendFileSync(join(d, 'ledger.jsonl'), line + '\n', 'utf8')
    return { ok: true, path: join(d, 'ledger.jsonl') }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 读台账最近 N 条。 */
export function readLedger(dir, limit = 20) {
  try {
    const d = resolveDir(dir)
    const f = join(d, 'ledger.jsonl')
    if (!existsSync(f)) return { ok: true, entries: [], path: f }
    const lines = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit)
    return { ok: true, path: f, entries: lines.map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 列出已有文献文件。 */
export function listRefs(dir) {
  try {
    const d = resolveDir(dir)
    return readdirSync(d).filter((f) => !f.startsWith('.')).map((f) => ({ file: f, path: join(d, f) }))
  } catch (error) {
    return []
  }
}

/**
 * 把一次抓取的结果落盘（正文 txt + 原始 PDF），并记台账。
 * @param {object} p - {dir, title, url, buffer, text, via, meta}
 * @returns {object} 落盘路径。
 */
export function saveDocument({ dir, title, url, buffer = null, text = '', via = '', meta = {} }) {
  const d = resolveDir(dir)
  // 标题里如果带着 ".pdf"/".txt" 这类后缀，先剥掉，否则落盘会变成
  // oeis-a215365-txt.txt 这种双后缀（slugify 会把点也换成连字符）。
  const cleanTitle = String(title || basename(String(url || 'doc'))).replace(/\.(pdf|txt|html?|xml|json)$/i, '')
  const slug = slugify(cleanTitle)
  const out = { dir: d, slug, files: [] }
  try {
    if (buffer) {
      const p = join(d, `${slug}.pdf`)
      writeFileSync(p, buffer)
      out.files.push(p)
    }
    if (text) {
      const p = join(d, `${slug}.txt`)
      writeFileSync(p, text, 'utf8')
      out.files.push(p)
    }
    appendLedger(d, { action: 'fetch', title: title || slug, url, via, bytes: buffer ? buffer.length : null, chars: text ? text.length : null, ...meta })
    return { ok: true, ...out }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), ...out }
  }
}
