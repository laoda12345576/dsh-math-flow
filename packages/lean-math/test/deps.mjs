/** Test lean_deps: transitive graph, module tagging, filters. */
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
  { projectDir: 'D:\\Ai for Math\\mathlib4', defaultTimeoutMs: 300000 }
)
const call = (n, a) => reg.get(n).execute(a, {})

console.log('tools:', [...reg.keys()].join(', '), '\n')

// A: local lemmas - the graph should show a3 -> a1, a2
const codeA = [
  'theorem a1 : 1 + 1 = 2 := by decide',
  'theorem a2 : 2 + 2 = 4 := by decide',
  'theorem a3 : 1 + 1 = 2 ∧ 2 + 2 = 4 := by exact ⟨a1, a2⟩'
].join('\n')
const ra = await call('lean_deps', { code: codeA, names: ['a3'], project_dir: '' })
const da = ra.declarations?.[0]
console.log('A) a3 (local):', 'nodes=' + da?.node_count, 'edges=' + da?.edge_count, 'direct=' + da?.direct_count)
const localEdges = (da?.edges || []).filter((e) => ['a1', 'a2', 'a3'].includes(e.to))
console.log('   local edges:', JSON.stringify(localEdges))
console.log('   by_module sample:', JSON.stringify(Object.entries(da?.by_module || {}).slice(0, 4)))

// B: direct-only
const rb = await call('lean_deps', { code: codeA, names: ['a3'], transitive: false, project_dir: '' })
const db = rb.declarations?.[0]
console.log('\nB) transitive:false -> nodes=' + db?.node_count, 'edges=' + db?.edge_count, '(expect edges 0)')
console.log('   direct deps:', JSON.stringify((db?.nodes || []).filter((n) => ['a1', 'a2'].includes(n.name)).map((n) => n.name)))

// C: a Mathlib theorem, filtered to Mathlib only
const codeC = 'import Mathlib.Tactic\n\ntheorem t (a b : ℝ) : (a + b)^2 = a^2 + 2*a*b + b^2 := by ring'
const rc = await call('lean_deps', { code: codeC, names: ['t'], module_prefix: 'Mathlib', max_nodes: 25 })
const dc = rc.declarations?.[0]
console.log('\nC) Mathlib ring theorem:')
console.log('   node_count=' + dc?.node_count, 'edge_count=' + dc?.edge_count, 'truncated=' + dc?.truncated)
console.log('   by_module top:', JSON.stringify(Object.entries(dc?.by_module || {}).sort((x, y) => y[1] - x[1]).slice(0, 5)))
console.log('   first nodes:', JSON.stringify((dc?.nodes || []).slice(0, 5)))
console.log('   errors:', JSON.stringify(rc.errors))
