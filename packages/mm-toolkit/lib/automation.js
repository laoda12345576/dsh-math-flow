/**
 * Automation half of dsh-plugin-mm-toolkit: the stateful Chrome daemon, CNKI
 * literature search, and Socratic multi-session deliberation.
 *
 * The daemon (`tools/browserd.py`) is a long-lived Playwright process holding one
 * persistent Chrome profile, spoken to over a loopback JSON line protocol. Keeping
 * it out-of-process is what makes logins survive and lets multi-step flows span
 * separate tool calls.
 *
 * @module dsh-plugin-mm-toolkit/automation
 */

import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { promises as fsp } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One JSON command to the daemon; resolves to its reply. */
function daemon(port, request, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let buf = ''
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* closed */ }
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        try { finish(JSON.parse(buf.slice(0, nl))) } catch { finish({ ok: false, error: 'daemon reply was not JSON' }) }
      }
    })
    socket.on('timeout', () => finish({ ok: false, error: `daemon timed out (${timeoutMs}ms)` }))
    socket.on('error', (e) => finish({ ok: false, error: `daemon unreachable: ${e.message}`, notRunning: true }))
  })
}

const jsonRender = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]
const tail = (s, n) => (String(s ?? '').length > n ? String(s).slice(-n) : String(s ?? ''))

const DEEPSEEK = 'https://chat.deepseek.com/'
const CNKI_HOME = 'https://x.cnki.net/web/psmc/#/home'

/** Five Socratic personas; each forces a different failure mode into the open. */
const ROLES = [
  { key: 'rigor', name: '严谨性审查员', prime: '你现在只扮演数学建模的严谨性审查员。规则：\n1 不夸奖、不总结、不复述我的问题，只指出问题。\n2 只盯五类漏洞：未经证明的假设、跳步的推导、量纲不对、边界/极限未交代、收敛性与稳定性未讨论。\n3 每条写成「第X步」+「为什么站不住」+「怎么补才站得住」。\n4 确实找不出漏洞就写「这一步我认可」并说明验证了什么；禁止凑数编造。\n5 中文，400字以内。' },
  { key: 'complete', name: '完备性检查员', prime: '你现在只扮演完备性检查员。规则：\n1 不重复别人说过的内容。\n2 只找三类：被默认排除的情形、极端取值下的行为、能推翻结论的具体反例。\n3 反例必须具体到可验证（给数值或极限情形）。\n4 最后一行写：该结论在什么范围内成立、什么范围内未知。\n5 中文，400字以内。' },
  { key: 'innovate', name: '理论创新推动者', prime: '你现在只扮演理论创新推动者，目标是在现有文献与技术基础上做原创解法。规则：\n1 先点名「这个模型最可疑的一个前提」并说明为何可疑。\n2 给出至少两条「削弱或替换该前提能得到什么新模型」的路径。\n3 每条说清：新在哪里、代价是什么、如何用现有数据验证更好。\n4 不要泛泛而谈，要具体到能写成公式或算法步骤。\n5 中文，450字以内。' },
  { key: 'devil', name: '魔鬼代言人', prime: '你现在只扮演魔鬼代言人，唯一目标是推翻给定结论。规则：\n1 先一句话概括对方主张，再开始攻击。\n2 攻击限于：数据/指标选择偏差、模型与问题匹配度、参数敏感性、替代解释。\n3 每条给出「如果成立，应该怎么修正」。\n4 不和稀泥。\n5 中文，400字以内。' },
  { key: 'midwife', name: '苏格拉底助产士', prime: '你只扮演苏格拉底式助产士。规则：\n1 不得直接给出答案、方法或结论，只能提问题。\n2 每次最多问 3 个，逐步深入。\n3 每个问题必须指向一个具体环节。\n4 优先问「回答了之后会发现自己原本漏了一步」的问题。\n5 中文，只输出问题。' },
]

