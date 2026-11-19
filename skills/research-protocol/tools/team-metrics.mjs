// 团队三个指标：塌陷 / 交接 / 吞吐。
//
// 数据源全是本地会话日志，不依赖插件埋点：
//   .agent-teams/<team>/team.json   → 队长 session id、成员 session id、任务书
//   ~/.dsh/sessions/*/<sid>/session.v3.jsonl.zstd → 真实对话与工具调用
//
// 用法：
//   node tools/team-metrics.mjs                    # 量当前 .agent-teams
//   node tools/team-metrics.mjs --state <dir>      # 量指定目录（如备份里的旧队）
//   node tools/team-metrics.mjs --cwd D:/plugin-flow-lab

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const CWD = path.resolve(argOf('--cwd', process.cwd()))
const STATE = path.resolve(argOf('--state', path.join(CWD, '.agent-teams')))
const SESSION_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

function decodeSession(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let i = 0
  while ((i = buf.indexOf(magic, i)) !== -1) { starts.push(i); i += 4 }
  const frames = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { frames.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end))) } catch {}
  }
  return Buffer.concat(frames).toString('utf8').split('\n').filter(Boolean)
}

const sessionIndex = new Map()
for (const proj of fs.readdirSync(SESSION_ROOT)) {
  const projDir = path.join(SESSION_ROOT, proj)
  if (!fs.statSync(projDir).isDirectory()) continue
  for (const sid of fs.readdirSync(projDir)) {
    const f = path.join(projDir, sid, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) sessionIndex.set(sid, f)
  }
}

function summarize(sid) {
  const file = sessionIndex.get(sid)
  if (!file) return null
  const out = { assistantChars: 0, reasoningChars: 0, toolCalls: 0, toolResultChars: 0, turns: 0, steps: new Map(), toolNames: new Map() }
  for (const line of decodeSession(file)) {
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'assistant/message') {
      // 按 step 归因：一个 step 就是一次模型调用，它要么在算东西，要么在问
      // "他们做完了吗"。两者的字符数一样，但一个是产出、一个是等待。
      const key = `${ev.data?.turn ?? 0}:${ev.data?.step ?? 0}`
      const s = out.steps.get(key) ?? { a: 0, r: 0, tools: [] }
      for (const c of ev.data?.message?.content ?? []) {
        if (c.type === 'text') { out.assistantChars += (c.text ?? '').length; s.a += (c.text ?? '').length }
        else if (c.type === 'reasoning') { out.reasoningChars += (c.text ?? '').length; s.r += (c.text ?? '').length }
      }
      out.steps.set(key, s)
    } else if (ev.type === 'tool/call') {
      out.toolCalls++
      const name = ev.data?.name ?? '?'
      out.toolNames.set(name, (out.toolNames.get(name) ?? 0) + 1)
      const key = `${ev.data?.turn ?? 0}:${ev.data?.step ?? 0}`
      const s = out.steps.get(key) ?? { a: 0, r: 0, tools: [] }
      s.tools.push(name)
      out.steps.set(key, s)
    } else if (ev.type === 'tool/result') {
      for (const c of ev.data?.message?.content ?? []) out.toolResultChars += (c.text ?? '').length
    } else if (ev.type === 'turn/end') {
      out.turns++
    }
  }
  return out
}

// 协调性调用：不产出内容，只问"做完了吗"或"去干这个"。
//
// 这里只认查询/等待类，不认 update_task / send_message / claim_task。
// 原因是实测撞到的：成员把结论写进 update_task 的 output 参数时，整个 step
// 只调了这一个工具，但它的推理就是产出本身（compute-geom 有 189k 字符落在
// 这一步）。按"工具名以 agent_teams_ 开头"一刀切，会把成员最重的那段工作
// 判成等待，于是成员总产出骤降、队长占比被虚构地抬高——比原指标错得更远。
//
// 等待是真的只有 status：team4 队长轮询了 36 次，每次带一句"他们完了吗"。
const COORD_TOOL = /^agent_teams_(status|list|list_tasks|inbox|wait|get_task)$/

function coordSplit(stat) {
  if (!stat) return { chars: 0, steps: 0, calls: 0 }
  let chars = 0, steps = 0, calls = 0
  for (const s of stat.steps.values()) {
    if (s.tools.length > 0 && s.tools.every(t => COORD_TOOL.test(t))) {
      chars += s.a + s.r
      steps++
      calls += s.tools.length
    }
  }
  return { chars, steps, calls }
}

