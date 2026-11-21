/**
 * 怎么把 Danus 拉起来——三种现实情况，一种接口。
 *
 * Danus 是 POSIX 项目：`bin/*` 是 bash，进程管理用 `killpg`，pyproject 的
 * classifier 写的是 POSIX::Linux。在 Linux/macOS 上 `bash bin/danus-mcp` 就是
 * 全部真相；在 Windows 上要么整个搬进 WSL2，要么用 Windows 侧的 Python 直接
 * `-m danus.gateway`。这两种都不是"退路"，都是正式路径，所以它们共用一个
 * `launchFor()`，调用方不需要知道自己在哪。
 *
 * 但**两个进程对平台的要求不一样**，这是实测出来的：
 *
 *   danus.gateway        stdlib + `mcp`，Windows 上能原生跑
 *   danus.orchestration  模块级 `import fcntl`，原生 Windows 上没有这个模块
 *
 * 后者不等于「只能去 WSL」：它对 POSIX 的依赖只有四处，`pycompat/` 全补上了
 * （见那个目录的文件头）。所以 auto 在 Windows 上先试原生 Python + pycompat，
 * 不行再退到 WSL；`{gateway: python, cli: wsl}` 仍然是合法配置。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WIN = process.platform === 'win32'

/**
 * Danus 缺的那几个 POSIX 接口的等价实现（`fcntl.flock`、`os.kill(pid,0)`、
 * `os.killpg`）。目录放在 PYTHONPATH 最前面，CPython 启动时会自动 import
 * `sitecustomize`，所以只对插件启动的这个子进程生效，不改上游一行代码，
 * 也不污染机器上任何一个 Python。
 */
const COMPAT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pycompat')
const HAS_COMPAT = existsSync(join(COMPAT, 'fcntl.py'))

/** POSIX shell 单引号转义。值进的是 `export` 列表，不是命令行参数。 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** `D:\Danus` → `/mnt/d/Danus`；已经是 WSL 路径的原样返回。 */
export function toWslPath(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  if (raw.startsWith('/')) return raw
  const unc = /^\\\\wsl\$\\([^\\]+)\\(.*)$/i.exec(raw)
  if (unc !== null) return `/${unc[2].replace(/\\/g, '/')}`
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(raw)
  if (drive !== null) {
    const rest = drive[2].replace(/\\/g, '/').replace(/\/+$/, '')
    return `/mnt/${drive[1].toLowerCase()}${rest === '' ? '' : `/${rest}`}`
  }
  return raw.replace(/\\/g, '/')
}

/** venv 里可用的解释器，先看 bootstrap 的 runtime/venv，再看仓库根的 .venv。 */
export function findPython(root) {
  const candidates = WIN
    ? ['runtime/venv/Scripts/python.exe', '.venv/Scripts/python.exe']
    : ['runtime/venv/bin/python', '.venv/bin/python', 'runtime/venv/bin/python3']
  for (const rel of candidates) {
    const p = join(root, ...rel.split('/'))
    if (existsSync(p)) return p
  }
  return ''
}

let wslCache = null

/**
 * WSL 到底能不能用：不是"装没装"，而是"默认发行版里有没有 bash、能不能看到
 * 这个 root"。Windows 上装了 Docker Desktop 就有 `wsl.exe`，而它那个发行版
 * 里连 bash 都没有——只看 `wsl -l` 会得到一个假的 yes。
 */
export function wslProbe(config) {
  if (wslCache !== null) return wslCache
  const exe = config?.launch?.wsl || 'wsl.exe'
  const distro = config?.launch?.wslDistro || ''
  const root = config?.root || ''
  const args = [...(distro === '' ? [] : ['-d', distro]), '-e', 'bash', '-lc',
    'printf "BASH_OK\\n"; test -d "$1" && printf "ROOT_OK\\n" || printf "ROOT_MISSING\\n"',
    '_', toWslPath(root)]
  try {
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 15000, windowsHide: true })
    const out = String(r.stdout ?? '')
    wslCache = {
      ok: r.status === 0 && out.includes('BASH_OK'),
      root: out.includes('ROOT_OK'),
      distro: distro === '' ? '(default)' : distro,
      detail:
        r.status !== 0 && out === ''
          ? 'no bash in the WSL default distro (Docker Desktop distros have none)'
          : out.includes('BASH_OK')
            ? ''
            : 'bash not found',
    }
  } catch (error) {
    wslCache = { ok: false, root: false, distro: distro === '' ? '(default)' : distro, detail: error.message }
  }
  return wslCache
}

/** 测试用：重置 WSL 探测结果。 */
export function resetWslCache() {
  wslCache = null
}

function gatewayEnv(config, { wsl = false } = {}) {
  const map = (p) => (wsl ? toWslPath(p) : p)
  const env = {
    DANUS_ROLE: config.role,
    DANUS_AUTHOR: config.author,
    DANUS_AGENTS_ROOT: map(config.agentsRoot),
    DANUS_VERIFY_URL: config.verifyUrl,
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === '' || value === undefined) delete env[key]
  }
  return env
}

function modeFor(config, target) {
  const mode = config.launch.mode
  if (typeof mode === 'string') return mode
  return mode?.[target] ?? mode?.gateway ?? 'auto'
}

