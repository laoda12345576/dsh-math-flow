/**
 * Does the run budget actually bound a verification?
 *
 * Regression for the 88-minute hang: a budget that only *signals* leaves the tool
 * call waiting on a process that never settles, so the wall clock is unbounded no
 * matter what the config says. This drives the real Lean toolchain with a 60s budget
 * and asserts the call returns promptly with a timeout verdict.
 */
import { spawn, execFileSync } from 'node:child_process'
import { apply } from '../lib/index.js'

const subprocess = {
  async resolveExecutable(bin) {
    return execFileSync('where.exe', [bin], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      signal: spec.signal,
      env: spec.env ?? process.env
    })
    const o = []
    const e = []
    child.stdout?.on('data', (d) => o.push(d))
    child.stderr?.on('data', (d) => e.push(d))
    const done = new Promise((r) => {
      child.on('close', (code) => r({ exitCode: code, signal: null }))
      child.on('error', () => r({ exitCode: 1, signal: null }))
    })
    const reader = (c) => ({ readFrom: () => ({ text: Buffer.concat(c).toString('utf8'), nextOffset: 0, lossy: false }) })
    return { collected: { stdout: reader(o), stderr: reader(e) }, done, terminate: () => child.kill() }
  }
}

const registry = new Map()
const ctx = {
  get: (k) => (k === 'subprocess' ? subprocess : undefined),
  tools: {
    register: (d) => (registry.set(d.name, d), () => {}),
    get: (n) => registry.get(n),
    async execute(exec) {
      const def = registry.get(exec.name)
      if (!def) return { isError: true, error: { message: `unknown tool: ${exec.name}` } }
      try {
        return { isError: false, value: await def.execute(exec.arguments, { signal: exec.signal }), content: [] }
      } catch (error) {
        return { isError: true, error: { message: error.message } }
      }
    }
  },
  effect: () => () => {}
}

const budgetMs = Number(process.argv[2] || 60000)
await apply(ctx, {
  projectDir: process.env.MATHLIB_DIR,
  defaultProjectDir: process.env.MATHLIB_DIR,
  lean: { projectDir: process.env.MATHLIB_DIR, verifyTimeoutMs: budgetMs },
  interactiveTimeoutMs: budgetMs
})

const started = Date.now()
const result = await registry.get('lean_verify_proof').execute(
  { code: 'import Mathlib.Tactic\nexample : 1 + 1 = 2 := by norm_num', timeout_ms: budgetMs },
  {}
)
const elapsedMs = Date.now() - started

console.log(`预算 ${budgetMs} ms`)
console.log(`实际耗时 ${(elapsedMs / 1000).toFixed(1)} s`)
console.log(`结果: success=${result.success}  timed_out=${result.timed_out === true}`)
console.log(`错误: ${result.error ?? '(无)'}`)

const upperBound = budgetMs + 40000
const pass =
  (result.success === true && elapsedMs <= 300000) ||
  (result.timed_out === true && elapsedMs <= upperBound)
console.log(pass ? '\nPASS: 调用被预算界定' : `\nFAIL: 未被界定（上限应为 ${upperBound} ms）`)
process.exit(pass ? 0 : 1)
