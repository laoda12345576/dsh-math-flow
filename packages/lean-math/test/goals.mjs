/** Goal-extraction test: multi-goal, single goal, and tactic-failure shapes. */
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
const reg = new Map()
await apply(
  {
    get: (k) => (k === 'subprocess' ? subprocess : undefined),
    tools: { register: (d) => (reg.set(d.name, d), () => {}) },
    effect: () => () => {}
  },
  // 600000, not 120000: loading `import Mathlib.Tactic` measures 80-150s on this
  // machine, and a budget smaller than that times out mid-load and looks like a bug.
  { projectDir: process.env.MATHLIB_DIR, interactiveTimeoutMs: 600000 }
)
const call = (n, a) => reg.get(n).execute(a, {})

// A: constructor splits into TWO goals - both must be listed
const a = await call('lean_open_file', {
  name: 'two',
  content: 'example (p q : Prop) (hp : p) (hq : q) : p ∧ q := by\n',
  project_dir: ''
})
const ra = await call('lean_run_tactic', { session_id: a.session_id, tactic: 'constructor' })
console.log('A) constructor -> goals count:', ra.goals.length, '(expect 2)')
ra.goals.forEach((g, i) => console.log(`   goal[${i}]:`, JSON.stringify(g)))
await call('lean_close_session', { session_id: a.session_id })

// B: single goal
const b = await call('lean_open_file', { name: 'one', content: 'example : 1 + 1 = 2 := by\n', project_dir: '' })
const rb = await call('lean_get_goals', { session_id: b.session_id })
console.log('\nB) single goal -> count:', rb.goals.length, '(expect 1) |', JSON.stringify(rb.goals[0]))
await call('lean_close_session', { session_id: b.session_id })

// C: tactic failure returns the surviving goal
const c = await call('lean_open_file', {
  name: 'fail',
  content: 'example (h : 2 + 2 = 5) : False := by\n',
  project_dir: ''
})
const rc = await call('lean_run_tactic', { session_id: c.session_id, tactic: 'exact 3' })
console.log('\nC) failed tactic -> accepted:', rc.tactic_accepted, '| rolled_back:', rc.rolled_back)
console.log('   goals:', JSON.stringify(rc.goals))
await call('lean_close_session', { session_id: c.session_id })

// D: a real Mathlib proof with a narrow import
const d = await call('lean_open_file', {
  name: 'ml',
  content: 'import Mathlib.Tactic\n\nexample (n : Nat) : n < n + 1 := by\n'
})
const t0 = Date.now()
const rd = await call('lean_run_tactic', { session_id: d.session_id, tactic: 'omega' })
console.log(`\nD) Mathlib.Tactic + omega -> proven=${rd.proven} in ${Math.round((Date.now() - t0) / 1000)}s`)
await call('lean_close_session', { session_id: d.session_id })