const pct = n => `${(n * 100).toFixed(1)}%`

/**
 * Count claims in a task description.
 *
 * Three shapes appear in practice, and all three are legitimate:
 *   1. a table, one claim per row          `C3 | 断言：...`
 *   2. four headed fields                  `判据 C3：...` / `判定方式：...`
 *   3. one claim per task, prose           `判据（照抄）：...`
 *
 * Shape 3 is what the captain actually writes when each task IS one claim, and
 * insisting on 1 or 2 made throughput uncomputable on a run whose task books
 * were substantively fine — the metric was measuring typography, not work.
 * @param {string} text - task description.
 * @returns {number} claim count, 0 when the text mentions no criterion at all.
 */
function claimCount(text) {
  const s = String(text ?? '')
  const table = (s.match(/^\s*C\d+\s*\|/gm) ?? []).length
  if (table > 0) return table
  if (!/判据|断言/.test(s)) return 0
  // Distinct C<n> labels are the best signal; a task with one unlabelled
  // criterion still counts as one.
  const ids = new Set(s.match(/\bC\d+\b/g) ?? [])
  return Math.max(1, ids.size)
}

const teams = []
for (const entry of fs.existsSync(STATE) ? fs.readdirSync(STATE) : []) {
  const dir = path.join(STATE, entry)
  if (!fs.statSync(dir).isDirectory()) continue
  const teamFile = path.join(dir, 'team.json')
  if (fs.existsSync(teamFile)) teams.push({ dir: entry, ...JSON.parse(fs.readFileSync(teamFile, 'utf8')) })
}

if (teams.length === 0) {
  console.log(`没有找到任何 team.json（${STATE}）`)
  process.exit(0)
}

// 台账位置：显式 --claims，否则取 runs/ 下最近改动的那份。
function latestClaims() {
  const runs = path.join(CWD, 'runs')
  if (!fs.existsSync(runs)) return null
  let best = null, bestTime = 0
  for (const d of fs.readdirSync(runs)) {
    const f = path.join(runs, d, 'claims.jsonl')
    if (!fs.existsSync(f)) continue
    const t = fs.statSync(f).mtimeMs
    if (t > bestTime) { best = f; bestTime = t }
  }
  return best
}
const claimsFile = argOf('--claims', latestClaims()) || null

