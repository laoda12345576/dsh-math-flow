/**
 * 控制面：`danus` CLI 的几个 verb，包成工具。
 *
 * 这一层不做编排判断——`start` 之后 worker 自己跑，主智能体只负责
 * assign / status / stop。插件能加的价值只有两处，都在下面：
 *
 * 1. **参数校验在本地做**。CLI 收到非法项目名会抛 Python 栈，模型看到的
 *    是一段 traceback；这里先按网关自己的正则（`^[A-Za-z0-9][A-Za-z0-9._-]*$`）
 *    拦下，回一句人话。
 * 2. **不可逆的动作要显式同意**。`stop --force` 直接 killpg，走到一半的
 *    round 就没了；`finalize` 是把某个 fact 认定成"这篇论文的答案"。
 *    Danus 的主智能体契约把后者列为 operator fork，而**契约是提示词，提示词
 *    劝不住**——所以把它做成工具参数，缺了就拒。
 */

import { spawn } from 'node:child_process'
import { launchFor } from './launch.js'

/** 与 danus/gateway/server.py 的 _PROJECT_NAME_RE 完全一致。 */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function splitTarget(target) {
  const text = String(target ?? '').trim()
  if (text === '') return { ok: false, reason: 'target is required: <project> or <project>/<worker>' }
  const parts = text.split('/')
  if (parts.length > 2) return { ok: false, reason: `target must be <project> or <project>/<worker>, got ${text}` }
  for (const part of parts) {
    if (!NAME_RE.test(part)) {
      return {
        ok: false,
        reason: `invalid name ${JSON.stringify(part)}: letters, digits, dot, dash and underscore only (the gateway uses the same rule)`,
      }
    }
  }
  return { ok: true, project: parts[0], worker: parts[1] ?? null }
}

export function validateProject(project) {
  const text = String(project ?? '').trim()
  if (text === '') return { ok: false, reason: 'project is required' }
  if (!NAME_RE.test(text)) {
    return { ok: false, reason: `invalid project name ${JSON.stringify(text)}: letters, digits, dot, dash and underscore only` }
  }
  return { ok: true, project: text }
}

/**
 * 拼一个 verb 的 argv。纯函数，测试直接盯它。
 * @returns {{ok: true, args: string[]} | {ok: false, reason: string}}
 */
export function buildCliArgs(verb, args = {}) {
  switch (verb) {
    case 'list':
      return { ok: true, args: ['list', ...(args.json === false ? [] : ['--json'])] }

    case 'new': {
      const p = validateProject(args.project)
      if (!p.ok) return p
      const roles = typeof args.roles === 'string' ? args.roles.trim() : ''
      if (roles !== '' && !/^(\w+:\d+)(,\w+:\d+)*$/.test(roles)) {
        return { ok: false, reason: `roles must look like high:3,xhigh:4 — got ${JSON.stringify(roles)}` }
      }
      const argv = ['new', p.project]
      if (roles !== '') argv.push('--roles', roles)
      if (typeof args.model === 'string' && args.model.trim() !== '') argv.push('--model', args.model.trim())
      return { ok: true, args: argv }
    }

    case 'assign': {
      const t = splitTarget(args.target)
      if (!t.ok) return t
      if (t.worker === null) return { ok: false, reason: 'assign needs <project>/<worker>, not a bare project' }
      const task = typeof args.task === 'string' ? args.task : ''
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (task.trim() === '' && file === '') return { ok: false, reason: 'assign needs task (or file); TASK.md would be empty' }
      const argv = ['assign', args.target.trim()]
      if (file !== '') argv.push('--file', file)
      else argv.push('--task', task)
      return { ok: true, args: argv }
    }

    case 'finalize': {
      const p = validateProject(args.project)
      if (!p.ok) return p
      const facts = Array.isArray(args.fact_ids)
        ? args.fact_ids.map((f) => String(f).trim()).filter((f) => f !== '')
        : typeof args.fact_ids === 'string' && args.fact_ids.trim() !== ''
          ? args.fact_ids.trim().split(/[\s,]+/).filter((f) => f !== '')
          : []
      const argv = ['finalize', p.project]
      const paper = typeof args.paper === 'string' ? args.paper.trim() : ''
      if (paper !== '') {
        if (!NAME_RE.test(paper)) return { ok: false, reason: `invalid paper id ${JSON.stringify(paper)}` }
        argv.push('--paper', paper)
      }
      argv.push(...facts)
      return { ok: true, args: argv }
    }

    case 'start': {
      const t = splitTarget(args.target)
      if (!t.ok) return t
      return { ok: true, args: ['start', args.target.trim()] }
    }

    case 'status': {
      const t = splitTarget(args.target)
      if (!t.ok) return t
      return { ok: true, args: ['status', args.target.trim(), ...(args.json === false ? [] : ['--json'])] }
    }

    case 'stop': {
      const t = splitTarget(args.target)
      if (!t.ok) return t
      return { ok: true, args: ['stop', args.target.trim(), ...(args.force === true ? ['--force'] : [])] }
    }

    default:
      return { ok: false, reason: `unknown verb ${verb}` }
  }
}

