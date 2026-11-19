// 接线测试：gate.js 是纯逻辑，能被单测；index.js 的 apply() 只在真宿主里跑过。
//
// 但恰恰是 apply() 写错最致命——它一抛，整轮 dsh 起不来，而现象是"任务没反应"，
// 看起来像模型不干活。所以这里用最小 ctx 把它跑一遍，只验三件事：
//   ① guard 装上了（门禁存在）
//   ② systemPrompt.section 与 context 各注册了一次
//   ③ context 的 text 能被反复求值，且返回真实时钟（不是抛异常、也不是空串）
//
// 不测拦截逻辑——那是 smoke.mjs 的事。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'))
const clock = path.join(tmp, '.clock.json')
fs.writeFileSync(clock, JSON.stringify({ dir: tmp, t0: Date.now() - 5 * 60000, budgetMin: 45 }))

const sections = []
const contexts = []
let guarded = null

const ctx = {
  tools: {
    guard(fn) {
      guarded = fn
    },
    register() {
      /* 状态工具注册失败不影响门禁，这里不模拟 */
    },
  },
  systemPrompt: {
    section(o) {
      sections.push(o)
    },
    context(o) {
      contexts.push(o)
    },
  },
}

await apply(ctx, { clockFile: clock, minReads: 3 })

assert.equal(typeof guarded, 'function', 'guard 应被装上')
assert.ok(sections.some((s) => s.name === 'dsh-plugin-research-gate'), '提示段应注册')

const clockCtx = contexts.find((c) => c.name === 'research-clock')
assert.ok(clockCtx, '时钟上下文应注册')
assert.equal(typeof clockCtx.order, 'number', 'context 需要有限 order')

const line1 = clockCtx.text()
assert.match(line1, /真实时钟/, '应渲染出时钟')
assert.match(line1, /已用 5 分/, '应报出已用时长')

// 再求值一次必须是字符串——text() 是每轮重新调的，不能依赖某次调用的副作用。
assert.equal(typeof clockCtx.text(), 'string')

// 关掉时不该注册（部署时可以只留门禁不要时钟）
const contexts2 = []
await apply(
  {
    tools: { guard() {}, register() {} },
    systemPrompt: { section() {}, context: (o) => contexts2.push(o) },
  },
  { clockFile: clock, injectClock: false },
)
assert.equal(contexts2.length, 0, 'injectClock=false 时不该注册时钟')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('wiring: ok')
