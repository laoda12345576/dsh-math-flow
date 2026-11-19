/**
 * dsh-plugin-research-gate — 研究流程门禁（cordis 胶水）
 *
 * 解决的问题不是"模型不会研究"，而是"模型会跳过研究"：
 * 拿到一个开放问题，它倾向于立刻去写数值搜索、跑出一些数字，用产出替代进展。
 * 提示词劝不住这件事——上一轮实测里，写了"先读文献"的任务，模型依然 0 次调用
 * 文献工具、直接开算。
 *
 * 所以这里把顺序做成**工具层面的硬约束**：
 *   survey（禁算） → synthesis（禁算） → verify（放行）
 * 前两个阶段调用计算类工具会被 tools.guard 拦下，并告诉它还差什么才能解锁。
 *
 * 与 SKILL.md 的分工：skill 负责讲"为什么这样排、每阶段该产出什么"，
 * 插件负责"不产出就走不到下一步"。前者可被忽略，后者不能。
 *
 * @module dsh-plugin-research-gate
 */

import { resolveDefineTool } from './toolkit.js'
import path from 'node:path'
import fs from 'node:fs'
import {
  STAGES,
  STAGE_LABEL,
  classify,
  computeTier,
  textTier,
  isReadOnlyShell,
  clockLine,
  localRefPath,
  createState,
  advance,
  openTicket,
  denialReason,
  delegationReason,
  delegationTooEarly,
  inspectSurveyCall,
  statusLine,
} from './gate.js'

/** 插件名。 */
export const name = 'research-gate'

/** 硬依赖：两个服务缺一个，门禁就不成立，不能让插件"看起来起来了"。 */
export const inject = ['systemPrompt', 'tools']

const DEFAULTS = {
  enabled: true,
  minReads: 3,
  minPriorArtChars: 400,
  minPlanChars: 300,
  minQuestionChars: 8,
  /** 单个问题内允许的草稿级计算次数，超了之后一律按证据级处理。 */
  scratchLimit: 8,
  /** 用户可追加的证据级识别正则（字符串形式，来自 JSON 配置）。 */
  evidenceExtra: [],
  /** 额外认作"委派通道"的工具名正则。默认已认 subagent / task / agent_teams_create。 */
  delegationTools: [],
  allowExtra: [],
  denyExtra: [],
  injectPrompt: true,
  order: 4900,
  /** 真实时钟：由 dsh-lab.sh 写的文件，插件只负责渲染。 */
  injectClock: true,
  clockFile: '.clock.json',
  clockOrder: 130,
}

/** 每个 agent 一份状态。key 取会话 id，取不到就退化成单例。 */
const STATES = new Map()

function stateKey(agent) {
  const id = agent?.session?.id ?? agent?.id ?? agent?.sessionId
  return typeof id === 'string' && id !== '' ? id : '__global__'
}

function stateFor(agent) {
  const k = stateKey(agent)
  let s = STATES.get(k)
  if (s === undefined) {
    s = createState()
    STATES.set(k, s)
  }
  return s
}

/**
 * 当前 agent 是不是子智能体。
 *
 * dsh 在派生时把 `header.origin = 'subagent'` 写进子会话，同时记 parentSession。
 * 门禁靠这个标志区分"谁有资格亲自跑批量计算"——子智能体本来就该干这个，
 * 否则它存在的意义就没了。
 *
 * @param {object} agent - guard 传入的 agent。
 * @returns {boolean} 是否子智能体。
 */
export function isSubagent(agent) {
  const header = agent?.session?.header ?? agent?.header
  if (header === undefined || header === null) return false
  // origin / parentSession 是 dsh 自己的派生标记（dsh-subagent/lib/index.js 写入）；
  // delegationDepth 是 agent-teams 那类"带血缘的成员"也会带的字段。
  // 三条取并集：宁可把成员当子智能体放行，也不能让干活的成员被门禁卡死。
  return header.origin === 'subagent' || header.parentSession !== undefined || (header.delegationDepth ?? 0) > 0
}

