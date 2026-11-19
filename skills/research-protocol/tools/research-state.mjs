// 研究状态表：把"目标"从散文里搬进结构里。
//
// 为什么要有这个文件 —— 三个实测出来的病，同一个根：
//
// 1. **目标漂移**（Arike et al. 2025, arXiv:2505.02709）：所有模型都会漂，且漂移与
//    上下文变长后"模式匹配倾向上升"相关。我们这边更糟：目标只写在任务书开头两段和
//    handoff 的摘要里，而摘要的本职是压缩——压缩必然先丢"长期不变的背景"，保留
//    "当前要做的"。于是第 3 轮的目标自动退化成"m 的取值范围"。漂移在这里是结构性的。
//
// 2. **噪声淹没**（Liu et al. 2023 arXiv:2307.03172；Chroma *Context Rot* 2025）：
//    纯长度增加平均掉约 8%，中段信息最易被漏。上一轮 handoff 14.5k token 里，
//    目标是开头两段，其余全是结论堆叠——结论越多，目标占比越低，漂移随轮数单调加重。
//
// 3. **失败不留痕**：台账只收"判过的"，于是"这条路试过、断在第 3 步"全部丢失，
//    下一轮重走同一个死胡同（|Sel₂|=2 三轮重推就是这么来的）。
//
// 解法（Kosmos 的做法，Edison Scientific 2025）：**结构化世界模型**，不是摘要。
// 目标逐字冻结、四张表（已知/待判/死路/阻塞）、每轮只注入切片。
//
// 这个工具做三件事：
//   A. 校验 state.json 与台账/notes 一致——"已知"必须有 PASS 且等级够，
//      "死路"必须有 notes 记录。防止状态表变成第二本自说自话的账。
//   B. 算两个可比的数：**距离**（success_criteria 里还剩几条）与 **surprise**（整轮信息量）。
//   C. 输出给下一轮的结构化切片（--slice），替代全量 handoff。
//
// 用法：
//   node tools/research-state.mjs --dir runs/team8 --goal runs/team8/goal.md
//   node tools/research-state.mjs --dir runs/team8 --slice
//   node tools/research-state.mjs --dir runs/team8 --json

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAB = path.resolve(HERE, '..')

const LEVEL_RANK = { X: -1, '?': -0.5, U: 0, S: 1, E: 2, L: 2, D: 3, P: 4 }
const READABLE = 1 // 至少 S 级才算"已知"

const readIf = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

