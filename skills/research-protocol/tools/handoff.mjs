// 结论交接：用几千 token 换掉 65 万 token 的整条会话重发。
//
// N-6 加了 `--resume`，能接着同一个会话跑。好处是上下文完整，代价是**每一轮
// 重发整条会话**——上一次续接实测约 65 万 token，而且随轮次线性增长。更要紧的
// 是：续接把"上一轮说过什么"整个搬进上下文，其中一半是已经被推翻的中间结论、
// 查过的死路、和被证伪的假设。它们不是知识，是噪声，而且模型会像对待知识一样
// 对待它们——team5 的队长就照着一份占位报告继续推理了两轮。
//
// 换一种交接方式：只搬**结论**，不搬**过程**。
//   · 报告正文（结论在现场，且已经过审计）
//   · 台账索引（每条判据的 id / 等级 / 结论，可复核）
//   · 作废与翻转清单（这些最容易被下一代忘掉，然后重新踩）
// 过程仍留在磁盘上（notes/、会话日志），需要时去读，不需要时不占上下文。
//
// 用法：
//   node tools/handoff.mjs --dir runs/team5 --state .agent-teams/edge-selmer-r2
//   → 写出 runs/team5/handoff.md，并打印字符数 / 估算 token
//
//   node tools/handoff.mjs --inject runs/team5/continue.yml \
//        --out runs/team5/.handoff-continue.yml --handoff runs/team5/handoff.md
//   → 把摘要插进任务书的 task 块开头（dsh-lab.sh --handoff 会调这一步）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGoal, loadRun, validate, roundSurprise, buildSlice } from './research-state.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAB = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const argOf = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}

const DIR = path.resolve(LAB, argOf('--dir', 'runs/team5'))
const STATE = path.resolve(LAB, argOf('--state', ''))
// 没给 --out 时必须留 null，不能 path.resolve(LAB, '')——那等于 LAB 自己，
// 后面 `OUT || 默认值` 会因为目录是 truthy 而把内容写到目录上（EISDIR）。
const OUT_RAW = argOf('--out', null)
const OUT = OUT_RAW ? path.resolve(LAB, OUT_RAW) : null
const INJECT = argOf('--inject', null)
const HANDOFF_IN = argOf('--handoff', null)
const MAX_LEDGER_ROWS = Number(argOf('--max-rows', 60))
// 目标可以来自别的目录：目标跨轮不变，而被交接的是一轮的状态。
const GOAL_DIR = argOf('--goal-dir', null)

const readIf = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const estTokens = (s) => Math.round(Buffer.byteLength(s, 'utf8') / 2.2) // 中文约 2.2 字节/token

// ── 注入模式：把摘要塞进任务书的 task 块 ───────────────────────────
//
// 任务书用的是 `task: |` 块标量。不去解析 YAML，因为这里只需要做一件事：
// 找到 `task: |` 那一行，把后面的每一行按同样缩进插进去。解析再序列化反而
// 会把注释和格式全吃掉——那些注释是给下一个人看的，比格式重要。
if (INJECT) {
  const taskPath = path.resolve(LAB, INJECT)
  const handoffPath = path.resolve(LAB, HANDOFF_IN ?? '')
  const outPath = path.resolve(LAB, OUT || INJECT.replace(/\.yml$/, '.handoff.yml'))
  if (!fs.existsSync(taskPath)) {
    console.error(`找不到任务书 ${taskPath}`)
    process.exit(2)
  }
  if (!fs.existsSync(handoffPath)) {
    console.error(`找不到交接摘要 ${handoffPath}`)
    process.exit(2)
  }
  const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/)
  const handoff = fs.readFileSync(handoffPath, 'utf8').trimEnd()

  const at = lines.findIndex((l) => /^\s*task:\s*\|/.test(l))
  if (at < 0) {
    console.error('任务书里没有 `task: |` 块，无法注入')
    process.exit(2)
  }
  const indent = (lines[at].match(/^(\s*)/) ?? ['', ''])[1] + '  '
  const block = ['', `${indent}## 交接摘要（handoff.mjs 自动生成，不是对话上下文）`, '']
  for (const l of handoff.split(/\r?\n/)) {
    // 标题降三级：独立文档里的 `#` 插进任务书后会和任务书自己的分节打架，
    // 模型读到的层级会变成"摘要和本轮任务是同级"，视觉上分不开。
    const demoted = l.replace(/^(#{1,4}) /, (_m, h) => '#'.repeat(Math.min(6, h.length + 3)) + ' ')
    block.push(demoted.length ? indent + demoted : '')
  }
  block.push('', `${indent}---`, '')

  const out = [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)]
  fs.writeFileSync(outPath, out.join('\n'), 'utf8')
  console.log(
    `已注入 ${path.basename(handoffPath)}（${Buffer.byteLength(handoff)} B）→ ${path.relative(LAB, outPath)}`,
  )
  process.exit(0)
}

