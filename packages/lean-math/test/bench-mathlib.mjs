/**
 * The scenario that matters most: a Mathlib-backed interactive proof.
 * Loads Mathlib ONCE into a resident server, then drives several tactics.
 */
import { apply } from '../lib/index.js'
import { spawn, execFileSync } from 'node:child_process'

const subprocess = {
  async resolveExecutable(bin) {
    try {
      return execFileSync('where.exe', [bin], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
    } catch {
      return null // the plugin's own PATH fallback will take over
    }
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
await apply(
  {
    get: (k) => (k === 'subprocess' ? subprocess : null),
    tools: { register: (d) => reg.set(d.name, d) },
    effect: (f) => f(),
    logger: { info() {}, warn() {}, error() {} },
  },
  { projectDir: process.env.MATHLIB_DIR, interactiveTimeoutMs: 900000, defaultTimeoutMs: 900000 }
)
const call = async (n, a) => {
  const t = Date.now()
  const out = await reg.get(n).execute(a, {})
  console.log(`   [${n}] ${Date.now() - t} ms`)
  return out
}

console.log('=== open a Mathlib.Tactic session (imports load ONCE here) ===')
const opened = await call('lean_open_file', {
  name: 'ml',
  content: 'import Mathlib.Tactic\n\nexample (n : Nat) : n < n + 1 := by',
})
console.log(JSON.stringify({ ok: opened.ok, error: opened.error, goals: opened.goals }, null, 2))
if (!opened.ok) { console.log('FAILED at open; aborting'); process.exit(1) }
const sid = opened.session_id

console.log('\n=== tactics (each should be incremental, NOT a Mathlib reload) ===')
for (const t of ['omega', 'exact Nat.lt_succ_self n', 'linarith']) {
  const r = await call('lean_run_tactic', { session_id: sid, tactic: t })
  console.log(`   tactic=${JSON.stringify(t)} accepted=${r.tactic_accepted} proven=${r.proven} goals=${JSON.stringify(r.goals)}`)
  if (r.error) console.log(`   ERROR: ${r.error}`)
  if (r.proven) break
}

console.log('\n=== #check inside the Mathlib session ===')
const q = await call('lean_query', { session_id: sid, command: '#check', expr: 'Nat.lt_succ_self' })
console.log('   answers:', JSON.stringify(q.answers))

await call('lean_close_session', { session_id: sid })
console.log('\nDone.')
process.exit(0)
