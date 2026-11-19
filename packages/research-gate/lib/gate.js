/**
 * 研究流程门禁：状态机、计算分级与工具分类（纯逻辑，不依赖 dsh 运行时）。
 *
 * 存在的理由是一类反复出现的失败：给模型一个"研究某问题"的任务，它会跳过
 * 前人已经做到哪一步，直接去写数值搜索脚本，最后交出一堆"我算了 c ≤ 10^5，
 * 没有解"——这对高度无界的有理点问题几乎没有信息量。
 *
 * 所以把顺序做成**物理约束**而不是提示词：
 *   survey（读文献） → synthesis（形成判据） → verify（才放证据级计算）
 *
 * ── v0.2 的两处修正（都是实测与追问撞出来的） ──────────────────────
 *
 * 修正一：计算分两级，不再一刀切。
 *   v0.1 把所有计算工具一律拦在前两阶段。后果是荒谬的：模型在 survey 阶段
 *   想验算文献里的一个数字（1+1 这种），也会被拦，于是它要么编一段 400 字
 *   废话骗开锁，要么放弃验算。**这是在惩罚理解行为。**
 *   现在按"规模"分级：单次小算（scratch）任何阶段放行，只是不能被当作论据；
 *   批量枚举（evidence）才需要 verify。判据是**规模**，不是学科。
 *
 * 修正二：verify 是一张"票据"，不是一次买断。
 *   v0.1 一旦推进到 verify，全会话的计算永久解锁。于是第 2、3、4 个子问题
 *   都能零文献工作直接开算——原来的病只是被推迟，没被治。
 *   现在一个 ticket 绑定一个问题；换问题要 open 新票，重新走 survey。
 *
 * @module dsh-plugin-research-gate/gate
 */

import fs from 'node:fs'
import path from 'node:path'

/** 阶段顺序。默认只能一步一步往前走，但允许退回 survey（见 advance）。 */
export const STAGES = ['survey', 'synthesis', 'verify']

/** 阶段的人话名字。 */
export const STAGE_LABEL = {
  survey: 'survey（梳理前人经验）',
  synthesis: 'synthesis（形成自己的方法判据）',
  verify: 'verify（数值验证）',
}

/**
 * 文献/调研类工具：这类工具在任何阶段都放行，且在 survey 阶段计数。
 * 匹配是**前缀/包含**式，因为插件命名带自己的前缀（paper_search、zotero_search…）。
 */
const SURVEY_PATTERNS = [
  /^paper_/i,
  /^zotero/i,
  /^wps_read/i,
  /^web_search/i,
  /^browser/i,
  /^skill/i,
  /^memory_(search|get|recall)/i,
  /^read_file$/i,
  /^grep$/i,
  /^glob$/i,
]

/**
 * 计算/数值类工具。
 *
 * 注意：这类工具**不再一律拒绝**——只拒绝被判定为 evidence 级别的调用。
 * 名单本身仍然重要，因为它决定"这次调用要不要过分级器"。
 */
const COMPUTE_PATTERNS = [
  /^viz_/i,
  /^math/i,
  /^lean/i,
  /^proof_/i,
  /^run_code$/i,
  /^code_runtime$/i,
  /^bash$/i,
  /^pwsh$/i,
  /^shell/i,
  /^terminal/i,
  /^python/i,
  /^jupyter/i,
  /^sympy/i,
  /^sage/i,
  /^mathematica$/i,
  /^matlab$/i,
  /^r_exec$/i,
]

/**
 * 通用 shell 工具。
 */
