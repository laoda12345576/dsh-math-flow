/**
 * Smoke test: load the plugin the way the harness will, resolve defineTool
 * through the profile fallback, and exercise apply() against a minimal ctx.
 */
import { name, inject, apply } from '../lib/index.js'
import { resolveDefineTool } from '../lib/toolkit.js'

console.log('plugin name   =', name)
console.log('plugin inject =', JSON.stringify(inject))
console.log('apply type    =', typeof apply)

const { defineTool, source } = await resolveDefineTool()
console.log('defineTool    =', source, '(type', typeof defineTool + ')')

const registered = []
const effects = []
const ctx = {
  get(key) {
    console.log('  ctx.get(' + JSON.stringify(key) + ') -> undefined (mock)')
    return undefined
  },
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    }
  },
  effect(callback) {
    effects.push(callback)
    return () => {}
  }
}

await apply(ctx, { projectDir: 'D:\\Ai for Math\\mathlib4', defaultTimeoutMs: 120000 })

console.log('registered    =', registered.length, 'tools')
for (const tool of registered) {
  const params = Object.keys(tool.parameters?.properties ?? {})
  console.log('  -', tool.name, '| params:', params.join(', ') || '(none)', '| render:', typeof tool.output?.render)
}
console.log('effects       =', effects.length)
