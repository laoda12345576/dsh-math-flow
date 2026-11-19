/**
 * Full regression + benchmark for the rewritten lean-math interactive loop.
 * Pure Lean only (no Mathlib) so the run stays short; the Mathlib payoff is the
 * same mechanism with a much bigger constant removed.
 */
import { apply } from '../lib/index.js'
import { spawn } from 'node:child_process'

const subprocess = {
  async resolveExecutable(bin) {
    const known = {
      lean: process.env.LEAN_BIN ?? 'lean',
      lake: process.env.LAKE_BIN ?? 'lake',
      elan: process.env.ELAN_BIN ?? 'elan',
      curl: 'curl',
    }
    return known[bin] ?? null
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let so = '', se = ''
    child.stdout.on('data', (d) => { so += d })
    child.stderr.on('data', (d) => { se += d })
    const done = new Promise((r) => child.on('close', (c) => r({ exitCode: c ?? 0 })))
    if (spec.signal) spec.signal.addEventListener('abort', () => { try { child.kill('SIGKILL') } catch {} }, { once: true })
    return {
      done,
      terminate() { try { child.kill('SIGKILL') } catch {} },
      collected: { stdout: { readFrom: () => ({ text: so }) }, stderr: { readFrom: () => ({ text: se }) } },
    }
  },
}
const reg = new Map()
const ctx = {
  get: (k) => (k === 'subprocess' ? subprocess : null),
  tools: { register: (d) => reg.set(d.name, d) },
  effect: (f) => f(),
  logger: { info() {}, warn() {}, error() {} },
}
const t0 = Date.now()
await apply(ctx, { projectDir: '', defaultTimeoutMs: 120000, interactiveTimeoutMs: 120000, searchTimeoutMs: 10000 })
console.log(`plugin apply: ${Date.now() - t0} ms | tools: ${[...reg.keys()].join(', ')}\n`)

async function call(name, args) {
  const def = reg.get(name)
  if (!def) throw new Error(`not registered: ${name}`)
  const t = Date.now()
  const out = await def.execute(args, {})
  return { out, ms: Date.now() - t }
}
const line = (l, r) => console.log(`${l.padEnd(34)} ${r.ms} ms  ${JSON.stringify(r.out).slice(0, 190)}`)

// ── 1. open ────────────────────────────────────────────────────────────────
let r = await call('lean_open_file', {
  name: 'v2', project_dir: '',
  content: 'example (n : Nat) : n + 0 = n := by',
})
console.log('1) open_file')
console.log(`   ${r.ms} ms | goals: ${JSON.stringify(r.out.goals)} | engine: ${r.out.engine}`)
const sid = r.out.session_id
const openMs = r.ms

// ── 2. get_goals should be instant (cached) ────────────────────────────────
r = await call('lean_get_goals', { session_id: sid })
console.log(`\n2) get_goals (cached)      ${r.ms} ms | goals: ${JSON.stringify(r.out.goals)}`)
const cachedMs = r.ms

// ── 3. tactics, timed ──────────────────────────────────────────────────────
console.log('\n3) tactics (each is one incremental elaboration)')
const stepMs = []
for (const t of ['induction n', 'simp', 'rfl']) {
  r = await call('lean_run_tactic', { session_id: sid, tactic: t })
  stepMs.push(r.ms)
  console.log(`   ${t.padEnd(14)} ${String(r.ms).padStart(5)} ms | accepted=${r.out.tactic_accepted} proven=${r.out.proven} goals=${JSON.stringify(r.out.goals)}`)
}

// ── 4. rejected tactic rolls back ──────────────────────────────────────────
console.log('\n4) rejected tactic')
r = await call('lean_run_tactic', { session_id: sid, tactic: 'exact 42' })
console.log(`   ${r.ms} ms | accepted=${r.out.tactic_accepted} rolled_back=${r.out.rolled_back}`)
console.log(`   errors: ${JSON.stringify(r.out.errors.map((e) => e.message))}`)
console.log(`   goals preserved: ${JSON.stringify(r.out.goals)}`)

// ── 5. undo ────────────────────────────────────────────────────────────────
console.log('\n5) undo')
r = await call('lean_undo', { session_id: sid, steps: 2 })
console.log(`   ${r.ms} ms | undone=${r.out.undone} steps_left=${r.out.steps} goals=${JSON.stringify(r.out.goals)}`)

// ── 6. query (#check) ──────────────────────────────────────────────────────
console.log('\n6) query #check')
r = await call('lean_query', { session_id: sid, command: '#check', expr: 'Nat.add_comm' })
console.log(`   ${r.ms} ms | answers: ${JSON.stringify(r.out.answers)}`)

// ── 7. multi-goal with bullets ─────────────────────────────────────────────
console.log('\n7) multi-goal + bullet addressing')
const m = await call('lean_open_file', { name: 'multi', project_dir: '', content: 'example (a b : Nat) : a = a ∧ b = b := by' })
const msid = m.out.session_id
r = await call('lean_run_tactic', { session_id: msid, tactic: 'constructor' })
console.log(`   constructor   ${r.ms} ms | goals=${JSON.stringify(r.out.goals)}`)
r = await call('lean_run_tactic', { session_id: msid, tactic: 'rfl', bullet: true })
console.log(`   · rfl        ${r.ms} ms | goals=${JSON.stringify(r.out.goals)}`)
r = await call('lean_run_tactic', { session_id: msid, tactic: 'rfl', bullet: true })
console.log(`   · rfl        ${r.ms} ms | goals=${JSON.stringify(r.out.goals)} proven=${r.out.proven}`)

// ── 8. sessions list ───────────────────────────────────────────────────────
console.log('\n8) sessions')
r = await call('lean_sessions', {})
console.log(`   ${JSON.stringify(r.out.live)}`)

// ── 9. verify_proof still authoritative (CLI, unchanged) ───────────────────
console.log('\n9) verify_proof (kernel, unchanged path)')
r = await call('lean_verify_proof', { code: 'example : 1 + 1 = 2 := by decide', project_dir: '' })
console.log(`   ${r.ms} ms | success=${r.out.success}`)
r = await call('lean_verify_proof', { code: 'example : 1 + 1 = 3 := by decide', project_dir: '' })
console.log(`   ${r.ms} ms | success=${r.out.success} errors=${r.out.errors.length}`)

await call('lean_close_session', { session_id: sid })
await call('lean_close_session', { session_id: msid })

console.log('\n──────── summary ────────')
console.log(`open (incl. server start): ${openMs} ms`)
console.log(`get_goals (cached):        ${cachedMs} ms`)
console.log(`avg tactic step:           ${Math.round(stepMs.reduce((a, b) => a + b, 0) / stepMs.length)} ms  (was ~4200 ms via CLI respawn)`)
process.exit(0)