const SHELL_TOOL = /^(bash|pwsh|shell\w*|terminal\w*)$/i
/** 一旦出现这些，命令就不再是"只看一眼"。 */
const INTERPRETER = /\b(python[0-9.]*|node|deno|bun|julia|Rscript|sage|lean|lake|ruby|perl|matlab)\b/i
/** 循环、区间、range：哪怕在 shell 里也是批量。 */
const LOOPY = /(^|[\s;(])(for|foreach|while|do)\b|\.\.|range\(/i

/**
 * 内联求值：`node -e "..."`、`python -c "..."`。这就是一台通用计算器，不给豁免。
 */
const EVAL_FLAG = /(?:^|\s)(?:-e|--eval|-p|--print|-c)\b/

/**
 * 跑的是"判据/审计脚本"，不是"自己算一遍"。
 *
 * 实测（team11）：队长的 `node tools/terminate-check.mjs` 被判成草稿级计算，
 * 8 次额度耗尽之后，连"跑一次收工门"都要跨会话委派给成员——三次都没回报，
 * 于是它派了三个题目为「跑一次收工门并回报 stdout」的任务，收口率凑成 8/8。
 *
 * 病因是口径：配额数的是**工具名**，想管的是**算力**。同一个 `node` 既能跑
 * 一次 O(10^9) 枚举，也能跑一个只读 run 目录的判据脚本，两者共享同一个预算。
 * 修法不是把 node 放行（那等于额度作废），而是按**路径**认：仓库里 tools/ test/
 * bench/ 下的脚本按约定是检查工具，跑它们算"验证"，不算"草稿级计算"。
 *
 * 这是命名契约，不是沙箱——补一条结构性约束：**脚本必须在本轮开工前就存在**。
 * 否则模型可以现写一个 `tools/brute.mjs` 丢进去然后申请豁免，那等于把额度废掉。
 * 判据用 mtime 与 .clock.json 的 t0 比：开工之后出现的脚本一律按普通计算处理。
 *
 * @param {string} cmd - 命令文本。
 * @param {number|null} [t0] - 本轮开工时刻（epoch ms）；给了就要求脚本比它旧。
 * @returns {boolean} 是验证脚本返回 true。
 */
export function isVerificationScript(cmd, t0 = null) {
  const s = String(cmd || '')
  if (!s) return false
  if (EVAL_FLAG.test(s)) return false
  const m = s.match(
    /(?:^|[\s"'=(])((?:(?:[A-Za-z]:)?[^\s"'|;&]*[\\/])?(?:tools|test|bench)[\\/][^\s"'|;&]+\.(?:mjs|cjs|js|py|sh))/i,
  )
  if (!m) return false
  // 外面套了循环，就不是"跑一次判据"。
  if (LOOPY.test(s.replace(m[1], ' '))) return false
  if (typeof t0 === 'number') {
    try {
      if (fs.statSync(path.resolve(process.cwd(), m[1])).mtimeMs >= t0) return false
    } catch {
      return false // 文件不存在：按普通计算处理，宁可严一点也不放行一个未知脚本
    }
  }
  return true
}

/**
 * 这条 shell 命令是不是纯查看？
 *
 * 实测撞出来的：把目录列出来（Get-ChildItem）被判成草稿级计算，八次之后
 * 连 `ls` 都被拦，模型只好改用 glob/read 绕。**看一眼文件系统不是计算**，
 * 它不该消耗草稿额度——否则门禁会逼着模型少看、瞎猜。
 *
 * 判据只认命令文本：出现解释器调用、循环、区间，就不是只读。
 * @param {string} name - 工具名。
 * @param {unknown} args - 调用参数。
 * @param {number|null} [t0] - 本轮开工时刻，传给 isVerificationScript。
 * @returns {boolean} 只读返回 true。
 */
export function isReadOnlyShell(name, args, t0 = null) {
  if (!SHELL_TOOL.test(String(name || ''))) return false
  let cmd = ''
  try {
    cmd = args && typeof args === 'object'
      ? String(args.command ?? args.cmd ?? args.script ?? '')
      : String(args ?? '')
  } catch {
    return false
  }
  if (!cmd) return false
  // 调了解释器不一定是在算：跑仓库里的判据/审计脚本属于"验证"，见 isVerificationScript。
  if (INTERPRETER.test(cmd)) return isVerificationScript(cmd, t0)
  if (LOOPY.test(cmd)) return false
  return true
}

/**
 * 真实时钟：交给宿主（dsh-lab.sh 写的 .clock.json）报时，不让模型自己估。
 *
 * 为什么必须由宿主注入：上下文里没有任何东西编码"过了多久"，token 数也不是时钟
 * （On the Clock, arXiv:2610.10833 明确写了这点：token count is a poor proxy）。
 * 所以"先跑一次 date"这种建议无效——读完那个数字，模型依然没有把"现在"和
 * "开工时刻"连起来的东西，于是报告里的时间线是从约束反推出来的（team11 写
 * "做到 23:45 之后"，而报告 23:32:56 就落盘了，进程 23:33:12 结束）。
 *
 * 注意这条注入**只提供感官，不提供目标**：数字旁边明说不存在"用够才算数"。
 * 上一版把时长做成判据，结果下限变成了目标（"need 30 min → 23:40"）。
 *
 * @param {string} file - .clock.json 路径。
 * @param {number} [now] - 当前时刻（测试用）。
 * @returns {string} 一行运行时上下文。
 */
export function clockLine(file, now = Date.now()) {
  const NO =
    '真实时钟：本轮未注入（不是 dsh-lab 起的会话）。不要凭记忆写时刻——审计会拿文件 mtime 核对报告里的每一个时间。'
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!c || typeof c.t0 !== 'number') return NO
    const hm = (ms) => new Date(ms).toTimeString().slice(0, 8)
    const span = (m) => {
      // 先四舍五入到秒再拆分：否则 29.999 分会渲染成"29 分 60 秒"。
      const total = Math.max(0, Math.round(Math.abs(m) * 60))
      return `${Math.floor(total / 60)} 分 ${String(total % 60).padStart(2, '0')} 秒`
    }
    const used = Math.max(0, now - c.t0) / 60000
    let s = `真实时钟（宿主注入，不要自己估算）：现在 ${hm(now)}，本轮开工 ${hm(c.t0)}，已用 ${span(used)}`
    if (typeof c.budgetMin === 'number') {
      const left = c.budgetMin - used
      s += `，预算 ${c.budgetMin} 分钟，${left >= 0 ? `剩 ${span(left)}` : `已超 ${span(left)}`}`
    }
    s +=
      '。这个数字不是判据，也不存在"用够才算数"——收工看的是有没有转移（新结论 / 判死一条路 / 推翻旧结论）。' +
      '报告里写到的任何时刻都必须真实：审计会拿文件 mtime 核对，写没发生的时段会被判违规。'
    return s
  } catch {
    return NO
  }
}