/**
 * @param {object} config resolveConfig() 的结果
 * @param {'gateway'|'cli'} target
 * @param {string[]} [extraArgs] cli 时的参数（已按 verb 拼好）
 * @param {{mode?: string}} [override] 测试/doctor 用
 */
export function launchFor(config, target, extraArgs = [], override = {}) {
  const declared = override.mode ?? modeFor(config, target)
  const mode = declared === 'auto' ? resolveAuto(config, target) : declared
  const root = config.root
  const explicit = config.launch.command?.[target] ?? []

  if (mode === 'command') {
    if (explicit.length === 0) {
      throw new Error(`launch.mode.${target}=command has no argv (launch.command.${target} is empty)`)
    }
    const [command, ...base] = explicit
    return {
      mode,
      command,
      args: [...base, ...extraArgs],
      env: { ...gatewayEnv(config) },
      cwd: root,
      label: `command ${command}`,
    }
  }

  if (mode === 'python') return pythonLaunch(config, target, extraArgs)
  if (mode === 'wsl') return wslLaunch(config, target, extraArgs)
  if (mode === 'bash') return bashLaunch(config, target, extraArgs)
  throw new Error(`unknown launch mode ${mode}`)
}

/** auto：按目标各选各的，理由见文件头。 */
function resolveAuto(config, target) {
  const root = config.root
  if (!WIN) {
    const script = join(root, 'bin', target === 'gateway' ? 'danus-mcp' : 'danus')
    return existsSync(script) ? 'bash' : 'python'
  }
  if (target === 'gateway') {
    const python = findPython(root)
    if (python !== '' && /Scripts/i.test(python)) return 'python'
    if (wslProbe(config).ok && wslProbe(config).root) return 'wsl'
    return 'python'
  }
  // CLI：Windows 上先试原生 Python + pycompat（fcntl / os.killpg 的等价实现），
  // 这条路能走通就不需要 WSL；走不通再退到 WSL。
  const python = findPython(root)
  if (HAS_COMPAT && python !== '') return 'python'
  const probe = wslProbe(config)
  if (probe.ok && probe.root) return 'wsl'
  throw new Error(
    'no way to run the Danus control plane on this machine: ' +
      (python === ''
        ? 'no Python interpreter was found next to the checkout (expected .venv or runtime/venv), '
        : 'the bundled pycompat/ directory is missing so `import fcntl` cannot be satisfied, ') +
      `and WSL is not usable (${probe.detail}). ` +
      'Fix one of: install the checkout with its venv (`bash scripts/bootstrap.sh`), ' +
      'set launch.python to an interpreter, install a WSL2 distro, or point ' +
      'launch.command.cli at your own launcher. The gateway is unaffected.',
  )
}

function bashLaunch(config, target, extraArgs) {
  const bash = config.launch.bash || 'bash'
  const script = join(config.root, 'bin', target === 'gateway' ? 'danus-mcp' : 'danus')
  return {
    mode: 'bash',
    command: bash,
    args: [script, ...extraArgs],
    env: { ...gatewayEnv(config) },
    cwd: config.root,
    label: `bash ${script}`,
  }
}

function wslLaunch(config, target, extraArgs) {
  const wsl = config.launch.wsl || 'wsl.exe'
  const distro = config.launch.wslDistro || ''
  const env = gatewayEnv(config, { wsl: true })
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`).join(' ')
  const binary = target === 'gateway' ? 'bin/danus-mcp' : 'bin/danus'
  const script =
    `cd "$1" || exit 1; shift; ` + (pairs === '' ? '' : `export ${pairs}; `) + `exec bash ${binary} "$@"`
  return {
    mode: 'wsl',
    command: wsl,
    // bash -lc <script> _ <root> <args...>：root 与参数都走 argv，
    // 不拼进 shell 字符串，项目名/任务文本里有引号也不会破坏命令。
    args: [...(distro === '' ? [] : ['-d', distro]), '-e', 'bash', '-lc', script, '_', toWslPath(config.root), ...extraArgs],
    env: {},
    cwd: undefined,
    label: `wsl${distro === '' ? '' : ` -d ${distro}`} bash ${binary}`,
  }
}

function pythonLaunch(config, target, extraArgs) {
  const python = config.launch.python || findPython(config.root) || (WIN ? 'python' : 'python3')
  const module = target === 'gateway' ? 'danus.gateway' : 'danus.orchestration'
  return {
    mode: 'python',
    command: python,
    args: ['-m', module, ...extraArgs],
    env: {
      ...gatewayEnv(config),
      PYTHONPATH: pythonPath(config.root),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      DANUS_PY: python,
    },
    cwd: config.root,
    label: `${python} -m ${module}`,
  }
}

/**
 * pycompat 排在 root 前面。不是风格问题：`sitecustomize` 只会从 sys.path 上
 * 第一个能找到它的目录加载，而 root 里没有这个文件——但如果将来有，顺序就
 * 决定了用哪一个。契约写在这里，而不是留给运气。
 */
function pythonPath(root) {
  return HAS_COMPAT ? [COMPAT, root].join(WIN ? ';' : ':') : root
}

/** 人读的一行，用于日志与 doctor。 */
export function describeLaunch(spec) {
  const shown = (a) => (/\s/.test(a) ? JSON.stringify(a) : a)
  return `${spec.mode}: ${spec.command} ${spec.args.map(shown).join(' ')}`.trim()
}
