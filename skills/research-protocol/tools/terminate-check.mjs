// 终止门：收工是**判出来的**，不是宣布出来的。
//
// 为什么需要 —— MAST 分类法（Cemri et al. 2025, arXiv:2503.13657）把多智能体失效
// 分成 14 种，其中 `Unaware of Termination Conditions` 占 12.4%、`Premature Termination`
// 是独立一类。我们这边是前者：队长写完报告就收工，"三个问题都判了"即可。
// 于是**阶段性成果 = 收工信号**，而阶段性成果恰恰是最不该停的地方。
//
// 这条门把"收工"变成二选一：
//   要么 goal.md 的成功判据全部达成（每条都能对回台账里的 PASS）；
//   要么明确列出 blocking（缺什么），且每条 blocking 都有对应的 notes 记录。
// "做了不少"不算。
//
// 2026-11-05 加一条：走 blocking 那条路收工时，还要求**真实用掉预算的一半**。
// 2026-11-06 撤回这条：它把"下限"变成了"目标"（日志原话：need 30 min → 23:40 …
// So I must keep working until ~23:40），而时长是最容易被填的资源。现在时长只报读数，
// 判据换成「转移」——这一轮到底有没有动。详见 research-state.mjs 的 transferStatus。
//
// 用法：
//   node tools/terminate-check.mjs --dir runs/team9
//   node tools/terminate-check.mjs --dir runs/team9 --strict   # 警告也当失败
//
// 退出码：0 可以收工 / 1 不许收工 / 2 用法错 / 3 轮次中断（不判定）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseGoal,
  loadRun,
  validate,
  roundSurprise,
  terminationStatus,
  budgetStatus,
  transferStatus,
  conjectureStatus,
  openStatus,
  narrativeClock,
  abortStatus,
  timeAnchor,
} from './research-state.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 实验台根目录。默认是 tools/ 的上一级；可用 LAB_ROOT 覆盖——
// 反向测试要造一个假的 .agent-teams，不能往真实验台里写。
const LAB = process.env.LAB_ROOT ? path.resolve(process.env.LAB_ROOT) : path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const argOf = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const STRICT = argv.includes('--strict')

const dirArg = argOf('--dir', null)
if (!dirArg) {
  console.error('用法: node tools/terminate-check.mjs --dir <run 目录> [--strict]')
  process.exit(2)
}
const dir = path.resolve(LAB, dirArg)
const goalPath = path.resolve(LAB, argOf('--goal', path.join(dirArg, 'goal.md')))
const reportPath = path.join(dir, 'report.md')

const readIf = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const goal = parseGoal(readIf(goalPath))
const run = loadRun(dir)
const report = readIf(reportPath)

// ── 0. 先判"这一轮到底跑完没有" ─────────────────────────────
//
// team12 被 `QUOTA: Insufficient Balance` 掐断在 11 分钟：没有 report.md、没有 state.json。
// 原来的判据会输出四项 FAIL，其中一项写着「这就是"阶段性成果就停工"」——**把余额用完
// 记成了模型不愿意干**。这两种事在测量上不能混：一个是研究层要治的病，一个是基础设施故障。
//
// 出口码 3 = 中断，不判定。判据见 research-state.mjs 的 abortStatus。
const abort = abortStatus(dir)
if (abort.aborted && abort.fatal) {
  const produced = fs.existsSync(path.join(dir, '.claim-verify', 'claims.jsonl'))
    ? fs.readFileSync(path.join(dir, '.claim-verify', 'claims.jsonl'), 'utf8').split('\n').filter(Boolean).length
    : 0
  console.log(`\n终止门：${path.relative(LAB, dir)}`)
  console.log(`目标： ${goal.question || '（goal.md 缺失）'}`)
  console.log('')
  console.log(`  ABORT 轮次中断    ${abort.reason}`)
  console.log(`        日志原文      ${abort.fatal}`)
  console.log('')
  console.log(`这一轮没有被判定：没有 report.md（收尾没发生）、没有 state.json${produced ? `，台账里有 ${produced} 条记录` : '，台账为空'}。`)
  console.log('拿它当"提前收工"的证据会得出错误结论——那需要模型自己停下来，而不是进程被掐断。')
  console.log('重跑一轮，或者先把基础设施修好。')
  process.exit(3)
}

const rows = []
// warnOnly：只警告，--strict 时才当失败。
// infoOnly：读数，永远不参与判定（预算用量用它）——"把读数当判据"正是上一版犯的错。
const add = (name, ok, detail, warnOnly = false, infoOnly = false) => rows.push({ name, ok, detail, warnOnly, infoOnly })

