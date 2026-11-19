/**
 * Does the diagnostic parser handle BOTH of Lean's error formats?
 *
 * Regression for a defect that cost 15 candidates across 3 ladder goals. Lean emits:
 *
 *   foo.lean:3:2: error: Tactic `simp` failed with a nested error:
 *   foo.lean:3:2: error(lean.invalidField): Invalid field `of_prod_left` ...
 *
 * The parser required a colon immediately after the severity, so every diagnostic
 * carrying an error code was invisible. The batch then had an empty error list, a
 * non-zero exit code, and no success flag — which the caller's fail-closed rule reads
 * as "Lean never said anything", discarding all five candidates even when some of them
 * had produced no error at all.
 *
 * Both shapes are asserted here, because a fix for the coded form must not lose the
 * uncoded one.
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

const project = process.env.MATHLIB_DIR
await apply(ctx, {
  projectDir: project,
  defaultProjectDir: project,
  lean: { projectDir: project, verifyTimeoutMs: 300000 }
})

const verify = (code) => registry.get('lean_verify_proof').execute({ code, timeout_ms: 300000 }, {})

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -> ' + detail}`)
  }
}

// ---- coded diagnostic: `error(lean.unknownIdentifier): ...` -----------------
const coded = await verify('import Mathlib.Tactic\nexample : 1 + 1 = 2 := by\n  exact bogus_identifier_xyz')
check('coded: the call fails', coded.success === false)
check('coded: it is not reported as a timeout', coded.timed_out !== true)
check(
  'coded: the diagnostic is parsed, not swallowed',
  Array.isArray(coded.errors) && coded.errors.length > 0,
  `errors=${JSON.stringify(coded.errors)} stderr=${String(coded.stderr).slice(0, 200)}`
)
check(
  'coded: the message survives',
  coded.errors.some((entry) => /bogus_identifier_xyz|Unknown identifier/i.test(entry.message)),
  JSON.stringify(coded.errors)
)
check(
  'coded: line and column are reported',
  coded.errors.some((entry) => Number.isInteger(entry.line) && entry.line > 0 && Number.isInteger(entry.column)),
  JSON.stringify(coded.errors)
)

// ---- uncoded diagnostic: `error: Tactic ... failed` -------------------------
const uncoded = await verify('import Mathlib.Tactic\nexample : 1 + 1 = 2 := by\n  exact (1 : Nat)')
check('uncoded: the call fails', uncoded.success === false)
check(
  'uncoded: the diagnostic is still parsed',
  Array.isArray(uncoded.errors) && uncoded.errors.length > 0,
  `errors=${JSON.stringify(uncoded.errors)}`
)

// ---- a clean proof must stay clean ------------------------------------------
const clean = await verify('import Mathlib.Tactic\nexample : 1 + 1 = 2 := by norm_num')
check('clean: success', clean.success === true)
check('clean: no errors', Array.isArray(clean.errors) && clean.errors.length === 0)

console.log(`\ndiagnostics: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
