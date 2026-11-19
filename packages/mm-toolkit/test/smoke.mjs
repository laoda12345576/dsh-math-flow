/**
 * Smoke test: import the plugin from its installed location, apply it against a
 * minimal fake context, and list the tools it registers.
 *
 * Run: node D:\tools\dsh-plugin-mm-toolkit\test\smoke.mjs
 */
import * as plugin from '../lib/index.js'

const registered = []
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool)
    },
  },
}

console.log('plugin name :', plugin.name)
console.log('plugin inject:', JSON.stringify(plugin.inject))

await plugin.apply(ctx, {})

console.log('registered tools:', registered.length)
for (const t of registered) {
  const required = t.parameters?.required
  const suffix = Array.isArray(required) && required.length ? `   required: ${required.join(', ')}` : ''
  console.log(`  - ${t.name}${suffix}`)
}

const missing = registered.filter((t) => typeof t.execute !== 'function' || typeof t.description !== 'string' || t.description.length < 20)
if (missing.length) {
  console.error('INVALID TOOLS:', missing.map((t) => t.name).join(', '))
  process.exit(1)
}
console.log('OK')