/**
 * 当前环境里有没有可用的委派工具。
 *
 * 这不是防御性编程，是实测撞出来的：这份 profile 的工具表里既没有 `subagent`
 * 也没有 shell，只有 viz_python 之类的计算通道。真机日志里模型自己说
 * `"subagent" isn't in my tool list`。
 *
 * 如果这时仍然强制委派，evidence 计算就永远做不成——门禁从"约束"变成"死锁"。
 * 所以：有委派工具就强制委派，没有就降级放行并明确告知风险。**宁可放宽，不可卡死。**
 *
 * @param {object} tools - tools 服务。
 * @param {object} agent - 当前 agent（作为视图作用域）。
 * @returns {string[]} 可用的委派工具名。
 */
function findDelegationTools(tools, agent, extra = []) {
  try {
    const visible = tools.view?.(agent)?.visible
    if (visible === undefined) return []
    const extraRe = (Array.isArray(extra) ? extra : []).map((n) => new RegExp(n, 'i'))
    return [...visible.keys()].filter((n) => /^subagent|^task$|_subagent$|^agent_teams_create$/i.test(n) || extraRe.some((re) => re.test(n)))
  } catch {
    return []
  }
}

/**
 * 当前 agent 能看到的工具名。给 denialReason 用来**只推荐真的装了的工具**。
 *
 * 返回 null 而不是空数组：拿不到视图时，提示应该按全集写，而不是说"一个都没有"。
 *
 * @param {object} tools - tools 服务。
 * @param {object} agent - 当前 agent。
 * @returns {string[]|null} 工具名，或 null（未知）。
 */
function visibleToolNames(tools, agent) {
  try {
    const visible = tools.view?.(agent)?.visible
    if (visible === undefined || visible === null) return null
    return [...visible.keys()]
  } catch {
    return null
  }
}

/** 给模型的固定规则段。它不能替代 guard，但能让模型少撞几次墙。 */
const PROMPT_TEXT = [
  '研究纪律（research-gate 门禁，强制执行）：',
  '任何研究类问题都分三步，顺序不可颠倒：',
  '1) survey — 只读文献。先弄清楚谁做过、把问题化成了什么代数对象、用什么降维手段、卡在哪一步。',
  '2) synthesis — 只推理写作。把前人没走通的地方收敛成一个可判真假的判据。',
  '3) verify — 判据成立，可以开始取证。',
  '',
  '计算分三级，按规模而非学科划分：',
  '· scratch（单次小规模求值，如核对文献里的一个数、验证一个恒等式）——任何阶段都可自己算。但输出要标 [scratch]，只能用于理解，不能写进报告当论据。',
  '· evidence（覆盖一个范围的批量计算：while、for+range、搜索/枚举语义、显式上界）——verify 之后才允许，且不由主智能体执行。',
  '· explore（更大、往往没有停止条件：10^5 以上的扫描、蒙特卡洛、参数空间搜索）——同上，且委派时必须写明预算与停止条件。',
  '',
  'evidence / explore 一律组队派给专人，理由不是流程洁癖：一次扫描的产物是"结论+脚本"，过程却是几万行中间输出；你亲自跑等于用上下文换你不需要的东西，上下文被填满之后就没法思考了。',
  '',
  '组队时每个成员在计划里带 tool_policy 指定角色。工具是硬隔离的，不是靠自觉：',
  '· surveyor 文献官——只有文献工具，拿不到任何算力。查前人做到哪、卡在哪。',
  '· computer 计算官——只有算力，拿不到文献工具。实现判据、跑、回报数字。',
  '· adversary 复核官——有算力，但不许改交付物、不许靠搜文献敷衍。独立审 computer 的结论，专门找反例。',
  '',
  '任务书写清四件事：①判据（成员看不到你的上下文，一字不差抄）②算法与规模 ③什么输出算推翻判据、什么算无结论 ④交付物是脚本路径+关键输出+一句结论，不要中间日志。',
  '计算工具写死，不要给选项。"viz_python 或 browser"这种写法会让成员挑了没开的通道然后直接放弃——上一轮就是这么丢的。',
  '在 verify 之前组队派批量计算会被拦：任务书里没写判据，成员只能瞎搜，带回来的数字你不知道该怎么用。',
  '如果本环境连组队工具都没有，批量计算会降级为你自己跑：这时必须主动限制输出体积（只打印统计与极值，不要逐条打印），否则上下文会被日志吃掉。',
  '',
  'verify 绑定的是"一个问题"，不是整个会话。换了子问题，用 research_stage(action=open, question=...) 开新票据，重新走 survey。',
  '用 research_stage 查看进度与推进阶段。被拦下的计算会告诉你它为什么被判定为 evidence/explore 级。',
  '为什么这么排：数值搜索只在问题已经被想清楚、只剩"这个判据对不对"时才有意义。在判据之前搜索，产出的是"小范围内没找到"，对高度无界的问题没有信息量。',
].join('\n')

