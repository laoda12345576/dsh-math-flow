// 真实时钟的回归测试。
//
// 起因（team11）：模型没有计时器，上下文里没有任何东西编码"从开工到现在过了多久"。
// 于是报告里的时间线是从约束反推的——预算 60 分钟、阈值 23:40 → 写"做到 23:45 之后"，
// 而报告 23:32:56 就落盘了。修法是把时钟交给宿主盖章，插件只负责渲染。
//
// 这个测试盯三件事：① 没有时钟文件时说"未注入"而不是编一个；
// ② 有文件时报出真实的已用/剩余；③ 文案里必须写明"这不是判据"，
// 否则被注入的数字会被当成又一个"用够才算数"的阈值（上一版就是这么坏的）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clockLine } from '../lib/gate.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-'))

// ① 没有文件
const missing = clockLine(path.join(tmp, 'nope.json'))
assert.match(missing, /未注入/)
assert.match(missing, /mtime/)

// ② 正常文件：开工 30 分钟前，预算 60 分钟
const t0 = Date.now() - 30 * 60000
const f = path.join(tmp, '.clock.json')
fs.writeFileSync(f, JSON.stringify({ dir: tmp, t0, budgetMin: 60 }))
const line = clockLine(f, Date.now())
assert.match(line, /已用 30 分/)
assert.match(line, /剩 30 分/)
assert.match(line, /预算 60 分钟/)

// ③ 超时也要如实说"超"，不能把负数藏起来
const over = clockLine(f, t0 + 90 * 60000)
assert.match(over, /已超 30 分/)

// ④ 没有预算就没预算字段，不硬编一个
fs.writeFileSync(f, JSON.stringify({ dir: tmp, t0, budgetMin: null }))
assert.doesNotMatch(clockLine(f, Date.now()), /预算/)

// ⑤ 文案必须否掉"用够才算数"，否则注入的读数会变成新的目标
assert.match(line, /不是判据/)
assert.match(line, /不存在"用够才算数"/)

// ⑥ 坏文件当成没有，不抛
fs.writeFileSync(f, '{ not json')
assert.match(clockLine(f), /未注入/)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('clock: ok')