/** Rotating Socratic moves, one per deliberation round. */
const MOVES = [
  { name: '定义澄清', ask: '指出本轮讨论中被含糊使用但从未精确定义的 1 个概念，追问其严格定义与适用边界。' },
  { name: '反例测试', ask: '给出一个能让当前主流意见失效的具体反例（带数值或极限情形），说明它暴露了什么。' },
  { name: '假设溯源', ask: '指出一个所有人都默认接受但从未被论证的假设，追问它凭什么成立、不成立会怎样。' },
  { name: '边界推进', ask: '把某个关键参数推到极端（0、无穷、物理上限），追问结论是否仍成立。' },
  { name: '视角翻转', ask: '假设结论恰好相反，追问需要什么条件才能让它成立，由此反推被忽略的结构。' },
  { name: '收敛判定', ask: '给出可执行的判定标准：什么样的数据结果能判定这个方案是错的？' },
]

/**
 * Register the automation tools.
 * @param {object} ctx - cordis context (needs `tools`).
 * @param {Function} defineTool - the harness tool factory.
 * @param {object} cfg - resolved plugin config.
 * @returns {Promise<void>} completion.
 */
export async function registerAutomation(ctx, defineTool, cfg) {
  const PORT = cfg.daemonPort
  const BOUT = path.join(cfg.workspace, 'browse_out')
  // The daemon is a Python script that lives in `scriptsDir`, outside this
  // package. Empty config means it is absent -- resolve that to a sentence the
  // reader can act on, not to a relative path that python cannot open.
  const PY = String(cfg.pythonExe ?? '').trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const BROWSERD_DIR = String(cfg.scriptsDir ?? '').trim()
  const BROWSERD = BROWSERD_DIR ? path.join(BROWSERD_DIR, 'browserd.py') : ''
  let daemonProblem = ''

  async function bridgeMissing() {
    if (!BROWSERD_DIR) return 'browserd.py 未安装：scriptsDir 未配置（见 packages/mm-toolkit/README.md「外部桥脚本」）'
    try { await fsp.stat(BROWSERD); return '' } catch { return `browserd.py 不存在：${BROWSERD}` }
  }

  async function ensureDirs() { await fsp.mkdir(BOUT, { recursive: true }) }

  async function alive() { const p = await daemon(PORT, { cmd: 'ping' }, 8000); return p.ok === true && p.alive === true }

  async function startDaemon(headed) {
    const missing = await bridgeMissing()
    if (missing) { daemonProblem = missing; return false }
    await ensureDirs()
    const args = [BROWSERD, '--serve']
    if (headed) args.push('--headed')
    const child = spawn(PY, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: cfg.workspace })
    child.unref()
    for (let i = 0; i < 20; i++) { await sleep(1500); if (await alive()) return true }
    daemonProblem = '守护进程 30 秒内未响应 ping'
    return false
  }

  async function stopDaemon() { await daemon(PORT, { cmd: 'quit' }, 20000); return true }

  // ------------------------------------------------------------------ browser

  const AGENTS = ROLES.map((r) => ({ key: r.key, name: r.name, prime: r.prime, tab: null, started: false, lastReply: '' }))
  const DS_REPLY = "() => {\n  const els = Array.from(document.querySelectorAll('.ds-assistant-message-main-content'));\n  if (!els.length) return { n: 0, last: '' };\n  const c = els[els.length - 1].cloneNode(true);\n  c.querySelectorAll('.katex').forEach(function (k) {\n    const a = k.getElementsByTagName('annotation');\n    const t = a.length ? a[0].textContent : '';\n    const s = document.createElement('span');\n    s.textContent = t ? (' $' + t.trim() + '$ ') : (k.textContent || '');\n    k.replaceWith(s);\n  });\n  return { n: els.length, last: c.innerText };\n}"

  async function ev(js, timeoutMs = 120000) {
    const r = await daemon(PORT, { cmd: 'eval', js, max: 400000 }, timeoutMs)
    if (!r.ok) return null
    try { return JSON.parse(r.result) } catch { return null }
  }

  async function tabs() { const t = await daemon(PORT, { cmd: 'tabs' }, 30000); return (t && t.tabs) || [] }

  ctx.tools.register(defineTool({
    name: 'browser',
    description: '操作一个常驻真 Chrome（有状态、可多步）。cmd: start/stop（headed=true 出可见窗口，便于手动登录）| goto/back | text/html/links/tables/forms/imgs | eval（执行任意 JS 并返回 JSON，可调站点自身 API）| click/clicktext/fill/type/press/wait/scroll | shot/saveblob | tabs/newtab/switch/closetab | cookies | download。跨调用保持页面状态，可连续完成登录、翻页、取数等流程。',
    parameters: {
      cmd: { type: 'string', required: true, description: 'start|stop|ping|goto|back|text|html|links|tables|forms|imgs|eval|click|clicktext|fill|type|press|wait|shot|saveblob|scroll|tabs|newtab|switch|closetab|cookies|download' },
      url: { type: 'string', description: 'goto/newtab/download 的 URL' },
      selector: { type: 'string', description: 'CSS 选择器' },
      text: { type: 'string', description: 'fill/type 的文本，或 clicktext 的文字' },
      js: { type: 'string', description: 'eval 的 JavaScript' },
      path: { type: 'string', description: 'shot/saveblob 的文件名，或 download 的绝对路径' },
      index: { type: 'number', description: 'switch/closetab 的序号，或 saveblob 选第几张' },
      ms: { type: 'number', description: 'wait 毫秒' },
      max: { type: 'number', description: '返回内容上限' },
      settle: { type: 'number', description: '动作后额外等待毫秒' },
      full: { type: 'boolean', description: 'shot 是否整页' },
      headed: { type: 'boolean', description: 'start 是否显示窗口' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 900000,
    async execute(args) {
      const cmd = String(args.cmd ?? '').toLowerCase()
      if (cmd === 'start') {
        const ok = await startDaemon(args.headed === true)
        return { ok, headed: args.headed === true, port: PORT, hint: ok ? '浏览器已启动' : (daemonProblem || '启动失败') }
      }
      if (cmd === 'stop') { await stopDaemon(); return { ok: true, action: 'stop' } }
      const req = { cmd }
      for (const k of ['url', 'selector', 'text', 'js', 'index', 'ms', 'max', 'settle']) {
        if (args[k] !== undefined && args[k] !== null) req[k] = args[k]
      }
      if (args.full === true) req.full = true
      if (cmd === 'shot' || cmd === 'saveblob') {
        await ensureDirs()
        const base = String(args.path ?? `${cmd}_${Date.now()}`).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/\.png$/i, '')
        const file = path.join(BOUT, `${base}.png`)
        req.path = file
        const r = await daemon(PORT, req, 300000)
        return { ok: r.ok === true, image: r.ok ? `${base}.png` : null, absolute_path: file, bytes: r.bytes ?? null, error: r.error ?? null }
      }
      if (args.path !== undefined && args.path !== null) req.path = args.path
      return await daemon(PORT, req, 600000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_read',
    description: '一步读取一个网页：导航过去并返回标题、正文文本和链接。需要多步交互时改用 browser。',
    parameters: {
      url: { type: 'string', required: true, description: '网页地址' },
      max: { type: 'number', description: '正文最大字符数，默认 20000' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 300000,
    async execute(args) {
      const g = await daemon(PORT, { cmd: 'goto', url: args.url, settle: 1800 }, 180000)
      if (!g.ok) return { ok: false, error: g.error ?? '导航失败' }
      const t = await daemon(PORT, { cmd: 'text', max: args.max ?? 20000 }, 120000)
      const l = await daemon(PORT, { cmd: 'links', max: 40 }, 120000)
      return { ok: true, url: t.url ?? args.url, title: t.title ?? '', chars: t.chars ?? 0, text: t.text ?? '', links: l.links ?? [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_status',
    description: '查看浏览器守护进程状态：是否在线、当前页面 URL 与标题、已打开的标签页。',
    parameters: {},
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 120000,
    async execute() {
      const p = await daemon(PORT, { cmd: 'ping' }, 8000)
      if (p.ok !== true || p.alive !== true) return { alive: false, port: PORT }
      const t = await daemon(PORT, { cmd: 'tabs' }, 30000)
      return { alive: true, url: p.url ?? null, tabs: (t && t.tabs) || [], current: t && t.current }
    },
  }))

  // --------------------------------------------------------------------- cnki

  const LOGIN_STATE = "() => { const t = document.body ? document.body.innerText : ''; const form = !!document.querySelector('input.login-form__input'); const m = t.match(/知网研学用户\\d+/); return { hasForm: form, user: m ? m[0] : null, loggedIn: !form && /学习空间/.test(t) }; }"
  const CNKI_ROWS = "() => {\n  const out = [];\n  for (const tr of document.querySelectorAll('table tbody tr')) {\n    const tds = Array.from(tr.querySelectorAll('td'));\n    if (tds.length < 5) continue;\n    const a = tr.querySelector('a[href]');\n    const title = a ? (a.innerText || '').replace(/\\s+/g, ' ').trim() : '';\n    if (!title || title.length < 4) continue;\n    const c = tds.map((td) => (td.innerText || '').replace(/\\s+/g, ' ').trim());\n    const i = c.findIndex((x) => x === title);\n    const at = i >= 0 ? i : 2;\n    out.push({ title, authors: c[at + 1] || '', source: c[at + 2] || '', date: c[at + 3] || '', db: c[at + 4] || '', cited: c[at + 5] || '', downloads: c[at + 6] || '', href: a.getAttribute('href') });\n  }\n  const b = document.body ? document.body.innerText : '';\n  const m = b.match(/共找到([\\d,]+)条结果/);\n  return { rows: out, total: m ? m[1].replace(/,/g, '') : null };\n}"

  async function cnkiSearch(query, limit) {
    if (!(await alive()) && !(await startDaemon(false))) return { ok: false, error: daemonProblem || '浏览器守护进程启动失败' }
    let st = await ev(LOGIN_STATE, 60000)
    if (!st || !st.loggedIn) {
      if (!cfg.cnkiUser || !cfg.cnkiPass) {
        return {
          ok: false,
          error: '知网需要登录，但未配置凭据。请在启动 dsh 前设置环境变量 MM_CNKI_USER / MM_CNKI_PASS（不要把密码写进仓库或 patch 文件），或先用 browser 工具 start headed=true 手动登录一次，登录态会被浏览器 profile 记住。',
          loggedIn: false,
        }
      }
      await daemon(PORT, { cmd: 'goto', url: CNKI_HOME, settle: 5000 }, 180000)
      await daemon(PORT, { cmd: 'fill', selector: 'input.login-form__input[type="text"]', text: cfg.cnkiUser }, 60000)
      await daemon(PORT, { cmd: 'fill', selector: 'input.login-form__input[type="password"]', text: cfg.cnkiPass }, 60000)
      await daemon(PORT, { cmd: 'eval', js: "() => { const c = document.querySelector('input.login-form__checkbox'); if (c && !c.checked) c.click(); return 1 }" }, 60000)
      await daemon(PORT, { cmd: 'eval', js: "() => { const b = document.querySelector('button.login-btn--primary'); if (b) b.click(); return 1 }" }, 60000)
      await sleep(8000)
      st = await ev(LOGIN_STATE, 60000)
    }
    if (!st || !st.loggedIn) return { ok: false, error: '知网未登录', state: st }
    const url = `https://x.cnki.net/web/kns8/#/home?kw=${encodeURIComponent(query)}&dbCode=SCDB&korder=SU&from=search&subject=`
    await daemon(PORT, { cmd: 'goto', url, settle: 5000 }, 180000)
    let got = null
    for (let i = 0; i < 6 && got === null; i++) {
      const v = await ev(CNKI_ROWS, 120000)
      if (v && v.rows && v.rows.length) got = v
      else await sleep(3000)
    }
    if (got === null) {
      await daemon(PORT, { cmd: 'eval', js: '() => { location.reload(); return 1 }' }, 30000)
      await sleep(8000)
      for (let i = 0; i < 6 && got === null; i++) {
        const v = await ev(CNKI_ROWS, 120000)
        if (v && v.rows && v.rows.length) got = v
        else await sleep(3000)
      }
    }
    if (got === null) return { ok: false, error: '未取到检索结果', url }
    const n = Math.max(1, Math.min(Number(limit) || 20, got.rows.length))
    return { ok: true, query, user: st.user ?? null, total: got.total, count: n, items: got.rows.slice(0, n) }
  }

  ctx.tools.register(defineTool({
    name: 'cnki',
    description: '知网研学文献检索（共享浏览器守护进程的登录态，自动登录）。cmd=search 检索并返回结构化结果（题名/作者/来源/时间/数据库/被引/下载/原文链接）与命中总数；cmd=status 看登录状态。用于国赛前期调研现有方法与模型。',
    parameters: {
      cmd: { type: 'string', required: true, description: 'search|status' },
      query: { type: 'string', description: '检索词（search 用）' },
      limit: { type: 'number', description: '返回条数，默认 20' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 900000,
    async execute(args) {
      const cmd = String(args.cmd ?? '').toLowerCase()
      if (cmd === 'status') {
        if (!(await alive()) && !(await startDaemon(false))) return { ok: false, browser: false, error: daemonProblem || '浏览器守护进程启动失败' }
        const st = await ev(LOGIN_STATE, 60000)
        return { ok: true, browser: true, loggedIn: Boolean(st && st.loggedIn), user: (st && st.user) || null }
      }
      if (cmd === 'search') return await cnkiSearch(args.query, args.limit)
      return { ok: false, error: `未知 cmd: ${cmd}` }
    },
  }))

  // -------------------------------------------------------------------- think

  async function switchTo(agent) {
    const list = await tabs()
    const used = new Set(AGENTS.filter((a) => a !== agent && a.tab !== null).map((a) => a.tab))
    let target = agent.tab !== null ? list.find((x) => x.i === agent.tab && /deepseek\.com/.test(x.url)) : null
    if (!target) target = list.find((x) => /chat\.deepseek\.com/.test(x.url) && !used.has(x.i))
    if (!target) return false
    agent.tab = target.i
    await daemon(PORT, { cmd: 'switch', index: target.i }, 60000)
    return true
  }

  async function askAgent(agent, text, waitSec, cap) {
    if (!(await switchTo(agent))) return { key: agent.key, name: agent.name, ok: false, error: '会话标签页不存在，请重建' }
    const msg = agent.started ? text : `${agent.prime}\n\n---\n\n以下是需要你处理的内容：\n\n${text}`
    await daemon(PORT, { cmd: 'fill', selector: 'textarea', text: msg }, 120000)
    await daemon(PORT, { cmd: 'press', key: 'Enter', settle: 3000 }, 120000)
    agent.started = true
    let last = ''
    let stable = 0
    let reply = ''
    const rounds = Math.max(4, Math.ceil(waitSec / 5))
    for (let i = 0; i < rounds; i++) {
      await sleep(5000)
      const v = await ev(DS_REPLY, 60000)
      if (v && v.last) {
        if (v.last === last && last.length > 0) { stable += 1; if (stable >= 2) { reply = last; break } } else stable = 0
        last = v.last
      }
    }
    agent.lastReply = reply || last
    return { key: agent.key, name: agent.name, ok: Boolean(agent.lastReply), reply: tail(agent.lastReply, cap) }
  }

  async function openAgents(keys) {
    if (!(await alive()) && !(await startDaemon(false))) return { ok: false, error: daemonProblem || '浏览器守护进程启动失败' }
    const want = keys && keys.length
      ? AGENTS.filter((a) => keys.includes(a.key))
      : AGENTS.filter((a) => ['rigor', 'complete', 'innovate'].includes(a.key))
    const opened = []
    for (const a of want) {
      const nt = await daemon(PORT, { cmd: 'newtab', url: DEEPSEEK }, 180000)
      if (!nt.ok) { opened.push({ key: a.key, name: a.name, ready: false }); continue }
      await sleep(4000)
      const mine = (await tabs()).filter((x) => /chat\.deepseek\.com/.test(x.url))
      a.tab = mine.length ? mine[mine.length - 1].i : null
      a.started = false
      a.lastReply = ''
      const ok = await ev("() => ({ hasInput: !!document.querySelector('textarea') })", 60000)
      opened.push({ key: a.key, name: a.name, tab: a.tab, ready: Boolean(ok && ok.hasInput) })
    }
    const ready = opened.filter((o) => o.ready).length
    return { ok: ready > 0, ready, opened, note: ready > 0 ? `已创建 ${ready} 个会话` : '未找到 DeepSeek 输入框，请先登录 chat.deepseek.com' }
  }

  function live() { return AGENTS.filter((a) => a.tab !== null) }

  async function socratic(text, rounds, waitSec, cap) {
    const lv = live()
    if (!lv.length) return { ok: false, error: '尚无会话，请先 cmd=open' }
    const n = Math.max(1, Math.min(Number(rounds) || 2, 5))
    const transcript = []
    for (let r = 1; r <= n; r++) {
      const move = MOVES[(r - 1) % MOVES.length]
      let question = text
      if (r > 1) {
        const prev = transcript[transcript.length - 1]
        const digest = prev.replies.map((x) => `【${x.name}】\n${x.reply || '（无回复）'}`).join('\n\n')
        question = `上一轮各位提出的意见汇总如下：\n\n${digest}\n\n---\n\n现在进行第 ${r} 轮追问（本轮重点：${move.name}）。请针对以上意见回答：\n`
          + '1) 哪些你认同？认同的必须给出修正后的模型或推导（只写同意不算）；\n'
          + '2) 哪些你不认同？给出理由与具体反例；\n'
          + `3) ${move.ask}\n`
          + '4) 最后另起一行写「你认为其他人都漏掉、但同样致命的一点」，只能一条，必须具体。\n'
          + '不要重复别人已经说过的内容。'
      }
      const replies = []
      for (const a of lv) replies.push(await askAgent(a, question, waitSec, cap))
      transcript.push({ round: r, move: move.name, replies })
    }
    return { ok: true, transcript }
  }

  async function diverge(text, waitSec, cap) {
    const lv = live()
    if (!lv.length) return { ok: false, error: '尚无会话，请先 cmd=open' }
    const ideas = []
    for (let i = 0; i < lv.length; i++) {
      const prompt = `你是第 ${i + 1} 号方案提出者。请独立给出一种解决下述问题的思路，要求：\n`
        + '1. 不要给最常规或教科书式的做法，给出一个与众不同但有理论依据的建模路径；\n'
        + '2. 说清楚它的核心机制、相比常规做法的优势、以及最大的风险；\n'
        + '3. 给出可验证的判据（用什么数据、看什么指标、预期优于基线多少）。\n\n问题：\n' + text
      ideas.push(await askAgent(lv[i], prompt, waitSec, cap))
    }
    return { ok: true, ideas }
  }

  ctx.tools.register(defineTool({
    name: 'think',
    description: '苏格拉底式多重思辨：为每个角色开一个独立 DeepSeek 网页会话（严谨性审查员/完备性检查员/理论创新推动者/魔鬼代言人/苏格拉底助产士）。cmd=roles 看角色；cmd=open 创建会话（roles 可选）；cmd=socratic 逐轮追问（每轮把上一轮全部意见汇总后广播回去，认同者必须给出修正模型、不认同者给反例、并指出别人漏掉的一点）；cmd=diverge 让各会话独立给出互不相同的思路；cmd=round 单次广播；cmd=ask 只问某角色；cmd=status/close。需先在浏览器登录 chat.deepseek.com。',
    parameters: {
      cmd: { type: 'string', required: true, description: 'roles|open|socratic|diverge|round|ask|status|close' },
      text: { type: 'string', description: '要审阅的问题/模型/方案' },
      rounds: { type: 'number', description: 'socratic 轮数，默认 2，最大 5' },
      role: { type: 'string', description: '角色键 rigor|complete|innovate|devil|midwife' },
      roles: { type: 'string', description: 'open 时创建哪些角色，逗号分隔' },
      wait_sec: { type: 'number', description: '每个会话等待回复的最长秒数，默认 180' },
      max_chars: { type: 'number', description: '每条回复截断长度，默认 2500' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 3600000,
    async execute(args) {
      const cmd = String(args.cmd ?? '').toLowerCase()
      const waitSec = Math.max(30, Math.min(Number(args.wait_sec) || 180, 900))
      const cap = Math.max(400, Math.min(Number(args.max_chars) || 2500, 9000))
      if (cmd === 'roles') return { ok: true, roles: ROLES.map((r) => ({ key: r.key, name: r.name })), moves: MOVES.map((m) => m.name) }
      if (cmd === 'open') {
        const keys = args.roles ? String(args.roles).split(',').map((s) => s.trim()).filter(Boolean) : null
        return await openAgents(keys)
      }
      if (cmd === 'status') return { ok: true, agents: AGENTS.map((a) => ({ key: a.key, name: a.name, tab: a.tab, started: a.started })) }
      if (cmd === 'close') {
        const list = await tabs()
        const used = new Set(AGENTS.filter((a) => a.tab !== null).map((a) => a.tab))
        let closed = 0
        for (const t of list.filter((x) => used.has(x.i) && /chat\.deepseek\.com/.test(x.url)).reverse()) {
          const r = await daemon(PORT, { cmd: 'closetab', index: t.i }, 60000)
          if (r.ok) closed += 1
        }
        for (const a of AGENTS) { a.tab = null; a.started = false }
        return { ok: true, closed }
      }
      if (cmd === 'socratic') {
        if (!args.text) return { ok: false, error: 'socratic 需要 text' }
        return await socratic(String(args.text), args.rounds, waitSec, cap)
      }
      if (cmd === 'diverge') {
        if (!args.text) return { ok: false, error: 'diverge 需要 text' }
        return await diverge(String(args.text), waitSec, cap)
      }
      if (cmd === 'round') {
        const lv = live()
        if (!lv.length) return { ok: false, error: '尚无会话，请先 cmd=open' }
        if (!args.text) return { ok: false, error: 'round 需要 text' }
        const replies = []
        for (const a of lv) replies.push(await askAgent(a, String(args.text), waitSec, cap))
        return { ok: true, replies }
      }
      if (cmd === 'ask') {
        const a = AGENTS.find((x) => x.key === args.role)
        if (!a) return { ok: false, error: '未知 role' }
        if (a.tab === null) return { ok: false, error: '该角色尚未创建' }
        if (!args.text) return { ok: false, error: 'ask 需要 text' }
        return await askAgent(a, String(args.text), waitSec, cap)
      }
      return { ok: false, error: `未知 cmd: ${cmd}` }
    },
  }))
}

/** Exported for unit tests / CLI reuse. */
export { daemon, ROLES }