/**
 * 判断一个工具属于哪一类。
 * @param {string} name - 工具名。
 * @param {{allowExtra?: string[], denyExtra?: string[]}} [config] - 人工覆盖。
 * @returns {'survey'|'compute'|'neutral'} 分类。
 */
export function classify(name, config = {}) {
  const n = String(name || '')
  const allowExtra = Array.isArray(config.allowExtra) ? config.allowExtra : []
  const denyExtra = Array.isArray(config.denyExtra) ? config.denyExtra : []
  if (allowExtra.includes(n)) return 'survey'
  if (denyExtra.includes(n)) return 'compute'
  if (SURVEY_PATTERNS.some((re) => re.test(n))) return 'survey'
  if (COMPUTE_PATTERNS.some((re) => re.test(n))) return 'compute'
  return 'neutral'
}

/**
 * 检查"名义上是调研工具"的调用，是不是在偷偷执行计算。
 *
 * 这个洞是实测撞出来的：门禁拦住 viz_python 之后，模型改用 browser 的 eval
 * 在浏览器里跑 JS，把 1+1 算了出来，还附上"python 通道被门禁锁住"的说明。
 * 工具名字是调研工具，干的事是计算。**分类不能只看名字，还要看参数。**
 *
 * v0.2 起它只负责"这看起来像计算吗"，至于算多大，交给 computeTier 判。
 *
 * @param {string} name - 工具名。
 * @param {unknown} args - 调用参数。
 * @returns {string|null} 违规原因；合规返回 null。
 */
export function inspectSurveyCall(name, args) {
  const n = String(name || '')
  if (!/^browser/i.test(n)) return null
  let s = ''
  try {
    s = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  } catch {
    return null
  }
  if (/"(cmd|action|command|method)"\s*:\s*"(eval|js|javascript|execute|run|script)"/i.test(s)) {
    return 'browser 的 eval/js 通道等同于一台通用计算器'
  }
  if (/"(code|script|javascript)"\s*:/i.test(s)) {
    return '调用参数里带了可执行代码字段'
  }
  return null
}

/**
 * 探索级计算的识别规则：比证据级更重，通常没有明确停止条件。
 *
 * 之所以要和证据级分开命名，是因为两者的**委派要求**不同：
 * 证据级只要说清判据与算法，探索级还必须写清预算与停止条件——
 * 没有停止条件的搜索不算实验，算消耗。
 */
