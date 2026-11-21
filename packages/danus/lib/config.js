/**
 * 配置解析：把 cordis.patch.yml 里的 config、环境变量、默认值合成一份。
 *
 * 优先级：显式 config > 环境变量 > 从 root 推断。root 本身可以来自
 * `DANUS_ROOT`，这样 patch 里不用写死机器路径——一份 patch 能跟着仓库走。
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const DEFAULTS = {
  root: '',
  role: 'main',
  author: 'dsh',
  agentsRoot: '',
  verifyUrl: '',
  gateway: true,
  control: true,
  tools: [],
  deny: [],
  injectPrompt: true,
  order: 4950,
  launch: {
    mode: 'auto',
    bash: '',
    wsl: '',
    wslDistro: '',
    python: '',
    command: [],
    startupTimeoutMs: 20000,
    callTimeoutMs: 3600000,
    doctorTimeoutMs: 20000,
  },
  policy: {
    finalizeRequiresApproval: true,
    forceStopRequiresApproval: true,
  },
}

const asBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !/^(0|false|no|off)$/i.test(String(value))
}

const asInt = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

const asList = (value) => {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v !== '')
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v !== '')
  return []
}

/** `~` 展开 + 相对路径按 cwd 解析（配置里允许写相对路径，但要能定位）。 */
export function expandPath(value, base = process.cwd()) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let p = value.trim()
  if (p === '~') p = homedir()
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2))
  return isAbsolute(p) ? p : resolve(base, p)
}

/**
 * @param {object} raw cordis 传进来的 config
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ok: boolean, config: object, problems: string[]}}
 */
export function resolveConfig(raw = {}, env = process.env) {
  const problems = []
  const launchRaw = { ...DEFAULTS.launch, ...(raw.launch ?? {}) }
  const policyRaw = { ...DEFAULTS.policy, ...(raw.policy ?? {}) }

  const root = expandPath(raw.root || raw.danusRoot || env.DANUS_ROOT || '')
  if (root === '') {
    problems.push(
      'no Danus root: set `root:` in the plugin config or export DANUS_ROOT ' +
        '(the directory that holds bin/danus and danus/gateway).',
    )
  } else if (!existsSync(root)) {
    problems.push(`Danus root does not exist: ${root}`)
  } else if (!statSync(root).isDirectory()) {
    problems.push(`Danus root is not a directory: ${root}`)
  }

  const agentsRoot = expandPath(raw.agentsRoot || env.DANUS_AGENTS_ROOT || (root ? join(root, 'runtime', 'projects') : ''))
  const port = env.VERIFY_PORT || '8091'
  const verifyUrl =
    (typeof raw.verifyUrl === 'string' && raw.verifyUrl.trim() !== '' ? raw.verifyUrl.trim() : '') ||
    env.DANUS_VERIFY_URL ||
    `http://127.0.0.1:${port}/verify`

  const command = normalizeCommand(launchRaw.command)
  const mode = normalizeMode(launchRaw.mode)
  const ALLOWED = ['auto', 'bash', 'wsl', 'python', 'command']
  for (const target of ['gateway', 'cli']) {
    if (!ALLOWED.includes(mode[target])) {
      problems.push(`launch.mode.${target} must be auto|bash|wsl|python|command, got ${mode[target]}`)
    }
    if (mode[target] === 'command' && command[target].length === 0) {
      problems.push(`launch.mode.${target}=command has no argv (launch.command.${target})`)
    }
  }

  const config = {
    root,
    role: String(raw.role || env.DANUS_ROLE || DEFAULTS.role),
    author: String(raw.author || env.DANUS_AUTHOR || DEFAULTS.author),
    agentsRoot,
    verifyUrl,
    gateway: asBool(raw.gateway, DEFAULTS.gateway),
    control: asBool(raw.control, DEFAULTS.control),
    tools: asList(raw.tools),
    deny: asList(raw.deny),
    injectPrompt: asBool(raw.injectPrompt, DEFAULTS.injectPrompt),
    order: asInt(raw.order, DEFAULTS.order),
    launch: {
      mode,
      bash: String(launchRaw.bash || ''),
      wsl: String(launchRaw.wsl || ''),
      wslDistro: String(launchRaw.wslDistro || ''),
      python: expandPath(launchRaw.python || '', root || process.cwd()),
      command,
      startupTimeoutMs: asInt(launchRaw.startupTimeoutMs, DEFAULTS.launch.startupTimeoutMs),
      callTimeoutMs: asInt(launchRaw.callTimeoutMs, DEFAULTS.launch.callTimeoutMs),
      doctorTimeoutMs: asInt(launchRaw.doctorTimeoutMs, DEFAULTS.launch.doctorTimeoutMs),
    },
    policy: {
      finalizeRequiresApproval: asBool(policyRaw.finalizeRequiresApproval, true),
      forceStopRequiresApproval: asBool(policyRaw.forceStopRequiresApproval, true),
    },
  }
  return { ok: problems.length === 0, config, problems }
}

/**
 * 显式命令：一个 argv 数组（网关和 CLI 用同一套），或者按目标分开给——
 * `{gateway: [...], cli: [...]}`。测试与"自带启动器"的部署都需要后者。
 */
function normalizeCommand(raw) {
  const asArgv = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v !== '')
    if (typeof value === 'string' && value.trim() !== '') return value.trim().split(/\s+/)
    return []
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return { gateway: asArgv(raw.gateway), cli: asArgv(raw.cli ?? raw.gateway) }
  }
  const both = asArgv(raw)
  return { gateway: both, cli: both }
}

/**
 * 启动方式也按目标分开：这两种进程对平台的要求不一样。
 *
 * 实测出来的差别：网关（`danus/gateway`）只依赖 stdlib + `mcp`，在 Windows 上
 * 用仓库自己的 venv 就能跑；而编排 CLI（`danus/orchestration`）**第一行就
 * `import fcntl`**，那是 POSIX 独占模块，在 Windows 上必然 `ModuleNotFoundError`。
 * 所以一份配置里写成 `{gateway: python, cli: wsl}` 是正常需求，不是特例。
 */
function normalizeMode(raw) {
  const allowed = (value, fallback) => {
    const text = String(value ?? fallback).toLowerCase()
    return text === '' ? fallback : text
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return { gateway: allowed(raw.gateway, 'auto'), cli: allowed(raw.cli, raw.gateway ?? 'auto') }
  }
  const both = allowed(raw, 'auto')
  return { gateway: both, cli: both }
}
