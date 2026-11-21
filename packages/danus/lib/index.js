/**
 * dsh-plugin-danus — 把 Danus 的编排面搬进 dsh 会话。
 *
 * 分三层，各自解决一个不同的问题：
 *
 *   A 网关（mcp.js）          主智能体能不能**看见**该看见的东西
 *   B 控制面（control.js）    主智能体能不能**启停**那窝 worker
 *   C 契约（skills/danus-*）  模型知不知道**该怎么用**
 *
 * 为什么 A 不是"在 patch 里多挂一行 mcp-client"：Danus 的权限边界是
 * "角色能看到哪些工具"（`danus/gateway/roles.py`），主智能体**没有**
 * `fact_submit`。把挂载交给宿主，插件就拿不到那份清单，也就无法断言
 * 边界有没有被绕过。这里每次启动读一次 `tools/list`，原样注册——多一个不
 * 注册，少一个不补。测试里那条 `main 看不到 fact_submit` 就是这条边界的哨兵。
 *
 * @module dsh-plugin-danus
 */

import { resolveDefineTool } from './toolkit.js'
import { resolveConfig } from './config.js'
import { McpError, McpStdioClient } from './mcp.js'
import { describeLaunch, launchFor } from './launch.js'
import { buildCliArgs, runDanusCli, toToolResult } from './control.js'
import { createMapper } from './schema.js'
import { doctor } from './doctor.js'
import { PROMPT_TEXT } from './prompt.js'

export const name = 'dsh-plugin-danus'

export const inject = ['systemPrompt', 'tools']

const OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const warn = (message) => console.error(`[${name}] ${message}`)

/**
 * @param {object} ctx cordis 上下文
 * @param {object} [config] cordis.patch.yml 里的 config
 */