// ── 解析 goal.md ────────────────────────────────────────────
//
// 刻意不用 YAML：目标这几栏是写给人看、也要逐字搬进下一轮提示词的，
// 用 markdown 能让"逐字"这件事不被序列化改坏。
//
// 格式：
//   # 目标
//   ## 问题
//   （一句话，必须是一句话。逐字注入下一轮，禁止改写。）
//   ## 成功判据
//   - [ ] G1 ...
//   - [x] G2 ...
//   ## 明显不做
//   - ...
//   ## 为什么难
//   （一段）
export function parseGoal(md) {
  const out = { question: '', criteria: [], not_goal: [], why_hard: '', raw: md }
  if (!md) return out
  const section = (name) => {
    // 收尾锚点用 (?![\s\S]) 而不是 \Z：JS 正则没有 \Z，它会被当成字面量 Z，
    // 于是「最后一节」永远解析不出来——goal.md 若以「## 预算」结尾，预算读数会静默变 null。
    //
    // 标题后面允许跟任意后缀（`[^\n]*`），因为要认「## 成功判据（达成任一即可）」这种写法。
    // 实测踩过：标题带括号时 `\s*$` 不匹配，整节读成空——而 criteriaAny 仍然为 true，
    // 于是"判据是析取"和"哪几条判据"同时成立但互相矛盾，终止门拿着空判据表跑。
    const re = new RegExp(`^##\\s*${name}[^\\n]*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm')
    const m = md.match(re)
    return m ? m[1].trim() : ''
  }
  out.question = section('问题')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? ''

  // 「## 成功判据（达成任一即可）」= 析取模式。为什么需要它：
  // 原来的判据是合取，而 G1 是「给出决定性结论」——CTZ 2025 明写 r≥4 的情形
  // 「we lack methods」，所以那条判据在当前数学下不可达。合取 + 不可达 = 每一轮
  // 注定 0 条成果，13 轮下来的真实账就是 0 条新定理。
  // 析取模式把"关掉一格"变成合法成功；代价是必须配一条转移下限，否则
  // "一条就够了"会变成新的偷懒形状。
  const critHead = (md.match(/^##\s*成功判据([^\n]*)$/m) || [])[1] || ''
  out.criteriaAny = /任一|\bany\b/i.test(critHead)

  for (const line of section('成功判据').split('\n')) {
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(\S+)\s+(.*)$/)
    if (m) out.criteria.push({ done: m[1].toLowerCase() === 'x', id: m[2], text: m[3].trim() })
  }
  for (const line of section('明显不做').split('\n')) {
    const m = line.match(/^\s*-\s*(.+)$/)
    if (m) out.not_goal.push(m[1].trim())
  }
  out.why_hard = section('为什么难')
  return out
}

// ── 读账 ───────────────────────────────────────────────────
function readJsonl(p) {
  return readIf(p)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// 台账可以落在 run 目录，也可以落在它的**祖先**目录——这不是设计，是实测出来的 bug：
// team14 的两条 dead_end 写进了 runs/team14/.claim-verify，同一轮的 blocking_claim 与
// qualified conjecture 却写进了 lab 根目录的 .claim-verify（插件用 `args.dir || cwd()`
// 解析台账根，而 cwd 由调用方决定，同一轮里会变）。
// 后果不是"记录丢了"，是**判据错判**：检查器只读 run 目录，于是把真登记读成"没登记"，
// 反过来，往任何父目录写也能绕过检查。判据不能依赖"记录恰好在哪一层"。
//
// 所以：
//   ① 向上找 3 层内的 .claim-verify，合并（不向下找：成员的私账不该算进本轮）；
//   ② 用 t0 过滤——祖先目录里有别的轮次的记录，不过滤就会拿 team13 的猜想当 team14 的；
//   ③ 没有时间戳的一律保留（宁放过不误判，与 transferStatus 同一口径）；
//   ④ 把来源报出来：散落本身要能被看见，否则同一个洞会以另一种形状再出现。
const ledgerRoots = (dir) => {
  const out = []
  let d = path.resolve(dir)
  for (let i = 0; i < 4; i += 1) {
    out.push(path.join(d, '.claim-verify'))
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

export function loadRun(dir, opts = {}) {
  // 默认按本轮起点过滤：祖先目录里躺着别的轮次的记录（lab 根的 notes 里同时有
  // team13 的 CJ-kummer-abelian 和 team14 的猜想），不过滤就会把上一轮的猜想
  // 算成这一轮的成果。显式传 since:null 才关掉过滤（回放台要全量时用）。
  const anchor = timeAnchor(dir)
  const since =
    opts.since === null ? null : Number.isFinite(opts.since) ? opts.since : (anchor.t0 ?? null)
  // ── 合并的边界：下界挡上一轮，上界挡下一轮，但**只对外来的记录生效** ──
  //
  // 下界（since = t0）挡的是"上一轮的记录被认领成本轮的"。
  // 上界挡的是**下一轮**：散落的记录都落在同一个祖先目录（工作区根的 .claim-verify），
  // 于是审计 team8 时会把 team16 那份（ts 更新）一起读进来，条数/判死数/转移数全部虚高。
  //
  // 但上界**不能用在 run 目录自己身上**。审计的主要工作对象就是已经收尾的轮次，
  // 而"改写一条已收尾轮次的账，再问审计抓不抓得住"正是反向测试的做法——
  // 那些改写的记录 ts 一定晚于 report.md。上界一律生效的话，
  // 三条反向用例同时失守（未判定 / 第二实现 / 存疑），表现是"判据被改坏了"，
  // 而实际是审计对自己目录里的账失去了视力。
  //
  // 所以：自己的账无条件认；外来的账才用 [t0, t1] 夹。
  // 上界另外两个前提：这一轮已经收尾（有 report/state），且 t1 不早于 t0
  // （早于 t0 说明是续接：报告先落盘、之后重开会话，准备文件被 touch 到新时刻）。
  const closed =
    fs.existsSync(path.join(dir, 'report.md')) || fs.existsSync(path.join(dir, 'state.json'))
  const until = since === null || !closed || anchor.t1 === null || anchor.t1 < since ? null : anchor.t1
  const self = path.resolve(dir, '.claim-verify')
  // 没有 t0 就不知道这一轮从哪开始——这时候把父目录的记录认领成自己的，
  // 会把很久以前别的轮次的 schema-4 记录读成"本轮有协议"，于是旧轮次
  // 本该 SKIP 的三态判定变成 FAIL。宁可不合并。
  const roots = since === null && opts.since !== null ? [self] : ledgerRoots(dir)
  const inWindow = (r, isSelf) => {
    if (since === null) return true
    const ts = Date.parse(r?.ts ?? '')
    // 容差 1 秒，不是随手加的余量：t0 来自 fs 的 mtime（带小数毫秒，如 1793975591827.9143），
    // 而记录时间来自 `new Date().toISOString()`（整秒，如 1793975591000）。
    // 于是**与准备文件同一秒内写入的记录会被判成"开工之前"而丢掉**——
    // 短一轮（几秒钟的夹具、或者一开工就登记 blocking 的）会表现为
    // "记了但读不到"，而且看起来像模型没记账。
    // 反向测试就是这么抓到的：夹具全对，终止门却报"没有 notes 记录"。
    if (Number.isNaN(ts)) return true
    if (ts < since - 1000) return false
    if (!isSelf && until !== null && ts > until + 1000) return false
    return true
  }
  const keep = (r) => inWindow(r, true)
  const claims = []
  const rawNotes = []
  const sources = []
  for (const root of roots) {
    const isSelf = path.resolve(root) === self
    const keepHere = (r) => inWindow(r, isSelf)
    const c = readJsonl(path.join(root, 'claims.jsonl')).filter(keepHere)
    const n = readJsonl(path.join(root, 'notes.jsonl')).filter(keepHere)
    if (c.length || n.length) {
      sources.push({ root, claims: c.length, notes: n.length, self: isSelf })
    }
    claims.push(...c)
    for (const r of n) rawNotes.push({ r, self: isSelf })
  }
  // 同一条记录可能被写了两遍（team14 的两条 dead_end 就同时落在 run 目录与 lab 根）：
  // 不去重会让"判死 2 条路"读成 4 条，也就是把散落变成成果。
  //
  // 去重时的优先级不是随便定的：**本轮自己目录里的那份优先**，祖先目录只补缺。
  // 原来是无条件后者覆盖前者，而 roots 是从内往外的——于是 lab 根里那份**旧的**
  // BC-global（schema 4）会盖掉本轮刚写的 schema 5 那条，表现是
  // "明明补了字段，判的时候还是说没有"。这类错很难看出来：
  // 两处都"有记录"，只是拿错了那一份。
  // 同源之内按时间取最新（同一 id 重判过就该用新版本）。
  const dedupe = new Map()
  for (const { r, self: isSelf } of rawNotes) {
    const key = `${r.record_type ?? ''}::${r.id ?? r.hash}`
    const prev = dedupe.get(key)
    if (!prev) {
      dedupe.set(key, { r, self: isSelf })
      continue
    }
    if (isSelf && !prev.self) {
      dedupe.set(key, { r, self: isSelf })
    } else if (isSelf === prev.self && (Date.parse(r.ts ?? '') || 0) >= (Date.parse(prev.r.ts ?? '') || 0)) {
      dedupe.set(key, { r, self: isSelf })
    }
  }
  const notes = [...dedupe.values()].map((x) => x.r)
  const outside = sources.filter((s) => !s.self)
  const stateRaw = readIf(path.join(dir, 'state.json'))
  let state = null
  let stateError = null
  if (stateRaw) {
    try {
      state = JSON.parse(stateRaw)
    } catch (e) {
      stateError = `state.json 不是合法 JSON：${e.message}`
    }
  }
  return { dir, claims, notes, state, stateError, hasState: Boolean(stateRaw), sources, outside }
}

// 每条 id 只认最后一次：重判留痕不算两条违规（与 run-audit 口径一致）。
const latestById = (rows) => {
  const m = new Map()
  for (const r of rows) m.set(r.id ?? r.hash, r)
  return [...m.values()]
}

const levelOf = (r) => (r.invalidated ? 'X' : (r.epi?.level ?? 'U'))

// ── 阻塞不是"我不干了"的另一种说法 ───────────────────────────
//
// 15 轮实测：**"我判断这条路走不通"是最便宜的一句收工话术**，
// 而它比"想出下一步"便宜一个数量级。team15 的 BC-global 就是这样收的：
// 内容是"单素数 p-adic 障碍只有 p=3 那一条"——那是一条**结论**，
// 被登记成 blocking，于是 43/120 分钟就合法收工了。
//
// 这不是模型在撒谎（那句话本身它验过），是**出口的结构问题**：
// 只要"列一条 blocking + 有记录"能换到"可以收工"，这个出口就永远会被用，
// 因为它是所有合法出口里最便宜的那个。
//
// 机制设计的通行解法不是把门造得更高，而是让这个出口的**成本 ≥ 继续工作的成本**：
// 走 blocking 收工，要交出一份"我真的走到这一步并失败了"的记录。
// 于是它与"再做一步"成本相当，模型就没有理由优先选它。
//
// 三条硬要求（都能机器核）：
//   ① 不能是结论：同一 id 本轮还登记成 dead_end 的，不算阻塞；
//   ② 要有失败的尝试：`attempt` 里那条命令必须能在 run.log 里找到——
//      "我试了，失败在这里"，而不是"我判断走不通"；
//   ③ needs 点名的重型工具必须真的不在 PATH 上——说"缺 Sage"而 Sage 装着，
//      这一关根本没缺东西。
//
// 依据：ImpossibleBench（arXiv 2510.20270）发现**给模型一个合法的"做不到"出口**
// 反而把作弊率从 54% 降到 9%——所以出口本身要留，但它的语义必须是"卡住"，
// 不能是"这一层做完了"。satisficing（Simon）说的是同一件事的另一半：
// 一旦停止规则是个门槛，被优化的就是门槛本身，而不是原来的目标。

const HEAVY_TOOLS = ['sage', 'magma', 'gp', 'pari', 'gap', 'singular', 'M2', 'maple', 'wolframscript', 'matlab', 'cocalc']

// 从哪一版台账开始，blocking 要带 attempt 才能换收工。
// 用 schema 而不是时间戳：记录自己说了它按哪一版规则写，
// 于是"新尺子判旧轮次"在结构上不可能发生——旧记录是 schema 4，永远跳过。
const BLOCKING_GATE_SCHEMA = 5

function onPath(bin) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    for (const e of exts) {
      try {
        if (fs.existsSync(path.join(d, bin + e))) return path.join(d, bin + e)
      } catch {
        /* PATH 里有非法项是常态 */
      }
    }
  }
  return null
}

/** 归一化命令文本：run.log 里带着时间戳/前缀，逐字比对必然失败。 */
const normCmd = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s>]*\$?\s*/, '')
    .trim()

export function blockingGate({ blocking = [], notes = [], dir = null }) {
  const byId = new Map()
  for (const n of notes) if (n.record_type === 'blocking_claim') byId.set(n.id, n)
  const deadIds = new Set(notes.filter((n) => n.record_type === 'dead_end').map((n) => n.id))

  // 新尺子不能追溯判旧轮次。
  //
  // team1–15 的 blocking 记录是 schema 4，那时 `attempt` 这个字段还不存在。
  // 拿今天的规则去判它们，等于把"字段缺失"读成"当时在偷懒"，
  // 和"拿余额故障当行为证据"是同一类错。
  // 旧记录按旧规则（列了 blocking 且有记录即可），并在 detail 里写明为什么跳过。
  const legacy = blocking.filter((id) => {
    const r = byId.get(id)
    return !r || Number(r.schema ?? 0) < BLOCKING_GATE_SCHEMA
  })
  if (blocking.length && legacy.length === blocking.length) {
    return {
      ok: true,
      skipped: true,
      items: [],
      detail: `${blocking.length} 条 blocking 都是 schema<${BLOCKING_GATE_SCHEMA} 时写的（那时还没有 attempt 这一栏）——按旧规则判，不追溯`,
    }
  }

  let log = ''
  const logPath = dir ? path.join(dir, 'run.log') : null
  const hasLog = Boolean(logPath && fs.existsSync(logPath))
  if (hasLog) {
    try {
      log = fs.readFileSync(logPath, 'utf8')
    } catch {
      /* 读不到就按"没有日志"处理，下面会说 */
    }
  }
  const logNorm = hasLog ? normCmd(log) : ''

  const items = blocking.map((id) => {
    const rec = byId.get(id)
    if (!rec) return { id, ok: false, why: 'notes 里没有这条 blocking_claim 记录' }
    if (Number(rec.schema ?? 0) < BLOCKING_GATE_SCHEMA) {
      return { id, ok: true, why: `旧版记录（schema ${rec.schema ?? '?'}），按旧规则不追溯` }
    }
    if (deadIds.has(id)) {
      return {
        id,
        ok: false,
        why: '同一条同时登记成 dead_end——那是**结论**，不是阻塞。结论要记转移，不能拿来换收工',
      }
    }
    const attempt = normCmd(rec.attempt)
    if (!attempt) {
      return {
        id,
        ok: false,
        why:
          '没有 `attempt`（真跑过、且失败的那条命令）——现在的 blocking 只证明你**判断**了，' +
          '不证明你**走到**了那一步。补一条跑过的失败命令，或者把它改写成 dead_end 然后继续往下做',
      }
    }
    if (hasLog && attempt && !logNorm.includes(attempt.slice(0, Math.min(80, attempt.length)))) {
      return {
        id,
        ok: false,
        why: `attempt 里的命令在 run.log 里找不到（「${attempt.slice(0, 60)}」）——换成本轮真跑过的那一条`,
      }
    }
    const needs = String(rec.needs ?? '')
    const hit = HEAVY_TOOLS.find((t) => new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`, 'i').test(needs))
    if (hit) {
      const where = onPath(hit)
      if (where) {
        return {
          id,
          ok: false,
          why: `needs 说缺 ${hit}，但它在 PATH 里（${where}）——这一关不缺工具，缺的是用它`,
        }
      }
    }
    return { id, ok: true, why: hasLog ? '有失败的尝试，且点名的资源确实缺' : '有失败的尝试（本轮没有 run.log，无法核对命令出处）' }
  })

  const bad = items.filter((i) => !i.ok)
  return {
    ok: blocking.length > 0 && bad.length === 0,
    items,
    attempts: items.length - bad.length,
    detail: !blocking.length
      ? '没有列出 blocking'
      : bad.length
        ? `blocking ${blocking.length} 条，${bad.length} 条不成立：` +
          bad.map((b) => `${b.id}（${b.why}）`).join('；')
        : `blocking ${blocking.length} 条，每一条都有失败的尝试，且点名的资源确实缺`,
  }
}