// ── 生成模式 ────────────────────────────────────────────────
const reportPath = path.join(DIR, 'report.md')
const report = readIf(reportPath)
if (!report) {
  console.error(`没有报告可交接：${reportPath}`)
  process.exit(2)
}

const ledgerPath = path.join(DIR, '.claim-verify', 'claims.jsonl')
const ledger = readIf(ledgerPath)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const teamJson = readIf(path.join(STATE, 'team.json'))
let team = null
if (teamJson) {
  try {
    team = JSON.parse(teamJson)
  } catch {}
}

// 等级：这里不重新实现 computeLevels，只读台账里写死的 epi.level 与 invalidated。
// 需要精确等级时跑 claim_audit——交接摘要不该是第二个真相来源。
const levelOf = (c) => (c.invalidated ? 'X' : (c.epi?.level ?? 'U'))
const passed = ledger.filter((c) => c.pass === true)
const dead = ledger.filter((c) => c.invalidated)
const failed = ledger.filter((c) => c.pass === false)

// 同一条断言可能被记过多次（改判据、翻转）。交接里只留每个 id 的最后一次，
// 并把"翻过面"标出来——那是下一代最需要知道、也最容易忽略的信息。
const byId = new Map()
for (const c of ledger) byId.set(c.id ?? c.hash, c)
const finalRows = [...byId.values()]

const head = [
  `# 交接摘要：${path.basename(DIR)}`,
  '',
  `> 由 \`tools/handoff.mjs\` 生成于 ${new Date().toISOString()}`,
  '> 这是**结论交接**，不是对话上下文。上一轮的过程（查过的死路、被推翻的中间结论、',
  '> 被证伪的假设）故意没有搬过来——它们不是知识，模型会把它们当知识用。',
  '> 需要原文时读磁盘：报告 `report.md`、台账 `.claim-verify/claims.jsonl`、笔记 `notes/`。',
  '',
  '## 上一轮的状态',
  '',
]

const stat = [
  `- 台账 **${ledger.length}** 条记录，去重后 **${finalRows.length}** 条判据：通过 ${passed.length} / 未通过 ${failed.length} / 作废 ${dead.length}`,
  `- 报告 ${Buffer.byteLength(report, 'utf8')} B`,
]
if (team?.tasks) {
  const t = team.tasks
  const done = t.filter((x) => x.status === 'completed').length
  stat.push(`- 派出的任务 ${t.length} 个（completed ${done}）：${t.map((x) => `${x.id}=${x.status}`).join(', ')}`)
}
if (team?.members?.length) stat.push(`- 成员 ${team.members.length} 个`)

const flipped = []
for (const id of new Set(ledger.map((c) => c.id))) {
  const recs = ledger.filter((c) => c.id === id)
  if (new Set(recs.map((c) => c.pass)).size > 1) flipped.push(id)
}

const tail = []
if (flipped.length) {
  tail.push('', '## ⚠ 判定翻过面的判据（必须写明哪一次算数）', '')
  for (const id of flipped) {
    const recs = ledger.filter((c) => c.id === id)
    tail.push(`- **${id}**：${recs.map((c) => (c.pass ? 'PASS' : 'FAIL')).join(' → ')}（${recs.length} 次记录）`)
  }
}
if (dead.length) {
  tail.push('', '## 已作废的判据', '')
  for (const c of dead) tail.push(`- **${c.id}**「${String(c.assertion ?? '').slice(0, 60)}」`)
}

const table = ['', '## 判据台账（每条一行，可复核）', '', '| id | 等级 | 结论 | 断言 |', '|---|---|---|---|']
for (const c of finalRows.slice(0, MAX_LEDGER_ROWS)) {
  const a = String(c.assertion ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 70)
  table.push(`| ${c.id ?? '?'} | ${levelOf(c)} | ${c.pass ? 'PASS' : 'FAIL'} | ${a} |`)
}
if (finalRows.length > MAX_LEDGER_ROWS) {
  table.push(`| … | | | 另有 ${finalRows.length - MAX_LEDGER_ROWS} 条，见 claims.jsonl |`)
}

