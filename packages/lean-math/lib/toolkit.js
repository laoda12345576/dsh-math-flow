/**
 * Tool-definition plumbing.
 *
 * The plugin uses the harness' own `defineTool()` from
 * `@deepseek-ai/dsh-tools`, so its parameter and output schemas flow through the
 * platform's canonical conversion and validation.
 *
 * Resolution order:
 *   1. the bare `@deepseek-ai/dsh-tools` specifier (registry installs, or a
 *      profile whose `node_modules` is an ancestor of this file);
 *   2. `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-tools`, the hoisted
 *      location a `dsh plugin add` install produces — needed because a linked
 *      plugin's realpath sits outside the profile, so Node's own lookup misses it.
 *
 * @module dsh-plugin-lean-math/toolkit
 */

/** Resolved implementation, cached across calls. */
let implementation = null

/** Where the current implementation came from. */
let implementationSource = 'unresolved'

/**
 * Resolve the harness' canonical `defineTool`.
 * @returns {Promise<{defineTool: (options: Record<string, unknown>) => Record<string, unknown>, source: string}>} the implementation.
 */
export async function resolveDefineTool() {
  if (implementation !== null) return { defineTool: implementation, source: implementationSource }
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') {
      implementation = mod.defineTool
      implementationSource = '@deepseek-ai/dsh-tools'
      return { defineTool: implementation, source: implementationSource }
    }
  } catch {
    /* fall through to the profile location */
  }
  for (const candidate of profileCandidatePaths()) {
    try {
      const mod = await import(candidate)
      if (typeof mod.defineTool === 'function') {
        implementation = mod.defineTool
        implementationSource = `${candidate} (profile fallback)`
        return { defineTool: implementation, source: implementationSource }
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'dsh-plugin-lean-math: could not resolve defineTool. Install it into a DSH profile ' +
      '(`dsh plugin --profile <name> add D:\\tools\\dsh-plugin-lean-math`) so ' +
      '@deepseek-ai/dsh-tools is hoisted into that profile.'
  )
}

/**
 * Candidate file URLs for the harness' own `dsh-tools` build.
 *
 * A linked plugin is resolved through its realpath, which is outside the profile,
 * so the profile's hoisted `node_modules` has to be imported by URL.
 * @returns {string[]} file URLs to try, in order.
 */
function profileCandidatePaths() {
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE
  if (typeof home !== 'string' || home === '') return []
  const base = home.replace(/\\/g, '/').replace(/\/+$/, '')
  return [`file:///${base.replace(/^\/+/, '')}/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js`]
}