// ── 1. 状态表 ─────────────────────────────────────────────
const v = validate(run.state, run.claims, run.notes)
add(
  '状态表',
  v.problems.length === 0,
  v.problems.length ? v.problems[0] : `已知 ${(run.state?.known ?? []).length} 条，与台账一致`,
)

// ── 1.5 台账来源 ───────────────────────────────────────────
//
// 台账散落是实测出来的：同一轮的两条 dead_end 在 run 目录，blocking_claim 与
// qualified conjecture 却在 lab 根目录（插件按 cwd 解析台账根，cwd 会变）。
// 只读 run 目录的检查器会把真登记读成"没登记"，而往任何父目录写又能绕过检查——
// 两个方向都是错判。现在合并，但把"有几条落在目录之外"摆出来：散落可见，
// 才不会下次以另一种形状再出现一遍。
if (run.outside.length) {
  const n = run.outside.reduce((s, x) => s + x.claims + x.notes, 0)
  add(
    '台账来源',
    false,
    `有 ${n} 条记录落在 run 目录之外：${run.outside
      .map((s) => `${path.relative(LAB, s.root)}（claims ${s.claims}/notes ${s.notes}）`)
      .join('、')}——按本轮起点过滤后合并判定，但台账本该落在 run 目录里`,
    true,
    true,
  )
}

// ── 2. 目标引用（反漂移的硬检查）────────────────────────────
//
// 目标漂移的机制是"每一轮压缩一次，目标被压成当前子问题"（Arike et al. 2025）。
// 对策不是叮嘱"别忘了目标"，而是要求报告里**逐字**出现 goal 的那句话。
// 一旦允许复述，第三轮就会算出"目标是 m 的取值范围"。
const norm = (s) => String(s).replace(/\s+/g, '').replace(/[，。：；、""''（）()]/g, '')
const q = norm(goal.question)
const reportNorm = norm(report)
add(
  '目标锚',
  Boolean(goal.question) && reportNorm.includes(q),
  !goal.question
    ? 'goal.md 没写「## 问题」，这一轮没有目标可锚'
    : reportNorm.includes(q)
      ? '报告里逐字出现了目标句'
      : `报告里没有逐字出现目标句：「${goal.question.slice(0, 40)}…」——复述、改写、缩略都不算`,
)

// ── 3. 终止资格 ───────────────────────────────────────────
// 规则只写一份（research-state.mjs 的 terminationStatus），这里只负责报警。
const term = terminationStatus({ goal, state: run.state, claims: run.claims, notes: run.notes, dir })
add('终止资格', term.ok, term.detail)

// 每条 id 只认最后一次（重判留痕不算两条）。
const latestById = (rowsIn) => {
  const m = new Map()
  for (const r of rowsIn) m.set(r.id ?? r.hash, r)
  return [...m.values()]
}
const latest = latestById(run.claims)

// ── 3.5 预算用量（只报读数，不作判据）──────────────────────
//
// 上一版把"用够预算一半"当判据。它被当成目标用了：模型读到 t0 与阈值，规划
// "做到 23:40 之后"，再把没发生的时段写进报告。时长是最容易被填的资源
// （AgentTime 里 158 个 run 有 14 个主动 sleep 凑时间），不能当门。
// 现在它只是读数，压力交给下面的「转移」。
const budget = budgetStatus(dir, goal)
const allDone = term.total > 0 && term.done === term.total
// ok=false + infoOnly=true ⇒ 显示成 INFO：它是读数，不是"通过"。
add('预算用量', false, budget.detail, false, true)

// ── 3.6 转移（取代预算时钟的那道门）──────────────────────────
//
// 判"这一轮动没动"：新结论 / 判死的路 / 推翻旧结论 / 提出可判猜想，
// 四者都要求台账或 notes 里有产物。distance 不参与判定——它是模型自己填的数。
//
// 2026-11-06 起加一条下限：goal 用「达成任一即可」时，至少要有 ⌈预算/45⌉ 条转移。
// 原因很具体：析取模式把"关一格"变成合法成功，于是"关一格就走"成了新的偷懒形状。
// 下限用产物数算，不用时长算——上一版时长门被读到阈值之后填过。
const transfer = transferStatus({
  dir,
  goal,
  claims: run.claims,
  notes: run.notes,
  state: run.state,
})
add('转移', transfer.ok || allDone, allDone ? '成功判据全部达成，不要求另有转移' : transfer.detail)