// ── 报告只抽"未解决"那几节 ───────────────────────────────────
//
// 上一版把 28KB 报告全文塞进下一轮，14.5k token。其中大半是"已经判过的东西
// 的复述"——不是知识，是噪声。而 Context Rot（Chroma 2025，18 个模型）说得很清楚：
// 纯长度增加平均掉约 8%，且中段信息最容易被漏。结论越多，目标在注意力里的
// 权重越低——漂移是这么被工程放大的，不是模型忘了。
//
// 全文仍在磁盘上，需要细节时按目录去读。
function extractOpenSections(md) {
  const lines = md.split(/\r?\n/)
  const out = []
  let grabbing = false
  let level = 0
  for (const l of lines) {
    const h = l.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const isOpen = /未解决|没做完|遗留|下一步|待办|未闭合|open question/i.test(h[2])
      if (isOpen) {
        grabbing = true
        level = h[1].length
        out.push(l)
        continue
      }
      if (grabbing && h[1].length <= level) grabbing = false
    }
    if (grabbing) out.push(l)
  }
  return out.join('\n').trim()
}

const openSec = extractOpenSections(report)

// 待办清单：state.json 的 open 里带 next_test 的，命令**完整**搬过去。
// 报告里常常没有「未解决」小节（team16 就没有），待办只活在 state.json 里；
// 而 terminate-check 要求每条 open 都带一条能直接跑的命令——交接不带它，
// 下一轮只知道「有三件事」，不知道「怎么开始」，这三条就永远留在原地。
function openTodoBlock(state) {
  const open = state?.open ?? []
  const objs = open.filter((o) => o && typeof o === 'object')
  if (!objs.length) return []
  const L = ['## 上一轮留下的待办（命令可直接跑，不要重新论证该不该做）', '']
  for (const o of objs) {
    L.push(`### ${o.id ?? '?'}`)
    L.push('')
    if (o.text) {
      L.push(String(o.text).trim())
      L.push('')
    }
    if (o.next_test) {
      L.push('```')
      L.push(String(o.next_test).trim())
      L.push('```')
      L.push('')
    } else {
      L.push('（这条没写 next_test——本轮要先补一条真能跑的命令）')
      L.push('')
    }
  }
  return L
}
const headings = report
  .split(/\r?\n/)
  .filter((l) => /^#{1,3}\s/.test(l))
  .map((l) => l.replace(/^#+\s*/, '· '))
  .slice(0, 24)

const goalPath = GOAL_DIR ? path.resolve(LAB, GOAL_DIR, 'goal.md') : path.join(DIR, 'goal.md')
const goal = parseGoal(readIf(goalPath))
const run = loadRun(DIR)
const { problems, warns } = validate(run.state, run.claims, run.notes)
const surprise = roundSurprise(run.claims)

const slice = buildSlice({
  goal,
  state: run.state,
  claims: run.claims,
  notes: run.notes,
  problems,
  warns,
  surprise,
})

const todoLines = openTodoBlock(run.state)

const md = [
  `# 交接：${path.basename(DIR)}（结构化状态，不是对话上下文）`,
  '',
  `> 由 \`tools/handoff.mjs\` 生成于 ${new Date().toISOString()}`,
  '> **目标在最前面且逐字**——它是这一轮唯一不许改写的东西。',
  '> 状态表由 `state.json` 提供，每一条都能对回台账；对不上的会写在下面。',
  '> 报告只搬「未解决」那几节。全文在 `report.md`，需要细节时按目录去读——',
  '> 把全文塞进来不会让你更聪明，只会把目标挤到中段（中段最容易被漏）。',
  '',
  slice,
  '',
  ...table,
  ...tail,
  '',
  ...todoLines,
  openSec
    ? `## 上一轮报告里「未解决」的部分（原文）\n\n${openSec}`
    : '## 上一轮报告里没有「未解决」小节\n\n> 如果这一轮真有未解决的问题，那它就不该收工——见 `tools/terminate-check.mjs`。',
  '',
  `## 报告目录（全文：\`${path.relative(LAB, reportPath)}\`）`,
  '',
  ...headings,
  '',
].join('\n')

const outPath = OUT || path.join(DIR, 'handoff.md')
fs.writeFileSync(outPath, md, 'utf8')
console.log(
  `已写出 ${path.relative(LAB, outPath)}：${Buffer.byteLength(md)} B，约 ${estTokens(md)} token` +
    `（台账 ${finalRows.length} 条，作废 ${dead.length}，翻面 ${flipped.length}）`,
)
