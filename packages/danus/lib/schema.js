/**
 * MCP 的 inputSchema → dsh 的 `parameters` 声明。
 *
 * dsh 的 defineTool 只接受一个很小的 schema 子集（`type` 是 string/number/
 * integer/boolean/null/array/object/json，object 必须显式写 additionalProperties，
 * 不支持 $ref/anyOf/allOf）。MCP 服务器给的却是完整 JSON Schema。两者之间只能
 * 做**有损**映射，所以这里的原则是：**宁可少约束，也不要给模型一个假的约束**。
 *
 * 具体做法：认得出来的类型照搬，认不出来的一律退到 `type: 'json'`（dsh 里它
 * 是"只标注、不校验"）。真正把关的是网关自己——它在调用时校验参数、按角色
 * 决定哪些工具存在。插件这里做的是"让模型看得懂怎么填"，不是"替网关验参"。
 */

import { createHash } from 'node:crypto'

const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/** @returns {{parameters: object, stats: {tools: number, widened: number, required: number}}} */
export function createMapper() {
  const stats = { tools: 0, widened: 0, required: 0 }
  return {
    stats,
    mapTool(tool) {
      const mapped = mapSchema(tool?.inputSchema)
      stats.tools += 1
      stats.widened += mapped.widened
      stats.required += mapped.required
      return mapped.parameters
    },
  }
}

export function mapSchema(inputSchema) {
  const schema = isRecord(inputSchema) ? inputSchema : {}
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const parameters = {}
  let widened = 0
  let requiredCount = 0

  for (const [name, raw] of Object.entries(properties)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue // 参数名要能出现在提示里
    const { spec, narrowed } = mapProperty(raw)
    if (required.has(name)) {
      spec.required = true
      requiredCount += 1
    }
    if (narrowed) widened += 1
    parameters[name] = spec
  }
  return { parameters, widened, required: requiredCount }
}

function mapProperty(raw) {
  const node = isRecord(raw) ? raw : {}
  const description = typeof node.description === 'string' ? node.description.slice(0, 600) : undefined
  const base = description === undefined ? {} : { description }

  // 联合类型 / 引用 / 组合：一律不猜。
  if (node.$ref !== undefined || node.anyOf !== undefined || node.oneOf !== undefined || node.allOf !== undefined) {
    return { spec: { type: 'json', ...base }, narrowed: 1 }
  }

  let type = node.type
  if (Array.isArray(type)) {
    const first = type.find((t) => t !== 'null')
    type = first ?? 'null'
    if (type === 'null') return { spec: { type: 'json', ...base }, narrowed: 1 }
  }

  if (type === 'array') {
    return { spec: { type: 'array', items: { type: 'json' }, ...base }, narrowed: 1 }
  }
  if (type === 'object') {
    // 嵌套对象原样交给模型（描述里有结构），但不声明属性：dsh 的子集要
    // additionalProperties，而我们没有可靠的办法逐个翻译嵌套属性。
    return { spec: { type: 'object', additionalProperties: true, ...base }, narrowed: 1 }
  }
  if (type === undefined && Array.isArray(node.enum)) {
    const values = node.enum.filter((v) => typeof v === 'string')
    if (values.length > 0 && values.length === node.enum.length) {
      return { spec: { type: 'string', enum: values, ...base }, narrowed: 0 }
    }
  }
  if (SCALARS.has(type)) {
    if (type === 'null') return { spec: { type: 'json', ...base }, narrowed: 1 }
    const spec = { type, ...base }
    if (Array.isArray(node.enum)) {
      const values = node.enum.filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      if (values.length > 0) spec.enum = values
    }
    if (typeof node.const === 'string' || typeof node.const === 'number' || typeof node.const === 'boolean') {
      spec.enum = [node.const]
    }
    return { spec, narrowed: 0 }
  }
  return { spec: { type: 'json', ...base }, narrowed: 1 }
}

/** 一份 schema 的指纹，用来判断"网关广告的工具集变了没有"。 */
export function schemaDigest(tools) {
  const shape = (Array.isArray(tools) ? tools : [])
    .map((t) => `${t?.name ?? ''}:${JSON.stringify(t?.inputSchema ?? {})}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(shape).digest('hex').slice(0, 12)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