// ── 3.7 猜想 ──────────────────────────────────────────────
//
// 猜想从这一轮起可以算成果（goal 里 G3 那条），但它必须是"下一轮能接着干"的形状。
// 判据不是写得好不好，是 falsifiable_by / missing_step / next_test 三栏齐不齐——
// 这三栏都答"执行者能不能接手"，答不出来的猜想下一轮不存在。
//
// 只在「达成任一即可」的契约下判。旧轮次的 goal 没声明"猜想算成果"，
// 拿新标准去追判它们，和拿余额故障当模型行为证据是同一类错误：用后来的尺子量过去的行为。
const conj = conjectureStatus(run.notes, goal, dir)
if (!goal.criteriaAny) {
  rows.push({ name: '猜想', ok: true, detail: `goal 没声明"达成任一即可"——猜想不参与收工判定（在册 ${conj.total} 条）`, warnOnly: true, infoOnly: true })
} else {
  // 这一栏只报读数，不单独判死。理由与"规则只写一份"同：猜想能否算成果，
  // 已经在「终止资格」里判过一次了（标 done 的判据若由不合格猜想支撑，就不算达成，
  // 并在那里写出原因）。这里再 FAIL 一次，会在"G2 已经用 hash 关掉"的轮次里
  // 因为一条没人用的弱猜想而否掉整轮——那是重复计分，不是更严。
  rows.push({
    name: '猜想',
    ok: conj.ok,
    detail:
      conj.total === 0
        ? '本轮没有登记猜想。若判据要靠猜想关，这条路等于没走'
        : conj.detail,
    warnOnly: true,
    infoOnly: true,
  })
}

// ── 3.8 待办清账 ──────────────────────────────────────────
//
// team13 收工时 open 里有 3 条，写得很实在（B± 的 j-不变量、16 结点回填 A=E1×E2、
// w-纤维化的第三种），但全是散文。下一轮拿到它，仍要从"那从哪下手"重新想一遍。
// 所以这条不要求清空 open，要求每条带一条能直接跑的命令——它不是免责声明，是入口。
// 同样只在新契约下判：旧轮次没有"留入口"的义务。
const openLed = openStatus(run.state, dir)
if (!goal.criteriaAny) {
  rows.push({ name: '待办清账', ok: true, detail: `goal 没声明"达成任一即可"——open 只报数（${openLed.total} 条），不判`, warnOnly: true, infoOnly: true })
} else {
  add('待办清账', openLed.ok, openLed.detail, openLed.total === 0)
}

// ── 3.9 自述时间 ──────────────────────────────────────────
//
// team11：报告 23:32:56 落盘，却写"把工作一直做到 23:45 之后"——进程 23:33:12 就结束了。
// 它不是记错，是时间线从约束反推出来的（预算 60 分钟、阈值 23:40 → 写 23:45）。
// 这条判据只有唯一满足解：别写假时间。
const clock = narrativeClock(dir, report)
add('自述时间', clock.ok, clock.detail)

// ── 3.10 收尾中断 ─────────────────────────────────────────
//
// 报告在盘上也算"跑完了"吗？team14 的报告 24 KB、state.json 齐全，但日志最后一行是
// QUOTA，§9 只剩"见下方原文粘贴"——它死在唤醒队长收尾那一步。
// 这种轮次可以判（有东西可判），但不能当作"模型自己写完的"，否则
// "报告完整"这件事会变成对进程存活时间的测量，而不是对模型的测量。
if (abort.lateFatal) {
  add(
    '收尾中断',
    false,
    `报告已落盘，但日志最后一行是致命错误：${abort.lateFatal}——收尾被基础设施掐断，` +
      '报告可能缺章节（本轮 §9 就是空的）。这一轮判据仍然有效，但别把"写完了"当成它的结论',
    true,
    true,
  )
}