for (const team of teams) {
  console.log(`\n=== ${team.name} ===`)
  const captain = summarize(team.captainSessionId)
  const members = (team.members ?? []).map(m => ({ ...m, stat: summarize(m.id) }))
  const missing = members.filter(m => !m.stat).map(m => m.name)

  const captainChars = captain ? captain.assistantChars + captain.reasoningChars : 0
  const memberChars = members.reduce((s, m) => s + (m.stat ? m.stat.assistantChars + m.stat.reasoningChars : 0), 0)
  const totalChars = captainChars + memberChars

  console.log(`队长   ${String(captainChars).padStart(7)} 字符（其中推理 ${captain?.reasoningChars ?? 0}）   工具 ${captain?.toolCalls ?? 0} 次   回合 ${captain?.turns ?? 0}`)
  for (const m of members) {
    const c = m.stat ? m.stat.assistantChars + m.stat.reasoningChars : 0
    const share = totalChars ? c / totalChars : 0
    console.log(`  ${(m.toolPolicy ?? 'no-policy').padEnd(8)} ${m.name.padEnd(14)} ${String(c).padStart(7)} 字符（推理 ${m.stat?.reasoningChars ?? 0}）   占比 ${pct(share)}   工具 ${m.stat?.toolCalls ?? 0} 次`)
  }

  const capCoord = coordSplit(captain)
  const memberCoord = members.reduce((s, m) => { const c = coordSplit(m.stat); s.chars += c.chars; s.calls += c.calls; return s }, { chars: 0, calls: 0 })
  const coordChars = capCoord.chars + memberCoord.chars
  const adjCaptain = captainChars - capCoord.chars
  const adjMember = memberChars - memberCoord.chars
  const adjTotal = adjCaptain + adjMember

  const captainShare = totalChars ? captainChars / totalChars : 0
  const adjCaptainShare = adjTotal > 0 ? adjCaptain / adjTotal : 0
  const adjMemberMax = adjTotal > 0 && members.length
    ? Math.max(...members.map(m => (m.stat ? m.stat.assistantChars + m.stat.reasoningChars - coordSplit(m.stat).chars : 0) / adjTotal))
    : 0

  const taskChars = (team.tasks ?? []).reduce((s, t) => s + (t.description ?? '').length, 0)
  const reportChars = (team.tasks ?? []).reduce((s, t) => s + (t.output ?? '').length, 0)
  const wire = taskChars + reportChars + totalChars
  const handoff = wire ? (taskChars + reportChars) / wire : 0

  const claims = (team.tasks ?? []).reduce((s, t) => s + claimCount(t.description ?? ''), 0)
  const verifyCalls = (captain?.toolNames.get('verify_claim') ?? 0)
    + members.reduce((s, m) => s + (m.stat?.toolNames.get('verify_claim') ?? 0), 0)
  const claimAudits = (captain?.toolNames.get('claim_audit') ?? 0)
    + members.reduce((s, m) => s + (m.stat?.toolNames.get('claim_audit') ?? 0), 0)

  // 塌陷不是"队长占比高"。队长本来就要写报告、读文献、判路线，占三四成是正常的。
  // 塌陷是两种结构病：
  //   1) 队长把活全干了：>80%，且成员总量还不如队长一个人；
  //   2) 成员里只剩一个在干：最大成员占成员总产出 >80%（三人以上时才判）。
  const memberCharsAdj = members.map(m => Math.max(0, (m.stat ? m.stat.assistantChars + m.stat.reasoningChars : 0) - coordSplit(m.stat).chars))
  const adjMemberSum = memberCharsAdj.reduce((a, b) => a + b, 0)
  const adjMaxMemberShare = adjMemberSum > 0 ? Math.max(...memberCharsAdj) / adjMemberSum : 0
  const verdict = adjCaptainShare > 0.8 ? '⚠ 队长独干'
    : (members.length >= 3 && adjMemberSum > 0 && adjMaxMemberShare > 0.8) ? '⚠ 成员里只剩一个在干'
    : 'ok'

  console.log('')
  if (coordChars > 0) {
    const shareOfCap = captainChars ? capCoord.chars / captainChars : 0
    console.log(`协调    队长 ${capCoord.steps} 个 step 只在等/查（status 类 ${capCoord.calls} 次），占队长字符 ${pct(shareOfCap)}、占全部 ${pct(totalChars ? coordChars / totalChars : 0)}`)
    console.log(`塌陷    原始 队长占 ${pct(captainShare)}（含等待，会随轮询次数漂移）`)
    console.log(`        剔除等待后 队长占 ${pct(adjCaptainShare)}，成员最大占成员总产出 ${pct(adjMaxMemberShare)}   ${verdict}`)
  } else {
    console.log(`塌陷    队长占 ${pct(captainShare)}，成员最大占成员总产出 ${pct(adjMaxMemberShare)}   ${verdict}`)
  }
  console.log(`交接    任务书 ${taskChars} + 回报 ${reportChars} 字符，占全部往来 ${pct(handoff)}   ${handoff > 0.3 ? '⚠ 推导塞进了任务书' : 'ok'}`)
  // 吞吐的口径是"每条判据花掉多少次校验"，不是"check 成员的调用数"——
  // check 角色已撤，校验现在是 verify_claim 这个函数，调用不归属任何成员。
  if (claims > 0) {
    const perClaim = verifyCalls / claims
    const verdict = verifyCalls === 0 ? '⚠ 一条都没验' : perClaim > 10 ? '⚠ 在偷偷重解' : 'ok'
    console.log(`校验    ${claims} 条任务书判据 / verify_claim ${verifyCalls} 次 = 每条 ${perClaim.toFixed(1)} 次，claim_audit ${claimAudits} 次   ${verdict}`)
  } else {
    console.log(`校验    verify_claim ${verifyCalls} 次，claim_audit ${claimAudits} 次（任务书里没有可识别的判据）`)
  }
  if (claimsFile) {
    const n = fs.readFileSync(claimsFile, 'utf8').split('\n').filter(l => l.trim()).length
    console.log(`台账    ${claimsFile}  ${n} 条`)
  }
  if (missing.length) console.log(`注意    找不到会话日志的成员：${missing.join(', ')}`)

  const degenerate = members.length < 2
  if (degenerate) console.log('注意    成员数 < 2，塌陷指标在这个规模上没有意义')
}