export async function apply(ctx, config = {}) {
  const solved = resolveConfig(config)
  const cfg = solved.config
  const state = {
    problems: solved.problems,
    client: null,
    registered: [],
    gateway: { ok: false, tools: [], error: null },
    mapper: createMapper(),
  }

  const tools = ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') {
    warn('ctx.tools is unavailable — nothing can be registered; this plugin needs a dsh profile')
    return
  }
  let defineTool
  try {
    ;({ defineTool } = await resolveDefineTool())
  } catch (error) {
    warn(error.message)
    return
  }

  const register = (def) => {
    try {
      tools.register(defineTool({ ...def, output: def.output ?? OUTPUT }))
      return true
    } catch (error) {
      warn(`could not register ${def.name}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // ── 配置不全时：别静默 ──────────────────────────────────────────────────
  // 工具全都不注册会让模型以为"这个插件没装"，然后换个办法硬来。注册一个
  // doctor，让它一眼看到为什么。
  if (!solved.ok) {
    for (const problem of solved.problems) warn(problem)
    register(
      controlTool('danus_doctor', 'Danus 插件的体检。当前配置不完整，先看这里的 problems。', {}, async () => ({
        ok: false,
        problems: solved.problems,
        hint:
          'Set `root:` in the plugin config (the directory holding bin/danus and danus/gateway) ' +
          'or export DANUS_ROOT, then restart the profile.',
      })),
    )
    return
  }

  // ── B 控制面 ────────────────────────────────────────────────────────────
  if (cfg.control) {
    for (const def of controlTools(cfg, state)) {
      if (register(def)) state.registered.push({ name: def.name, layer: 'control' })
    }
  }

  // ── A 网关 ──────────────────────────────────────────────────────────────
  if (cfg.gateway) {
    await mountGateway(cfg, state, register)
  }

  // ── C 契约（只在提示里点一句，全文在 skill） ────────────────────────────
  if (cfg.injectPrompt) {
    try {
      const host = ctx?.systemPrompt?.ctx ?? ctx
      host.systemPrompt.section({
        name,
        order: cfg.order,
        interpolate: false,
        text: () =>
          state.gateway.ok ? PROMPT_TEXT : `${PROMPT_TEXT}\n\n${GATEWAY_DOWN_NOTE(state.gateway.error)}`,
      })
    } catch (error) {
      warn(`prompt section failed (the tools still work): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const gatewayCount = state.registered.filter((r) => r.layer === 'gateway').length
  console.error(
    `[${name}] role=${cfg.role} · ${state.registered.length} tools ` +
      `(${gatewayCount} gateway, ${state.registered.length - gatewayCount} control) · ${describeLaunchSafe(cfg, state)}`,
  )
  return state
}

function describeLaunchSafe(cfg, state) {
  try {
    return describeLaunch(launchFor(cfg, 'gateway'))
  } catch (error) {
    state.gateway.error = state.gateway.error ?? error.message
    return `launcher unresolved: ${error.message}`
  }
}

/**
 * 启动网关、读它广告的工具、原样注册。
 *
 * 注册名统一 `danus_<tool>`：`gm_add` 这种名字放进一个装了几十个插件的会话里
 * 太泛，而 `danus_gm_add` 让模型一眼知道这是哪个系统的写入口。
 */
async function mountGateway(cfg, state, register) {
  const spec = launchFor(cfg, 'gateway')
  const client = new McpStdioClient({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
    label: 'danus gateway',
    startupTimeoutMs: cfg.launch.startupTimeoutMs,
    callTimeoutMs: cfg.launch.callTimeoutMs,
  })
  state.client = client

  try {
    await client.start()
  } catch (error) {
    state.gateway.ok = false
    state.gateway.error = error instanceof McpError ? error.message : String(error)
    warn(`gateway did not start: ${state.gateway.error}`)
    warn('control tools still registered; run danus_doctor for the resolved launcher and stderr tail')
    return
  }

  const advertised = Array.isArray(client.toolList) ? client.toolList : []
  state.gateway.tools = advertised.map((t) => String(t?.name ?? '')).filter((n) => n !== '')
  const allowed = cfg.tools.length === 0 ? null : new Set(cfg.tools)
  const denied = new Set(cfg.deny)

  for (const tool of advertised) {
    const mcpName = String(tool?.name ?? '')
    if (mcpName === '') continue
    if (allowed !== null && !allowed.has(mcpName)) continue
    if (denied.has(mcpName)) continue
    const dshName = `danus_${mcpName}`
    const parameters = state.mapper.mapTool(tool)
    const description = gatewayDescription(cfg, tool)
    const readOnly = ['gm_search', 'fact_search', 'search_arxiv_theorems'].includes(mcpName)
    const ok = register({
      name: dshName,
      description,
      parameters,
      ...(readOnly ? { isConcurrencySafe: () => true } : {}),
      async execute(args) {
        const result = await client.call(mcpName, args ?? {})
        return {
          ok: result.ok,
          tool: mcpName,
          ...(result.ok ? {} : { error: result.text, hint: result.hint ?? undefined }),
          ...(result.structured !== null && result.structured !== undefined
            ? { data: result.structured }
            : { text: result.text }),
        }
      },
    })
    if (ok) state.registered.push({ name: dshName, layer: 'gateway', tool: mcpName })
  }

  // 角色边界不是"提醒"：清单里没有的，插件一定没注册。这条断言留在日志里，
  // 因为它是整套设计里唯一一处"没有报错就代表正确"的地方。
  if (cfg.role === 'main' && state.gateway.tools.includes('fact_submit')) {
    warn('gateway advertised fact_submit for role=main — the role table in danus/gateway/roles.py says that must not happen')
  }
  if (!state.gateway.tools.includes('fact_submit') && cfg.role !== 'worker' && cfg.role !== 'all') {
    console.error(`[${name}] write path correctly absent for role=${cfg.role} (main can read the graph, never write it)`)
  }
  state.gateway.ok = true
}

function gatewayDescription(cfg, tool) {
  const base = typeof tool?.description === 'string' ? tool.description.trim() : ''
  return (
    (base === '' ? `Danus gateway tool ${tool?.name}.` : base) +
    `\n\n(role-gated: this tool is on the ${cfg.role} surface of the Danus gateway. ` +
    'Any project-scoped tool takes `project` — pass it; there is no default project.)'
  )
}

// ── 控制面工具 ──────────────────────────────────────────────────────────────

function controlTool(toolName, description, parameters, execute) {
  return { name: toolName, description, parameters, execute }
}

function controlTools(cfg, state) {
  const run = async (verb, args, { timeoutMs } = {}) => {
    const built = buildCliArgs(verb, args)
    if (!built.ok) return { ok: false, verb, error: built.reason }
    const result = await runDanusCli(cfg, built.args, {
      timeoutMs: timeoutMs ?? cfg.launch.callTimeoutMs,
    })
    return toToolResult(verb, result)
  }

  return [
    controlTool(
      'danus_doctor',
      '体检 Danus 连接：root / 解释器 / CLI / 网关工具清单（按角色）/ verify 服务 / skill。' +
        '任何"跑着但没进展"的情况先跑它——Danus 的失败大多是静默的。',
      {},
      async () => doctor(cfg, { reprobe: reprobe(state), registered: state.registered }),
    ),

    controlTool(
      'danus_list',
      '列出所有 Danus 项目：各自 worker 数、有几个活着、用的模型。多个项目并行时用它保持花名册。',
      {},
      async () => run('list', { json: true }, { timeoutMs: cfg.launch.doctorTimeoutMs }),
    ),

    controlTool(
      'danus_new',
      '新建一个 Danus 项目（脚手架 + worker 目录）。开工前必须问操作者要几个 high、几个 xhigh，' +
        '默认 high:3,xhigh:4，不要自己替他选。',
      {
        project: { type: 'string', required: true, description: '项目名（字母数字点划线下划线）。' },
        roles: { type: 'string', description: 'worker 编制，例如 high:3,xhigh:4。' },
        model: { type: 'string', description: '覆盖 worker 模型；一般留空走 danus.env。' },
      },
      async (args) => run('new', args),
    ),

    controlTool(
      'danus_assign',
      '写某个 worker 的 TASK.md（本轮它负责哪个分支）。整体方向走 danus_gm_add 的 master_guidance，' +
        '这里只写"你负责哪一支"。覆盖，不追加。',
      {
        target: { type: 'string', required: true, description: '<project>/<worker>' },
        task: { type: 'string', description: '任务正文。' },
        file: { type: 'string', description: '从文件读任务（与 task 二选一）。' },
      },
      async (args) => run('assign', args),
    ),

    controlTool(
      'danus_finalize',
      '把已核验的 fact 记为该论文的目标定理（写 TARGET.md，write-paper 只从这里读）。' +
        '不传 fact_id 时只打印候选终点事实，不写任何东西。',
      {
        project: { type: 'string', required: true, description: '项目名。' },
        paper: { type: 'string', description: '论文 id；省略写默认 TARGET.md。' },
        fact_ids: { type: 'array', items: { type: 'string' }, description: '要认定为目标的事实 id。' },
        approved: {
          type: 'boolean',
          description: cfg.policy.finalizeRequiresApproval
            ? '操作者是否已经同意把结果作为"答案"。没得到同意不要传 true。'
            : '（本部署未要求确认）',
        },
      },
      async (args) => {
        if (cfg.policy.finalizeRequiresApproval && args?.approved !== true) {
          return {
            ok: false,
            verb: 'finalize',
            error: 'approval required',
            hint:
              'finalize 把某个 fact 认定为这篇论文的答案，Danus 的契约把它列为 operator fork。' +
              '先问操作者；得到同意后带 approved=true 重试。只想看候选终点事实就别传 fact_ids。',
          }
        }
        return run('finalize', args)
      },
    ),

    controlTool(
      'danus_start',
      '启动项目的 worker 循环（或单个 worker）。幂等：`.pid.lock` 保证重复 start 不会起两窝。',
      { target: { type: 'string', required: true, description: '<project> 或 <project>/<worker>' } },
      async (args) => run('start', args),
    ),

    controlTool(
      'danus_status',
      '看 worker 是否活着、跑到第几轮、最后活动时间。`stuck?` 是软信号，由你决定 stop/restart。',
      {
        target: { type: 'string', required: true, description: '<project> 或 <project>/<worker>' },
      },
      async (args) => run('status', args),
    ),

    controlTool(
      'danus_stop',
      '停 worker。默认优雅退出（跑完当前轮），force=true 立即 killpg。',
      {
        target: { type: 'string', required: true, description: '<project> 或 <project>/<worker>' },
        force: { type: 'boolean', description: '立即 killpg，不跑完当前轮。' },
        approved: {
          type: 'boolean',
          description: cfg.policy.forceStopRequiresApproval
            ? 'force 停止不可逆（当前轮的工作会丢），需要操作者同意。'
            : '（本部署未要求确认）',
        },
      },
      async (args) => {
        if (args?.force === true && cfg.policy.forceStopRequiresApproval && args?.approved !== true) {
          return {
            ok: false,
            verb: 'stop',
            error: 'approval required for force stop',
            hint:
              'force 会 killpg，当前轮直接丢。先试优雅 stop（不传 force），它会在轮次边界退出；' +
              '确实要立刻停，问过操作者再带 approved=true。',
          }
        }
        return run('stop', args)
      },
    ),
  ]
}

function reprobe(state) {
  return async () => {
    if (state.client === null) return { ok: false, tools: [], error: 'gateway client was never created' }
    try {
      await state.client.start()
      return { ok: true, tools: (state.client.toolList ?? []).map((t) => String(t?.name ?? '')) }
    } catch (error) {
      return { ok: false, tools: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
}

const GATEWAY_DOWN_NOTE = (error) => `## Danus 网关当前不可用

控制面工具还在（list / new / assign / start / status / stop），但**事实图与全局记忆
的读写工具没有注册**——你没有 gm_* / fact_* / search_arxiv_theorems 可用。
原因：${error ?? '未知'}

不要绕开它去直接改文件：那些 store 只允许通过网关写。先跑 danus_doctor 定位，
修好后重启 profile（工具清单在启动时固定）。`