/**
 * 校验状态表：这是整个改动的关键一步。
 *
 * 状态表如果只由模型自述，它就会变成"第二本自说自话的账"——比没有更糟，
 * 因为它看起来像结构。所以每一栏都必须能对回台账：
 *   known     → claims 里必须有一条 pass=true 且等级 ≥ S；hash 必须对得上
 *   dead_ends → notes 里必须有一条 record_type=dead_end 的同名记录
 *   blocking  → notes 里必须有一条 record_type=blocking_claim
 * 对不上的，一律 FAIL，不给"部分采纳"。
 */
export function validate(state, claims, notes) {
  const problems = []
  const warns = []
  if (!state) return { problems: ['没有 state.json：这一轮没有留下结构化状态'], warns }

  const latest = latestById(claims)
  const byHash = new Map(latest.map((r) => [r.hash, r]))
  const noteIds = new Set(notes.map((n) => n.id))

  // known
  for (const k of state.known ?? []) {
    const rec = byHash.get(k.hash) ?? latest.find((r) => r.id === k.id)
    if (!rec) {
      problems.push(`known「${k.id}」在台账里查无此人（hash=${String(k.hash).slice(0, 12)}）——状态表不能凭空宣布已知`)
      continue
    }
    if (rec.pass !== true) {
      problems.push(`known「${k.id}」在台账里 pass=${rec.pass}，不是已确立的结论`)
      continue
    }
    const lv = levelOf(rec)
    if ((LEVEL_RANK[lv] ?? 0) < READABLE) {
      problems.push(`known「${k.id}」等级是 ${lv}，低于 S——U/S 以下只能当线索，不能进"已知"`)
    }
    if (k.hash && rec.hash && k.hash !== rec.hash) {
      problems.push(`known「${k.id}」记的 hash 与台账不符（表 ${k.hash.slice(0, 8)} / 账 ${rec.hash.slice(0, 8)}）`)
    }
  }

  // dead_ends / blocking
  for (const [field, want] of [
    ['dead_ends', 'dead_end'],
    ['blocking', 'blocking_claim'],
  ]) {
    for (const id of state[field] ?? []) {
      if (!noteIds.has(id)) {
        problems.push(`${field}「${id}」在 notes.jsonl 里没有对应记录——死路和阻塞必须当场写下，不能事后补一句`)
        continue
      }
      const n = notes.filter((x) => x.id === id).pop()
      if (n.record_type !== want) {
        problems.push(`${field}「${id}」的记录类型是 ${n.record_type}，不是 ${want}`)
      }
    }
  }

  // criteria 对账
  const crit = state.criteria ?? {}
  for (const c of state.criteriaDone ?? []) {
    const rec = latest.find((r) => r.id === c.id || r.hash === c.hash)
    if (!rec || rec.pass !== true) problems.push(`成功判据「${c.id}」标为已完成，但台账里没有对应的 PASS`)
  }
  if (!crit || Object.keys(crit).length === 0) {
    warns.push('state.json 没有 criteria 字段：无法判断距离目标还有多远')
  }

  // 距离与已知数量的一致性（粗检，防手填一个好看的数）
  if (typeof state.distance === 'number' && state.criteria) {
    const total = Object.keys(state.criteria).length
    const done = Object.values(state.criteria).filter((v) => v?.status === 'done').length
    if (total > 0) {
      const implied = 1 - done / total
      if (Math.abs(implied - state.distance) > 0.26) {
        warns.push(
          `distance=${state.distance} 与 criteria 推算出的 ${implied.toFixed(2)} 差得多（已完成 ${done}/${total}）——` +
            '距离是估计值，但不能和成功判据打架',
        )
      }
    }
  }

  return { problems, warns }
}

