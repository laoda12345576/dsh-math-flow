/** Focused test of the interactive loop: rollback + acceptance (pure Lean, fast). */
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { apply } from '../lib/index.js'

// Scratch directory for the interactive session. Override with MATHLIB_WORKSPACE
// if your Mathlib checkout lives somewhere specific; the test only needs a
// writable path it can drop a .lean file into.
const WORKSPACE = process.env.MATHLIB_WORKSPACE || process.env.TEMP || '/tmp'

const subprocess = {
  async resolveExecutable(bin) {
    return execFileSync('where.exe', [bin], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd })
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
const fs = {
  async resolve(p) {
    return { full: resolvePath(WORKSPACE, p) }
  },
  processPath: (t) => t.full,
  async writeText(t, c) {
    writeFileSync(t.full, c, 'utf8')
  }
}
const registered = new Map()
await apply(
  {
    get: (k) => (k === 'subprocess' ? subprocess : k === 'fs' ? fs : undefined),
    tools: { register: (d) => (registered.set(d.name, d), () => {}) },
    effect: () => () => {}
  },
  { projectDir: process.env.MATHLIB_DIR, defaultTimeoutMs: 600000 }
)

const call = (n, a) => registered.get(n).execute(a, {})

// Pure Lean (no Mathlib import) with project_dir:"" -> plain `lean`, fast.
const opened = await call('lean_open_file', {
  name: 'loop',
  content: 'example : 1 + 1 = 2 := by\n',
  project_dir: ''
})
const sid = opened.session_id
console.log('opened', sid, '| project:', JSON.stringify(opened.project_dir))

console.log('\nSTEP 0: initial goals')
const g0 = await call('lean_get_goals', { session_id: sid })
console.log('  goals:', JSON.stringify(g0.goals), '| proven:', g0.proven)

console.log('\nSTEP 1: WRONG tactic (expect accepted=false, rolled_back=true)')
const t1 = await call('lean_run_tactic', { session_id: sid, tactic: 'exact 5' })
console.log('  accepted:', t1.tactic_accepted, '| rolled_back:', t1.rolled_back, '| proven:', t1.proven)
console.log('  source after:', JSON.stringify(t1.source))

console.log('\nSTEP 2: GOOD tactic after rollback (expect accepted=true, proven=true)')
const t2 = await call('lean_run_tactic', { session_id: sid, tactic: 'decide' })
console.log('  accepted:', t2.tactic_accepted, '| rolled_back:', t2.rolled_back, '| proven:', t2.proven)
console.log('  source after:', JSON.stringify(t2.source))
if (!t2.proven) console.log('  errors:', JSON.stringify(t2.errors), '| goals:', JSON.stringify(t2.goals))

await call('lean_close_session', { session_id: sid })
console.log('\ndone')