// ── 4. 任务收口 ───────────────────────────────────────────
// 为什么单独查：本轮实测过"派了 4 个任务只跑 1 个"，而「终止资格」判 PASS——
// 因为它走的是 blocking 路线，只看 goal 的判据。**判据可以靠 blocking 收工，
// 但派出去的活不能凭"时间不够"消失。** 两件事必须分开查。
//
// 终态照抄插件的 TERMINAL_TASK_STATUSES：只有白名单算完成，其余一律算没做完。
// 状态是个开放集合，按"什么算完成"写，不按"我记得有哪几种没完成"写。
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
// 队目录名**不是** runs/<x> 的同名：队长建队时自己起名（team14-dodge、team15-rdp），
// 而这里原来只找 `.agent-teams/<runs 目录名>/team.json`。于是「建了队」被读成「没建队」，
// 这条检查静默 PASS —— 等于从来没查过。两轮实测（team14 / team15）都这样，
// 而两轮的报告里都写着「队是建了」。这不只是读错路径：**这条检查存在的理由**
// （"派了 4 个任务只跑 1 个"）正好被它自己的命名假设绕过去了。
//
// 改法：按前缀认领（team15 → team15-rdp），多个候选取最新；一个都对不上但
// .agent-teams 下有本轮新建的 team.json，就说"名字对不上"，不再报"没建队"。
const base = path.basename(dir)
const teamCands = []
for (const r of [path.join(LAB, '.agent-teams'), path.join(LAB, '.agent-teams', 'archive')]) {
  let names = []
  try { names = fs.readdirSync(r) } catch { continue }
  for (const n of names) {
    const p = path.join(r, n, 'team.json')
    if (!fs.existsSync(p)) continue
    let mt = 0
    try { mt = fs.statSync(p).mtimeMs } catch {}
    teamCands.push({ p, n, mt })
  }
}
const t0 = timeAnchor(dir).t0
const near = teamCands
  .filter((c) => c.n === base || c.n.startsWith(`${base}-`) || c.n.startsWith(`${base}_`))
  .sort((a, b) => b.mt - a.mt)
// 同前缀可能有多个（同一轮重跑过一次）。优先拿本轮起点之后写的那一个，
// 否则会把上一轮的 team.json 当成本轮的——而它的任务状态早就全 completed，
// 于是"收口"这一行会显示一个漂亮的 8/8，实际这一轮根本没建队。
const nearFresh = near.filter((c) => t0 === null || c.mt >= t0)
const teamPath = (nearFresh.length ? nearFresh[0] : near.length ? near[0] : null)?.p ?? null
if (!teamPath) {
  const fresh = teamCands.filter((c) => t0 !== null && c.mt >= t0)
  // 报告里说建了队、盘上却找不到：这两件事必须对上。
  // 原来这里只报"没有建队"就 PASS——而 PASS 的意思是"收口查过了、没问题"，
  // 可它其实一个任务状态都没读到。**检查没跑成，不能算通过。**
  const claimsTeam = /建队|team\.json|subagent|个成员|名成员/i.test(report)
  add(
    '任务收口',
    fresh.length === 0 && !claimsTeam,
    fresh.length
      ? `建了队但目录名对不上：${fresh.map((c) => c.n).join(', ')}` +
        `（找的是 .agent-teams/${base}/）——这条检查等于没跑，队里的任务状态没被读过`
      : claimsTeam
        ? '报告里提到建队/成员/派活，但 .agent-teams 下没有本轮新建的 team.json——' +
          '要么队没建成（这一轮其实是单线程跑的），要么队伍落在别处。两种都该在报告里说清，不能默认通过'
        : '本轮没有建队（.agent-teams 下没有本轮新建的 team.json）',
    true,
  )
} else {
  const team = JSON.parse(fs.readFileSync(teamPath, 'utf8'))
  const allTasks = team.tasks ?? []
  const notDone = allTasks.filter((t) => !TERMINAL.has(t.status))
  const abortFile = path.join(path.dirname(teamPath), 'abort.json')
  const abort = fs.existsSync(abortFile) ? JSON.parse(fs.readFileSync(abortFile, 'utf8')) : null
  const abortIds = new Set((abort?.tasks ?? []).map((t) => t.id ?? t.taskId).filter(Boolean))
  const unexplained = notDone.filter(
    (t) => !(t.status === 'abandoned' || t.abandonedAt || t.abandonReason) && !abortIds.has(t.id),
  )
  // 流程任务 vs 研究任务：team11 派了 8 个，其中 3 个的题目是「跑一次收工门并原样回报 stdout」。
  // 它们让"收口 8/8"看起来漂亮，但其实是在给门本身打工——因为队长自己的 shell 被算力配额挡住了。
  // 这条不判 FAIL（跑门确实该做），只把数摆出来：收口比例里有多少是机械活。
  const MECH = /收工门|终止门|terminate-check|跑门|收尾检查/
  const mechTasks = allTasks.filter((t) => MECH.test(String(t.subject ?? '')))
  add(
    '任务收口',
    unexplained.length === 0,
    allTasks.length === 0
      ? '建了队但没派任务'
      : `派了 ${allTasks.length} 个，收口 ${allTasks.length - notDone.length} 个` +
        (mechTasks.length ? `（其中 ${mechTasks.length} 个是流程任务：${mechTasks.map((t) => t.id).join(', ')}）` : '') +
        (unexplained.length
          ? `；没收口也没记录：${unexplained.map((t) => `${t.id}(${t.status})`).join(', ')}` +
            '——"时间不够"不是理由，要砍就写 abandon，或说清是哪条判据失败'
          : ''),
  )
}