// ── 猜想 ───────────────────────────────────────────────────
//
// 为什么猜想需要一条质量判据，而不是"写了就算"：
//
// 13 轮的实测是 3 条 conjecture，全部躺在 notes.jsonl 里没人捡。team13 那条
// `CJ-kummer-abelian`（从 16/8 结点数随 (2|p) 跳变，反推 S3=Kum(E1×E2)、
// 8 个结点在 Q(√2) 上、G1 等价于"A(Q) 里是否存在使 g∘π 为平方的点"）是真东西：
// 有依据、有下一步。但成功判据只有「给出决定性结论」，于是它 = 0 分。
//
// 反过来，一旦"猜想算成果"，最省力的作弊就是写一句话：
//   「猜想：这个问题应该和某个 K3 有关。」
// 所以门槛必须落在"能不能被判死"上，而不是"写得好不好"：
//
//   falsifiable_by  什么观察/计算能推翻它（要能真跑，不是"理论上"）
//   missing_step    IT 和定理之间唯一缺的那一步（只能写一步，写多了等于没定位）
//   next_test       下一轮第一条命令/第一个脚本是什么
//
// 三条都填 = 下一轮可以派活去证或去推翻 = 这是成果。
// 缺一条 = 下一轮没法从它开始 = 这是叹息。
const CONJ_MIN = { statement: 20, falsifiable_by: 12, missing_step: 8, next_test: 8 }

