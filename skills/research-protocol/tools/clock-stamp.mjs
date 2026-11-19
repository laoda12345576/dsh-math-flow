// 给宿主用的时钟：把"这一轮什么时候开工"写成一个文件，插件只负责渲染。
//
// 为什么不在插件里算：锚点规则必须和 tools/research-state.mjs 的 timeAnchor() 一致，
// 否则会出现"注入的时钟说已用 40 分钟、审计说 22 分钟"——两套读数打架时，
// 模型会挑对它有利的那一套引用，人就彻底失去判断依据。
// 所以规则只写一份（research-state.mjs），这里只做序列化。
//
// 用法：
//   node tools/clock-stamp.mjs --dir runs/team12 > .clock.json
//
// 输出：{"dir":..., "t0":epoch_ms, "budgetMin":60, "startedAt":"23:10:28"}

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { timeAnchor } from './research-state.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAB = path.resolve(HERE, '..')

export function stamp(dir, goalMd = '') {
  const { t0 } = timeAnchor(dir)
  const sec = (String(goalMd).match(/^##\s*预算\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m) || [])[1] || ''
  const m = sec.match(/(\d+)\s*(?:分钟|min)/i)
  return {
    dir: path.resolve(dir),
    t0: t0 ?? Date.now(),
    budgetMin: m ? Number(m[1]) : null,
    startedAt: new Date(t0 ?? Date.now()).toTimeString().slice(0, 8),
    stampedAt: new Date().toISOString(),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--dir')
  const dir = path.resolve(LAB, i >= 0 ? argv[i + 1] : '.')
  const goalPath = path.join(dir, 'goal.md')
  const goalMd = fs.existsSync(goalPath) ? fs.readFileSync(goalPath, 'utf8') : ''
  console.log(JSON.stringify(stamp(dir, goalMd), null, 2))
}
