/**
 * dsh-plugin-claim-verify — 把一条判据变成一次函数调用。
 *
 * 解决的问题：把"核对一个数字对不对"做成一个 agent，是在用最贵的方式做最机械的事。
 * team4 里 `check` 角色活了 103 秒、0 条回执——不是它笨，是这件事根本不该是一个 agent：
 * 它要读上下文、理解任务、写脚本、执行、回报，五步里任何一步都能断。
 *
 * 而它真正的失败方式更难看：复核期间判据被改写并重新编号，checker 验的 C3/C4
 * 和报告里的 C3/C4 根本不是同一件事。所以这里除了"快"，还要做第二件事——
 * **用 hash 把判据钉住**：同一条断言永远是同一个 hash，改了就是新记录，
 * 历史记录不覆盖。这样"边验边改"会留下痕迹，而不是消失。
 *
 * 与生成分离的硬约束：脚本只许产生数据（每行一个 JSON 对象），
 * `pass` 由 judge.py 在另一个进程里按事先声明的规则给出。脚本碰不到结论。
 *
 * @module dsh-plugin-claim-verify
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveDefineTool } from './toolkit.js'
import {
  epiGate,
  checkCoverage,
  computeLevels,
  statementMismatch,
  readSelfReportedCoverage,
  expandSpace,
  CLAIM_TYPES,
  EVIDENCE_KINDS,
} from './epistemic.js'
import { auditLean, ALLOWED_AXIOMS } from './lean.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const JUDGE = path.join(HERE, 'judge.py')

export const name = 'claim-verify'

export const inject = ['tools']

const DEFAULTS = {
  // Empty means "resolve `python` from PATH". Set explicitly only if you need a
  // specific interpreter; nothing here assumes an Anaconda install.
  pythonExe: '',
  timeoutMs: 120000,
  stateDir: '.claim-verify',
  // Lean：判定必须真跑内核，所以这两个路径要能在无 elan 的 PATH 下也找到。
  leanExe: 'lean',
  lakeExe: 'lake',
  projectDir: '',
  leanTimeoutMs: 240000,
}

// 台账 schema 版本。每加一个字段就 +1，并让消费方按版本解释：
// 旧记录里"字段缺失"的意思是"那时还没这个机制"，不是 false（N-28）。
// 没有版本号时，每加一个字段，全部历史记录的解释就要重算一次，而没人记得发生过。
export const SCHEMA_VERSION = 5
// 5：notes 的 blocking_claim 新增 `attempt`（本轮真跑过且失败的命令）。
//    收工门按 schema 分流——4 及以前的 blocking 没有这一栏，判的时候跳过，
//    否则"新加一栏"就会变成"历史全轮作废"。

const round2 = (x) => Math.round(x * 100) / 100

/**
 * 惊喜度 = −log2(实际发生的概率)。
 *
 * prediction=hold、confidence=0.9、结果 PASS → p=0.9  → 0.15 bit（意料之中）
 * prediction=hold、confidence=0.9、结果 FAIL → p=0.1  → 3.32 bit（很意外）
 * prediction=refute、confidence=0.6、结果 FAIL → p=0.6 → 0.74 bit
 *
 * 为什么用信息量而不是"猜对/猜错"：猜对一次 99% 有把握的事，几乎不提供信息；
 * 猜对一次 55% 的事，才是在学东西。整轮 surprise 趋近 0 = 这轮只在公证。
 */
export function surpriseOf(confidence, matched) {
  if (!Number.isFinite(confidence)) return null
  if (confidence < 0 || confidence > 1) return null
  const c = Math.min(1 - 1e-6, Math.max(1e-6, confidence))
  return round2(-Math.log2(matched ? c : 1 - c))
}

/**
 * 研究层字段：三个台账写入点（lean / coverage_incomplete / python 主路径）都要过这里。
 *
 * 只在一个出口加字段的教训我们已经吃过一次（N-18：expected 只写了主路径，
 * 被判 coverage 不全的那条记录仍然是个没有通过标准的数字）。
 */
function researchFields(args, pass) {
  const out = { schema: SCHEMA_VERSION }

  const ck = String(args?.claim_key ?? '').trim()
  if (ck) out.claim_key = ck

  const sup = String(args?.supersedes ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (sup.length) out.supersedes = sup

  const pred = String(args?.prediction ?? '').trim()
  if (pred === 'hold' || pred === 'refute') {
    out.prediction = pred
    const conf = Number(args?.confidence)
    if (Number.isFinite(conf) && conf >= 0 && conf <= 1) {
      out.confidence = conf
      // pass=null（disputed / blocked）没有"实际结果"，算不出惊喜，也不该算。
      if (typeof pass === 'boolean') out.surprise = surpriseOf(conf, (pred === 'hold') === pass)
    }
    const detail = String(args?.prediction_detail ?? '').trim()
    if (detail) out.prediction_detail = detail
  }
  return out
}

/**
 * 允许被脚本 import 的模块。
 *
 * 白名单而不是黑名单：禁止 `open` 这种写法很容易被 `__builtins__['open']`
 * 绕过去，而"只能 import 这些"没有绕法。脚本要做的事是算数，算数不需要
 * 文件系统和网络。
 */
const ALLOWED_IMPORTS = new Set([
  'math',
  'json',
  'sys',
  'itertools',
  'fractions',
  'decimal',
  'collections',
  'random',
  'string',
  'typing',
  'dataclasses',
  'functools',
  'operator',
  'heapq',
  'bisect',
  'statistics',
  'time',
])

const BANNED_TOKENS = [
  '__import__',
  'open(',
  'exec(',
  'eval(',
  'subprocess',
  'socket',
  'requests',
  'urllib',
  'shutil',
  'os.system',
  'os.popen',
  'os.remove',
  'os.rmdir',
  'pathlib',
  'claims.jsonl',
]

/**
 * Reject a script that could forge evidence or reach outside its sandbox.
 *
 * This is not a security boundary — a determined script can still lie about
 * numbers. It removes the cheap cheats (writing to the ledger, importing a
 * shell, opening the filesystem) so that faking a result requires faking data
 * that refute can then sample.
 *
 * @param {string} code - the Python source.
 * @returns {string|null} reason to reject, or null when acceptable.
 */
export function inspectCode(code) {
  for (const token of BANNED_TOKENS) {
    if (code.includes(token)) return `脚本里出现了禁止的调用：${token}`
  }
  const importRe = /^\s*(?:from\s+([A-Za-z_][\w.]*)|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm
  let match
  while ((match = importRe.exec(code)) !== null) {
    const group = match[1] ?? match[2] ?? ''
    for (const raw of group.split(',')) {
      const mod = raw.trim().split(/\s+as\s+/)[0].split('.')[0]
      if (mod && !ALLOWED_IMPORTS.has(mod)) {
        return `不允许 import ${mod}（只允许纯计算模块：${[...ALLOWED_IMPORTS].join(', ')}）`
      }
    }
  }
  return null
}

/** Freeze a claim's identity: same wording → same hash, any edit → new record. */
export function claimHash(assertion) {
  return crypto.createHash('sha256').update(String(assertion ?? ''), 'utf8').digest('hex').slice(0, 12)
}

/**
 * 判定脚本的指纹。
 *
 * 只有 assertion 的 hash 是不够的：team5 那一轮 `A-C4` 出现两次，同一个 claim_hash、
 * 同一个脚本文件名，先 17 行判 FAIL、后 16 行判 PASS——脚本被原地改写了，台账里
 * 两行并存却看不出改了什么。断言没动、结论翻了，这正是最需要留痕的情况。
 * 所以把"跑的那段代码"和"判的那条规则"也各钉一个 hash。
 */
export function scriptSha(code) {
  return crypto.createHash('sha256').update(String(code ?? ''), 'utf8').digest('hex').slice(0, 12)
}

export function judgeSha(kind, predicate, value) {
  return claimHash(JSON.stringify({ kind: kind ?? '', predicate: predicate ?? '', value: value ?? '' }))
}

/**
 * Run a child process to completion, capturing stdout and stderr separately.
 *
 * Written by hand rather than with execFile because a runaway enumeration must
 * be killable at the deadline, and because stdout is capped: a script that
 * prints millions of lines would otherwise eat the caller's context before the
 * judge ever sees it.
 */
function runCapture(exe, args, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(exe, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = 4_000_000

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 200_000) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut, elapsedMs: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, elapsedMs: Date.now() - started })
    })
  })
}

