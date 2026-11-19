/**
 * Tool-definition plumbing.
 *
 * The plugin prefers the harness' own `defineTool()` from
 * `@deepseek-ai/dsh-tools`, so its parameter and output schemas flow through the
 * platform's canonical conversion and validation. When that package cannot be
 * resolved (the library is opened outside a DSH profile, e.g. from the CLI or a
 * unit test) a local implementation of the same schema DSL is used, so the plugin
 * is dependency-free and testable in isolation.
 *
 * @module dsh-plugin-jammers-sim/toolkit
 */

/** Resolved implementation, cached across calls. */
let implementation = null

/** Where the current implementation came from. */
let implementationSource = 'unresolved'

/**
 * Resolve the `defineTool` implementation, preferring the platform's.
 *
 * Resolution order:
 *   1. the bare `@deepseek-ai/dsh-tools` specifier (registry installs, or a
 *      profile whose `node_modules` is an ancestor of this file);
 *   2. `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-tools`, the hoisted
 *      location a `dsh plugin add` install produces — needed because a linked
 *      plugin's realpath sits outside the profile, so Node's own lookup misses it;
 *   3. the local fallback, which implements the same schema DSL.
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
    /* try the profile location next */
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
  implementation = localDefineTool
  implementationSource = 'local fallback'
  return { defineTool: implementation, source: implementationSource }
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

/**
 * Convert the harness parameter-spec DSL into JSON Schema.
 *
 * The implicit parameter root stays open, mirroring the platform: only explicitly
 * declared objects carry `additionalProperties`.
 * @param {Record<string, unknown>} parameters - parameter specs keyed by name.
 * @returns {Record<string, unknown>} the JSON Schema.
 */
export function parametersToJsonSchema(parameters) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    properties[name] = nodeToJsonSchema(spec)
    if (spec !== null && typeof spec === 'object' && /** @type {Record<string, unknown>} */ (spec).required === true) required.push(name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {})
  }
}

/**
 * Convert one DSL node (or a whole value-schema spec) into JSON Schema.
 * @param {unknown} spec - the DSL node.
 * @returns {Record<string, unknown>} the JSON Schema.
 */
export function nodeToJsonSchema(spec) {
  if (spec === null || typeof spec !== 'object') return {}
  const node = /** @type {Record<string, unknown>} */ (spec)
  const out = {}
  if (typeof node.description === 'string') out.description = node.description
  if (Array.isArray(node.oneOf)) {
    out.oneOf = node.oneOf.map((branch) => nodeToJsonSchema(branch))
    return out
  }
  const type = node.type
  if (type === 'json' || type === undefined) {
    return Object.keys(out).length > 0 ? out : {}
  }
  out.type = type
  if (node.enum !== undefined) out.enum = node.enum
  if (node.const !== undefined) out.const = node.const
  if (type === 'array') {
    out.items = node.items === undefined ? {} : nodeToJsonSchema(node.items)
  }
  if (type === 'object') {
    const properties = {}
    const required = []
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const converted = nodeToJsonSchema(child)
      properties[name] = converted.schema ?? converted
      if (child?.required === true) required.push(name)
    }
    out.properties = properties
    out.additionalProperties = node.additionalProperties ?? false
    if (required.length > 0) out.required = required
  }
  return out
}

/**
 * Wrap an options object into a `ToolDefinition`, converting DSL specs.
 * @param {Record<string, unknown>} options - `defineTool` options using the same DSL.
 * @returns {Record<string, unknown>} the tool definition.
 */
export function localDefineTool(options) {
  const parameters = parametersToJsonSchema(options.parameters)
  const outputSchema = nodeToJsonSchema(options.output?.schema)
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.presentCall === undefined ? {} : { presentCall: options.presentCall }),
    ...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
    async execute(args, exec) {
      const value = args ?? {}
      const problems = validateJsonSchema(parameters, value, '')
      if (problems.length > 0) throw new Error(`invalid arguments for ${String(options.name)}: ${problems.join('; ')}`)
      return options.execute(value, exec)
    }
  }
}

/**
 * Validate a JSON value against the schema subset this plugin uses.
 *
 * Supported keywords: `type`, `enum`, `const`, `required`, `properties`,
 * `additionalProperties`, `items`, `oneOf`.
 * @param {Record<string, unknown>} schema - JSON Schema node.
 * @param {unknown} value - candidate value.
 * @param {string} path - JSON path for messages.
 * @returns {string[]} validation problems; empty when valid.
 */
export function validateJsonSchema(schema, value, path) {
  const problems = []
  const at = path === '' ? '(root)' : path
  if (schema === null || typeof schema !== 'object') return problems
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((branch) => validateJsonSchema(branch, value, path).length === 0)
    if (!matched) problems.push(`${at} 不满足 oneOf 的任何分支`)
    return problems
  }
  if (schema.const !== undefined && value !== schema.const) problems.push(`${at} 必须等于 ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${at} 必须是 ${schema.enum.map((item) => JSON.stringify(item)).join(' / ')} 之一`)
  }
  const type = schema.type
  if (typeof type === 'string') {
    const matches = typeMatches(type, value)
    if (!matches) {
      problems.push(`${at} 必须是 ${type}（实际 ${describeType(value)}）`)
      return problems
    }
  }
  if (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value)
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (record[name] === undefined) problems.push(`${at}.${name} 必填`)
    }
    const properties = schema.properties ?? {}
    for (const [name, child] of Object.entries(properties)) {
      if (record[name] !== undefined) problems.push(...validateJsonSchema(child, record[name], `${path}.${name}`))
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(record)) {
        if (properties[name] === undefined) problems.push(`${at}.${name} 是未声明的字段`)
      }
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      problems.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`))
    })
  }
  return problems
}

/**
 * Whether a value matches one JSON Schema type name.
 * @param {string} type - schema type.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether it matches.
 */
function typeMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

/**
 * Describe a value's JSON type for error messages.
 * @param {unknown} value - candidate value.
 * @returns {string} the type description.
 */
function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