// ── 5. 预测覆盖（区分研究还是公证）────────────────────────────
const surprise = roundSurprise(run.claims)
const total = latest.length
const withPred = latest.filter((r) => r.prediction).length
add(
  '预测覆盖',
  total === 0 || withPred >= Math.ceil(total * 0.6),
  total === 0
    ? '本轮没有判定记录'
    : `${withPred}/${total} 条判据在跑之前写了预测；surprise 均值 ${
        surprise.mean === null ? '（算不出）' : `${surprise.mean} bit`
      }` + (surprise.mean !== null && surprise.mean < 0.3 ? '（趋近 0：本轮基本在确认已知，不是在探索）' : ''),
  true,
)

// ── 5. 底座债务（N-30）────────────────────────────────────
//
// "改底座会让下游全部失效"这条规矩在验证上对、在研究上是灾难：它把修正成本
// 定成无限大，于是两轮各欠一笔、第三笔在路上。这里至少让债务**可见**，
// 并要求每笔债在 notes 里有一条记录（否则它只存在于报告的一段散文里）。
const debtRe = /(留待下一轮|留待下轮|欠一次正式更正|待下轮新开判据|下轮再改)[^\n]{0,120}/g
const debts = [...report.matchAll(debtRe)].map((m) => m[0].trim())
const debtNotes = run.notes.filter((n) => n.record_type === 'blocking_claim' && /底座|ground|C-D/i.test(n.statement))
add(
  '底座债务',
  debts.length === 0 || debtNotes.length >= debts.length,
  debts.length === 0
    ? '本轮没有把修正推给下一轮'
    : `报告里有 ${debts.length} 处把修正推给下一轮，notes 里只有 ${debtNotes.length} 条记录：` +
      debts.slice(0, 2).map((d) => `「${d.slice(0, 40)}…」`).join('、'),
  true,
)

// ── 6. 死路留痕 ───────────────────────────────────────────
const deadRe = /(走不通|行不通|此路不通|死路|放弃这条|不再尝试)/g
const deadHits = [...report.matchAll(deadRe)].length
const deadNotes = run.notes.filter((n) => n.record_type === 'dead_end').length
add(
  '死路留痕',
  deadHits === 0 || deadNotes > 0,
  deadHits === 0
    ? '报告里没有"这条路走不通"之类的表述'
    : `报告提到走不通 ${deadHits} 次，notes 里 ${deadNotes} 条 dead_end` +
      (deadNotes === 0 ? '——下一轮会把同一个死胡同重走一遍' : ''),
  true,
)

// ── 输出 ─────────────────────────────────────────────────
console.log(`\n终止门：${path.relative(LAB, dir)}`)
console.log(`目标： ${goal.question || '（goal.md 缺失）'}`)
console.log('')

// 三态：早于研究层协议的轮次记 SKIP，不记 FAIL。
// 拿新标准把历史全判红，人就会学会无视这一栏——而这一栏一旦被无视，
// 真正的红行也一起看不见了。判据：有 goal.md，或台账里出现 schema>=4 的记录。
const protocolRound = fs.existsSync(goalPath) || run.claims.some((r) => (r.schema ?? 0) >= 4)
if (!protocolRound) {
  console.log('  SKIP 本轮早于研究层协议（无 goal.md，台账无 schema>=4）')
  console.log('       没有"成功判据"这个概念，也就没有收工标准可判——不按新标准记 FAIL。')
  process.exit(0)
}

for (const r of rows) {
  const tag = r.ok ? 'PASS' : r.infoOnly ? 'INFO' : r.warnOnly && !STRICT ? 'WARN' : 'FAIL'
  console.log(`  ${tag.padEnd(4)} ${r.name.padEnd(8)} ${r.detail}`)
}

const fails = rows.filter((r) => !r.ok && !r.infoOnly && (!r.warnOnly || STRICT))
console.log('')
if (fails.length) {
  console.log(`✗ 不许收工（${fails.length} 项）：${fails.map((r) => r.name).join('、')}`)
  console.log('  收工只有两条路：① 成功判据全部达成；② 列出 blocking，且每条都带一条真跑过、失败的命令（attempt）。')
  console.log('  "我判断这条路走不通"不是第二条——那是结论，应该记 dead_end，然后继续做下一步。')
  process.exit(1)
}
console.log('✓ 可以收工')
process.exit(0)