/** 数一数脚本产出了多少条 JSON 行（覆盖对账失败时也要给行数，别只给结论）。 */
function countRows(stdout) {
  let n = 0
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    try {
      const row = JSON.parse(t)
      if (row && typeof row === 'object') n += 1
    } catch {
      /* 脏行不算 */
    }
  }
  return n
}

export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const py = cfg.pythonExe && cfg.pythonExe.trim() ? cfg.pythonExe : 'python'
  const { defineTool } = await resolveDefineTool()

  const stateRoot = (dir) => path.resolve(dir || process.cwd(), cfg.stateDir)

  ctx.effect(() => {
    ctx.logger?.info?.(`claim-verify 已就绪；解释器=${py}`)
  })

  ctx.tools.register(
    defineTool({
    name: 'verify_claim',
    description:
      '把一条判据变成一次可复现的判定：跑你给的 Python 脚本，按你事先声明的规则判它，用 hash 把断言钉住。' +
      '**脚本只产数据不给结论**：每行 print 一个 JSON 对象（`#` 行忽略），pass 由判定器在另一进程给出，' +
      '所以脚本里 print("PASS") 不算数。返回 pass / 证据路径 / claim_hash。' +
      '适合有限枚举、同余整除、Legendre 符号、区间扫描；需读文件或联网的判定用 shell 自己跑。' +
      '**全称/否定式断言必须声明 claim_type 与 evidence**（forall+search 会被直接拒收）；' +
      'exhaustive 要给 space + why_complete，判定器按 space 逐格对账，少一格即 FAIL。' +
      '完整规则见 skill 的「数值结果不许直接当证明」。',
    parameters: {
      id: { type: 'string', required: true, description: '判据编号，如 C3。报告里引用它时必须用同一个 hash。' },
      assertion: {
        type: 'string',
        required: true,
        description:
          '断言原文（一字不差）。hash 由它算出：改了字就是另一条判据。' +
          '带界的结论要把界写进这句话里（"在 h≤1e6 内无仿射点"），否则引用 hash 时界就丢了。',
      },
      claim_type: {
        type: 'string',
        enum: CLAIM_TYPES,
        description:
          '命题形式。forall=对任意成立；exists=存在（一次计算即可成立）；none_in=在某范围内不存在（带界的否定）；' +
          'value=精确计算出的量；approx=数值观察（不可用于任何结论）。全称/否定式断言不填会被拒收。',
      },
      evidence: {
        type: 'string',
        enum: EVIDENCE_KINDS,
        description:
          '证据种类。proof=由已有判据推出（需 premises）；exhaustive=有限论域穷尽枚举（需 space + why_complete）；' +
          'search=有限次搜索/抽样（需 scope，且只能支持 exists 或 none_in）；literature=文献（需 cite）。',
      },
      scope: {
        type: 'string',
        description: 'evidence=search 时必填：这个结论成立的范围，如 "h≤1e6 且分母≤1e4"。必须原样出现在 assertion 里。',
      },
      space: {
        type: 'string',
        description:
          'evidence=exhaustive 时必填，JSON 字符串。product 形式：' +
          '{"kind":"product","factors":[{"name":"b1","values":[1,-1,5,-5]},{"name":"b2","values":[1,-1]}]}；' +
          'range 形式：{"kind":"range","var":"p","from":2,"to":20000,"step":1}。脚本每行必须带这些字段，判定器逐格对账。',
      },
      why_complete: {
        type: 'string',
        description: 'evidence=exhaustive 时必填：为什么这个有限论域覆盖了全部情形（约化引理）。这句话会被 hash 钉住供 refute 攻。',
      },
      premises: {
        type: 'string',
        description: 'evidence=proof 时必填：被引用判据的 claim_hash，逗号分隔。本条的等级不会高于其中最弱的一条。',
      },
      lemma: { type: 'string', description: 'evidence=proof 且没有 premises 时：所用标准引理的名字（如 "2-descent 精确列"）。' },
      cite: { type: 'string', description: 'evidence=literature 时必填：作者/年份/定理号。' },
      lean_file: { type: 'string', description: 'evidence=lean 时必填：.lean 文件路径。' },
      lean_decl: { type: 'string', description: 'evidence=lean 时必填：Lean 里那条定理的名字（theorem 后面的标识符）。判定会跑 Lean 内核，不是读你的自述。' },
      statement: {
        type: 'string',
        description:
          'evidence=lean 时必填：**你要证的那条 Lean 语句原文**（如 `∀ t : ℕ, t * 1 = t`）。' +
          '它会被并进同一次编译的 #check 结果、与 assertion 并排存进台账，报告引用 P 级判据时要逐字带上。' +
          '不给的话台账里只有内核私藏的一行，读者无法判断"被证的"是不是"你说的那件事"。' +
          '注意：要写你在证的命题，不是抄 #check 输出（抄它就等于没声明，且会被判不一致）。',
      },
      project_dir: { type: 'string', description: 'Lean 项目目录（含 lakefile）。给了就走 `lake env lean`，用于 import Mathlib；不给则用裸 `lean`。' },
      code: {
        type: 'string',
        description:
          'Python 源码。负责产生数据：每行 print 一个 JSON 对象，例如 print(json.dumps({"p":p,"v":v}))。' +
          '只允许纯计算（math/json/itertools/fractions 等），不能读写文件、不能联网。' +
          'evidence=lean 时可以省略——那条分支不跑 Python。',
      },
      judge: {
        type: 'string',
        enum: ['all', 'any', 'none', 'count', 'equals'],
        description:
          'all=每一行都满足 predicate；any=至少一行满足；none=没有一行满足（用于"扫完 0 个反例"这种，' +
          '注意空数据不算通过）；count=行数等于 value；equals=整体输出等于 value。',
      },
      predicate: {
        type: 'string',
        description: 'judge=all/any/none 时必填。对每行 JSON 的 Python 表达式，字段名直接当变量用，如 `v % 2 == 0 and leg == 1`。',
      },
      value: { type: 'string', description: 'judge=count 或 equals 时必填。' },
      code2: {
        type: 'string',
        description:
          'evidence=exhaustive 时的**第二个独立实现**：换一种坐标基/算法/数据结构重写同一件事。' +
          '两份都跑、各自判，一致才算 E 级；不一致落 disputed（既不算 PASS 也不算 FAIL），必须进报告。' +
          '不给 code2 就必须给 single_impl_reason，且等级降到 S（只能当线索）——' +
          '因为判定器自己写错是常态：team6 的 D-ENUM 一次错了 4 处，全靠"换个基重写"才现形。',
      },
      single_impl_reason: {
        type: 'string',
        description:
          '不提供 code2 时的必填理由：为什么这条判据只写一遍就够（如"只数一行，没有中间量"）。' +
          '写了也仍然是 S 级，不会因为理由充分就升到 E。',
      },
      dir: { type: 'string', description: '工作目录，脚本和证据都落在这里。默认当前目录。' },
      timeout_ms: { type: 'number', description: '超时（毫秒），默认 120000。机械判定不该超过这个数。' },
      note: { type: 'string', description: '可选：这条判据在验什么、为什么通过标准是它。会原样存进台账。' },

      // ── 研究层字段（N-27 / N-28 / M1）──────────────────────────
      //
      // 前三个解决"账本是逐轮护照"：结论换一轮就换一个身份，于是推翻旧结论这件事
      // 在账本上没有任何信号。claim_key 让同一件事跨轮认得出，supersedes 让"接替"
      // 从散文变成结构。
      //
      // 第四个解决"流程里没有猜这个动作"：不要求先预测，模型就只会写它已经知道
      // 怎么判的东西——三轮 32 PASS / 0 数学否证，就是这么来的。
      claim_key: {
        type: 'string',
        description:
          '可选：这条结论的**跨轮语义键**（如 `selmer2-rank`）。同一个键在不同轮次里指的是同一件事。' +
          '留空 = 明确声明"本轮新结论，不声称与任何旧结论同源"——留空是合法的，但不要为了好看而乱填。' +
          '审计会拿同一个 claim_key 的不同轮次做对账：结论相反时判 FAIL。',
      },
      supersedes: {
        type: 'string',
        description:
          '可选：本条**接替**了哪些旧判据，填它们的 claim_hash，逗号分隔。' +
          '接替不等于断言相同——断言可以加强（如从"数出 2"加强到"并且闭合性已证"），' +
          '但被接替那条的旧判定必须在本轮报告里被交代，否则审计判 FAIL。',
      },
      prediction: {
        type: 'string',
        enum: ['hold', 'refute'],
        description:
          '**强烈建议填**：在跑脚本之前，你预计这条断言会被判真（hold）还是判假（refute）。' +
          '这是这套流程里唯一能让"我其实在猜"留下痕迹的字段。' +
          '不填不拒收，但整轮会算不出 surprise，报告里也就无法区分"研究"和"公证"。',
      },
      confidence: {
        type: 'number',
        description:
          'prediction 的置信度，0~1。和 prediction 一起用于算 surprise = −log2(实际发生的概率)：' +
          '高置信猜错、低置信猜对，都算高惊喜。全轮 surprise 趋近 0 说明这轮只在确认已知。',
      },
      prediction_detail: {
        type: 'string',
        description: '可选：具体预测（如"应该是 {1,−ε}"）。给读者看，不参与计算。',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      const assertion = String(args?.assertion ?? '').trim()
      const code = String(args?.code ?? '')
      const kind = String(args?.judge ?? 'all')
      const predicate = String(args?.predicate ?? '')
      const value = args?.value === undefined ? undefined : String(args.value)
      const isLean = String(args?.evidence ?? '').trim() === 'lean'

      // 判定条件必须进台账，且**每一条出口都要写**——包括 coverage_incomplete、
      // timeout、异常这些提前 return 的分支。只修主路径的话，被判成 coverage 不全的
      // 那条记录仍然是个没有通过标准的数字，审计读不出"它在按什么判"。
      const expectedOf = (k, pred, val) => {
        if (pred && String(pred).trim()) return `${k}: ${pred}`
        if (val !== undefined && val !== null && String(val).trim()) return `${k}: ${val}`
        return null
      }

      if (!id) return { ok: false, error: '缺少 id' }
      if (!assertion) return { ok: false, error: '缺少 assertion（判定要被 hash 钉住，不能空）' }
      if (!code.trim() && !isLean) return { ok: false, error: '缺少 code' }
      if (!isLean) {
        if (!args?.judge) {
          return { ok: false, error: '缺少 judge：非 Lean 判据必须声明判定规则（all/any/none/count/equals）' }
        }
        if (['all', 'any', 'none'].includes(kind) && !predicate.trim()) {
          return { ok: false, error: `judge=${kind} 需要 predicate` }
        }
        if (['count', 'equals'].includes(kind) && value === undefined) {
          return { ok: false, error: `judge=${kind} 需要 value` }
        }
      }

      // 证据等级闸：在跑脚本之前判，因为"该不该跑这次计算"是声明阶段的事。
      // 跑完再拒，模型已经花掉了一次计算和一个数字，那个数字会留在上下文里继续被引用。
      let spaceObj = args?.space
      if (typeof spaceObj === 'string') {
        const t = spaceObj.trim()
        if (t) {
          try {
            spaceObj = JSON.parse(t)
          } catch {
            return { ok: false, error: 'space 不是合法 JSON', hint: '例：{"kind":"range","var":"p","from":2,"to":20000,"step":1}' }
          }
        } else spaceObj = undefined
      }
      const premises = Array.isArray(args?.premises)
        ? args.premises.map((x) => String(x).trim()).filter(Boolean)
        : String(args?.premises ?? '')
            .split(/[,，\s]+/)
            .map((x) => x.trim())
            .filter(Boolean)

      const gate = epiGate({
        assertion,
        claim_type: args?.claim_type,
        evidence: args?.evidence,
        scope: args?.scope,
        space: spaceObj,
        why_complete: args?.why_complete,
        premises,
        lemma: args?.lemma,
        cite: args?.cite,
        lean_file: args?.lean_file,
        lean_decl: args?.lean_decl,
      })
      if (gate.error) {
        return { ok: false, rejected: 'epistemic_gate', error: gate.error, hint: gate.hint ?? '改断言或改证据种类，别改判据编号。' }
      }
      const epi = gate.epi ?? null

      // ── 验前闸（N-23 / N-17）─────────────────────────────────
      //
      // 这两条都在"花掉一次计算/一次编译"之前判：
      //   · Lean 缺 statement —— 判据声明阶段就该说清"要证的是哪句话"，跑完再问已经晚了；
      //   · exhaustive 既无第二实现又无理由 —— 判定器自己写错是常态（D-ENUM 一次错 4 处），
      //     单实现不该拿到 E 级，而"降级"必须在跑之前说清，否则模型会以为跑完就是 E。
      const code2 = String(args?.code2 ?? '')
      const singleImplReason = String(args?.single_impl_reason ?? '').trim()
      // Lean 的 statement 不在这里强制：判死和 blocked 的判据本来就没证成，
      // 要求它们声明"被证的语句"是多余的摩擦。只在 proven/computed 之后检查——
      // 那时才真的产生了"内核证了某句话"这个事实，才需要问"是哪句话"。
      if (epi?.evidence === 'exhaustive' && !code2.trim() && !singleImplReason) {
        return {
          ok: false,
          rejected: 'second_impl_required',
          error: 'evidence=exhaustive 既没有 code2，也没有 single_impl_reason',
          hint:
            '穷尽枚举的结论要两个独立实现互证（换坐标基/换算法/换语言），一致才给 E 级。' +
            '只写一遍就够的话，请给 single_impl_reason 说明为什么（如"只数一行，无中间量"），' +
            '但那一律只算 S 级——判定器写错一次，整条结论就是错的，而这不会自己暴露。',
        }
      }

      const rejected = inspectCode(code)
      if (rejected !== null && !isLean) {
        return { ok: false, error: rejected, hint: '判定脚本只做纯计算；要读写文件请用 shell。' }
      }

      const hash = claimHash(assertion)
      const root = stateRoot(args?.dir)
      await fsp.mkdir(root, { recursive: true })

      // N-20：文件名必须带上实现本身的 sha。
      // 原来只按 `id.hash` 命名，重判一次就把旧实现覆盖掉——台账里 script_sha 还留着
      // 旧值、文件已经不在，"当时为什么判成 1"永久失传。而这恰恰是最该复现的东西。
      const scriptId = scriptSha(code).slice(0, 8)
      const base = `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.${hash}.${scriptId}`
      const scriptPath = path.join(root, `${base}.py`)
      const outPath = path.join(root, `${base}.out.txt`)
      const specPath = path.join(root, `${base}.expect.json`)
      const ledgerPath = path.join(root, 'claims.jsonl')

      // ── Lean 判定 ───────────────────────────────────────────────
      //
      // 这条分支不跑 Python：命题是否成立由 Lean 内核回答，不由数据回答。
      // 判决失败的判据**当场落成 X（作废）**，并且台账后面所有引用它的推导
      // 都会跟着降成 X——"作废"是状态，不是报告里的一句话。
      if (epi?.evidence === 'lean') {
        const audit = await auditLean({
          file: String(args?.lean_file ?? ''),
          decl: String(args?.lean_decl ?? ''),
          projectDir: args?.project_dir ?? cfg.projectDir,
          timeoutMs: Number.isFinite(args?.timeout_ms) && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : cfg.leanTimeoutMs,
          leanExe: cfg.leanExe,
          lakeExe: cfg.lakeExe,
        })
        const proven = audit.verdict === 'proven'
        const computed = audit.verdict === 'computed'
        // computed（native_decide）= 拿计算当证明：不作废，但只能当 E 级用，
        // 且必须按 exhaustive 的规矩给 space/why_complete，否则降到 S。
        // blocked = 判决没跑成（编译环境缺、超时、工具链坏）：落 `?`，既不通过也不作废。
        // 第三档是必须的：环境抖动一次就落 X，会让整轮结论沿引用链清零，
        // 而报告读起来还像"严谨地作废了一条"。那次 QUOTA 把 t3 记成数学失败就是这么来的。
        const blocked = audit.verdict === 'blocked'

        // N-23：只有"判过了"的才需要对齐语句；判死的和没判成的，对齐也没意义。
        // 这是 P 级唯一的诚实性检查：内核保证"这条形式语句成立"，
        // 而这条检查保证"这条形式语句就是你写下来的那句话"。
        if (proven || computed) {
          const sm = statementMismatch({
            assertion,
            statement: String(args?.statement ?? ''),
            proved: audit.statement ?? '',
          })
          if (sm) {
            return {
              ok: false,
              rejected: sm.reason,
              error: 'Lean 判过了，但它证的不是你声明的那条语句',
              hint: sm.hint,
              claim_hash: hash,
              lean: { statement: audit.statement ?? null, statement_sha: audit.statement_sha ?? null },
              ledger: ledgerPath,
              note: '这条没有写进台账：判据在对齐闸门就被拒收了，重判不产生新记录也不会覆盖任何东西。',
            }
          }
        }

        const level = proven ? 'P' : computed ? (spaceObj && epi.why_complete ? 'E' : 'S') : blocked ? '?' : 'X'
        const leanPass = proven || computed ? true : blocked ? null : false
        const record = {
          id,
          hash,
          assertion,
          // blocked 落 null 而不是 false：false 在账本里读作"判过、没通过"，
          // 而这里是"没判成"。三个状态必须能区分，否则下游只能猜。
          pass: leanPass,
          kind: 'lean',
          ...researchFields(args, leanPass),
          reason: `lean_${audit.verdict}`,
          script_sha: scriptSha(''),
          judge_sha: judgeSha('lean', audit.decl, audit.statement_sha),
          epi: { ...epi, level },
          ...(blocked ? { blocked: true } : {}),
          lean: {
            file: audit.file,
            file_sha: audit.file_sha,
            decl: audit.decl,
            statement: audit.statement,
            statement_sha: audit.statement_sha,
            axioms: audit.axioms ?? [],
            verdict: audit.verdict,
            reasons: audit.reasons ?? [],
          },
          ...(audit.verdict === 'failed' ? { invalidated: true, invalidated_reason: (audit.reasons ?? []).join(',') } : {}),
          // 两者并排存：assertion 是"我想说什么"，proved_statement 是"内核实际证明了什么"。
          // 只存一个的话，读者永远分不清这两件事，而 P 级的全部意义就在这个区分上。
          statement_claimed: String(args?.statement ?? '').trim(),
          proved_statement: audit.statement ?? null,
        note: args?.note ?? '',
        elapsed_ms: audit.elapsed_ms,
        evidence: audit.file,
        ts: new Date().toISOString(),
      }
        await fsp.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')
        return {
          ok: true,
          pass: record.pass,
          claim_hash: hash,
          id,
          claim_type: epi.claim_type,
          evidence: 'lean',
          level,
          lean: record.lean,
          ...(proven ? {} : { reasons: audit.reasons ?? [] }),
          ...(computed ? { downgraded: 'native_decide 走的是编译器不是内核，只能当穷尽计算用' } : {}),
          statement_claimed: record.statement_claimed,
          proved_statement: record.proved_statement,
          evidence_path: audit.file,
          ledger: ledgerPath,
          hint: proven
            ? `P 级（只代表这一句被内核证明）：\n  ${record.proved_statement ?? '（未能取到）'}\n` +
              `报告引用 ${id} 时必须同时写出上面这一行语句，以及它的 claim_hash=${hash}。` +
              '不能写成"已证明 <assertion> 成立"——内核证的是那条形式语句，assertion 是它的自然语言说明。'
            : computed
              ? 'native_decide 通过 ≠ 证明：它引入了 native 公理。要当 E 级用就补 space + why_complete，否则只能是 S。'
              : audit.verdict === 'blocked'
                ? `判定未能执行（${(audit.reasons ?? []).join(',')}）。**blocked 不是通过**，这条判据现在不能当已证引用。`
                : `${audit.hint ?? ''}Lean 判死：${(audit.reasons ?? []).join(', ')}。按规定这条作废，引用它的推导一并作废。`,
        }
      }

      await fsp.writeFile(scriptPath, code, 'utf8')

      const timeoutMs = Number.isFinite(args?.timeout_ms) && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : cfg.timeoutMs
      const cwd = path.resolve(args?.dir || process.cwd())

      // ── 一份实现 = 跑一次 + 判一次 + 对一次覆盖 ──────────────────
      //
      // 抽成函数是为了 N-17：有两份独立实现时它要被调用两次，而这两次必须走
      // **完全相同**的判定规则，否则"两实现一致"退化成"两次判法碰巧同结论"。
      const evaluate = async (codeText, tag) => {
        const suffix = tag ? `.${tag}` : ''
        const sPath = path.join(root, `${base}${suffix}.py`)
        const oPath = path.join(root, `${base}${suffix}.out.txt`)
        const pPath = path.join(root, `${base}${suffix}.expect.json`)
        await fsp.writeFile(sPath, codeText, 'utf8')
        const r = await runCapture(py, [sPath], { timeoutMs, cwd })
        await fsp.writeFile(oPath, r.stdout, 'utf8')
        const ctx_ = { outPath: oPath, scriptPath: sPath, elapsed: r.elapsedMs, stdout: r.stdout, stderr: r.stderr }
        if (r.timedOut) return { ok: false, fatal: 'timeout', reason: `超时（${timeoutMs}ms）`, ...ctx_ }
        if (r.code !== 0) return { ok: false, fatal: 'exit', reason: `脚本退出码 ${r.code}`, ...ctx_ }

        await fsp.writeFile(
          pPath,
          JSON.stringify({ stdout_path: oPath, expect: { kind, predicate, value } }, null, 2),
          'utf8',
        )

        // 覆盖对账：声明了"穷尽 space"就必须真的走遍每一格。
        // 这一步比谓词判定更靠前，因为"值都对"和"范围都对"是两件事。
        let cover = null
        if (epi?.evidence === 'exhaustive') {
          const exp = expandSpace(spaceObj)
          const declared = Number(spaceObj?.domain_size) || (exp && !exp.error ? exp.total : null)
          if (kind === 'count') {
            // N-19：count 判的是"命中行数"，脚本本来就不该打印未命中行，
            // 所以"逐格对账"在这个组合下**结构上不可能满足** —— 唯一能过的写法
            // 是把断言改成总格数，那是工具在逼人改命题。
            // 改成自报遍历量：只打印命中行仍然正确，但"我确实走遍了这些格"由脚本自己说。
            const self = readSelfReportedCoverage(r.stdout)
            if (self?.error) return { ok: false, fatal: 'coverage', reason: self.error, ...ctx_ }
            if (!self) {
              return {
                ok: false,
                fatal: 'coverage',
                ...ctx_,
                reason: 'count 模式要求脚本自报遍历量',
                hint:
                  '在脚本末尾 print 一行（以 # 开头，判定器会跳过它）：\n' +
                  '  #@coverage {"seen": <实际遍历的格子数>}\n' +
                  `本例声明的论域是 ${declared ?? '（未知）'} 格，所以 seen 应当等于它。` +
                  '只打印命中的行是对的，但"我确实走遍了这些格"得由脚本自己说——' +
                  '否则判定器无法区分"只算了 8 格"和"算了 16 格命中 8 格"。',
              }
            }
            if (declared && self.seen !== declared) {
              return {
                ok: false,
                fatal: 'coverage',
                ...ctx_,
                reason: `自报遍历 ${self.seen} 格，与声明的 ${declared} 格不符`,
                hint: '自报值必须等于 space 的格数（或 space.domain_size）。少报说明真的没走完；多报说明 space 声明小了。',
              }
            }
            cover = { ok: true, total: declared ?? self.seen, seen: self.seen, mode: 'self-reported', grid_checked: false }
          } else {
            cover = { ...checkCoverage(r.stdout, spaceObj), mode: 'grid', grid_checked: true }
            if (!cover.ok) return { ok: false, fatal: 'coverage', cover, ...ctx_ }
          }
        }

        const judged = await runCapture(py, [JUDGE, pPath], { timeoutMs: 60000, cwd: root })
        let v
        try {
          v = JSON.parse(judged.stdout || '{}')
        } catch {
          return { ok: false, fatal: 'judge', ...ctx_, stdout: judged.stdout, stderr: judged.stderr }
        }
        return {
          ok: true,
          pass: v.pass === true,
          rows: v.rows ?? null,
          checked: v.checked ?? null,
          failures: v.failures ?? [],
          expected: v.expected ?? expectedOf(kind, predicate, value),
          note: v.note ?? '',
          sensitivity: v.sensitivity,
          cover,
          ...ctx_,
        }
      }

      const fp = { script_sha: scriptSha(code), judge_sha: judgeSha(kind, predicate, value) }
      const r1 = await evaluate(code, code2.trim() ? '1' : '')

      if (!r1.ok) {
        if (r1.fatal === 'timeout') {
          await fsp.appendFile(
            ledgerPath,
            `${JSON.stringify({ id, hash, assertion, pass: false, kind, reason: 'timeout', ...fp, ...(epi ? { epi } : {}), elapsed_ms: r1.elapsed, evidence: r1.outPath, script: r1.scriptPath, note: args?.note ?? '', ts: new Date().toISOString() })}\n`,
            'utf8',
          )
          return {
            ok: true,
            pass: false,
            reason: r1.reason,
            claim_hash: hash,
            evidence: r1.outPath,
            stderr_tail: String(r1.stderr ?? '').slice(-800),
            hint: '超时说明这不是机械判定，或者上界取得太大。缩小范围或改用更强的过滤条件。',
          }
        }
        if (r1.fatal === 'exit') {
          return {
            ok: false,
            pass: false,
            reason: r1.reason,
            claim_hash: hash,
            script: r1.scriptPath,
            evidence: r1.outPath,
            stderr_tail: String(r1.stderr ?? '').slice(-2000),
            hint: '先让脚本跑通再谈判据。stderr 在上面。',
          }
        }
        if (r1.fatal === 'coverage') {
          const c = r1.cover
          await fsp.appendFile(
            ledgerPath,
            `${JSON.stringify({ id, hash, assertion, pass: false, kind, reason: 'coverage_incomplete', ...fp, ...researchFields(args, false), epi: { ...epi, level: 'S', ...(c ? { coverage: c } : {}) }, expected: expectedOf(kind, predicate, value), rows: countRows(r1.stdout), note: args?.note ?? '', elapsed_ms: r1.elapsed, script: r1.scriptPath, evidence: r1.outPath, ts: new Date().toISOString() })}\n`,
            'utf8',
          )
          return {
            ok: true,
            pass: false,
            rejected: 'coverage_incomplete',
            claim_hash: hash,
            ...(c
              ? { declared_total: c.total, seen: c.seen, missing: c.missing, extra: c.extra, bad_rows: c.bad_rows }
              : {}),
            reason: r1.reason,
            evidence: r1.outPath,
            hint:
              r1.hint ??
              '声明的论域没有被穷尽，所以这次计算不能支持全称结论。' +
                (c?.missing?.length ? `缺这些格子：${c.missing.join(' , ')}。` : '') +
                (c?.extra?.length ? `多出这些格子（不在声明里）：${c.extra.join(' , ')}。` : '') +
                '要么补上没算的格子，要么把 space 改成真实范围并把结论降成 search。',
          }
        }
        return {
          ok: false,
          pass: false,
          reason: '判定器输出无法解析',
          claim_hash: hash,
          stdout_tail: String(r1.stdout ?? '').slice(-800),
          stderr_tail: String(r1.stderr ?? '').slice(-800),
        }
      }

      // ── 第二实现（N-17）────────────────────────────────────────
      //
      // 判定器自己写错是常态，不是意外：team6 的 D-ENUM 一次错了 4 处，全都是
      // "你以为在测 A，实际在测 B"，而 coverage 逐格对账一格都没抓到。
      // 现形靠的是**换一种坐标基重写一遍**。所以两个实现不一致时不许落 PASS 也不许落 FAIL：
      // 那不是"结论错了"，是"我们还不知道"。
      let r2 = null
      let disputed = null
      if (code2.trim()) {
        r2 = await evaluate(code2, '2')
        if (!r2.ok) {
          return {
            ok: false,
            pass: false,
            rejected: 'second_impl_failed',
            claim_hash: hash,
            reason: `第二个实现没跑通：${r2.reason}`,
            stderr_tail: String(r2.stderr ?? '').slice(-1500),
            hint:
              '两实现必须各自独立跑完，否则"互证"不成立。修好第二份再判——' +
              '不要删掉它退回单实现，那正好是这个机制要挡的事。',
          }
        }
        if (r2.pass !== r1.pass) {
          disputed = {
            impl1: { pass: r1.pass, rows: r1.rows },
            impl2: { pass: r2.pass, rows: r2.rows },
            note: '两个实现给出相反结论，至少有一个在测错东西。这条既不算 PASS 也不算 FAIL，必须先定性。',
          }
        }
      }

      const implCount = r2 ? 2 : 1
      // 等级：两实现一致才 E；单实现一律 S；分歧落 ?（与 blocked 同档，都是"还没判成"）。
      let finalLevel = epi?.level
      if (epi?.evidence === 'exhaustive') {
        finalLevel = disputed ? '?' : implCount === 2 ? 'E' : 'S'
      }
      // P0-4：判定表达式对数据不敏感（恒真式）时，PASS 携带的信息为零。
      //
      // 旧版只把等级降到 S，`pass` 仍然是 true。降级只换了标签，没改它能不能当证据：
      // 报告照样引用它、审计照样把它算进"E 级以上结论"、判据的 doneBacked 照样认它。
      // team15 的 C3-p3 正是这个形状——把所有数值扰动成 3v+7、布尔取反之后无一行翻转，
      // 它仍然进了 PASS 统计，只在事后的审计里被标了一下。
      //
      // 新版按"空判定"处理：pass = null（既不是通过也不是不通过），verdict = 'vacuous'，
      // level = 'X'（证据无效，与"被推翻"同档）。结构上就不可能被当成证据，
      // 而不是靠每个消费方都记得"看见 insensitive 要打折"。
      //
      // 依据：一个不能对已知错误报错的判定器不是弱判定器，它根本不是判定器
      // （阳性/阴性对照的通行要求）。mutation testing 里这叫 equivalent mutant /
      // vacuous test：覆盖到了，但不会有任何输入让它变红。
      const insensitive =
        r1.sensitivity === 0 && ['all', 'any', 'none'].includes(kind) && (r1.rows ?? 0) > 0
      if (insensitive) finalLevel = 'X'
      // 脚本往 stderr 打了东西却报 PASS：多半是 except 吞掉了异常继续往下跑。
      // 不判死（有些库正常输出警告），但把它写进台账，并降 S——
      // 一条"运行时不干净"的判定不该拿到最高证据等级。
      const stderrNoise = String(r1.stderr ?? '').trim().length > 0 && r1.pass === true
      if (stderrNoise && finalLevel !== 'X') finalLevel = 'S'
      const verdict = disputed ? 'disputed' : insensitive ? 'vacuous' : r1.pass === true ? 'pass' : 'fail'

      const record = {
        id,
        hash,
        assertion,
        // pass 只有三态：true / false / null。null 不是"还没判"，是"判了但没有内容"
        // （disputed = 两实现打架；vacuous = 判定器对数据不敏感）。
        pass: verdict === 'pass' ? true : verdict === 'fail' ? false : null,
        verdict,
        kind,
        ...fp,
        ...researchFields(args, verdict === 'pass' || verdict === 'fail' ? r1.pass : null),
        ...(epi ? { epi: { ...epi, level: finalLevel, ...(r1.cover ? { coverage: r1.cover } : {}) } } : {}),
        // 判定条件必须进台账。judge=count/equals 只给 value，judge=all/any/none 只给
        // predicate，两种都不产生 verdict.expected —— 于是台账里只剩下一个数字，
        // 审计看不到"通过标准是什么"。这是 N-16 的根因：检查的是记账格式，不是内容。
        expected: r1.expected,
        rows: r1.rows,
        checked: r1.checked,
        failures: r1.failures,
        impl_count: implCount,
        ...(r1.sensitivity !== undefined ? { sensitivity: r1.sensitivity } : {}),
        ...(insensitive ? { insensitive: true } : {}),
        ...(stderrNoise ? { stderr_noise: true } : {}),
        ...(r2 ? { impl2_script_sha: scriptSha(code2), impl_agree: !disputed } : {}),
        ...(disputed ? { reason: 'disputed', disputed } : {}),
        ...(!r2 && singleImplReason ? { single_impl_reason: singleImplReason } : {}),
        note: args?.note ?? '',
        judge_note: r1.note ?? '',
        elapsed_ms: r1.elapsed,
        script: r1.scriptPath,
        evidence: r1.outPath,
        ts: new Date().toISOString(),
      }

      // 等级在这里落定，而不是在声明时：一条推导的强度取决于它的前提，
      // 而前提在台账里。写记录前把整本台账读一遍重算，回执里给的就是最终等级。
      if (record.epi) {
        let prior = []
        try {
          prior = (await fsp.readFile(ledgerPath, 'utf8'))
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
        } catch {
          /* 首次判定，没有台账 */
        }
        const lv = computeLevels([...prior, record]).get(hash)
        if (lv) {
          record.epi.level = lv.level
          if (lv.laundered_from?.length) record.epi.laundered_from = lv.laundered_from
        }
      }
      await fsp.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')

      return {
        ok: true,
        pass: record.pass,
        verdict,
        claim_hash: hash,
        id,
        rows: record.rows,
        checked: record.checked,
        expected: record.expected,
        // 只回前几个反例：判 FAIL 的时候，证据在文件里，上下文里只需要看一个。
        failures: (record.failures ?? []).slice(0, 3),
        evidence: r1.outPath,
        ledger: ledgerPath,
        elapsed_ms: record.elapsed_ms,
        impl_count: implCount,
        ...(r2 ? { impl_agree: !disputed } : {}),
        ...(r1.sensitivity !== undefined ? { sensitivity: r1.sensitivity } : {}),
        ...(insensitive ? { insensitive: true } : {}),
        // 条件展开而不是 `|| undefined`：宿主对返回值做无损 JSON 校验，
        // 而 undefined 不是合法 JSON 值——留着这个键会让整条结果被拒收。
        ...(r1.note ? { note: r1.note } : {}),
        ...(epi ? { claim_type: epi.claim_type, evidence: epi.evidence, level: record.epi.level } : {}),
        ...(epi?.scope ? { scope: epi.scope } : {}),
        ...(r1.cover ? { coverage: r1.cover } : {}),
        ...(disputed ? { disputed } : {}),
        hint:
          verdict === 'vacuous'
            ? `这条判定是空的（verdict=vacuous，pass=null，level=X）：把每一行的数值扰动成 3v+7、布尔取反之后，` +
              `**没有一行翻转**——predicate 测的是它自己的形状，不是数据。` +
              `已按"空判定"入账，不能当证据引用，也不能用来关任何一条成功判据。\n` +
              `改法（任选）：① 让 predicate 真的引用行内数值（\`a*b === c*c\` 而不是 \`true\` 或 \`x == x\`）；` +
              `② 改成 judge=count，先对一个**已知应当失败**的样本跑一遍，确认它真的会红。`
            : disputed
              ? `两个实现结论相反：impl1 ${r1.pass ? 'PASS' : 'FAIL'}（${r1.rows} 行）vs impl2 ${r2.pass ? 'PASS' : 'FAIL'}（${r2.rows} 行）。` +
                '这条记为 disputed：既不能当已证，也不能当作被推翻——先定性哪一份在测错东西，再重判。'
              : record.pass
                ? epi
                  ? `PASS（等级 ${record.epi.level}：${epi.claim_type}/${epi.evidence}）。` +
                    `报告里引用 ${id} 时带上 claim_hash=${hash}` +
                    (record.epi.level === 'S' || record.epi.level === 'U'
                      ? `，并把范围「${epi.scope ?? '（未声明）'}」一起写出来——这一条不能支持无界结论。` +
                        (epi.evidence === 'exhaustive' && implCount === 1
                          ? ' 单实现只给 S：补一个换基/换算法的 code2 重判，才能升到 E。'
                          : '')
                      : '，并且只能按这个等级使用。') +
                    (stderrNoise
                      ? ` 注意：脚本的 stderr 非空却报了 PASS，等级已压到 ${record.epi.level}。` +
                        '如果那是被 except 吞掉的异常，这条判定读的是残缺数据——先让脚本干净地跑完。'
                      : '')
                  : `PASS。报告里引用 ${id} 时带上 claim_hash=${hash}，否则它和这条判定对不上。`
                : 'FAIL。failures 里是具体反例；先看 evidence 文件确认判定规则本身没写错。',
      }
    },
    }),
  )

  ctx.tools.register(
    defineTool({
    name: 'lean_audit',
    description:
      '跑 Lean 内核判定一个 .lean 文件里的某条声明，并给出**可据以定级的判决**。不写台账，供形式化过程中反复自检用；' +
      '要落成台账里的正式判据请用 verify_claim(evidence=lean)。' +
      '它判四件事：① 编译是否真的没有 error（注意：带 sorry 的文件退出码也是 0，所以不看退出码）；' +
      '② `#print axioms` 的公理表（`sorryAx` / 自定义 `axiom` 判死，`native_decide` 生成的 native 公理降为 computed）；' +
      '③ `autoImplicit` 是否在声明之前显式关闭（开着的时候拼错的标识符会变成隐式变量，语句悄悄变成恒真式）；' +
      '④ 用 `#check` 取内核展开后的语句，给一个指纹——报告里必须逐字带上它。' +
      '返回 verdict ∈ proven / computed / failed / blocked。**blocked 不是通过**。',
    parameters: {
      file: { type: 'string', required: true, description: '.lean 文件的绝对路径。' },
      decl: { type: 'string', required: true, description: '要判定的声明名（theorem/lemma 后面的标识符）。' },
      project_dir: { type: 'string', description: '含 lakefile 的项目目录；给了就走 `lake env lean`（import Mathlib 需要）。' },
      timeout_ms: { type: 'number', description: '超时毫秒，默认 240000（Mathlib 首次加载慢）。超时判 blocked。' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      const file = String(args?.file ?? '').trim()
      const decl = String(args?.decl ?? '').trim()
      if (!file) return { ok: false, error: '缺少 file' }
      if (!decl) return { ok: false, error: '缺少 decl（没有名字就没有可判定的对象）' }
      const r = await auditLean({
        file,
        decl,
        projectDir: args?.project_dir ?? cfg.projectDir,
        timeoutMs: Number.isFinite(args?.timeout_ms) && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : cfg.leanTimeoutMs,
        leanExe: cfg.leanExe,
        lakeExe: cfg.lakeExe,
      })
      return {
        ok: true,
        verdict: r.verdict,
        reasons: r.reasons ?? [],
        decl: r.decl ?? decl,
        statement: r.statement ?? null,
        statement_sha: r.statement_sha ?? null,
        axioms: r.axioms ?? [],
        native_axioms: r.native_axioms ?? [],
        untrusted_axioms: r.untrusted_axioms ?? [],
        allowed_axioms: [...ALLOWED_AXIOMS],
        scan: r.scan ?? null,
        diagnostics: (r.diagnostics ?? []).slice(0, 8),
        ...(r.hint ? { hint: r.hint } : {}),
        note:
          r.verdict === 'proven'
            ? '内核核过、公理表干净。报告里引用这条时必须逐字写出 statement。'
            : r.verdict === 'computed'
              ? 'native_decide 通过：它信任编译器而不是内核，只能当穷尽计算（E）用。'
              : r.verdict === 'blocked'
                ? 'blocked 不是通过——工具链或超时问题解决之前，这条不能算已证。'
                : '判死。按规则这条作废，引用它的推导一并作废。',
      }
    },
    }),
  )

  ctx.tools.register(
    defineTool({
    name: 'claim_audit',
    description:
      '读判定台账，列出每条判据的最终状态与 hash。' +
      '**四种漂移都会报**：同一 id 出现两个不同 hash（断言被改写）、不同 script_sha（脚本被换）、' +
      '不同 judge_sha（判定规则被换）、既有 PASS 又有 FAIL（结论翻转）。' +
      '前三种说明旧结论对新判据无效；第四种最危险——它意味着"改到通过为止"，报告里必须写明哪一次算数。' +
      '同时给出每条判据的**证据等级**（D 推导 / E 穷尽计算 / L 文献 / S 抽样 / U 未声明）与洗白名单' +
      '（声称推导但前提是抽样的条目——它们按最弱前提算，仍然不能支撑全称结论）。' +
      '写报告前调一次，把报告里引用的 hash 与这里对齐。',
    parameters: {
      dir: { type: 'string', description: '工作目录。默认当前目录。' },
      id: { type: 'string', description: '只看某一条。省略则列出全部。' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      const root = stateRoot(args?.dir)
      const ledgerPath = path.join(root, 'claims.jsonl')
      let raw = ''
      try {
        raw = await fsp.readFile(ledgerPath, 'utf8')
      } catch {
        return { ok: true, total: 0, records: [], note: '台账还不存在：还没有任何一条判据被真正判定过。' }
      }

      const all = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          all.push(JSON.parse(line))
        } catch {
          /* 坏行忽略，不因为一行脏数据否认整本台账 */
        }
      }

      const only = args?.id ? String(args.id).trim() : ''
      const filtered = only ? all.filter((r) => r.id === only) : all

      // 等级在**整本台账**上算，再筛：一条推导的前提可能在别的 id 下，
      // 只看 filtered 会把前提当成"查无此人"，于是把 D 误降成 U。
      const levels = computeLevels(all)

      // 一个 id 的最新记录 + 历史 hash 集合：两个以上 hash 就是"判据被改过"。
      const byId = new Map()
      for (const r of filtered) {
        const entry = byId.get(r.id) ?? { id: r.id, hashes: new Set(), records: [] }
        entry.hashes.add(r.hash)
        entry.records.push(r)
        byId.set(r.id, entry)
      }

      const records = [...byId.values()].map((entry) => {
        const last = entry.records[entry.records.length - 1]
        // 老台账没有 script_sha/judge_sha，缺失记为 undefined：只有真出现过两个
        // 不同值才算"被改过"，否则会把历史数据全部误报成冲突。
        const distinct = (key) => {
          const s = new Set(entry.records.map((r) => r[key]).filter((v) => v !== undefined && v !== null && v !== ''))
          return s.size
        }
        const passes = new Set(entry.records.map((r) => r.pass === true))
        const drift = []
        if (entry.hashes.size > 1) drift.push('assertion_rewritten')
        if (distinct('script_sha') > 1) drift.push('script_rewritten')
        if (distinct('judge_sha') > 1) drift.push('judge_rewritten')
        if (passes.size > 1) drift.push('verdict_flipped')
        const lv = last.hash ? levels.get(last.hash) ?? { level: 'U' } : { level: 'U' }
        return {
          id: entry.id,
          // 三态：true 判过通过 / false 判过没通过 / null 没判成（blocked）。
          // 把 null 压成 false，就等于把"环境坏了"记成"结论错了"。
          pass: last.pass === true ? true : last.pass === null ? null : false,
          hash: last.hash,
          hashes: [...entry.hashes],
          conflicts: drift.length > 0,
          drift,
          // 这一条能被引用来支持什么，全看 level。S/U 只能当有界结论或线索用。
          level: lv.level,
          claim_type: last.epi?.claim_type ?? null,
          evidence: last.epi?.evidence ?? null,
          scope: last.epi?.scope ?? null,
          ...(lv.laundered_from?.length ? { laundered_from: lv.laundered_from } : {}),
          ...(lv.invalidated_by?.length ? { invalidated_by: lv.invalidated_by } : {}),
          ...(lv.blocked_by?.length ? { blocked_by: lv.blocked_by } : {}),
          ...(last.invalidated ? { invalidated: true, invalidated_reason: last.invalidated_reason ?? '' } : {}),
          attempts: entry.records.length,
          // 这三个字段必须显式兜底成 null。
          // Lean 记录没有 rows（它不跑 Python，没有"行数"这一维），elapsed_ms 也可能缺；
          // 而 `{ rows: undefined }` 在宿主眼里不是合法 JSON —— 它做无损校验，会整条拒收，
          // 报错却是 `invalid output: value is not lossless JSON`，指向完全无关的方向。
          // team8 实轮就是这么坏的：逐 id 视图正常（单条有 rows），一取全部就报错。
          rows: last.rows ?? null,
          elapsed_ms: last.elapsed_ms ?? null,
          evidence_path: last.evidence ?? null,
          ts: last.ts ?? null,
        }
      })

      const conflicts = records.filter((r) => r.conflicts)
      const flipped = records.filter((r) => r.drift.includes('verdict_flipped'))
      const swapped = records.filter(
        (r) => r.drift.includes('script_rewritten') || r.drift.includes('judge_rewritten'),
      )
      const byLevel = records.reduce((a, r) => ((a[r.level] = (a[r.level] ?? 0) + 1), a), {})
      // 只能当线索用的：抽样、以及没声明类型的（老记录全在这里）。
      const weak = records.filter((r) => r.level === 'S' || r.level === 'U')
      // 没判成的单独一档。它既不在 passed 里，也不在作废里——如果混进任何一边，
      // 都会产生一个假的结论：混进 passed 是虚报，混进作废是冤杀。
      const blockedRecs = records.filter((r) => r.level === '?')
      const washed = records.filter((r) => (r.laundered_from ?? []).length)
      // pass 回答"这条判据的检查过了吗"，level 回答"它能当什么用"。两者不是一回事：
      // 一条推导自己的脚本会跑通（pass=true），但前提是 blocked，它就只剩 `?`。
      // 只报 passed 会让读者以为真有一条能用的结论——所以再报一个 usable。
      const usable = records.filter((r) => r.pass === true && r.level !== '?' && r.level !== 'X')
      return {
        ok: true,
        total: records.length,
        passed: records.filter((r) => r.pass === true).length,
        usable: usable.length,
        blocked: blockedRecs.length,
        conflicts: conflicts.length,
        by_level: byLevel,
        weak: weak.length,
        records,
        note: [
          conflicts.length > 0
            ? [
                `${conflicts.length} 条判据在判定之后被改过。`,
                flipped.length
                  ? `结论翻转过：${flipped.map((c) => c.id).join(', ')}——同一个 id 既有 PASS 又有 FAIL，报告里必须写明哪一次算数、为什么。`
                  : '',
                swapped.length
                  ? `判据被换过：${swapped.map((c) => c.id).join(', ')}——断言没改但脚本或判定规则变了，旧 PASS 不能直接搬到新实现上。`
                  : '',
              ]
                .filter(Boolean)
                .join(' ')
            : '没有发现断言改写、判据替换或结论翻转。',
          washed.length
            ? `**洗白**：${washed.map((c) => `${c.id}(${c.laundered_from.join('/')})`).join(', ')} ` +
              '声称是推导，但前提里有抽样——等级按最弱前提算，这几条仍然不能用在全称结论上。'
            : '',
          weak.length
            ? `${weak.length} 条等级为 S/U（${weak.map((c) => c.id).join(', ')}）：引用它们时范围必须一起写出来，` +
              '不能出现在"证明/因此/故"这类句式里。'
            : '',
          blockedRecs.length
            ? `${blockedRecs.length} 条**未判定**（blocked，等级 ?：${blockedRecs.map((c) => c.id).join(', ')}）：` +
              '判决没跑成，事实未知。不能当已证引用，也**不算作废**——' +
              '引用它们推导出来的东西会一起变成 ?，既不是结论也不是废纸。先把环境修好重判，别把它们写成"已判死"。'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      }
    },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'research_note',
      description:
        '把**不能判定**的研究产物写进账本：死路、阻塞、猜想。不跑任何判据，只落盘。\n' +
        '为什么需要它：台账只收"判过的"，于是"这条路试过、断在第 3 步"这种负面知识全部丢失，' +
        '下一轮会把同一个死胡同重新走一遍。而负面知识恰恰是研究里最贵的部分。\n' +
        '三种类型：\n' +
        '- `dead_end`：试了什么、断在哪一步、需要什么条件才能过。**不是失败汇报，是给下一轮的地图。**\n' +
        '- `blocking_claim`：你判断"这做不出来"时，把理由写成可检验的断言（"缺 X 引理"/"Y 在 Z 情形下不成立"）。' +
        '它会被下一轮当判据攻，而不是变成一句没人反驳的叹息。\n' +
        '- `conjecture`：看到了模式但还证不了。写进账本，下一轮可以派活去证或去推翻。\n' +
        '全部写进 `.claim-verify/notes.jsonl`，与 claims.jsonl 分开——它们没有 pass，不该污染判定统计。',
      parameters: {
        dir: { type: 'string', description: '工作目录。默认当前目录。' },
        type: {
          type: 'string',
          required: true,
          enum: ['dead_end', 'blocking_claim', 'conjecture'],
          description: 'dead_end=死路；blocking_claim=我认为做不到的理由；conjecture=看到但没证的模式。',
        },
        id: { type: 'string', required: true, description: '短标识，如 `DE-mwindow`。报告里引用它时用这个。' },
        statement: {
          type: 'string',
          required: true,
          description:
            '一句话说清。dead_end 写"想做什么、结果如何"；blocking_claim 写**可判真假的断言**' +
            '（"不存在使 … 成立的 …"），不要写"这很难"；conjecture 写你猜的命题。',
        },
        detail: { type: 'string', description: '可选：展开。dead_end 写断在第几步、当时的数据是什么。' },
        blocked_at: { type: 'string', description: 'dead_end 用：断在哪一步（如"第 3 步：需要 K 的类数闭合，但只有 m≤2 的实例"）。' },
        needs: { type: 'string', description: 'dead_end / blocking_claim 用：要过这一关还需要什么。这一栏是下一轮派活的依据。' },
        attempt: {
          type: 'string',
          description:
            'blocking_claim 必填（要拿它收工时）：**本轮真跑过、并且失败的那一条命令**，原样贴上来。' +
            '它必须能在 run.log 里找到。写不出命令，说明你还没走到那一步——那样的话这是结论不是阻塞，' +
            '请改记 dead_end，然后继续做下一步。',
        },
        falsifiable_by: {
          type: 'string',
          description:
            'conjecture 必填：什么观察或计算能**推翻**它。要写成能真跑的东西（"把 16 个结点坐标代入 Kummer 商映射"），' +
            '不写"理论上可以被检验"。填不出这一栏，说明它不是猜想，是一个印象。',
        },
        missing_step: {
          type: 'string',
          description:
            'conjecture 必填：它和定理之间**唯一缺的那一步**。只能写一步——写三步等于没定位，' +
            '因为下一步该干什么仍然不清楚。',
        },
        next_test: {
          type: 'string',
          description:
            'conjecture 必填：下一轮的第一条命令或第一个脚本（具体到能直接跑）。' +
            '这一栏是下一轮的开始位置；写不出来，这条猜想下一轮就不存在。',
        },
        implies: { type: 'string', description: 'conjecture 可选：如果它成立，能推出什么（尽量连回 goal.md 的成功判据）。' },
        claim_key: { type: 'string', description: '可选：跨轮语义键，与 verify_claim 的同名字段同一套约定。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args) {
        const root = stateRoot(args?.dir)
        const kind = String(args?.type ?? '').trim()
        const id = String(args?.id ?? '').trim()
        const statement = String(args?.statement ?? '').trim()
        if (!['dead_end', 'blocking_claim', 'conjecture'].includes(kind)) {
          return { ok: false, error: 'type 必须是 dead_end / blocking_claim / conjecture' }
        }
        if (!id || !statement) return { ok: false, error: 'id 与 statement 都必填' }
        // 猜想要能当成果用，就必须能被判死。三栏缺一，它只是印象。
        // 13 轮里 3 条 conjecture 全躺在账本里没被捡起来，根因是"猜想不算成果"；
        // 一旦算成果，最省力的作弊是写一句话，所以门槛落在这里，而不是"写得好不好"。
        if (kind === 'conjecture') {
          const lack = ['falsifiable_by', 'missing_step', 'next_test'].filter(
            (k) => String(args?.[k] ?? '').trim().length < 8,
          )
          if (lack.length) {
            return {
              ok: false,
              error:
                `conjecture 缺少 ${lack.join(' / ')}。猜想要在本轮算成果，必须能被执行者接手：` +
                'falsifiable_by（什么能推翻它）/ missing_step（唯一缺的那一步）/ next_test（下一轮第一条命令）。',
            }
          }
        }

        await fsp.mkdir(root, { recursive: true })
        const notePath = path.join(root, 'notes.jsonl')
        const attempt = String(args?.attempt ?? '').trim()
        const rec = {
          schema: SCHEMA_VERSION,
          record_type: kind,
          id,
          statement,
          ...(args?.detail ? { detail: String(args.detail) } : {}),
          ...(args?.blocked_at ? { blocked_at: String(args.blocked_at) } : {}),
          ...(args?.needs ? { needs: String(args.needs) } : {}),
          ...(attempt ? { attempt } : {}),
          ...(args?.falsifiable_by ? { falsifiable_by: String(args.falsifiable_by) } : {}),
          ...(args?.missing_step ? { missing_step: String(args.missing_step) } : {}),
          ...(args?.next_test ? { next_test: String(args.next_test) } : {}),
          ...(args?.implies ? { implies: String(args.implies) } : {}),
          ...(args?.claim_key ? { claim_key: String(args.claim_key) } : {}),
          ts: new Date().toISOString(),
        }
        await fsp.appendFile(notePath, `${JSON.stringify(rec)}\n`, 'utf8')

        let total = 0
        try {
          total = (await fsp.readFile(notePath, 'utf8')).split('\n').filter((l) => l.trim()).length
        } catch {
          /* 刚写的一定存在，这里失败也不影响主流程 */
        }
        // blocking 缺 attempt 时不拒收（这条记录对下一轮仍然有用），但明确告诉它：
        // 这条换不到收工。拒收会把"如实登记一个阻塞"变成一件有风险的事，
        // 而我们要的是"登记可以，但别拿它当终点"。
        const exitBlocked = kind === 'blocking_claim' && attempt.length < 8
        return {
          ok: true,
          type: kind,
          id,
          notes_path: notePath,
          total_notes: total,
          ...(kind === 'blocking_claim' ? { exit_eligible: !exitBlocked } : {}),
          hint:
            kind === 'dead_end'
              ? '已记。下一轮的任务书会自动带上这条死路——它的作用是让别人不要重走，而不是证明你努力过。'
              : kind === 'blocking_claim'
                ? exitBlocked
                  ? '已记，但**这条不能拿它收工**：缺 `attempt`（本轮真跑过、并且失败的那条命令）。' +
                    '现在的它只是"你判断走不通"，而"判断走不通"是最便宜的一句收工话术。' +
                    '两条路：① 真去试一次并失败，把命令填进 attempt；② 把它改记成 dead_end，然后继续做下一步。'
                  : '已记。这条有失败的尝试做底：下一轮要么证它、要么推翻它。两种结果都比"我觉得不行"有用。'
                : '已记。这条猜想到此是"可执行"的：下一轮可以照 next_test 直接开跑，或者照 falsifiable_by 直接推翻。不写 next_test 的猜想，下一轮不存在。',
        }
      },
    }),
  )
}