const EXPLORE_RULES = [
  { re: /\bwhile\s*(\(\s*)?(true|1)\b/i, why: '无上界循环，没有停止条件' },
  { re: /\b(range|arange|linspace)\s*\([^)]*\b(10\s*\*\*\s*[5-9]|1e[5-9]|\d{6,})/i, why: '上界到 10^5 以上，是探索性扫描' },
  { re: /(遍历|枚举|扫描|搜索|search|enumerate|sweep|scan)[^。\n]{0,30}?(\d{6,}|10\s*\*\*\s*[5-9]|1e[5-9])/i, why: '任务/代码里写明了 10^5 以上的扫描规模' },
  { re: /\b(random\.|np\.random|numpy\.random|montecarlo|monte_carlo)\b/i, why: '蒙特卡洛采样，结论依赖样本量而非证明' },
  { re: /\b(explore|exploration|grid\s*search|parameter\s*space|参数空间|探索性)\b/i, why: '明确的探索性搜索' },
]

/**
 * 证据级计算的识别规则。
 *
 * 每条的取向都是：**这个东西一旦跑起来，它覆盖的是一个范围，不是一个数。**
 * 单点求值（sqrt(2)、1+1、因式分解一个数）不在此列。
 */
const EVIDENCE_RULES = [
  { re: /\bwhile\b/i, why: '有 while 循环，规模由运行过程决定' },
  { re: /\bfor\b[^:;{}]{0,140}?\b(range|arange|linspace|seq_along|seq_len)\s*\(/i, why: '在区间/序列上做循环，是批量枚举' },
  { re: /\bfor\s*\([^)]*;[^)]*;/, why: 'C 风格的 for 循环，是批量枚举' },
  { re: /\b(range|arange|linspace)\s*\([^)]*\*\*/i, why: '循环上界写成幂次（如 10**5），是扫描规模的写法' },
  { re: /\b(search|enumerate|sweep|scan|brute|exhaust|iterate|遍历|枚举|搜索)\w*/i, why: '出现搜索/枚举语义' },
  { re: /\b(itertools\.)?(product|permutations|combinations)\s*\(/i, why: '组合式枚举，规模天然爆炸' },
  { re: /\b(random\.|np\.random|numpy\.random|montecarlo|monte_carlo)\b/i, why: '蒙特卡洛采样，结论依赖样本量' },
  { re: /\b(max_n|n_max|upper_bound|upperLimit|bound\s*=|limit\s*=|up_to|upto)\b/i, why: '显式设定了搜索上界' },
]

/**
 * 只按文本判定级别，不看草稿预算。
 *
 * 委派任务书也要过这一关：否则主智能体可以把一次大扫描包装成"给子智能体的
 * 调研任务"，绕过前面所有约束。**判据对委派任务书同样成立。**
 *
 * @param {string} text - 待判定文本。
 * @param {object} [config] - { evidenceExtra: RegExp[] }
 * @returns {{tier: 'scratch'|'evidence'|'explore', why: string}} 判定。
 */
export function textTier(text, config = {}) {
  const s = String(text || '')
  const toRules = (list, why) =>
    (Array.isArray(list) ? list : []).map((re) => ({ re: re instanceof RegExp ? re : new RegExp(String(re), 'i'), why }))
  const extraExplore = toRules(config.exploreExtra, '命中自定义探索级规则')
  const extraEvidence = toRules(config.evidenceExtra, '命中自定义证据级规则')

  for (const rule of [...EXPLORE_RULES, ...extraExplore]) {
    if (rule.re.test(s)) return { tier: 'explore', why: rule.why }
  }
  for (const rule of [...EVIDENCE_RULES, ...extraEvidence]) {
    if (rule.re.test(s)) return { tier: 'evidence', why: rule.why }
  }
  return { tier: 'scratch', why: '单次小规模求值' }
}

/**
 * 判定一次计算的级别（含草稿预算）。
 *
 * @param {unknown} args - 调用参数（会整体转成字符串做特征匹配）。
 * @param {object} state - 当前票据状态。
 * @param {object} [config] - { scratchLimit, evidenceExtra: RegExp[], noBudget: boolean }
 * @returns {{tier: 'scratch'|'evidence'|'explore', why: string}} 判定。
 */
export function computeTier(args, state, config = {}, toolName = '') {
  const scratchLimit = Number.isFinite(config.scratchLimit) ? config.scratchLimit : 8
  let s = ''
  try {
    s = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  } catch {
    s = ''
  }

  // 纯查看的 shell 命令不是计算：不判级、不吃额度。
  if (toolName && isReadOnlyShell(toolName, args)) return { tier: 'scratch', why: '只读命令，不计入计算额度' }

  const t = textTier(s, config)
  if (t.tier !== 'scratch') return t
  if (config.noBudget === true) return t

  // 单次小算可以是理解的一部分；但同一个问题里反复小算，累计起来就是一次扫描。
  const used = Number(state?.scratchCalls ?? 0)
  if (used >= scratchLimit) {
    return {
      tier: 'evidence',
      why: `本问题内已做过 ${used} 次草稿级计算（上限 ${scratchLimit}），累加起来等同于一次扫描`,
    }
  }
  return { tier: 'scratch', why: '单次小规模求值' }
}

/** 新建一份初始状态（等同于开一张新票据）。 */
export function createState(question = '') {
  return {
    /** 这张票据对应的问题。换问题要 open 新票。 */
    question: String(question || '').trim(),
    stage: 'survey',
    /** 被放行的文献类工具调用次数。 */
    reads: 0,
    /** 被拒绝的证据级计算调用次数，用来判断模型是不是在硬顶。 */
    denials: 0,
    /** 已放行的草稿级计算次数（计入预算）。 */
    scratchCalls: 0,
    /** 已委派给子智能体的次数（含被判定为计算任务的委派）。 */
    delegations: 0,
    /** 没有委派工具时，直接跑批量计算的次数（降级路径，用于事后诊断）。 */
    directRuns: 0,
    /** survey 阶段提交的前人经验综述。 */
    priorArt: '',
    /** synthesis 阶段提交的验证计划。 */
    plan: '',
    /** 阶段推进的时间线，便于事后复盘。 */
    trail: [],
    /** 最近被计入 reads 的工具名，用于诊断"它到底读了什么"。 */
    readTools: [],
    /** 已经计入过 reads 的本地文献文件（归一化路径）。同名只算一次，防刷。 */
    readFiles: [],
    /** 已经开到第几张票。 */
    tickets: 1,
    /** 已关闭（换问题）的票据存档。 */
    history: [],
  }
}

/**
 * 开一张新票据：把当前票据存档，回到 survey。
 *
 * 这是"verify 只买一次票"那个漏洞的补丁。子问题变了，前面的 prior_art
 * 对它不再作数——同一位作者的同一篇论文，能回答 A 问题，不代表能回答 B 问题。
 *
 * @param {object} state - 当前状态。
 * @param {string} question - 新问题。
 * @param {object} [config] - { minQuestionChars }
 * @returns {{ok: boolean, reason?: string, state?: object, note?: string}}
 */
/**
 * P1-6：这次调用算不算"读了本地文献"？
 *
 * 口径原来只数 paper_* / cnki / zotero 的调用次数，于是模型用 read 把 refs 全文
 * 翻了一遍却被记为没读，只能补三次 paper_* 调用去过闸——其中两次重复检索、
 * 一次失败。门禁满足了，读的量没变。数"调了哪个工具"和"读没读"不是一回事。
 *
 * 返回归一化路径（用于按文件去重），不算则返回 null。
 */
export function localRefPath(toolName, args) {
  const name = String(toolName || '')
  // 名字要含 read_file：宿主既有 `read` 也有 `read_file`，只认前者会漏掉一半环境
  // （P1-7 那种"两套环境"的坑，在这里会表现为"同一个动作，计数有时算有时不算"）。
  if (!/^(read|read_file|open_file|view_file|fs_read)$/i.test(name)) return null
  const raw = String(args?.path ?? args?.file_path ?? args?.file ?? '')
  if (!raw) return null
  const norm = raw.replace(/\\/g, '/')
  if (!/(^|\/)refs\//.test(norm)) return null
  return norm
}

export function openTicket(state, question, config = {}) {
  const minQ = Number.isFinite(config.minQuestionChars) ? config.minQuestionChars : 8
  const q = String(question || '').trim()
  if (q.length < minQ) {
    return { ok: false, reason: `开新票据要写清楚新问题本身（不少于 ${minQ} 字），不能留空或只写"继续"。` }
  }
  const archive = {
    question: state.question,
    stage: state.stage,
    reads: state.reads,
    priorArtLen: (state.priorArt || '').length,
    planLen: (state.plan || '').length,
    scratchCalls: state.scratchCalls,
    denials: state.denials,
  }
  const next = createState(q)
  next.tickets = (state.tickets || 1) + 1
  next.history = [...(state.history || []), archive].slice(-20)
  next.trail = [{ from: `ticket#${state.tickets || 1}`, to: `ticket#${next.tickets}`, at: Date.now() }]
  return {
    ok: true,
    state: next,
    note: `已开 ticket#${next.tickets}，回到 survey。上一张票据（${archive.question || '未命名'}）已存档：读 ${archive.reads} 次、草稿算 ${archive.scratchCalls} 次。`,
  }
}

/**
 * 校验一次阶段推进。
 *
 * 三条硬条件，缺一不可：
 *   1. 只能往前一步，但**允许退回 survey**（读了新东西发现判据要改，是正常研究动作）；
 *   2. 每一阶段必须留下一段可检查的文字（priorArt / plan），空着不带；
 *   3. 推进到 synthesis 前，文献类工具必须真的调用过若干次——
 *      光写一段"前人做过什么"的文字没有成本，模型可以凭记忆编；
 *      但 paper_search/paper_fetch 的调用是有代价的，能证明它真的去查了。
 *
 * @param {object} state - 当前状态。
 * @param {string} to - 目标阶段。
 * @param {{priorArt?: string, plan?: string}} payload - 提交的内容。
 * @param {object} [config] - 阈值。
 * @returns {{ok: boolean, reason?: string, state?: object, note?: string}} 判定结果。
 */
/**
 * 引文校验：prior_art 里的每一条"前人做了什么"，必须能指回 refs/ 下的原文。
 *
 * 为什么加这一条：原来的门禁只查字数（≥400），而 400 字是两三句话就能凑满的。
 * 模型完全可以凭记忆写一段"Berry 研究了三距离问题，用了椭圆曲线"——这句话
 * 大概率是对的，但它证明不了模型读过手上这几篇，只证明它知道这件事。**知道
 * 和读到是两回事**，前者不能作为"前人卡在哪一步"的依据。
 *
 * 格式：`[refs/文件名.txt] “原文里连续出现的一句话”`
 * 只做归一化空白后的子串匹配，不做语义比对——语义比对需要模型，而门禁的
 * 全部意义是"不靠模型自觉"。
 *
 * @param {string} text - prior_art 正文。
 * @param {string} refsDir - 文献目录。
 * @returns {{total:number, ok:string[], missing:Array<{file:string,quote:string}>, noFile:string[]}}
 */
export function checkCitations(text, refsDir) {
  const out = { total: 0, ok: [], missing: [], noFile: [] }
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  // 只认这一种形状：方括号给文件，紧跟一句带引号的话。放宽到中英文引号。
  const re = /\[(?:refs[\\/])?([^\]\s]+\.(?:txt|md))\]\s*[「“"']([^」”"']{8,400})[」”"']/g
  let m
  while ((m = re.exec(text)) !== null) {
    out.total++
    const file = m[1]
    const quote = m[2]
    const full = path.isAbsolute(file) ? file : path.join(refsDir, file)
    if (!fs.existsSync(full)) { out.noFile.push(file); continue }
    let hay = ''
    try { hay = norm(fs.readFileSync(full, 'utf8')) } catch { out.noFile.push(file); continue }
    // 引文可能被模型轻微改动；取前 40 字符做锚点，够长到不会撞车，够短到容错。
    const needle = norm(quote).slice(0, Math.min(40, norm(quote).length))
    if (hay.includes(needle)) out.ok.push(file)
    else out.missing.push({ file, quote: quote.slice(0, 60) })
  }
  return out
}

export function advance(state, to, payload = {}, config = {}) {
  const minReads = Number.isFinite(config.minReads) ? config.minReads : 3
  const minPriorArt = Number.isFinite(config.minPriorArtChars) ? config.minPriorArtChars : 400
  const minPlan = Number.isFinite(config.minPlanChars) ? config.minPlanChars : 300

  const cur = state.stage
  const curIdx = STAGES.indexOf(cur)
  const toIdx = STAGES.indexOf(to)
  if (toIdx < 0) return { ok: false, reason: `未知阶段 "${to}"；可选：${STAGES.join(' / ')}` }
  if (toIdx === curIdx) return { ok: false, reason: `已经在 ${STAGE_LABEL[cur]}，不需要重复推进。` }

  // 回退：只允许回到 survey。prior_art / plan 清空——读到新东西后必须重新写，
  // 否则"退回去再立刻推回来"就是一次零成本的洗白。
  if (toIdx < curIdx) {
    if (to !== 'survey') {
      return {
        ok: false,
        reason: `只能退回 survey（现在 ${STAGE_LABEL[cur]}）。要改判据就回 survey 重读，不能直接跳到 ${STAGE_LABEL[to]}。`,
      }
    }
    const back = {
      ...state,
      stage: 'survey',
      priorArt: '',
      plan: '',
      trail: [...state.trail, { from: cur, to: 'survey', at: Date.now(), kind: 'reopen' }],
    }
    return {
      ok: true,
      state: back,
      note: '已退回 survey：prior_art 与 plan 已清空，读到新证据后要重新提交。已读计数保留（读过的还算读过）。',
    }
  }

  if (toIdx > curIdx + 1) {
    return { ok: false, reason: `不能跳级：现在是 ${STAGE_LABEL[cur]}，下一个只能是 ${STAGE_LABEL[STAGES[curIdx + 1]]}。` }
  }

  const next = { ...state, trail: [...state.trail, { from: cur, to, at: Date.now() }] }

  if (to === 'synthesis') {
    const text = String(payload.priorArt || '').trim()
    if (state.reads < minReads) {
      return {
        ok: false,
        reason:
          `文献类工具只调用了 ${state.reads} 次，至少要 ${minReads} 次才能进入 synthesis。` +
          '请先用 paper_search 检索、paper_fetch 抓全文、或读 refs/ 下的 .txt，把前人做到哪一步弄清楚。',
      }
    }
    if (text.length < minPriorArt) {
      return {
        ok: false,
        reason:
          `prior_art 只有 ${text.length} 字，至少要 ${minPriorArt} 字。` +
          '要写清楚：谁做过、把问题化成了什么代数对象、用的什么降维手段、卡在哪一步。' +
          '只写"某某研究过这个问题"不算。',
      }
    }
    // 引文校验：字数只是"有没有写"，引文才管"读没读"。
    // refs/ 不存在时跳过——不是所有研究都有本地文献，硬拦会把没文献的题卡死。
    const refsDir = config.refsDir || path.join(process.cwd(), 'refs')
    let citeNote = ''
    if (config.requireCitation !== false && fs.existsSync(refsDir)) {
      const minCite = Number.isFinite(config.minCitations) ? config.minCitations : 2
      const c = checkCitations(text, refsDir)
      if (c.total < minCite) {
        return {
          ok: false,
          reason:
            `prior_art 里的引文只有 ${c.total} 条，至少要 ${minCite} 条。` +
            '每条写成 `[refs/文件名.txt] “原文里连续出现的一句话”`，门禁会去原文里检索这句话。' +
            '只写结论不指原文，等于"我知道"而不是"我读到"——后者才有资格决定往哪走。',
        }
      }
      if (c.noFile.length) {
        return { ok: false, reason: `这些文件在 refs/ 下不存在：${c.noFile.join(', ')}` }
      }
      if (c.missing.length) {
        const list = c.missing.map((x) => `[${x.file}] “${x.quote}…”`).join('；')
        return {
          ok: false,
          reason:
            `这些话在原文里检索不到：${list}。` +
            '引文必须是原文里连续存在的一段（可以截取，不能改写）。回去读那一篇，把句子照抄过来。',
        }
      }
      citeNote = `（引文 ${c.total} 条已核）`
    }
    next.priorArt = text
    next.stage = 'synthesis'
    const done = { ok: true, state: next }
    if (citeNote) done.note = citeNote
    return done
  }

  // to === 'verify'
  const text = String(payload.plan || '').trim()
  if (!next.priorArt) {
    return { ok: false, reason: '没有 survey 阶段留下的 prior_art，流程不完整，不能进入 verify。' }
  }
  if (text.length < minPlan) {
    return {
      ok: false,
      reason:
        `plan 只有 ${text.length} 字，至少要 ${minPlan} 字。要写清三件事：` +
        '① 你要验证的具体判据是什么（一个可判真假的命题，不是"跑个搜索看看"）；' +
        '② 为什么这个判据值得验证——它接在哪条前人没走通的路上；' +
        '③ 什么样的结果会推翻你的思路。',
    }
  }
  next.plan = text
  next.stage = 'verify'
  return { ok: true, state: next }
}

/**
 * 流程已走完（verify）时的拒绝理由：不是禁止算，是禁止**你**算。
 *
 * 判据已经写好了，剩下的是一次有明确边界的计算——这种活的产物是"结论 + 脚本"，
 * 过程则是几万行中间输出。让主智能体亲自跑，等于用上下文换它根本不需要的东西。
 * 所以强制委派：子智能体在独立上下文里执行，只带回结果。
 *
 * @param {object} state - 当前状态。
 * @param {string} toolName - 被拦的工具。
 * @param {{tier: string, why: string}} tier - 分级结果。
 * @param {object} [config] - 阈值。
 * @returns {string} 给模型看的委派说明。
 */
export function delegationReason(state, toolName, tier, config = {}, delegateTool = 'agent_teams_create') {
  const isExplore = tier.tier === 'explore'
  const label = isExplore ? '探索级' : '证据级'
  const head =
    `[研究流程门禁] "${toolName}" 这次调用被判定为**${label}计算**。` +
    `\n判定原因：${tier.why}。` +
    `\n阶段没问题（你已经在 ${STAGE_LABEL.verify}），但这类计算不由主智能体执行——组队派给专人。`

  const why =
    `\n\n为什么要外包，这不是流程洁癖：` +
    `\n一次扫描的产物是"结论 + 脚本"，过程却是几万行中间输出。你亲自跑，等于用上下文换你根本不需要的东西；` +
    `而上下文一旦被日志填满，你后面就没法思考了。专职成员的独立上下文正是为这件事存在的。`

  const how =
    `\n\n怎么派：用 ${delegateTool} 组队，每个成员在计划里带 tool_policy 指定角色。三个角色，工具是硬隔离的（不是靠提示词自觉）：` +
    `\n· surveyor 文献官——只有文献工具，拿不到任何算力。派它查前人做到哪、卡在哪。` +
    `\n· computer 计算官——只有算力，拿不到文献工具。派它实现判据、跑、回报数字。` +
    `\n· adversary 复核官——有算力但不许改交付物、不许靠搜文献敷衍。派它独立审 computer 的结论，专门找反例。` +
    `\n\n每个任务必须写清四件事：` +
    `\n① 判据：一字不差抄你 plan 里那条，成员看不到你的上下文；` +
    `\n② 算法与规模：什么算法、上界多少、复杂度估计；` +
    `\n③ 反证条件：什么输出算推翻判据、什么算"无结论"（最容易漏；漏了就会把"没搜到"当成"不存在"）；` +
    `\n④ 交付物：脚本落盘路径 + 关键输出 + 一句结论。明确要求它不要贴中间日志。` +
    `\n\n**计算工具要写死，不要给选项。** 上一轮任务书写了"viz_python 或 browser 的 eval"，成员挑了 browser，` +
    `而那个环境浏览器没开，它查了一次状态就放弃了，一个数字都没算出来。正确写法是：「用 viz_python 执行，不要用 browser」。`

  const exploreExtra = isExplore
    ? `\n\n探索级额外要求：在 prompt 里写明预算（时间上限、规模上限）与停止条件。` +
      `没有停止条件的搜索不算实验，算消耗——它会一直跑到超时，然后你得到一个没有信息量的"没找到"。`
    : ''

  return head + why + how + exploreExtra
}

/**
 * 委派任务书本身被判为证据/探索级，但流程还没走到 verify 时的拒绝理由。
 *
 * 这个洞必须堵：否则主智能体可以把一次大扫描包装成"给子智能体的调研任务"，
 * 绕过前面所有约束。判据对任务书同样成立。
 *
 * @param {object} state - 当前状态。
 * @param {{tier: string, why: string}} tier - 分级结果。
 * @param {object} [config] - 阈值。
 * @returns {string} 给模型看的原因。
 */
export function delegationTooEarly(state, tier, config = {}) {
  const minPlan = Number.isFinite(config.minPlanChars) ? config.minPlanChars : 300
  const label = tier.tier === 'explore' ? '探索级' : '证据级'
  return (
    `[研究流程门禁] 这次的委派任务书里描述的是**${label}计算**（${tier.why}），但你现在在 ${STAGE_LABEL[state.stage]}。` +
    `\n\n委派不是免检通道：子智能体只会照着任务书执行。任务书里没写判据，它就只能瞎搜；` +
    `搜完带回来的是一堆数字，而你不知道该拿它们怎么办。` +
    `\n\n先走完流程：` +
    (state.stage === 'survey'
      ? `\n· 现在缺的是"前人做到哪一步"。文献类调用 ${state.reads} 次，先读够再谈计算。`
      : `\n· 现在缺的是判据。调用 research_stage(advance, to=verify, plan=...) 写清：验证什么命题、接在哪条前人没走通的路上、什么结果会推翻它（不少于 ${minPlan} 字）。`) +
    `\n· 到位之后再用 subagent 委派，那时任务书才有东西可写。`
  )
}

/**
 * 生成拒绝理由。要让模型知道**下一步该做什么**，而不只是"不行"。
 *
 * 关键是要说清"你这次为什么被判定为证据级"——否则模型会以为所有计算都被禁，
 * 转而去钻 browser eval 那种洞（v0.1 已经发生过一次）。
 *
 * @param {object} state - 当前状态。
 * @param {string} toolName - 被拦的工具。
 * @param {object} [config] - 阈值。
 * @param {string} [why] - 分级器给出的理由。
 * @returns {string} 给模型看的原因。
 */
export function denialReason(state, toolName, config = {}, why = '') {
  const minReads = Number.isFinite(config.minReads) ? config.minReads : 3
  const minPriorArt = Number.isFinite(config.minPriorArtChars) ? config.minPriorArtChars : 400
  const scratchLimit = Number.isFinite(config.scratchLimit) ? config.scratchLimit : 8
  const head =
    `[研究流程门禁] "${toolName}" 这次调用被判定为**证据级/探索级计算**，在 ${STAGE_LABEL[state.stage]} 阶段不可用。` +
    (why ? `\n判定原因：${why}。` : '')

  const clarify =
    `\n注意两点：` +
    `\n· 单次小规模求值（草稿级 / scratch，如核对文献里的一个数、验证一个恒等式）在任何阶段都放行，无需解锁。` +
    `本问题已用掉 ${state.scratchCalls ?? 0}/${scratchLimit} 次草稿额度。` +
    `\n· 即使走到 verify，这类计算也不由你亲自执行，而是委派子智能体（独立上下文，只带回结论）。` +
    `但在判据写出来之前，委派也没有意义——你没法给子智能体一个它看得懂的任务。`

  if (state.stage === 'survey') {
    return (
      head +
      clarify +
      `\n现在只做一件事：把前人做到哪一步搞清楚。当前文献类调用 ${state.reads}/${minReads} 次。` +
      `\n可用：paper_search / paper_resolve / paper_fetch / paper_verify、读 refs/ 下的 .txt、web 检索。` +
      `\n解锁条件：文献类调用满 ${minReads} 次，并调用 research_stage(advance, to=synthesis, prior_art=...) 提交不少于 ${minPriorArt} 字的前人经验综述（谁做过、化成了什么代数对象、什么手段、卡在哪一步）。` +
      `\n理由：数值搜索只在问题已经有明确的判据之后才有意义；在此之前它只会产出一堆"小范围内没找到"，而这对高度无界的问题没有信息量。`
    )
  }
  return (
    head +
    clarify +
    `\n现在应当把思路收敛成一个可判真假的判据，而不是开始算。` +
    `\n解锁条件：调用 research_stage(advance, to=verify, plan=...) 提交验证计划（判据是什么、接在哪条前人没走通的路上、什么结果会推翻它）。`
  )
}

/** 当前进度的一句话摘要，供状态工具和 systemPrompt 共用。 */
export function statusLine(state, config = {}) {
  const minReads = Number.isFinite(config.minReads) ? config.minReads : 3
  const scratchLimit = Number.isFinite(config.scratchLimit) ? config.scratchLimit : 8
  const parts = [
    `ticket#${state.tickets ?? 1}`,
    state.question ? `问题「${state.question.length > 24 ? `${state.question.slice(0, 24)}…` : state.question}」` : '问题未命名',
    `阶段 ${state.stage}`,
    `文献类调用 ${state.reads}/${minReads}`,
    `草稿计算 ${state.scratchCalls ?? 0}/${scratchLimit}`,
    `委派 ${state.delegations ?? 0}`,
    `被拦的批量计算 ${state.denials}`,
  ]
  if ((state.directRuns ?? 0) > 0) parts.push(`降级直跑 ${state.directRuns}`)
  if (state.priorArt) parts.push(`prior_art ${state.priorArt.length} 字`)
  if (state.plan) parts.push(`plan ${state.plan.length} 字`)
  return parts.join(' · ')
}
