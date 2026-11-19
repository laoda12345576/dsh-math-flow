/** Test lean_axioms: detects `sorry` cheating and real completeness. */
import { spawn, execFileSync } from 'node:child_process'
import { apply } from '../lib/index.js'

const subprocess = {
  async resolveExecutable(bin) {
    return execFileSync('where.exe', [bin], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, signal: spec.signal })
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
  { interactiveTimeoutMs: 120000 }
)

console.log('registered:', [...reg.keys()].length, 'tools ->', [...reg.keys()].join(', '), '\n')

const call = (n, a) => reg.get(n).execute(a, {})

const code = [
  'theorem good (n : Nat) : n + 0 = n := by simp',
  'theorem cheating : 1 + 1 = 3 := by sorry',
  'theorem also_good : 2 + 2 = 4 := by decide'
].join('\n')

const r = await call('lean_axioms', { code, project_dir: '' })
console.log('ok:', r.ok, '| any_sorry:', r.any_sorry)
for (const d of r.declarations) {
  console.log(`  ${d.name.padEnd(12)} uses_sorry=${d.uses_sorry}  complete=${d.complete}  axioms=${JSON.stringify(d.axioms)}`)
}

// explicit names
const r2 = await call('lean_axioms', { code, names: ['cheating'], project_dir: '' })
console.log('\nexplicit names -> any_sorry:', r2.any_sorry, '| declarations:', r2.declarations.length)

// Mathlib case
const r3 = await call('lean_axioms', {
  code: 'import Mathlib.Tactic\n\ntheorem t (n : Nat) : n < n + 1 := by omega',
  project_dir: 'D:\\Ai for Math\\mathlib4'
})
console.log('\nMathlib -> ok:', r3.ok, '| any_sorry:', r3.any_sorry, '|', JSON.stringify(r3.declarations))