/**
 * 跑一次 CLI。异步——`spawnSync` 会把宿主的事件循环一起冻住，而 `status`
 * 在 worker 卡住时要等内核探测，不该连累界面。
 */
export function runDanusCli(config, argv, { timeoutMs = 120000, env = {} } = {}) {
  return new Promise((resolve) => {
    let spec
    try {
      spec = launchFor(config, 'cli', argv)
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error.message, timedOut: false, spec: null })
      return
    }
    let child
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: `could not spawn ${spec.command}: ${error.message}`, timedOut: false, spec })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    if (timer.unref) timer.unref()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut, spec })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, timedOut, spec })
    })
  })
}

const MAX_TEXT = 8000

/** stdout 是 JSON 就解析；不是就原文返回（截断，并说明截断）。 */
export function readOutput(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return { json: null, text: '' }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return { json: JSON.parse(text), text }
    } catch {
      /* 不是 JSON，往下走 */
    }
  }
  return { json: null, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated)` : text }
}

/** CLI 结果 → 工具结果。失败时把 stderr 尾行带上，别让模型猜。 */
export function toToolResult(verb, result) {
  const { json, text } = readOutput(result.stdout)
  const stderr = String(result.stderr ?? '').trim()
  if (result.timedOut) {
    return {
      ok: false,
      verb,
      error: 'timeout',
      hint: `danus ${verb} did not return in time. status/stop on a stuck worker can hang on the liveness probe; retry with a longer callTimeoutMs or check the worker pid.`,
    }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      verb,
      exit_code: result.code,
      stderr: condense(stderr),
      stdout: text.slice(0, 2000),
      hint: hintFor(verb, stderr),
    }
  }
  return { ok: true, verb, data: json, output: json === null ? text : undefined }
}

/**
 * Python traceback 的前 15 行里没有信息，结论在最后一行。
 * 把 12 行栈压成一句，模型才有机会读懂。
 */
export function condense(stderr) {
  const text = String(stderr ?? '').trim()
  if (text === '') return ''
  if (!/Traceback \(most recent call last\)/.test(text)) return text.split('\n').slice(-12).join('\n')
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '')
  const tail = lines[lines.length - 1] ?? ''
  const where = [...lines].reverse().find((l) => /File ".*", line \d+/.test(l))
  return where === undefined ? tail : `${tail}\n  at ${where.trim()}`
}

function hintFor(verb, stderr) {
  if (/No module named 'fcntl'/.test(stderr)) {
    return (
      'danus/orchestration/cli.py imports fcntl, which only exists on POSIX. The control ' +
      'plane (list/new/assign/start/status/stop) cannot run on native Windows. Run Danus ' +
      'inside WSL2 and set launch.mode.cli=wsl (or launch.wslDistro). Layer A — the ' +
      'gateway and its gm_*/fact_* tools — is unaffected on Windows.'
    )
  }
  if (/No module named '(mcp|fastapi|uvicorn)'/.test(stderr)) {
    return 'the Danus venv is missing a declared extra; run `bash scripts/bootstrap.sh` in the Danus root'
  }
  if (/No such file|not found|ENOENT/i.test(stderr)) {
    return 'the danus launcher was not found — check root and launch.mode (danus_doctor prints the resolved command)'
  }
  return 'danus refused the command; the stderr above is the reason it gave'
}