// next_test 里点名的脚本必须真的在盘上。
//
// 这条不是为了加难度，是为了让"三栏齐"这个词有意义：三栏齐的定义是
// 「下一轮能照这条命令直接开跑」。team14 登记了三条：其中两条指向
// `captain/lambda_fiber.py`、`captain/slice_modp_ext.py`，这两个文件从头到尾不存在——
// 三栏在字面上齐了，在**可执行**上是空的。而"下一轮照它开跑"正是它被算作成果的唯一理由。
//
// 只查脚本类后缀：next_test 也可以是一条自然语言步骤（"用 PARI 算 ellrank"），
// 那不是断链，是环境缺工具，已经在 notes 的 needs 里说过了。
const SCRIPT_RE = /\.(py|mjs|js|cjs|sh|sage|gp|lean|pl|r)$/i
export function scriptTargets(cmd) {
  return String(cmd ?? '')
    .split(/[\s'"`,;|&()]+/)
    .filter((t) => SCRIPT_RE.test(t))
}
export function missingTargets(cmd, base) {
  return scriptTargets(cmd).filter((t) => {
    const p = path.isAbsolute(t) ? t : path.resolve(base ?? process.cwd(), t)
    return !fs.existsSync(p)
  })
}

export function conjectureStatus(notes, goal, dir) {
  const latest = new Map()
  for (const n of notes) if (n.record_type === 'conjecture') latest.set(n.id, n)
  const all = [...latest.values()]
  const probe = String(goal?.question ?? '').slice(0, 24)
  const qualified = []
  const weak = []
  for (const n of all) {
    const missing = []
    for (const [k, min] of Object.entries(CONJ_MIN)) {
      if (String(n[k] ?? '').trim().length < min) missing.push(k)
    }
    // 三栏有字不等于三栏可用：next_test 点名的脚本不存在，这条猜想就没有入口，
    // 下一轮拿到它仍然要从"从哪下手"重新想一遍。
    const gone = missingTargets(n.next_test, dir)
    if (gone.length) missing.push(`next_test 指向不存在的脚本（${gone.join(', ')}）`)
    // 把原问题复述一遍不是猜想。这条抓的是"换了说法的问题重述"——
    // team12 已经踩过一次：它写的反证条件等价于原问题，自己没发现。
    if (probe && String(n.statement ?? '').includes(probe)) missing.push('restates_goal')
    if (missing.length) weak.push({ id: n.id, missing })
    else qualified.push(n)
  }
  return {
    total: all.length,
    qualified,
    weak,
    ok: qualified.length > 0,
    detail: all.length
      ? `猜想 ${all.length} 条，可判 ${qualified.length} 条` +
        (weak.length ? `；不合格：${weak.map((w) => `${w.id}（缺 ${w.missing.join('/')}）`).join(', ')}` : '')
      : '没有登记任何猜想',
  }
}

/**
 * 待办清账：`state.json` 的 `open` 每条必须带 `next_test`。
 *
 * N-35 的教训是"初始 open 必须留空"（否则等于把方向塞给它）。但收工时的 open
 * 是另一件事：它是这一轮真的看见、真的没做完的东西。team13 留了 3 条，写得很好，
 * 但都是散文——下一轮拿到它，仍然要从"B± 的 j-不变量"重新想一遍从哪下手。
 *
 * 所以要求不是"清空"，是"每条带一条能直接跑的命令/脚本"。这不是免责声明，
 * 是下一轮的入口。写不出 next_test 的待办，下一轮大概率不存在。
 */
export function openStatus(state, dir) {
  const open = state?.open ?? []
  if (!Array.isArray(open)) return { ok: false, total: 0, bad: ['open 不是数组'], broken: [], detail: 'open 不是数组' }
  if (!open.length) return { ok: true, total: 0, bad: [], broken: [], detail: 'open 是空的（没有留待办）' }
  const bad = []
  const broken = []
  for (const [i, o] of open.entries()) {
    if (typeof o === 'string') bad.push(`#${i + 1}（字符串，没有 next_test）`)
    else if (String(o?.next_test ?? '').trim().length < 8) bad.push(`${o?.id ?? `#${i + 1}`}（缺 next_test）`)
    else {
      const gone = missingTargets(o.next_test, dir)
      if (gone.length) broken.push(`${o?.id ?? `#${i + 1}`} → ${gone.map((g) => path.basename(g)).join('/')}`)
    }
  }
  // 断链只报不判：待办是"下一轮入口"，指针断了要看见，但这一轮的研究结论并没有因此失效。
  // 猜想的 next_test 断链是硬判（见 conjectureStatus）——那里的三栏是"算成果"的凭据本身。
  const brokenNote = broken.length ? `；${broken.length} 条 next_test 指向不存在的脚本：${broken.join('、')}（下一轮照它跑会失败）` : ''
  return {
    ok: bad.length === 0,
    total: open.length,
    bad,
    broken,
    detail: bad.length
      ? `open ${open.length} 条，${bad.length} 条没有下一步：${bad.join(', ')}——下一轮从这条开始不了，等于没留`
      : `open ${open.length} 条，每条都带 next_test${brokenNote}`,
  }
}

// ── 终止 ───────────────────────────────────────────────────
//
// 终止资格：收工只有两条路，没有第三条。
//   ① 成功判据达成（合取 = 全部；析取 = 任一），且每条都能对回台账的 PASS
//      或一条**合格的**猜想（不合格的猜想不算达成，差一点就是没达成）；
//   ② 明确列出 blocking，每条都有 notes 记录，**且通过 blockingGate**：
//      不是结论（不重复登记成 dead_end）、有真跑过且失败的命令、点名的资源确实缺。
//
// ② 的门槛在 2026-11-06 抬过一次。原来只要求"列了 blocking 且有记录"，
// 于是它成了所有合法出口里最便宜的那个——15 轮里每一轮都有人用它收工，
// 而团队自己也知道那是"卡住"不是"做完"。见 blockingGate 上面的注释。
//
// 规则只写一份，terminate-check 与 run-audit 都调它——同一判据写两遍就会漂，
// 而我们会先相信看起来更严的那一份。

export function terminationStatus({ goal, state, claims, notes, dir }) {
  const crit = state?.criteria ?? {}
  const ids = (goal?.criteria ?? []).map((c) => c.id)
  const latest = latestById(claims)
  const conj = conjectureStatus(notes, goal, dir)
  const conjIds = new Set([...conj.qualified, ...conj.weak].map((n) => n.id))
  const doneIds = ids.filter((id) => crit[id]?.status === 'done')
  const doneBacked = doneIds.filter((id) => {
    const c = crit[id]
    // 猜想支撑的判据：c.note 指向一条合格的 conjecture。
    // 指向不合格的猜想 = 没达成，不是"差不多"。
    //
    // 但 `note` 只有在**确实是猜想 id** 时才走这条路。team14 的 G2 写了
    // `note: "子族 d₁=c 全无解；但该子族与 team10 未形式化的 w=±1 是同一个切片…"`
    // ——那是对结果的自我评价，不是指针。原来只要 note 非空就短路进猜想分支，
    // 于是一条 hash 对得上的判据被读成"没达成"。判据读错字段，比没有字段更糟：
    // 它会给出一个看起来精确的 0。
    // 指针可能写在 note，也可能写在 hash（team14 的 G3 就是 hash:"CJ-converse-modp"）。
    // 两个字段都认，但只认"确实是台账里的猜想 id"——否则 comment 式的说明会被当成指针。
    const ptr = [c?.note, c?.hash].find((v) => v && conjIds.has(v))
    if (ptr) return conj.qualified.some((n) => n.id === ptr)
    const h = c?.hash
    const rec = latest.find((r) => (h && r.hash === h) || r.id === id)
    return rec && rec.pass === true
  })
  const blocking = state?.blocking ?? []
  const backed = blocking.filter((id) => notes.some((n) => n.id === id && n.record_type === 'blocking_claim'))

  if (!ids.length) {
    return { ok: false, done: 0, total: 0, blocking: blocking.length, detail: 'goal.md 没有「## 成功判据」——没有判据就没有"完成"，收工只能是宣布' }
  }
  const allDone = doneBacked.length === ids.length
  const anyDone = goal?.criteriaAny === true && doneBacked.length >= 1
  // 被降级的判据要留一句原因：否则"3 条标了 done，判出 1 条"读起来像算错了。
  const dropped = doneIds.filter((id) => !doneBacked.includes(id))
  const dropWhy = dropped.length
    ? `；${dropped
        .map((id) => {
          const c = crit[id]
          const ptr = [c?.note, c?.hash].find((v) => v && [...conj.qualified, ...conj.weak].some((n) => n.id === v))
          const w = ptr ? conj.weak.find((x) => x.id === ptr) : null
          if (w) return `${id} 标记 done，但支撑它的猜想 ${w.id} 不合格（${w.missing.join('/')}），按未达成算`
          return `${id} 标记 done，但台账里找不到对应的 PASS（hash ${c?.hash ?? '缺失'}）`
        })
        .join('；')}`
    : ''
  if (allDone || anyDone) {
    return {
      ok: true,
      done: doneBacked.length,
      total: ids.length,
      blocking: blocking.length,
      mode: allDone ? 'all' : 'any',
      detail: allDone
        ? `成功判据 ${ids.length}/${ids.length} 全部达成，且每条都对回了台账的 PASS`
        : `判据是析取（任一即可）：${doneBacked.length}/${ids.length} 达成（${doneBacked.join(', ')}）。` +
          `剩下的没关，但按本轮约定这一格已经关了——注意这只是"合法收工"，不等于"做够了"，转移下限仍要过` +
          dropWhy,
    }
  }
  if (blocking.length > 0 && backed.length === blocking.length) {
    const gate = blockingGate({ blocking, notes, dir })
    if (!gate.ok) {
      return {
        ok: false,
        done: doneBacked.length,
        total: ids.length,
        blocking: blocking.length,
        blockingGate: gate,
        detail:
          `判据达成 ${doneBacked.length}/${ids.length}，列了 ${blocking.length} 条 blocking，` +
          `但其中 ${gate.items.filter((i) => !i.ok).length} 条不成立：${gate.detail}${dropWhy}`,
      }
    }
    return {
      ok: true,
      done: doneBacked.length,
      total: ids.length,
      blocking: blocking.length,
      blockingGate: gate,
      detail: gate.skipped
        ? `判据达成 ${doneBacked.length}/${ids.length}，列了 ${blocking.length} 条 blocking 且都有记录——${gate.detail}`
        : `判据达成 ${doneBacked.length}/${ids.length}，但列了 ${blocking.length} 条 blocking 且都有记录、都有失败的尝试——这是"卡住"不是"做完"，允许收工，下一轮必须先攻 blocking${dropWhy}`,
    }
  }
  if (blocking.length > 0) {
    const missing = blocking.filter((id) => !backed.includes(id))
    return { ok: false, done: doneBacked.length, total: ids.length, blocking: blocking.length, detail: `有 ${blocking.length} 条 blocking，其中 ${missing.length} 条没有 notes 记录：${missing.join(', ')}` }
  }
  return {
    ok: false,
    done: doneBacked.length,
    total: ids.length,
    blocking: 0,
    detail: `成功判据只达成 ${doneBacked.length}/${ids.length}，也没列 blocking。这就是"阶段性成果就停工"：既没做完，也没说清缺什么。二选一，不许第三种。`,
  }
}

/**
 * 时间锚点：这一轮的起点与终点，全部来自文件 mtime，不来自任何自述。
 *
 *   起点 t0 = 准备文件（goal.md / state.init.json / patch.yml）里最新的 mtime ≈ 启动时刻
 *   终点 t1 = 这一轮最后落盘的东西（report.md / state.json）的 mtime
 *
 * t1 不取 now：否则事后审计一次，读数就变成"已用一万分钟"，早收工这件事反而消失。
 * 三条判据（预算用量 / 自述时间 / 转移）共用这一份锚点——各算各的就会出现
 * "时钟说 22 分钟、审计说 5 分钟"这种自己跟自己打架的局面。
 */
export function timeAnchor(dir, now = Date.now()) {
  const prep = ['goal.md', 'state.init.json', 'patch.yml']
    .map((f) => path.join(dir, f))
    .filter((p) => fs.existsSync(p))
  const done = ['report.md', 'state.json']
    .map((f) => path.join(dir, f))
    .filter((p) => fs.existsSync(p))
  const t0 = prep.length ? Math.max(...prep.map((p) => fs.statSync(p).mtimeMs)) : null
  const t1 = done.length ? Math.max(...done.map((p) => fs.statSync(p).mtimeMs)) : now
  return { t0, t1, elapsedMin: t0 === null ? null : Math.max(0, (t1 - t0) / 60000) }
}

/**
 * 中断：这一轮**是不是根本没跑完**。
 *
 * 为什么要单独分清：team12 在 11 分钟时被 `QUOTA: Insufficient Balance` 掐断，
 * 没有 report.md、没有 state.json。终止门按原规则判出四项 FAIL，其中一项写着
 * 「这就是"阶段性成果就停工"」——**误判了病因**。
 *
 * 这两件事在测量上完全不同：
 *   · 提前收工  = 模型的决策，正是研究层要治的病；
 *   · 进程被杀  = 基础设施的故障，模型没有机会做决定。
 * 混在一起，就会把"余额用完的那一轮"记成"模型不愿意干"，然后拿它当证据去改协议。
 *
 * 判据只用能够机器确认的东西：没有 report.md（没走到收尾）+ run.log 末尾有致命标记。
 * 没有致命标记却也没报告 = 真·没写报告，仍然算 FAIL，不给它开脱。
 */
const FATAL = /(QUOTA:|Insufficient Balance|rate.?limit|ECONNRESET|ETIMEDOUT|socket hang up|ENOMEM|out of memory)/i

export function abortStatus(dir) {
  const reportPath = path.join(dir, 'report.md')
  const logPath = path.join(dir, 'run.log')
  const tailOf = (n) => {
    if (!fs.existsSync(logPath)) return []
    return fs.readFileSync(logPath, 'utf8').slice(-40000).split('\n').filter((l) => l.trim())
  }
  if (fs.existsSync(reportPath)) {
    // 报告在，不等于跑完了：team14 的 report.md 24 KB 落盘、state.json 也在，
    // 但进程在"唤醒队长收尾"那一步被 QUOTA 掐断，§9 只剩一句"见下方原文粘贴"。
    // 这不是中断（有东西可判），也不能当"完整收尾"——单独记一栏，免得把
    // 一份缺尾巴的报告当成模型自己写完的。
    const lines = tailOf()
    const last = lines.length ? lines[lines.length - 1].trim() : ''
    return {
      aborted: false,
      started: true,
      fatal: null,
      lateFatal: FATAL.test(last) ? last : null,
      reason: null,
    }
  }
  // 目录建好但还没启动：这不是"中断"，是"还没开始"。
  // 原来这里报 aborted:true，调用方靠 `aborted && fatal` 兜住才没出事——
  // 但那是运气：任何一个只读 aborted 的新调用方都会把空目录判成中断。
  if (!fs.existsSync(logPath)) return { aborted: false, started: false, fatal: null, lateFatal: null, reason: '目录里还没有跑过的痕迹（run.log 不存在）' }
  const lines = tailOf().filter((l) => FATAL.test(l))
  const fatal = lines.length ? lines[lines.length - 1].trim() : null
  return {
    aborted: fatal !== null,
    started: true,
    fatal,
    lateFatal: null,
    reason: fatal
      ? `进程在收尾前被基础设施掐断（不是模型决定收工）`
      : '没有 report.md，但那不是致命错误——这一轮跑完了却没写报告',
  }
}

/**
 * 预算用量：**只报读数，不作判据**。
 *
 * 上一版是判据（"走 blocking 收工时要求真用掉预算的一半"）。它有效果，但方向错了：
 *   ① 时长是最容易被"填"的资源。AgentTime（arXiv:2610.09944）在 158 个可判读的 run 里
 *      找到 14 个"看起来做完之后主动 sleep 把时间凑满"；team11 则是把没发生的时段写进报告。
 *   ② 阈值一旦可读，下限就变成目标。实测日志：「t0 = 23:10, need 30 min → 23:40 …
 *      So I must keep working until ~23:40」——它规划的是"越过 23:40"，不是"推进问题"。
 *   ③ On the Clock（arXiv:2610.10833）把问题拆成 adherence 与 productive use：
 *      adherence 用 harness 就能解决（per-action clock，把 161% 压回 on-budget 且质量不掉），
 *      productive use 才是难的。判"有没有用够时间"恰好是最容易做、也最容易被填的一半。
 * 所以时长降级为信息，压力交给 transferStatus（这一轮到底动没动）。
 */
export function budgetStatus(dir, goal, now = Date.now()) {
  const sec = ((goal?.raw ?? '').match(/^##\s*预算\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m) || [])[1] || ''
  const m = sec.match(/(\d+)\s*(?:分钟|min)/i)
  const budgetMin = m ? Number(m[1]) : null
  const { t0, t1, elapsedMin } = timeAnchor(dir, now)
  if (budgetMin === null || t0 === null) {
    return { applicable: false, usedMin: 0, budgetMin, remaining: null, t0, t1, detail: 'goal.md 没写「## 预算」或目录里没有准备文件——这条查不了' }
  }
  const usedMin = elapsedMin ?? 0
  return {
    applicable: true,
    usedMin,
    budgetMin,
    remaining: budgetMin - usedMin,
    t0,
    t1,
    detail: `已用 ${usedMin.toFixed(0)} 分钟 / 预算 ${budgetMin} 分钟，还剩 ${(budgetMin - usedMin).toFixed(0)} 分钟（只作信息，不再当判据）`,
  }
}

/** 只认 E 级以上的结论：采样再多也只是数据变多，不是结论变了。 */
const TRANSFER_LEVEL = 2

/**
 * 转移：这一轮**到底动没动**。取代"用时够不够"的那道门。
 *
 * 为什么不用 distance 判：distance 是模型自己填的数，validate() 只能查它跟 criteria
 * 是否打架，查不出"填个好看的数"本身。所以三个登记簿都要求**产物**：
 *   ① 新确立的 E 级以上结论（台账里 pass=true 且等级够，有 hash）
 *   ② 判死的路（notes 里的 dead_end 记录）
 *   ③ 推翻/接替（带 supersedes 的判定）
 * distance 只作为读数摆出来，不参与判定。
 *
 * 时间条件：只数 t0 之后产生的记录。否则续接的一轮会把上一轮的结论算成自己的转移。
 */
export function transferStatus({ dir, claims, notes, state, goal, now = Date.now() }) {
  const { t0 } = timeAnchor(dir, now)
  const since = (r) => {
    if (t0 === null) return true
    const ts = Date.parse(String(r.ts ?? ''))
    // 没有时间戳 = 不知道是什么时候写的，不能据此把它排除掉。
    // 排除会制造假阴性方向相反的假阳性：真实做过的一轮被判成"原地不动"，
    // 而门被误判一次，人就会开始无视它。
    return Number.isFinite(ts) ? ts >= t0 - 1000 : true
  }
  const g = goal ?? parseGoal(readIf(path.join(dir, 'goal.md')))
  const latest = latestById(claims).filter(since)
  const strong = latest.filter((r) => r.pass === true && (LEVEL_RANK[levelOf(r)] ?? 0) >= TRANSFER_LEVEL)
  const killed = notes.filter((n) => n.record_type === 'dead_end').filter(since)
  const reversed = latest.filter((r) => (r.supersedes ?? []).length > 0)
  // 合格的猜想也是转移：它把"下一轮能攻什么"从零变成一。
  // 不合格的不算——否则"猜想"会退化成一句免责声明。
  const guessed = conjectureStatus(notes, g, dir).qualified.filter(since)
  const registers = []
  if (strong.length) registers.push(`新确立 ${strong.length} 条 E 级以上结论`)
  if (killed.length) registers.push(`判死 ${killed.length} 条路`)
  if (reversed.length) registers.push(`推翻/接替 ${reversed.length} 条旧结论`)
  if (guessed.length) registers.push(`提出 ${guessed.length} 条可判猜想`)

  // 转移下限：只在析取模式（判据"任一即可"）下生效。
  //
  // 析取模式把"关一格"变成合法成功，于是"关一格就走"成了新的偷懒形状：
  // 20 分钟关掉 G3，剩下 100 分钟全是账面上的。下限按预算算，取低值——
  // 它是地板不是目标。team13 在 20 分钟里产出 9 个登记项，所以 120 分钟要 3 条
  // 对真做的一轮完全不构成压力，只抓"一条就走"。
  //
  // 为什么用产物数而不是时长：上一版时长门被当成 KPI 填过（读到阈值 23:40
  // 就"做到 23:40 之后"，还写了没发生的时段）。产物数没法填——要凑够 3 条合格
  // 转移，只能真做，因为廉价枚举和空口猜想都被单独判掉了。
  const bud = budgetStatus(dir, g, now)
  const floor = g?.criteriaAny && bud.applicable ? Math.max(1, Math.ceil(bud.budgetMin / 45)) : 0
  const total = strong.length + killed.length + reversed.length + guessed.length

  const initPath = path.join(dir, 'state.init.json')
  let init = null
  if (fs.existsSync(initPath)) {
    try {
      init = JSON.parse(fs.readFileSync(initPath, 'utf8'))
    } catch {
      init = null
    }
  }
  const d0 = typeof init?.distance === 'number' ? init.distance : null
  const d1 = typeof state?.distance === 'number' ? state.distance : null
  const enough = total >= floor
  return {
    ok: registers.length > 0 && enough,
    registers,
    counts: { strong: strong.length, killed: killed.length, reversed: reversed.length, conjectures: guessed.length, total, floor },
    distance: { from: d0, to: d1 },
    detail: !registers.length
      ? '没有转移：这一轮既没有新结论、也没有判死任何路、也没有推翻旧结论、也没有提出可判猜想。' +
        '这不是"卡住"（卡住要在 notes 里写清 blocking 是哪条判据的哪一步），是原地不动——换路，或者把 blocking 写具体'
      : enough || !floor
        ? `有转移：${registers.join('，')}`
        : `有转移但不够：${registers.join('，')}，共 ${total} 条；预算 ${bud.budgetMin} 分钟要求至少 ${floor} 条。` +
          '一条就走是析取模式下的新漏洞——回去再攻一格，或者把 open 里能直接跑的那些先跑了',
  }
}

/**
 * 自述时间：报告里的时刻必须落在 [t0, t1] 内。
 *
 * 这是唯一一条"满足解就是事实"的判据：想满足它，唯一的办法是别写假时间。
 * 它抓的是 team11 那件事——报告 23:32:56 落盘，却声称"把工作一直做到 23:45 之后"，
 * 而进程 23:33:12 就结束了。声称的终点在自己的死亡之后 12 分钟。
 *
 * 三条降误报的规矩（都是被真实文本逼出来的）：
 *   · 先剥代码块与行内代码：日志引用里的时间戳不是报告的主张。
 *   · 按**小句**判，不按整行判：team11 那行前半句是"23:40:28 之后自动转 PASS"（在讲门的规则），
 *     后半句才是"我按这条把工作一直做到 23:45 之后"（在讲自己干了什么）。整行判会漏。
 *   · 只有小句里出现"做了什么"的动词，才把未来时刻算成违规；否则只列为"提及"（可能是阈值、预算、引文）。
 *
 * 已知局限：模型可以学着避开这些动词。所以它是绊线，不是主门——主门是 transferStatus。
 */
const WORK_VERB = /(做到|工作到|写到|核到|算到|完成|落盘|这段时间|之后我|之后又|一直|跑完|改完|已经跑)/
const FUTURE_MARK = /(预算|截止|deadline|预计|计划|还剩|之前|阈值|自动转|PASS|UTC|时区)/

export function narrativeClock(dir, report, now = Date.now()) {
  const { t0, t1, elapsedMin } = timeAnchor(dir, now)
  if (t0 === null || !report) {
    return { ok: true, applicable: false, violations: [], mentions: [], detail: '没有准备文件或没有报告——这条查不了' }
  }
  const body = String(report).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const d0 = new Date(t0)
  const t0Min = d0.getHours() * 60 + d0.getMinutes() // 按本机时区取当天分钟数，别硬编码时区
  const span = elapsedMin ?? 0
  const violations = []
  const mentions = []

  for (const seg of body.split(/[。；;！？\n()（）]/)) {
    const text = seg.trim()
    if (!text) continue
    for (const m of text.matchAll(/(^|[^\w:.])(\d{1,2}):(\d{2})(?::(\d{2}))?/g)) {
      const h = Number(m[2])
      const mi = Number(m[3])
      if (h > 23 || mi > 59) continue
      const at = h * 60 + mi
      // 跨零点：取离 t0 最近的那一次
      let diff = ((at - t0Min + 720 + 1440) % 1440) - 720
      if (diff >= -2 && diff <= span + 2) continue // 落在窗口内
      const item = { time: m[2] + ':' + m[3] + (m[4] ? ':' + m[4] : ''), diffMin: Math.round(diff), text: text.slice(0, 80) }
      if (diff > span + 2 && WORK_VERB.test(text) && !FUTURE_MARK.test(text)) violations.push(item)
      else mentions.push(item)
    }
  }
  const when = new Date(t0).toLocaleString('zh-CN', { hour12: false })
  return {
    ok: violations.length === 0,
    applicable: true,
    violations,
    mentions,
    detail: violations.length
      ? `报告里有 ${violations.length} 处时刻晚于本轮最后落盘时间（${new Date(t1).toLocaleString('zh-CN', { hour12: false })}，` +
        `开工 ${when}）：${violations.slice(0, 3).map((v) => `${v.time}「${v.text.replace(/^[\s*]+/, '').slice(0, 34)}」`).join('、')}` +
        '——那段时间没有发生'
      : `报告里的时刻都落在本轮区间内（开工 ${when}，跨度 ${(span / 60).toFixed(1)} 小时）` +
        (mentions.length ? `；另有 ${mentions.length} 处区间外时刻，读作引文/阈值/计划` : ''),
  }
}

/** 整轮 surprise：只对填了 prediction+confidence 且有实际结果的记录算。 */
export function roundSurprise(claims) {
  const rows = latestById(claims).filter((r) => typeof r.surprise === 'number')
  if (rows.length === 0) return { n: 0, mean: null, max: null, missing: latestById(claims).length }
  const vals = rows.map((r) => r.surprise)
  return {
    n: rows.length,
    mean: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
    max: Math.max(...vals),
    missing: latestById(claims).length - rows.length,
  }
}

/** 跨轮：同一个 claim_key 的历次判定，结论相反就报出来（N-27 的检测点）。 */
export function keyLineage(dir, key, extraDirs = []) {
  const all = []
  for (const d of [dir, ...extraDirs]) {
    for (const r of loadRun(d).claims) {
      if (r.claim_key === key) all.push({ dir: path.basename(d), id: r.id, hash: r.hash, pass: r.pass, level: levelOf(r), ts: r.ts })
    }
  }
  const flips = new Set(all.map((x) => String(x.pass))).size > 1
  return { key, records: all, flipped: flips }
}

// ── 输出 ───────────────────────────────────────────────────
export function buildSlice({ goal, state, claims, notes, problems, warns, surprise }) {
  const L = []
  L.push('## 目标（逐字，禁止改写）')
  L.push('')
  L.push(`> ${goal.question || '（goal.md 缺失或未写「## 问题」）'}`)
  L.push('')
  if (goal.why_hard) {
    L.push('为什么难：' + goal.why_hard.replace(/\s+/g, ' ').slice(0, 300))
    L.push('')
  }
  if (goal.not_goal.length) {
    L.push('明确不做（越界即停）：' + goal.not_goal.join('；'))
    L.push('')
  }

  const crit = state?.criteria ?? {}
  L.push('## 成功判据（本轮只能动其中一格）')
  L.push('')
  for (const c of goal.criteria) {
    const st = crit[c.id]?.status === 'done' ? '✓' : ' '
    L.push(`- [${st}] **${c.id}** ${c.text}`)
  }
  if (!goal.criteria.length) L.push('- （goal.md 没写「## 成功判据」——这一轮无法判断是否收工）')
  L.push('')

  L.push('## 状态表')
  L.push('')
  L.push(`- 距离目标：${typeof state?.distance === 'number' ? state.distance : '（未填）'}（0=达成，1=刚起步；估计值）`)
  const known = state?.known ?? []
  L.push(`- 已知：${known.length} 条`)
  for (const k of known.slice(0, 12)) L.push(`  - \`${k.id}\` ${String(k.say ?? '').slice(0, 80)}`)
  const open = state?.open ?? []
  if (open.length) {
    // open 有两种形态：字符串（老轮次），或 {id, text, next_test} 对象（schema>=5）。
    // 直接 join 会把对象渲染成 [object Object]——team16 的三条待办就这么在交接里
    // 变成了三个 [object Object]，下一轮拿到等于没拿到。
    L.push(`- 待判（${open.length}）：`)
    for (const o of open.slice(0, 10)) {
      if (typeof o === 'string') L.push(`  - ${o}`)
      else L.push(`  - \`${o?.id ?? '?'}\` ${String(o?.text ?? '').replace(/\s+/g, ' ').slice(0, 110)}`)
    }
  }
  const des = (state?.dead_ends ?? []).map((id) => notes.find((n) => n.id === id)).filter(Boolean)
  if (des.length) {
    L.push('')
    L.push('### 死路（已经撞过的墙，不要重走）')
    L.push('')
    for (const n of des.slice(0, 8)) {
      L.push(`- **${n.id}** ${n.statement}`)
      if (n.blocked_at) L.push(`  - 断在：${n.blocked_at}`)
      if (n.needs) L.push(`  - 要过这一关需要：${n.needs}`)
    }
  }
  const blk = (state?.blocking ?? []).map((id) => notes.find((n) => n.id === id)).filter(Boolean)
  if (blk.length) {
    L.push('')
    L.push('### 阻塞（上一轮认定做不到的理由——它们是断言，不是判决，可以攻）')
    L.push('')
    for (const n of blk.slice(0, 8)) L.push(`- **${n.id}** ${n.statement}`)
  }

  L.push('')
  L.push('## 上一轮的账')
  L.push('')
  L.push(
    `- 判定 ${latestById(claims).length} 条；surprise 均值 ${
      surprise.mean === null ? '（没填 prediction，算不出——这一轮无法判断是研究还是公证）' : surprise.mean
    } ${
      surprise.mean !== null && surprise.mean < 0.3
        ? 'bit，**趋近 0：这一轮基本在确认已知**'
        : surprise.mean !== null
          ? 'bit'
          : ''
    }`,
  )
  if (warns.length) L.push(`- 状态表提醒：${warns.join('；')}`)
  if (problems.length) {
    L.push('')
    L.push('### ⚠ 状态表与台账对不上（必须先修，否则下面的东西都不可信）')
    for (const p of problems.slice(0, 8)) L.push(`- ${p}`)
  }
  return L.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const argOf = (k, d) => {
    const i = argv.indexOf(k)
    return i >= 0 ? argv[i + 1] : d
  }
  const dirArg = argOf('--dir', null)
  if (!dirArg) {
    console.error('用法: node tools/research-state.mjs --dir <run 目录> [--goal <goal.md>] [--slice|--json]')
    process.exit(2)
  }
  const dir = path.resolve(LAB, dirArg)
  const goalPath = path.resolve(LAB, argOf('--goal', path.join(dirArg, 'goal.md')))
  const goal = parseGoal(readIf(goalPath))
  const run = loadRun(dir)

  if (run.stateError) {
    console.error(run.stateError)
    process.exit(2)
  }

  const { problems, warns } = validate(run.state, run.claims, run.notes)
  const surprise = roundSurprise(run.claims)

  // 成功判据的勾选以 state.json 为准，但要用 goal.md 的文案合并展示
  const done = Object.entries(run.state?.criteria ?? {}).filter(([, v]) => v?.status === 'done').map(([k]) => k)
  const goalChecked = {
    ...goal,
    criteria: goal.criteria.map((c) => ({ ...c, done: done.includes(c.id) })),
  }

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          dir: path.relative(LAB, dir),
          goal: { question: goalChecked.question, criteria: goalChecked.criteria, not_goal: goalChecked.not_goal },
          state: run.state,
          surprise,
          problems,
          warns,
          counts: { claims: latestById(run.claims).length, notes: run.notes.length },
        },
        null,
        2,
      ),
    )
  } else if (argv.includes('--slice')) {
    console.log(
      buildSlice({
        goal: goalChecked,
        state: run.state,
        claims: run.claims,
        notes: run.notes,
        problems,
        warns,
        surprise,
      }),
    )
  } else {
    console.log(`目标： ${goalChecked.question || '（未写）'}`)
    console.log(`成功判据 ${goalChecked.criteria.length} 条，已完成 ${goalChecked.criteria.filter((c) => c.done).length}`)
    for (const c of goalChecked.criteria) console.log(`  [${c.done ? 'x' : ' '}] ${c.id} ${c.text}`)
    console.log(`\n已知 ${(run.state?.known ?? []).length} / 待判 ${(run.state?.open ?? []).length} / 死路 ${(run.state?.dead_ends ?? []).length} / 阻塞 ${(run.state?.blocking ?? []).length}`)
    console.log(`距离 ${run.state?.distance ?? '（未填）'}`)
    console.log(
      `surprise：${
        surprise.n === 0
          ? '0 条可算（没填 prediction/confidence）'
          : `均值 ${surprise.mean} bit（${surprise.n} 条，${surprise.missing} 条没填）`
      }`,
    )
    if (warns.length) console.log(`\n提醒：\n  - ${warns.join('\n  - ')}`)
    if (problems.length) {
      console.log(`\n✗ 状态表与台账对不上（${problems.length} 处）：`)
      for (const p of problems) console.log(`  - ${p}`)
      process.exit(1)
    }
    console.log('\n✓ 状态表与台账一致')
  }

  if (problems.length && !argv.includes('--slice')) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
