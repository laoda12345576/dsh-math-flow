/**
 * 体检。这个文件的存在理由：Danus 的失败模式**几乎全是静默的**。
 *
 * 没有 verify 服务，`fact_submit` 会干净地报错，但 worker 只是原地重试，从外面
 * 看就是"在跑"；网关起不来，工具就是没有，模型只会换个工具，不会说"功能缺了"；
 * `DANUS_ROLE` 没设，网关 fail-closed 到只读集合，主智能体于是**看不到**
 * `fact_revoke`，也不会报错。所以这些东西必须能被一条命令问出来，而不是等
 * 跑了两小时发现事实图是空的。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { describeLaunch, findPython, launchFor, wslProbe } from './launch.js'
import { condense, runDanusCli, readOutput } from './control.js'

const ROLE_EXPECTS = {
  main: { has: ['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems'], hasNot: ['fact_submit'] },
  worker: { has: ['gm_add', 'gm_search', 'fact_submit', 'fact_search', 'search_arxiv_theorems'], hasNot: [] },
  verifier: { has: ['search_arxiv_theorems'], hasNot: ['gm_add', 'gm_search', 'fact_submit', 'fact_search', 'fact_revoke'] },
  all: { has: ['fact_submit', 'fact_revoke'], hasNot: [] },
}

function healthUrl(verifyUrl) {
  return String(verifyUrl).replace(/\/verify\/?$/, '/health')
}

async function probeHttp(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = await response.text()
    return { ok: response.ok, status: response.status, body: body.slice(0, 300) }
  } catch (error) {
    return { ok: false, status: 0, error: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {object} config
 * @param {object} ctx
 * @param {Array<{name: string, tool: string}>} [ctx.registered] 已注册的网关工具
 * @param {() => Promise<{ok: boolean, tools?: string[], error?: string}>} [ctx.reprobe] 重新拉一次网关
 * @param {Record<string,string>} [ctx.env]
 */
export async function doctor(config, ctx = {}) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const env = ctx.env ?? process.env

  add('root', existsSync(config.root), config.root || '(unset)')
  const cliScript = join(config.root, 'bin', 'danus')
  const gatewayScript = join(config.root, 'bin', 'danus-mcp')
  add('bin/danus', existsSync(cliScript), existsSync(cliScript) ? cliScript : `missing: ${cliScript}`)
  add('bin/danus-mcp', existsSync(gatewayScript), existsSync(gatewayScript) ? gatewayScript : `missing: ${gatewayScript}`)

  const python = findPython(config.root)
  add(
    'interpreter',
    config.launch.mode === 'wsl' || config.launch.mode === 'bash' || python !== '' || (config.launch.command?.gateway?.length ?? 0) > 0,
    [
      python === '' ? 'no venv under runtime/venv or .venv' : python,
      `mode: gateway=${config.launch.mode?.gateway ?? config.launch.mode}, cli=${config.launch.mode?.cli ?? config.launch.mode}`,
      process.platform === 'win32'
        ? `wsl=${wslProbe(config).ok ? `yes (${wslProbe(config).distro})` : `no (${wslProbe(config).detail})`}`
        : '',
    ]
      .filter((s) => s !== '')
      .join(' · '),
  )

  try {
    const gw = describeLaunch(launchFor(config, 'gateway'))
    let cli
    try {
      cli = describeLaunch(launchFor(config, 'cli', ['list', '--json']))
    } catch (error) {
      cli = `unavailable — ${error.message.split('. ')[0]}`
    }
    add('launcher', true, `gateway: ${gw}\n    cli: ${cli}`)
  } catch (error) {
    add('launcher', false, error.message)
  }

  add('agentsRoot', existsSync(config.agentsRoot), config.agentsRoot || '(unset)')
  let projects = null
  if (existsSync(config.agentsRoot)) {
    try {
      projects = readdirSync(config.agentsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      projects = null
    }
    add('projects', true, projects === null ? 'unreadable' : projects.length === 0 ? 'none yet' : projects.join(', '))
  }

  const cli = await runDanusCli(config, ['list', '--json'], { timeoutMs: config.launch.doctorTimeoutMs })
  const cliOut = readOutput(cli.stdout)
  const cliOk = cli.code === 0
  add(
    'cli',
    cliOk,
    cliOk
      ? `${Array.isArray(cliOut.json) ? `${cliOut.json.length} project(s)` : 'ok'} · ${cli.spec?.mode ?? '?'}`
      : condense(cli.stderr) || `exit ${cli.code}`,
  )

  if (ctx.reprobe !== undefined) {
    const probe = await ctx.reprobe()
    const advertised = Array.isArray(probe.tools) ? probe.tools : []
    const expected = ROLE_EXPECTS[config.role] ?? null
    const missing = expected === null ? [] : expected.has.filter((t) => !advertised.includes(t))
    const leaked = expected === null ? [] : expected.hasNot.filter((t) => advertised.includes(t))
    add(
      'gateway',
      probe.ok && missing.length === 0 && leaked.length === 0,
      probe.ok
        ? `role=${config.role} · ${advertised.length} tools: ${advertised.join(' ')}` +
          (missing.length > 0 ? `\n    MISSING for this role: ${missing.join(' ')}` : '') +
          (leaked.length > 0 ? `\n    LEAKED (role must not see): ${leaked.join(' ')}` : '')
        : (probe.error ?? 'did not start'),
    )
    if (Array.isArray(ctx.registered)) {
      const gateway = ctx.registered.filter((r) => r.layer === 'gateway').map((r) => r.tool)
      const control = ctx.registered.filter((r) => r.layer === 'control').length
      const unregistered = advertised.filter((t) => !gateway.includes(t))
      add(
        'tool surface',
        unregistered.length === 0,
        unregistered.length === 0
          ? `${gateway.length} gateway + ${control} control = ${ctx.registered.length} tools in this session`
          : `advertised but not registered: ${unregistered.join(' ')} (deny list or a schema that failed to map)`,
      )
    }
  }

  const health = await probeHttp(healthUrl(config.verifyUrl), 5000)
  add(
    'verify service',
    health.ok,
    health.ok
      ? `${healthUrl(config.verifyUrl)} → ${health.status}`
      : `${healthUrl(config.verifyUrl)} → ${health.status === 0 ? health.error : `HTTP ${health.status}`}` +
          '\n    fact_submit cannot land without it; start it with `bash scripts/services.sh up verify`',
  )

  const skillsHome = join(env.DSH_HOME || join(homedir(), '.dsh'), 'skills')
  const skillNames = ['danus-main', 'danus-initialize']
  const present = skillNames.filter((n) => existsSync(join(skillsHome, n, 'SKILL.md')))
  add(
    'skills',
    present.length === skillNames.length,
    present.length === skillNames.length
      ? `${present.join(', ')} in ${skillsHome}`
      : `missing ${skillNames.filter((n) => !present.includes(n)).join(', ')} under ${skillsHome} — the tools work without them, but nothing then tells the model the layer rules`,
  )

  const failed = checks.filter((c) => !c.ok)
  return {
    ok: failed.length === 0,
    checked_at: new Date().toISOString(),
    failed: failed.map((c) => c.name),
    checks,
    note:
      'The gateway list above is what the server advertised for this role, not what the ' +
      'config asked for — the role table in danus/gateway/roles.py is the authority.',
  }
}