export async function apply(ctx, config = {}) {
  const opt = { ...DEFAULTS, ...config }
  if (opt.enabled === false) return

  // 真实时钟文件。门禁要用它的 t0 判"这个脚本是不是本轮才出现的"
  // （否则模型可以现写一个 tools/brute.mjs 丢进去骗豁免）；第 4 节用它渲染时钟。
  const clockFile = path.resolve(process.cwd(), opt.clockFile)
  const clockT0 = (() => {
    try {
      const c = JSON.parse(fs.readFileSync(clockFile, 'utf8'))
      return typeof c?.t0 === 'number' ? c.t0 : null
    } catch {
      return null
    }
  })()
  // 配置可能来自 JSON（正则只能写成字符串），这里统一编译。
  opt.evidenceExtra = (Array.isArray(opt.evidenceExtra) ? opt.evidenceExtra : [])
    .map((re) => (re instanceof RegExp ? re : new RegExp(String(re), 'i')))
    .filter((re) => re instanceof RegExp)

  // ---- 1. 门禁本体 --------------------------------------------------------
  const tools = ctx.tools
  if (tools === undefined || typeof tools.guard !== 'function') {
    console.error(`[${name}] tools.guard 不可用：门禁无法成立，插件降级为只提供 research_stage（不拦截）`)
  } else {
    ctx.tools.guard((exec) => {
      const agent = exec?.agent
      const st = stateFor(agent)
      const toolName = String(exec?.name || '')
      const args = exec?.arguments
      const sub = isSubagent(agent)

      // ── 0. 委派本身也要过检 ────────────────────────────────────────────
      // 否则主智能体可以把一次大扫描包装成"给子智能体的调研任务"，
      // 绕过前面所有约束。判据对任务书同样成立。
      if (/^subagent/i.test(toolName) && !sub) {
        const tt = textTier(args, { ...opt, noBudget: true })
        if (tt.tier !== 'scratch' && st.stage !== 'verify') {
          st.denials += 1
          return delegationTooEarly(st, tt, opt)
        }
        st.delegations += 1
        return undefined
      }

      // P1-6：读本地 refs/*.txt 也算读文献。
      //
      // 原来 reads 只数 paper_search/fetch/verify/cnki/zotero。实测里模型用 read
      // 把 refs 全文翻了一遍（**真读了**），却被记为没读，于是它为了过闸补了三次
      // paper_* 调用——两次重复检索、一次失败。门禁被满足了，读的量一点没变。
      // 这正是"数调用了哪个工具"与"读没读"的口径错位。判定本身抽成 gate.js 的
      // localRefPath，好让测试能直接盯住"哪些调用会被算"。
      const refFile = localRefPath(toolName, args)
      if (refFile !== null) {
        // 按文件去重：同一份读十遍算一次，否则刷指标比读文献便宜。
        if (!Array.isArray(st.readFiles)) st.readFiles = []
        if (!st.readFiles.includes(refFile)) {
          st.readFiles.push(refFile)
          st.reads += 1
          if (st.readTools.length < 50) st.readTools.push(`read:${refFile.split('/').pop()}`)
        }
        return undefined
      }

      const kind = classify(toolName, opt)
      // 名字是调研工具、参数在算，也要走分级（browser eval 这个洞是实测撞出来的）。
      const sneaky = kind === 'survey' ? inspectSurveyCall(toolName, args) : null
      // 纯查看的 shell 命令（ls、Get-ChildItem、Select-String）不是计算，
      // 不该消耗草稿额度——把它算进去，八次之后连看一眼目录都被拦。
      const looksLikeCompute = (kind === 'compute' && !isReadOnlyShell(toolName, args, clockT0)) || sneaky !== null

      if (!looksLikeCompute) {
        if (kind === 'survey' && !sub) {
          st.reads += 1
          if (st.readTools.length < 50) st.readTools.push(toolName)
        }
        return undefined
      }

      // ── 分级：只看规模，不看学科 ────────────────────────────────────────
      // 读文献时核对一个数字，是理解的一部分；批量枚举才是要用这个门禁治的病。
      const tier = computeTier(args, st, opt, toolName)
      if (tier.tier === 'scratch') {
        st.scratchCalls += 1
        return undefined
      }

      // 子智能体本来就是来干粗活的：它的上下文是一次性的，跑完就丢。
      if (sub) {
        st.scratchCalls += 1
        return undefined
      }

      // 主智能体：判据没写出来之前，连委派都没意义。
      if (st.stage !== 'verify') {
        st.denials += 1
        const label = sneaky === null ? toolName : `${toolName}（${sneaky}）`
        return denialReason(st, label, opt, tier.why, visibleToolNames(tools, agent))
      }

      // 判据有了，但活不该由主智能体干。
      const delegates = findDelegationTools(tools, agent, opt.delegationTools)
      if (delegates.length === 0) {
        // 没有委派工具：放行，但要记账并明确告诉它这是降级，别以为可以随便扫。
        st.directRuns = (st.directRuns ?? 0) + 1
        st.scratchCalls += 1
        return undefined
      }
      st.denials += 1
      return delegationReason(st, toolName, tier, opt, delegates[0])
    })
  }

  // ---- 2. 状态工具 --------------------------------------------------------
  if (tools !== undefined && typeof tools.register === 'function') {
    try {
      const { defineTool } = await resolveDefineTool()
      const output = { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] }

      tools.register(
        defineTool({
          name: 'research_stage',
          description:
            '查看、推进或更换研究票据。三个阶段：survey（读文献）→ synthesis（形成判据）→ verify（可以取证）。' +
            '计算分三级：单次小规模求值（scratch）任何阶段都能自己算；批量枚举（evidence）与开放搜索（explore）只在 verify 之后允许，' +
            '而且不由主智能体执行，必须用 subagent 委派。' +
            'verify 是绑定"一个问题"的：换了子问题必须 action=open 开新票据，重新走 survey。' +
            '推进必须提交内容：进 synthesis 要交 prior_art（前人做到哪一步），进 verify 要交 plan（你要验证的判据是什么、为什么值得验证）。',
          parameters: {
            action: {
              type: 'string',
              enum: ['status', 'advance', 'open'],
              description: 'status 查看进度；advance 推进阶段（可退回 survey）；open 换问题、开新票据。',
            },
            to: { type: 'string', enum: STAGES, description: 'advance 时的目标阶段，只能往前一步，或退回 survey。' },
            question: {
              type: 'string',
              description: 'action=open 时必须：新问题本身，写清楚问的是什么。不少于 8 字。',
            },
            prior_art: {
              type: 'string',
              description: '进 synthesis 必须：前人经验综述。谁做过、化成了什么代数对象、用什么手段、卡在哪一步。不少于 400 字。',
            },
            plan: {
              type: 'string',
              description: '进 verify 必须：验证计划。①可判真假的判据 ②它接在哪条前人没走通的路上 ③什么结果会推翻它。不少于 300 字。',
            },
          },
          output,
          async execute(args, exec) {
            const agent = exec?.agent
            const st = stateFor(agent)
            const action = String(args?.action || 'status')
            if (action === 'status') {
              return {
                ok: true,
                stage: st.stage,
                label: STAGE_LABEL[st.stage],
                ticket: st.tickets ?? 1,
                question: st.question || '(未命名)',
                summary: statusLine(st, opt),
                reads: st.reads,
                denials: st.denials,
                scratch_calls: st.scratchCalls ?? 0,
                scratch_limit: opt.scratchLimit,
                delegations: st.delegations ?? 0,
                direct_runs: st.directRuns ?? 0,
                prior_art_chars: st.priorArt.length,
                plan_chars: st.plan.length,
                read_tools: st.readTools.slice(-20),
                next: STAGES[STAGES.indexOf(st.stage) + 1] ?? null,
                hint:
                  st.stage === 'verify'
                    ? '判据已成立。批量计算请用 subagent 委派，不要自己跑；换了子问题请 action=open 开新票。'
                    : '草稿级小算随时自己算；批量计算要等 verify，且到时候是委派子智能体执行。',
              }
            }
            if (action === 'open') {
              const r = openTicket(st, args?.question, opt)
              if (!r.ok) return { ok: false, reason: r.reason, stage: st.stage, summary: statusLine(st, opt) }
              STATES.set(stateKey(agent), r.state)
              return {
                ok: true,
                stage: r.state.stage,
                label: STAGE_LABEL[r.state.stage],
                ticket: r.state.tickets,
                question: r.state.question,
                summary: statusLine(r.state, opt),
                note: r.note,
              }
            }
            const r = advance(st, String(args?.to || ''), { priorArt: args?.prior_art, plan: args?.plan }, opt, visibleToolNames(tools, agent))
            if (!r.ok) return { ok: false, reason: r.reason, stage: st.stage, summary: statusLine(st, opt) }
            STATES.set(stateKey(agent), r.state)
            return {
              ok: true,
              stage: r.state.stage,
              label: STAGE_LABEL[r.state.stage],
              ticket: r.state.tickets ?? 1,
              summary: statusLine(r.state, opt),
              note:
                r.note ??
                (r.state.stage === 'verify'
                  ? '判据已成立。现在用 subagent 委派批量计算：把判据、算法与规模、反证条件、交付物写进 prompt。不要自己跑。'
                  : '进入 synthesis：现在把前人没走通的地方收敛成一个可判真假的判据，仍然不要开算。'),
            }
          },
        })
      )
    } catch (error) {
      console.error(`[${name}] research_stage 注册失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- 3. 提示段 ----------------------------------------------------------
  if (opt.injectPrompt) {
    try {
      const host = ctx?.systemPrompt?.ctx ?? ctx
      host.systemPrompt.section({
        name: 'dsh-plugin-research-gate',
        order: opt.order,
        interpolate: false,
        text: () => PROMPT_TEXT,
      })
    } catch (error) {
      console.error(`[${name}] 提示段注入失败（不影响拦截）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- 4. 真实时钟 --------------------------------------------------------
  //
  // 用 systemPrompt.context 而不是 section：context 是**每轮重渲染**的运行时快照
  // （"Current runtime context. This snapshot supersedes earlier runtime-context
  // snapshots."），放在这里才会随会话推进刷新；section 在系统提示顶部，隔几十轮
  // 之后模型基本看不见它。
  //
  // 只给读数，不给目标：text 里明说"不存在用够才算数"。
  if (opt.injectClock) {
    try {
      const host = ctx?.systemPrompt?.ctx ?? ctx
      host.systemPrompt.context({
        name: 'research-clock',
        order: opt.clockOrder,
        text: () => clockLine(clockFile),
      })
    } catch (error) {
      console.error(`[${name}] 时钟注入失败（不影响拦截）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 测试与运维用：清空所有会话状态。 */
export function resetAllStates() {
  STATES.clear()
}
