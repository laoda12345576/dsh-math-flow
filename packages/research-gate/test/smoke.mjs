/**
 * 门禁的确定性测试：不依赖 dsh 运行时，只测状态机、分级器与分类。
 *
 * 重点验证的不是"函数能跑"，而是五件会真出事的行为：
 *   1. 证据级计算在 verify 之前必须被拦；
 *   2. 草稿级小算在任何阶段都要放行（v0.1 在这里犯过错，惩罚了理解行为）；
 *   3. 草稿额度用完之后，小算也要升级成证据级（防"分 100 次小算绕过"）；
 *   4. 文献类工具必须能过、并且被计数；
 *   5. 换问题必须重开票据，verify 不能一次买断。
 */
import {
  classify,
  computeTier,
  textTier,
  createState,
  advance,
  openTicket,
  denialReason,
  delegationReason,
  delegationTooEarly,
  statusLine,
  inspectSurveyCall,
} from '../lib/gate.js'
import { isSubagent } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`[PASS] ${label}${extra ? '  ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`[FAIL] ${label}${extra ? '  ' + extra : ''}`)
  }
}

console.log('\n--- classify ---')
ok(classify('viz_python') === 'compute', 'viz_python 归为计算类')
ok(classify('bash') === 'compute', 'bash 归为计算类')
ok(classify('lean_verify_proof') === 'compute', 'lean_verify_proof 归为计算类')
ok(classify('math_solve') === 'compute', 'math_* 归为计算类')
ok(classify('paper_search') === 'survey', 'paper_search 归为调研类')
ok(classify('paper_fetch') === 'survey', 'paper_fetch 归为调研类')
ok(classify('wps_read') === 'survey', 'wps_read 归为调研类')
ok(classify('read_file') === 'survey', 'read_file 归为调研类')
ok(classify('research_stage') === 'neutral', 'research_stage 不被拦（否则死锁）')
ok(classify('zzz_custom') === 'neutral', '未知工具默认放行，不误伤')
ok(classify('paper_search', { denyExtra: ['paper_search'] }) === 'compute', 'denyExtra 可把调研工具改判为拦')
ok(classify('viz_python', { allowExtra: ['viz_python'] }) === 'survey', 'allowExtra 可放行计算工具')

console.log('\n--- 计算分级（v0.3：scratch / evidence / explore） ---')
const fresh = () => createState('测一个数')
ok(computeTier({ code: 'print(1+1)' }, fresh()).tier === 'scratch', '1+1 是草稿级，不再被当成研究失格')
ok(computeTier({ code: 'print(math.isqrt(2))' }, fresh()).tier === 'scratch', '单点求值 sqrt(2) 是草稿级')
ok(computeTier({ code: 'sympy.factorint(10**12)' }, fresh()).tier === 'scratch', '不循环的大数因式分解仍是草稿级')
ok(computeTier({ code: 'for c in range(1, 5000): check(c)' }, fresh()).tier === 'evidence', '有界的小循环是证据级')
ok(computeTier({ code: 'while True: probe()' }, fresh()).tier === 'explore', 'while True 没有停止条件 → 探索级')
ok(computeTier({ code: 'for c in range(1, 10**5): pass' }, fresh()).tier === 'explore', '上界到 10^5 → 探索级')
ok(computeTier({ code: 'for c in range(1, 100001): check(c)' }, fresh()).tier === 'explore', '上界 100001 → 探索级')
ok(computeTier({ code: 'np.random.rand(1000)' }, fresh()).tier === 'explore', '蒙特卡洛 → 探索级')
ok(computeTier({ code: 'xs = [c for c in range(20) if search(c)]' }, fresh()).tier === 'evidence', '搜索语义是证据级')
ok(computeTier({ code: 'itertools.product(A, B)' }, fresh()).tier === 'evidence', '组合式枚举是证据级')
ok(computeTier({ code: 'N_MAX = 50000' }, fresh()).tier === 'evidence', '显式上界是证据级')
ok(textTier('帮我 grid search 一下参数空间').tier === 'explore', '中文语境里的"参数空间搜索"也能识别为探索级')

const used8 = { ...fresh(), scratchCalls: 8 }
ok(computeTier({ code: 'print(1+1)' }, used8, { scratchLimit: 8 }).tier === 'evidence', '草稿额度用完后，小算升级为证据级')
ok(/已做过 8 次/.test(computeTier({ code: 'print(1+1)' }, used8, { scratchLimit: 8 }).why), '升级理由说清了是频次问题')
ok(
  computeTier({ code: 'print(1+1)' }, fresh(), { evidenceExtra: [/1\+1/] }).tier === 'evidence',
  'evidenceExtra 可追加自定义证据级规则'
)

console.log('\n--- 委派任务书也要过检（防"包装成调研任务"） ---')
ok(textTier('请把 c 从 1 遍历到 100000，统计个数').tier === 'explore', '任务书里写大范围遍历 → 探索级')
ok(textTier('请帮我读一下这篇论文的摘要').tier === 'scratch', '纯阅读任务书不被判为计算')
ok(textTier('算一下 1+1').tier === 'scratch', '1+1 的任务书仍是草稿级')

console.log('\n--- 阶段推进 ---')
let s = createState()
ok(s.stage === 'survey', '初始阶段是 survey')

let r = advance(s, 'synthesis', { priorArt: 'x'.repeat(500) }, { minReads: 3, minPriorArtChars: 400 })
ok(!r.ok && /只调用了 0 次/.test(r.reason || ''), '没读过文献时不能进 synthesis', (r.reason || '').slice(0, 40))

s.reads = 2
r = advance(s, 'synthesis', { priorArt: 'x'.repeat(500) }, { minReads: 3, minPriorArtChars: 400 })
ok(!r.ok && /至少要 3 次/.test(r.reason || ''), '读得不够也不放行')

s.reads = 3
r = advance(s, 'synthesis', { priorArt: '短' }, { minReads: 3, minPriorArtChars: 400 })
ok(!r.ok && /至少要 400 字/.test(r.reason || ''), '综述太短不放行')

r = advance(s, 'synthesis', { priorArt: 'x'.repeat(500) }, { minReads: 3, minPriorArtChars: 400 })
ok(r.ok && r.state.stage === 'synthesis', '条件齐了才能进 synthesis')
s = r.state

r = advance(s, 'verify', { plan: 'x'.repeat(400) }, { minPlanChars: 300 })
ok(r.ok && r.state.stage === 'verify', 'synthesis → verify 需要 plan 且够长')

console.log('\n--- 回退（v0.2 新增） ---')
let back = advance({ ...createState(), stage: 'verify', priorArt: 'x', plan: 'y' }, 'survey', {}, {})
ok(back.ok && back.state.stage === 'survey', '允许从 verify 退回 survey（读到新证据要改判据）')
ok(back.state.priorArt === '' && back.state.plan === '', '回退会清空 prior_art 与 plan，防止零成本洗白')
ok(/重新提交/.test(back.note || ''), '回退文案说明了要重新提交')

let wrongBack = advance({ ...createState(), stage: 'verify' }, 'synthesis', {}, {})
ok(!wrongBack.ok && /只能退回 survey/.test(wrongBack.reason || ''), '回退只能回 survey，不能退到 synthesis')

let s2 = createState()
s2.reads = 9
r = advance(s2, 'verify', { plan: 'x'.repeat(400) }, { minPlanChars: 300 })
ok(!r.ok && /不能跳级/.test(r.reason || ''), '不能从 survey 跳到 verify')

let s3 = { ...createState(), stage: 'synthesis', priorArt: 'x'.repeat(500) }
r = advance(s3, 'verify', { plan: '短' }, { minPlanChars: 300 })
ok(!r.ok && /至少要 300 字/.test(r.reason || ''), 'plan 太短不放行')

let s4 = { ...createState(), stage: 'synthesis' }
r = advance(s4, 'verify', { plan: 'x'.repeat(400) }, { minPlanChars: 300 })
ok(!r.ok && /prior_art/.test(r.reason || ''), '没有 prior_art 时不许进 verify（防空降）')

console.log('\n--- 票据制（v0.2 新增：verify 不是一次买断） ---')
const didVerify = { ...createState('问题A'), stage: 'verify', reads: 5, priorArt: 'x'.repeat(500), plan: 'y'.repeat(400), scratchCalls: 3 }
let t = openTicket(didVerify, '问题B：换一个子问题', {})
ok(t.ok && t.state.stage === 'survey', '开新票后回到 survey')
ok(t.state.reads === 0 && t.state.scratchCalls === 0, '新票的读计数与草稿额度归零')
ok(t.state.priorArt === '' && t.state.plan === '', '新票不继承上一张票的 prior_art')
ok(t.state.tickets === 2, '票据编号递增')
ok(t.state.history.length === 1 && t.state.history[0].question === '问题A', '上一张票被存档')

let bad = openTicket(didVerify, '继续', { minQuestionChars: 8 })
ok(!bad.ok && /不少于 8 字/.test(bad.reason || ''), '开新票必须写清问题，不能只写"继续"')

console.log('\n--- 参数级检查（堵 browser eval） ---')
ok(inspectSurveyCall('browser', { cmd: 'eval', code: '1+1' }) !== null, 'browser eval 被判为"在算"（真机撞出来的洞）')
ok(inspectSurveyCall('browser', { cmd: 'goto', url: 'https://arxiv.org' }) === null, 'browser goto 正常放行')
ok(inspectSurveyCall('browser_navigate', { action: 'js', script: 'x' }) !== null, 'action=js 也被识别')
ok(inspectSurveyCall('paper_search', { query: 'x' }) === null, '非 browser 工具不受影响')
ok(
  computeTier({ cmd: 'eval', code: 'for (let c = 0; c < 1e5; c++) f(c)' }, fresh()).tier === 'evidence',
  'browser eval 里跑循环，同样升格为证据级'
)

console.log('\n--- 拒绝文案 ---')
const st = createState()
st.reads = 1
const msg = denialReason(st, 'viz_python', { minReads: 3, minPriorArtChars: 400 }, '在区间上做循环，是批量枚举')
ok(/viz_python/.test(msg), '拒绝文案点名了被拦的工具')
ok(/survey/.test(msg), '拒绝文案说明了当前阶段')
ok(/paper_search/.test(msg), '拒绝文案给出了可用工具')
ok(/1\/3/.test(msg), '拒绝文案给出了进度')
ok(/解锁条件/.test(msg), '拒绝文案给出了解锁条件')
ok(/证据级\/探索级计算/.test(msg), '拒绝文案说明了分级，而不是"禁止一切计算"')
ok(/草稿级/.test(msg) && /任何阶段都放行/.test(msg), '拒绝文案说明小草稿算仍然可用（防它再去钻 browser 的洞）')
ok(/在区间上做循环/.test(msg), '拒绝文案给出了本次的分级理由')
ok(/委派子智能体/.test(msg), '拒绝文案预告了 verify 之后也要委派，别抱幻想')

// 只推荐真正挂载了的工具：paper 是另一个插件，可能没装。
// 提示里点名一个不存在的工具，模型调完拿到"工具不存在"，会以为门禁坏了。
const noPaper = denialReason(st, 'viz_python', { minReads: 3 }, '', ['viz_python', 'web_search', 'read_file'])
ok(!/paper_search/.test(noPaper), '没装 paper 时，拒绝文案不再点名 paper_search')
ok(/web 检索/.test(noPaper) && /refs/.test(noPaper), '没装 paper 时仍给出真实的替代路径')
const withPaper = denialReason(st, 'viz_python', { minReads: 3 }, '', [
  'viz_python',
  'paper_search',
  'paper_fetch',
])
ok(/paper_search/.test(withPaper) && /paper_fetch/.test(withPaper), '装了 paper 时照常点名')
ok(!/paper_resolve/.test(withPaper), '只点名实际可见的那几个，不按全集抄')
const unknown = denialReason(st, 'viz_python', { minReads: 3 }, '', null)
ok(/paper_search/.test(unknown), '拿不到工具视图时按全集写（未知不等于没有）')

const advNoPaper = advance(createState('问题B'), 'synthesis', { priorArt: 'x'.repeat(500) }, { minReads: 3 }, [])
ok(!/paper_search/.test(advNoPaper.reason), 'advance 的拒绝理由同样不再点名没装的 paper')
ok(/refs/.test(advNoPaper.reason), 'advance 的拒绝理由仍给出可走的路')

console.log('\n--- 委派说明（v0.3 的核心） ---')
const vst = { ...createState('问题A'), stage: 'verify', priorArt: 'x'.repeat(500), plan: 'y'.repeat(400) }
const dm = delegationReason(vst, 'viz_python', { tier: 'evidence', why: '在区间上做循环' })
ok(/不由主智能体执行/.test(dm), '委派说明明确"不是禁止算，是禁止你算"')
ok(/阶段没问题/.test(dm), '委派说明区分了"流程没过"和"流程过了但要外包"两种拒绝')
ok(/agent_teams_create/.test(dm), '委派说明点名了要用的建队工具')
ok(/surveyor/.test(dm) && /computer/.test(dm) && /adversary/.test(dm), '三个角色都点名了（文献官/计算官/复核官）')
ok(/tool_policy/.test(dm), '说明了用 tool_policy 指定角色，而不是靠提示词自觉')
ok(/写死/.test(dm) && /不要给选项/.test(dm), '要求计算工具写死：给选项会让成员挑错通道然后放弃')
ok(/判据/.test(dm) && /反证/.test(dm) && /交付物/.test(dm), '委派任务书四要素都在（判据/算法/反证/交付物）')
ok(/不要贴中间日志/.test(dm), '明确要求子智能体不要回贴日志')
ok(!/预算/.test(dm), '证据级不强制写预算')

const xm = delegationReason(vst, 'viz_python', { tier: 'explore', why: '上界到 10^5' })
ok(/探索级/.test(xm), '探索级在文案里单独命名')
ok(/预算/.test(xm) && /停止条件/.test(xm), '探索级额外要求写预算与停止条件')

const em = delegationTooEarly({ ...createState(), stage: 'survey', reads: 1 }, { tier: 'explore', why: '上界到 10^5' }, {})
ok(/委派不是免检通道/.test(em), '过早委派被拦，且说明了原因')
ok(/文献类调用 1 次/.test(em), '过早委派文案给出了当前进度')

console.log('\n--- 子智能体判定（放行依据） ---')
ok(isSubagent({ session: { header: { origin: 'subagent', parentSession: 'p1' } } }) === true, 'origin=subagent 被认成子智能体')
ok(isSubagent({ session: { header: { parentSession: 'p1' } } }) === true, '只有 parentSession 时也按子智能体处理')
ok(isSubagent({ session: { header: { delegationDepth: 1 } } }) === true, '带 delegationDepth 的团队成员也要放行（agent-teams）')
ok(isSubagent({ session: { header: { delegationDepth: 0 } } }) === false, 'delegationDepth=0 不算子智能体')
ok(isSubagent({ session: { header: { id: 'root' } } }) === false, '普通会话不是子智能体')
ok(isSubagent({}) === false, '拿不到 header 时保守地按主智能体处理（宁严勿松）')

console.log('\n--- statusLine ---')
ok(/survey/.test(statusLine(createState())), '状态摘要含阶段')
ok(/ticket#1/.test(statusLine(createState())), '状态摘要含票据号')
ok(/草稿计算 0\/8/.test(statusLine(createState())), '状态摘要含草稿额度')
ok(/委派 0/.test(statusLine(createState())), '状态摘要含委派次数')

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail} =====`)
if (fail > 0) process.exitCode = 1
