/** Mathlib interactive step through the plugin, with timing and timeout check. */
import { spawn, execFileSync } from 'node:child_process'
import { apply } from '../lib/index.js'

const subprocess = {
  async resolveExecutable(bin) {
    return execFileSync('where.exe', [bin], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env ?? process.env, signal: spec.signal })
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

const registered = new Map()
await apply(
  {
    get: (k) => (k === 'subprocess' ? subprocess : undefined),
    tools: { register: (d) => (registered.set(d.name, d), () => {}) },
    effect: () => () => {}
  },
  { projectDir: process.env.MATHLIB_DIR, defaultTimeoutMs: 600000, interactiveTimeoutMs: 300000 }
)
const call = (n, a) => registered.get(n).execute(a, {})

// (a) full Mathlib interactive step
const opened = await call('lean_open_file', {
  name: 'mathlib_it',
  content: 'import Mathlib\n\nexample (n : Nat) : n < n + 1 := by\n'
})
console.log('opened:', opened.session_id, '| project:', JSON.stringify(opened.project_dir))
const t0 = Date.now()
const t = await call('lean_run_tactic', { session_id: opened.session_id, tactic: 'omega' })
console.log(`  omega -> accepted=${t.tactic_accepted} proven=${t.proven} in ${Math.round((Date.now() - t0) / 1000)}s`)
if (!t.proven) console.log('  errors:', JSON.stringify(t.errors), 'goals:', JSON.stringify(t.goals))
await call('lean_close_session', { session_id: opened.session_id })

// (b) narrow import (Mathlib.Tactic) - the practical recommendation
const o2 = await call('lean_open_file', {
  name: 'narrow',
  content: 'import Mathlib.Tactic\n\nexample (n : Nat) : n < n + 1 := by\n'
})
const t1 = Date.now()
const t2 = await call('lean_run_tactic', { session_id: o2.session_id, tactic: 'omega' })
console.log(`narrow (Mathlib.Tactic) -> accepted=${t2.tactic_accepted} proven=${t2.proven} in ${Math.round((Date.now() - t1) / 1000)}s`)
await call('lean_close_session', { session_id: o2.session_id })

// (c) the timeout is actually enforced: a second instance with a 3s budget
const reg2 = new Map()
await apply(
  {
    get: (k) => (k === 'subprocess' ? subprocess : undefined),
    tools: { register: (d) => (reg2.set(d.name, d), () => {}) },
    effect: () => () => {}
  },
  { projectDir: process.env.MATHLIB_DIR, interactiveTimeoutMs: 3000 }
)
const call2 = (n, a) => reg2.get(n).execute(a, {})
const o3 = await call2('lean_open_file', {
  name: 'timeout',
  content: 'import Mathlib\n\nexample (n : Nat) : n < n + 1 := by\n'
})
const t3 = Date.now()
const t4 = await call2('lean_run_tactic', { session_id: o3.session_id, tactic: 'omega' })
console.log(
  `timeout check -> timed_out reported by runTactic? ${Boolean(t4.errors?.length || t4.timed_out)} | ` +
    `proven=${t4.proven} | took ${Math.round((Date.now() - t3) / 1000)}s (budget 3s)`
)
await call2('lean_close_session', { session_id: o3.session_id })
