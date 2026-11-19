/**
 * claim-verify 的契约测试。
 *
 * 这些测试不是"跑通就行"——每一条都对应一次具体的失败方式：
 * 脚本伪造结论、空数据被当成通过、判据被改过却沿用旧 PASS。
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { inspectCode, claimHash, apply, surpriseOf, SCHEMA_VERSION } from '../lib/index.js'

const PY = process.env.CLAIM_VERIFY_PY || 'python'
const TMP = path.join(os.tmpdir(), `claim-verify-${Date.now()}`)

/** Minimal host stand-in: the plugin only needs tools.register / effect / logger. */
function fakeCtx() {
  const tools = new Map()
  return {
    tools: {
      register: (def) => {
        tools.set(def.name, def)
        return () => {}
      },
      get: (name) => tools.get(name),
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ---- 静态检查 -------------------------------------------------------------

test('拒绝读文件的脚本', () => {
  assert.match(inspectCode('f = open("x")\n'), /禁止/)
})

test('拒绝 import 系统模块', () => {
  assert.match(inspectCode('import os\nprint(os.getcwd())\n'), /不允许 import os/)
  assert.match(inspectCode('import subprocess\n'), /禁止的调用|不允许 import/)
})

test('拒绝 __import__ 绕道', () => {
  assert.match(inspectCode('m = __import__("os")\n'), /禁止/)
})

test('允许纯计算模块', () => {
  assert.equal(inspectCode('import math\nimport json\nprint(1)\n'), null)
  assert.equal(inspectCode('from fractions import Fraction\nprint(1)\n'), null)
})

test('拒绝写入台账', () => {
  assert.match(inspectCode('x = "claims.jsonl"\n'), /禁止/)
})

// ---- hash 冻结 ------------------------------------------------------------

test('同一断言 hash 稳定，改一个字就变', () => {
  const a = claimHash('对任意素数 p>3，p² ≡ 1 (mod 24)')
  const b = claimHash('对任意素数 p>3，p² ≡ 1 (mod 24)')
  const c = claimHash('对任意素数 p>3，p² ≡ 1 (mod 12)')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 12)
})

// ---- 端到端 ---------------------------------------------------------------

test('端到端：真实判定 PASS + 证据落盘', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'T1',
    assertion: '2^100 是 31 位数，末三位是 376',
    code: [
      'import json',
      'n = 2**100',
      'print(json.dumps({"digits": len(str(n)), "tail": n % 1000}))',
    ].join('\n'),
    judge: 'all',
    predicate: 'digits == 31 and tail == 376',
    dir: TMP,
  })

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.pass, true, JSON.stringify(r))
  assert.equal(r.rows, 1)
  assert.equal(r.id, 'T1')
  assert.equal(r.claim_hash, claimHash('2^100 是 31 位数，末三位是 376'))
  const evidence = await fsp.readFile(r.evidence, 'utf8')
  assert.match(evidence, /"digits": 31/)
})

test('端到端：判定为假时 FAIL 并给出反例', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'T2',
    assertion: 'p<=20 的素数都是奇数',
    code: [
      'import json',
      'def isp(n):',
      '    return n > 1 and all(n % d for d in range(2, int(n**0.5)+1))',
      'for p in range(2, 21):',
      '    if isp(p):',
      '        print(json.dumps({"p": p, "odd": p % 2 == 1}))',
    ].join('\n'),
    judge: 'all',
    predicate: 'odd',
    dir: TMP,
  })

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.pass, false, 'p=2 是偶数，应该判 FAIL')
  assert.ok(r.failures.length > 0, 'FAIL 必须给出具体反例')
  assert.equal(r.failures[0].row.p, 2)
})

test('脚本自己 print("PASS") 不算数', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'T3',
    assertion: '一个什么都没算的断言',
    code: 'print("PASS")\n',
    judge: 'all',
    predicate: 'ok',
    dir: TMP,
  })

  // 非 JSON 行 → 判定器拒绝在脏数据上给结论
  assert.equal(r.pass, false, '人类可读的 PASS 不能被当成通过')
  assert.match(String(r.note ?? ''), /JSON/)
})

test('空数据不算通过（真空成立的陷阱）', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  // 断言原本是「扫完整个范围没有反例」，现在会被全称闸拦下——这是对的：
  // 它本来就是一条无界否定命题。所以这里显式声明成带界的否定，
  // 让测试真正走到"空输出"那一步，而不是停在参数校验。
  const r = await tool.execute({
    id: 'T4',
    assertion: 'E(Q) 在 h≤1e6 内没有反例',
    claim_type: 'none_in',
    evidence: 'search',
    scope: 'h≤1e6',
    code: 'print("# 什么都没扫")\n',
    judge: 'none',
    predicate: 'bad == 1',
    dir: TMP,
  })

  assert.equal(r.pass, false, '没有扫到不等于不存在')
  assert.match(String(r.note ?? ''), /空|没扫/)
})

test('脚本报错要如实失败，不能当成判据成立', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'T5',
    assertion: '一条会崩的判据',
    code: 'raise RuntimeError("boom")\n',
    judge: 'all',
    predicate: 'x == 1',
    dir: TMP,
  })

  assert.equal(r.ok, false)
  assert.equal(r.pass, false)
  assert.match(String(r.stderr_tail ?? ''), /boom/)
})

test('冲突检测：同一 id 换了断言要被发现', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const verify = ctx.tools.get('verify_claim')
  const audit = ctx.tools.get('claim_audit')

  const body = 'import json\nprint(json.dumps({"v": 1}))\n'

  await verify.execute({
    id: 'C9',
    assertion: '初版断言：v 等于 1',
    code: body,
    judge: 'all',
    predicate: 'v == 1',
    dir: TMP,
  })
  await verify.execute({
    id: 'C9',
    assertion: '复核期间被改过的断言：v 等于 2',
    code: body,
    judge: 'all',
    predicate: 'v == 1',
    dir: TMP,
  })

  const a = await audit.execute({ dir: TMP, id: 'C9' })
  assert.equal(a.conflicts, 1, '两个不同 hash 必须报冲突')
  assert.equal(a.records[0].hashes.length, 2)
  assert.match(String(a.note ?? ''), /改过/)
})

// 这就是 team5 那一轮 A-C4 的样子：断言一个字没改，脚本被原地改了，
// 先 17 行判 FAIL、后 16 行判 PASS。旧版的 claim_audit 完全看不见——
// 它只比 hash，而 hash 是断言的。
test('同一断言换了脚本导致结论翻转，必须被发现', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const verify = ctx.tools.get('verify_claim')
  const audit = ctx.tools.get('claim_audit')

  const assertion = '前 3 行里 v 全等于 1'
  // 第一版：多输出一行不合规的数据 -> FAIL
  await verify.execute({
    id: 'C4',
    assertion,
    code: 'import json\nfor v in (1, 1, 2):\n    print(json.dumps({"v": v}))\n',
    judge: 'all',
    predicate: 'v == 1',
    dir: TMP,
  })
  // 第二版：同一个 id、同一句断言，脚本被"调整"成只输出合规的那两行 -> PASS
  await verify.execute({
    id: 'C4',
    assertion,
    code: 'import json\nfor v in (1, 1):\n    print(json.dumps({"v": v}))\n',
    judge: 'all',
    predicate: 'v == 1',
    dir: TMP,
  })

  const a = await audit.execute({ dir: TMP, id: 'C4' })
  assert.equal(a.records[0].hashes.length, 1, '断言没变，所以 hash 只有一个——正是它藏得住的原因')
  assert.equal(a.conflicts, 1, '结论翻转必须报冲突')
  assert.ok(a.records[0].drift.includes('verdict_flipped'), `应标记结论翻转，实际 ${JSON.stringify(a.records[0].drift)}`)
  assert.ok(a.records[0].drift.includes('script_rewritten'), '应标记脚本被换')
  assert.match(String(a.note ?? ''), /翻转/)
  assert.match(String(a.note ?? ''), /换过/)
})

test('返回值必须是无损 JSON（不能带 undefined）', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  // 通过时 judge.py 的 note 为空字符串；如果实现写成 `note: verdict.note || undefined`，
  // 这个键就是 undefined。直接调 execute() 看不出来，但宿主的无损校验会拒收整条结果，
  // 而且报错指向"可能含 NaN/Infinity"——方向完全错。
  const r = await tool.execute({
    id: 'T6',
    assertion: 'v 等于 1',
    code: 'import json\nprint(json.dumps({"v": 1}))\n',
    judge: 'all',
    predicate: 'v == 1',
    dir: TMP,
  })

  assert.equal(r.pass, true)
  for (const [k, v] of Object.entries(r)) {
    assert.notEqual(v, undefined, `字段 ${k} 是 undefined，会被宿主校验拒绝`)
  }
  const round = JSON.parse(JSON.stringify(r))
  assert.equal(Object.keys(round).length, Object.keys(r).length, 'stringify 掉了字段')
})

test('count 接受字符串 form 的 value', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'T7',
    assertion: '恰好三行',
    code: 'import json\nfor i in range(3):\n    print(json.dumps({"i": i}))\n',
    judge: 'count',
    value: '3',
    dir: TMP,
  })

  // 工具参数 schema 里 value 是 string，若判定器不转型，`3 == "3"` 永远为假。
  assert.equal(r.pass, true, JSON.stringify(r))
  assert.equal(r.rows, 3)
})

// ---- 证据等级：数值实验不能冒充证明 -------------------------------------
//
// 下面每一条都对应实验台里真实发生过的一次事故，不是假想的。

test('全称断言不声明证据类型，直接拒收', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  // team4 的 V1：对任意素数，两条同余式恒成立。46 行枚举什么也没验。
  const r = await tool.execute({
    id: 'E1',
    assertion: '对任意素数 p，p²+1 ≡ 1 (mod p)',
    code: 'import json\nprint(json.dumps({"p": 3}))\n',
    judge: 'all',
    predicate: 'p == 3',
    dir: TMP,
  })
  assert.equal(r.ok, false, '全称断言必须先声明等级')
  assert.equal(r.rejected, 'epistemic_gate')
  assert.match(String(r.error), /全称|任意/)
  assert.ok(String(r.hint).length > 10, '拒收必须给替代写法，否则模型会绕过闸门')
})

test('forall + search 是被禁止的组合（146k 组搜索不能证明"无点"）', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'E2',
    assertion: 'E(Q) 无仿射点',
    claim_type: 'forall',
    evidence: 'search',
    scope: 'h≤1e6',
    code: 'import json\nprint(json.dumps({"n": 1}))\n',
    judge: 'all',
    predicate: 'n == 1',
    dir: TMP,
  })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, 'epistemic_gate')
  assert.match(String(r.error), /forall \+ search|不能支持/)
  assert.match(String(r.hint), /none_in|exhaustive|proof/)
})

test('search 必须带 scope，且 scope 要写进断言原文', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const noScope = await tool.execute({
    id: 'E3',
    assertion: 'h≤1e6 内无仿射点',
    claim_type: 'none_in',
    evidence: 'search',
    code: 'import json\nprint(json.dumps({"n": 1}))\n',
    judge: 'all',
    predicate: 'n == 1',
    dir: TMP,
  })
  assert.equal(noScope.ok, false)
  assert.match(String(noScope.error), /scope/)

  // 界只写在参数里、不写在断言里：引用 hash 时界就丢了，等于无界结论。
  const looseScope = await tool.execute({
    id: 'E3b',
    assertion: 'E(Q) 无仿射点',
    claim_type: 'none_in',
    evidence: 'search',
    scope: 'h≤1e6',
    code: 'import json\nprint(json.dumps({"n": 1}))\n',
    judge: 'all',
    predicate: 'n == 1',
    dir: TMP,
  })
  assert.equal(looseScope.ok, false)
  assert.match(String(looseScope.error), /没有出现在断言原文/)
})

test('带界的搜索结果 PASS，但等级是 S，回执里带着界', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'E4',
    assertion: 'E(Q) 在 h≤1e6 内无仿射点',
    claim_type: 'none_in',
    evidence: 'search',
    scope: 'h≤1e6',
    code: 'import json\nfor h in range(3):\n    print(json.dumps({"h": h, "hit": False}))\n',
    judge: 'all',
    predicate: 'hit == False',
    dir: TMP,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.pass, true)
  assert.equal(r.level, 'S', '抽样最多是 S，不管跑多少行')
  assert.equal(r.scope, 'h≤1e6')
  assert.match(String(r.hint), /不能支持无界结论/)
})

test('exhaustive 缺 space / why_complete 被拒收', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const noSpace = await tool.execute({
    id: 'E5',
    assertion: '8 个候选类里 4 个存活',
    claim_type: 'value',
    evidence: 'exhaustive',
    why_complete: 'b_i 只能取平方自由因子',
    code: 'import json\nprint(json.dumps({"b1": 1, "b2": 1}))\n',
    judge: 'all',
    predicate: 'b1 == 1',
    dir: TMP,
  })
  assert.equal(noSpace.ok, false)
  assert.match(String(noSpace.error), /space/)

  const noWhy = await tool.execute({
    id: 'E5b',
    assertion: '8 个候选类里 4 个存活',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: '{"kind":"product","factors":[{"name":"b1","values":[1,-1]},{"name":"b2","values":[1,-1]}]}',
    code: 'import json\nprint(json.dumps({"b1": 1, "b2": 1}))\n',
    judge: 'all',
    predicate: 'b1 == 1',
    dir: TMP,
  })
  assert.equal(noWhy.ok, false)
  assert.match(String(noWhy.error), /why_complete/)
})

test('声明穷尽 8 类、实际只算 4 类 → coverage_incomplete（这是 team5 的那个错）', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'E6',
    assertion: '候选 (b1,b2) 的 8 类里 4 类存活',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: '{"kind":"product","factors":[{"name":"b1","values":[1,-1,5,-5]},{"name":"b2","values":[1,-1]}]}',
    why_complete: 'b1 取 sf(5) 的因子 ±1,±5；b2 取 sf(−4)=−1 的因子 ±1',
    single_impl_reason: '这条测的是"覆盖会不会被抓"，故意只写一份',
    // 只算了 b1=1 的那两个——就像只查 p=2,5 而漏掉实位
    code: 'import json\nfor b2 in (1, -1):\n    print(json.dumps({"b1": 1, "b2": b2, "alive": True}))\n',
    judge: 'all',
    predicate: 'alive == True',
    dir: TMP,
  })
  assert.equal(r.pass, false, '谓词全 PASS 也不能通过：论域没走完')
  assert.equal(r.rejected, 'coverage_incomplete')
  assert.equal(r.declared_total, 8)
  assert.equal(r.seen, 2)
  assert.ok(r.missing.length > 0, '必须点名缺哪些格子')
  assert.match(String(r.hint), /没有.*穷尽|缺/)
})

test('声明穷尽并且真的走完 → 等级 E', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'E7',
    assertion: '候选 (b1,b2) 的 8 类全部可判，其中 4 类存活',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: '{"kind":"product","factors":[{"name":"b1","values":[1,-1,5,-5]},{"name":"b2","values":[1,-1]}]}',
    why_complete: 'b1 取 sf(5) 的因子 ±1,±5；b2 取 sf(−4)=−1 的因子 ±1',
    code: [
      'import json',
      'alive = {(1,1),(1,-1),(5,1),(5,-1)}',
      'for b1 in (1,-1,5,-5):',
      '    for b2 in (1,-1):',
      '        print(json.dumps({"b1": b1, "b2": b2, "alive": (b1,b2) in alive}))',
      'print(\'#@coverage {"seen": 8}\')',
    ].join('\n'),
    // 第二实现：换一种遍历顺序与数据结构（先 b2 后 b1、存活用列表），
    // 判同一件事。两份一致才给 E —— 这就是 N-17 要求的东西。
    code2: [
      'import json',
      'rows = []',
      'for b2 in (1,-1):',
      '    for b1 in (1,-1,5,-5):',
      '        rows.append({"b1": b1, "b2": b2, "alive": b1 in (1,5)})',
      'for r in rows:',
      '    print(json.dumps(r))',
      'print(\'#@coverage {"seen": 8}\')',
    ].join('\n'),
    judge: 'count',
    value: '8',
    dir: TMP,
  })
  assert.equal(r.pass, true, JSON.stringify(r))
  assert.equal(r.level, 'E')
  assert.equal(r.claim_type, 'value')
  assert.equal(r.impl_count, 2)
  assert.equal(r.impl_agree, true)

  // 声明的论域必须落盘。只记 coverage:{total,seen} 的话，事后重判只能
  // 从输出反推 space——那等于让被判的人自己出考纲。
  const rows = (await fsp.readFile(path.join(TMP, '.cv-test', 'claims.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const rec = rows.filter((x) => x.id === 'E7').pop()
  const sp = typeof rec.epi.space === 'string' ? JSON.parse(rec.epi.space) : rec.epi.space
  assert.ok(sp, '台账里必须留下 space')
  assert.equal(sp.factors.length, 2)
})

test('推导用抽样当前提 → 等级降到 S（洗白要被算出来，不是被声明掉）', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const verify = ctx.tools.get('verify_claim')
  const audit = ctx.tools.get('claim_audit')

  const base = await verify.execute({
    id: 'E8a',
    assertion: 'E(Q) 在 h≤1e6 内无仿射点',
    claim_type: 'none_in',
    evidence: 'search',
    scope: 'h≤1e6',
    code: 'import json\nfor h in range(4):\n    print(json.dumps({"h": h, "hit": False}))\n',
    judge: 'all',
    predicate: 'hit == False',
    dir: TMP,
  })
  assert.equal(base.pass, true)

  const derived = await verify.execute({
    id: 'E8b',
    assertion: 'E(Q) 无仿射点，故 r(E)=0',
    claim_type: 'forall',
    evidence: 'proof',
    premises: base.claim_hash,
    code: 'import json\nprint(json.dumps({"r": 0}))\n',
    judge: 'all',
    predicate: 'r == 0',
    dir: TMP,
  })
  assert.equal(derived.pass, true, '调用本身可以通过')
  assert.equal(derived.level, 'S', '但等级不能高于最弱前提')

  const a = await audit.execute({ dir: TMP, id: 'E8b' })
  assert.equal(a.records[0].level, 'S')
  assert.deepEqual(a.records[0].laundered_from, [base.claim_hash])
  assert.match(String(a.note), /洗白/)
})

test('proof 既不给 premises 也不给 lemma → 拒收', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')
  const r = await tool.execute({
    id: 'E9',
    assertion: '于是 |Sel₂(E)| = 2',
    claim_type: 'value',
    evidence: 'proof',
    code: 'import json\nprint(json.dumps({"n": 2}))\n',
    judge: 'all',
    predicate: 'n == 2',
    dir: TMP,
  })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /premises|lemma/)
})

// ---- Lean 判定：编译通过不等于证明了那个命题 ----------------------------
//
// 这一组全部实测过：下面每种写法都能让 `lean file.lean` 返回 0。

const LEAN = async (dir, name, body) => {
  await fsp.mkdir(dir, { recursive: true })
  const f = path.join(dir, name)
  await fsp.writeFile(f, body, 'utf8')
  return f
}

test('sorry 的证明判死（退出码是 0，但公理表里有 sorryAx）', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-sorry')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const tool = ctx.tools.get('verify_claim')
  const file = await LEAN(dir, 'a.lean', 'set_option autoImplicit false\ntheorem t : 1 + 1 = 3 := by sorry\n')

  const r = await tool.execute({
    id: 'L1',
    assertion: '1+1=3',
    claim_type: 'value',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 't',
    dir,
  })
  assert.equal(r.pass, false, 'sorry 不能通过')
  assert.equal(r.level, 'X', 'Lean 判死的判据必须是作废态')
  assert.ok(r.reasons.includes('sorry'), `应报 sorry，实际 ${JSON.stringify(r.reasons)}`)
})

test('autoImplicit 开着时，拼错的标识符会让语句变成恒真式', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-auto')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const tool = ctx.tools.get('verify_claim')
  // 这条在实际 Lean 里编译通过、不依赖任何公理——因为 Foo 被当成了隐式变量。
  const file = await LEAN(dir, 'b.lean', 'theorem vac : Foo = Foo := rfl\n')

  const r = await tool.execute({
    id: 'L2',
    assertion: 'Foo = Foo',
    claim_type: 'value',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'vac',
    dir,
  })
  assert.equal(r.pass, false)
  assert.ok(r.reasons.includes('auto_implicit_on'), `应报 autoImplicit，实际 ${JSON.stringify(r.reasons)}`)
  assert.equal(r.level, 'X')
})

test('真证明：PASS，等级 P，并给出内核展开后的语句指纹', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-ok')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const tool = ctx.tools.get('verify_claim')
  const file = await LEAN(dir, 'c.lean', 'set_option autoImplicit false\ntheorem ok (n : Nat) : n + 0 = n := rfl\n')

  const r = await tool.execute({
    id: 'L3',
    assertion: '对任意自然数 n，n+0=n',
    claim_type: 'forall',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'ok',
    statement: '∀ n : Nat, n + 0 = n',
    dir,
  })
  assert.equal(r.pass, true, JSON.stringify(r))
  assert.equal(r.level, 'P')
  assert.equal(r.lean.verdict, 'proven')
  assert.match(String(r.lean.statement), /n \+ 0 = n/, '没取到内核展开的语句，指纹就是空的')
  assert.ok(r.lean.statement_sha)
  assert.match(String(r.hint), /逐字|语句/)
})

test('native_decide 得 computed：只能当穷尽计算，不是证明', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-native')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const tool = ctx.tools.get('verify_claim')
  const file = await LEAN(dir, 'd.lean', 'set_option autoImplicit false\ntheorem nat1 : 2 + 2 = 4 := by native_decide\n')

  const r = await tool.execute({
    id: 'L4',
    assertion: '2+2=4',
    claim_type: 'value',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'nat1',
    statement: '2 + 2 = 4',
    dir,
  })
  assert.equal(r.pass, true, 'computed 不算失败')
  assert.equal(r.level, 'S', '没给 space/why_complete 时只能降到 S')
  assert.equal(r.lean.verdict, 'computed')
  assert.ok(r.lean.axioms.some((a) => /native_decide/.test(a)), '必须把 native 公理列出来')
})

test('工具链不可用 → blocked，且 blocked 不是通过', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-blocked')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanExe: 'definitely-not-lean-xyz', leanTimeoutMs: 20000 })
  const tool = ctx.tools.get('verify_claim')
  const file = await LEAN(dir, 'e.lean', 'set_option autoImplicit false\ntheorem ok : 1 = 1 := rfl\n')

  const r = await tool.execute({
    id: 'L5',
    assertion: '1=1',
    claim_type: 'value',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'ok',
    dir,
  })
  // N-9：blocked 曾经落 X，和"判死"同一个值。一次环境抖动就会把整轮结论
  // 沿引用链清零，而报告读起来还像"严谨地作废了一条"。现在它是独立的 `?`：
  // 既不是通过（pass 不是 true），也不是判死（level 不是 X）。
  assert.equal(r.pass, null, 'blocked 既不算通过，也不该记成"判过、没通过"')
  assert.equal(r.level, '?', 'blocked 必须是独立的未判定档，不能和 X 合并')
  assert.match(String(r.hint), /blocked 不是通过/)
})

test('作废沿引用链下传：引用了一条被 Lean 判死的判据，自己也是 X', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-cascade')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const verify = ctx.tools.get('verify_claim')
  const audit = ctx.tools.get('claim_audit')
  const file = await LEAN(dir, 'f.lean', 'set_option autoImplicit false\ntheorem bad : 1 + 1 = 3 := by sorry\n')

  const dead = await verify.execute({
    id: 'L6a',
    assertion: '1+1=3',
    claim_type: 'value',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'bad',
    dir,
  })
  assert.equal(dead.level, 'X')

  // 下游：拿这条作废的判据当前提去"推出"别的东西。
  const downstream = await verify.execute({
    id: 'L6b',
    assertion: '由 1+1=3 得 2+2=6',
    claim_type: 'value',
    evidence: 'proof',
    premises: dead.claim_hash,
    code: 'import json\nprint(json.dumps({"v": 6}))\n',
    judge: 'all',
    predicate: 'v == 6',
    dir,
  })
  assert.equal(downstream.level, 'X', '前提作废，结论必须跟着作废')

  const a = await audit.execute({ dir })
  const rec = a.records.find((x) => x.id === 'L6b')
  assert.equal(rec.level, 'X')
  assert.ok((rec.invalidated_by ?? []).length > 0, '要说清是被谁带下水的')
  assert.deepEqual(a.by_level.X, 2)
})

// blocked 与 failed 必须分家：两条路都判不过，但一条是"事实被否掉了"，
// 一条是"事实还没被看到"。混在一起，一次超时就能让下游结论全变成"作废"。
test('blocked 当前提 → 下游是 ?（未判定），不是 X（作废）', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-blocked-cascade')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanExe: 'definitely-not-lean-xyz', leanTimeoutMs: 20000 })
  const verify = ctx.tools.get('verify_claim')
  const audit = ctx.tools.get('claim_audit')
  const file = await LEAN(dir, 'g.lean', 'set_option autoImplicit false\ntheorem ok2 : 1 = 1 := rfl\n')

  const stuck = await verify.execute({
    id: 'L7a',
    assertion: '1=1',
    claim_type: 'value',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'ok2',
    dir,
  })
  assert.equal(stuck.level, '?')

  const downstream = await verify.execute({
    id: 'L7b',
    assertion: '由 1=1 得 2=2',
    claim_type: 'value',
    evidence: 'proof',
    premises: stuck.claim_hash,
    code: 'import json\nprint(json.dumps({"v": 2}))\n',
    judge: 'all',
    predicate: 'v == 2',
    dir,
  })
  assert.equal(downstream.level, '?', '前提没判成，结论既不能算已证，也不该被划成作废')

  const a = await audit.execute({ dir })
  assert.equal(a.blocked, 2, 'blocked 单独计数，不能混进 passed，也不能混进作废')
  // L7b 自己的脚本是跑通的（pass=true），但它的一切建立在一条没判成的前提上，
  // 所以 usable 必须是 0。这条断言防的是"用 passed 冒充结论"。
  assert.equal(a.usable, 0, 'pass 不等于可用：前提未判定时，一条也不许算进 usable')
  assert.equal(a.by_level['?'], 2)
  assert.equal(a.by_level.X ?? 0, 0, '一条都没判死，不许出现 X')
  const rec = a.records.find((x) => x.id === 'L7b')
  assert.ok((rec.blocked_by ?? []).length > 0, '要说清是被谁卡住的')
  // 三态要能区分：blocked 那条记 null（没判成），不是 false（判过、没通过）。
  assert.equal(a.records.find((x) => x.id === 'L7a').pass, null, 'null 是没判成，false 才是没通过')
  assert.match(String(a.note), /未判定/)
})

// ---- N-23：断言 ↔ 形式语句（本轮新增） ------------------------------------

test('N-23 一个 1=1 的定理配无关断言 → 拒收，不进台账', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-unrelated')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const tool = ctx.tools.get('verify_claim')
  const file = await LEAN(dir, 'a.lean', 'set_option autoImplicit false\ntheorem trivial_thing : 1 = 1 := rfl\n')

  const r = await tool.execute({
    id: 'N23-BAD',
    // 这条断言与 1=1 毫无关系。旧版会判 P —— 内核只保证"某条语句成立"。
    assertion: '对任意椭圆曲线 E/Q，若 E(Q) 含 4 阶点则 rank E(Q) >= 1',
    claim_type: 'forall',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'trivial_thing',
    statement: '1 = 1',
    dir,
  })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, 'statement_unrelated')
  assert.match(String(r.hint), /rank|同一个/)
  // 拒收不能留痕成一条 PASS：台账里不该出现这条 id。
  const led = path.join(dir, '.cv', 'claims.jsonl')
  const txt = await fsp.readFile(led, 'utf8').catch(() => '')
  assert.equal(txt.includes('N23-BAD'), false, '被闸门拒收的判据不许写进台账')
})

test('N-23 有界全称冒充无界全称 → 拒收（N-15 的实现面）', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-bounded')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const tool = ctx.tools.get('verify_claim')
  const file = await LEAN(
    dir,
    'b.lean',
    'set_option autoImplicit false\ntheorem bounded_only : (List.range 200).all (fun t => t * 1 = t) = true := by decide\n',
  )

  const r = await tool.execute({
    id: 'N15-BAD',
    assertion: '对所有自然数 t 都有 t * 1 = t',
    claim_type: 'forall',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'bounded_only',
    statement: '(List.range 200).all (fun t => t * 1 = t) = true',
    dir,
  })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, 'bounded_as_unbounded')
  assert.match(String(r.hint), /界|200/)
})

test('N-23 把界写进断言就放行（同一份 Lean，不同的说法）', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lean-bounded-ok')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const tool = ctx.tools.get('verify_claim')
  const file = await LEAN(
    dir,
    'c.lean',
    'set_option autoImplicit false\ntheorem bounded_ok : (List.range 200).all (fun t => t * 1 = t) = true := by decide\n',
  )

  const r = await tool.execute({
    id: 'N15-OK',
    assertion: '在 t<200 的范围内，所有 t 都满足 t * 1 = t',
    claim_type: 'forall',
    evidence: 'lean',
    lean_file: file,
    lean_decl: 'bounded_ok',
    statement: '(List.range 200).all (fun t => t * 1 = t) = true',
    dir,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.pass, true)
  // P 级只代表"这条形式语句被内核证明"——台账里必须能同时看到两边。
  assert.ok(r.proved_statement, '台账要存内核实际证明的语句')
  assert.equal(r.statement_claimed, '(List.range 200).all (fun t => t * 1 = t) = true')
})

// ---- N-19：count + 自报覆盖 ------------------------------------------------

const SPACE8 = '{"kind":"product","factors":[{"name":"b1","values":[1,-1,5,-5]},{"name":"b2","values":[1,-1]}]}'

test('N-19 全遍历但只打印命中行：自报 seen 后可以通过', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'N19-OK',
    assertion: '8 类候选里恰好 4 类存活',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: SPACE8,
    why_complete: 'b1 取 ±1,±5；b2 取 ±1，四乘二共 8 格',
    code: [
      'import json',
      'n = 0',
      'for b1 in (1,-1,5,-5):',
      '    for b2 in (1,-1):',
      '        n += 1',
      '        if b1 in (1,5):',
      '            print(json.dumps({"b1": b1, "b2": b2}))',
      'print(\'#@coverage {"seen": %d}\' % n)',
    ].join('\n'),
    code2: [
      'import json',
      'hit = [(1,1),(1,-1),(5,1),(5,-1)]',
      'for pair in hit:',
      '    print(json.dumps({"b1": pair[0], "b2": pair[1]}))',
      'print(\'#@coverage {"seen": 8}\')',
    ].join('\n'),
    judge: 'count',
    value: '4',
    dir: TMP,
  })
  assert.equal(r.pass, true, JSON.stringify(r))
  assert.equal(r.coverage.mode, 'self-reported')
  assert.equal(r.coverage.grid_checked, false, '这种模式没做逐格对账，必须如实标出')
  assert.equal(r.coverage.seen, 8)
})

test('N-19 自报的遍历量与声明的论域不符 → FAIL', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'N19-BAD',
    assertion: '8 类候选里恰好 2 类存活',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: SPACE8,
    why_complete: '同上',
    single_impl_reason: '测自报不符会不会被抓',
    code: [
      'import json',
      'for b1 in (1,-1):',
      '    print(json.dumps({"b1": b1}))',
      'print(\'#@coverage {"seen": 2}\')',
    ].join('\n'),
    judge: 'count',
    value: '2',
    dir: TMP,
  })
  assert.equal(r.pass, false)
  assert.equal(r.rejected, 'coverage_incomplete')
  assert.match(String(r.reason), /2.*8|不符/)
})

// ---- N-17：第二实现与 disputed ---------------------------------------------

test('N-17 两个实现结论相反 → disputed，既不算 PASS 也不算 FAIL', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'N17-DISPUTED',
    assertion: '4 个候选里恰好 2 个满足条件',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: '{"kind":"product","factors":[{"name":"a","values":[1,2,3,4]}]}',
    why_complete: 'a 取 1..4',
    code: [
      'import json',
      'for a in (1,2,3,4):',
      '    if a % 2 == 0:',
      '        print(json.dumps({"a": a}))',
      'print(\'#@coverage {"seen": 4}\')',
    ].join('\n'),
    // 第二份实现写错了一个条件（a>1 而不是 a%2==0）——这正是 D-ENUM 那类 bug
    code2: [
      'import json',
      'for a in (1,2,3,4):',
      '    if a > 1:',
      '        print(json.dumps({"a": a}))',
      'print(\'#@coverage {"seen": 4}\')',
    ].join('\n'),
    judge: 'count',
    value: '2',
    dir: TMP,
  })
  assert.equal(r.pass, null, 'disputed 不是 false，是"还不知道"')
  assert.equal(r.level, '?')
  assert.equal(r.impl_agree, false)
  assert.ok(r.disputed && r.disputed.impl1 && r.disputed.impl2)
  assert.match(String(r.hint), /相反|定性/)
})

// ---- N-20：证据文件不互相覆盖 ----------------------------------------------

test('N-20 同一断言换实现重判 → 两份证据文件都在，旧的没被覆盖', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'n20')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const base = {
    id: 'N20',
    assertion: '1 到 3 的和是 6',
    code: 'import json\nprint(json.dumps({"s": 6}))\n',
    judge: 'all',
    predicate: 's == 6',
    dir,
  }
  const a = await tool.execute(base)
  const b = await tool.execute({ ...base, code: 'import json\nprint(json.dumps({"total": 6}))\n', predicate: 'total == 6' })
  assert.equal(a.pass, true)
  assert.equal(b.pass, true)
  // 同一句话就是同一个 hash —— 这是设计，不是缺陷。区分两次实现的
  // 是文件名里的 script_sha，不是 claim_hash。
  assert.equal(a.claim_hash, b.claim_hash)

  const dirFiles = await fsp.readdir(path.join(dir, '.cv'))
  const pyFiles = dirFiles.filter((f) => f.startsWith('N20.') && f.endsWith('.py'))
  assert.equal(pyFiles.length, 2, `换实现后应当有两份脚本，实际：${pyFiles.join(', ')}`)
  const l1 = await fsp.readFile(a.evidence.replace(/\.out\.txt$/, '.py'), 'utf8')
  assert.match(l1, /"s": 6/, '第一版脚本必须还能读到')
})

// ---- P0-4：恒真式判据 ------------------------------------------------------

test('P0-4 predicate 是恒真式 → 记为空判定（pass=null / vacuous / X），不当证据', async () => {
  const ctx = fakeCtx()
  await apply(ctx, { pythonExe: PY, stateDir: '.cv-test', timeoutMs: 60000 })
  const tool = ctx.tools.get('verify_claim')

  const r = await tool.execute({
    id: 'P04-BAD',
    assertion: '在 1..3 中不存在等于 0 的取值',
    claim_type: 'none_in',
    evidence: 'search',
    scope: '1..3',
    code: 'import json\nfor v in (1,2,3):\n    print(json.dumps({"v": v}))\n',
    judge: 'all',
    // 这个 predicate 根本没看 v。脚本跑通就 PASS，PASS 携带的信息为零。
    predicate: 'True',
    dir: TMP,
  })
  // 2026-11-06 改：旧版这里断言 `pass === true` 且等级降 S。降级只换了标签——
  // 报告照样引用它、审计照样把它算进 E 级、判据照样拿它当 PASS。
  // 现在按空判定处理：pass 必须是 null（既不是通过也不是不通过），
  // 否则"不敏感就降级"这句规定只有在人记得它的时候才成立。
  assert.equal(r.pass, null, '空判定不能记成 PASS')
  assert.equal(r.verdict, 'vacuous')
  assert.equal(r.insensitive, true, '不引用数据的 predicate 必须被标出来')
  assert.equal(r.sensitivity, 0)
  assert.equal(r.level, 'X', '证据无效，与被推翻同档')

  // 落盘的那一条也要是 null——否则下游（doneBacked / 审计）读台账时又把它当 PASS。
  const led = (await fsp.readFile(path.join(TMP, '.cv-test', 'claims.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((x) => x.id === 'P04-BAD')
  assert.equal(led.length, 1)
  assert.equal(led[0].pass, null)
  assert.equal(led[0].verdict, 'vacuous')

  const good = await tool.execute({
    id: 'P04-OK',
    assertion: '前三个候选都满足 v 为正整数',
    code: 'import json\nfor v in (1,2,3):\n    print(json.dumps({"v": v}))\n',
    judge: 'all',
    predicate: 'v > 0 and v == int(v)',
    dir: TMP,
  })
  assert.equal(good.pass, true)
  assert.equal(good.verdict, 'pass')
  assert.equal(good.insensitive, undefined, '真判据不该被误标')
  assert.ok(good.sensitivity > 0, `扰动后应有一行翻转，实际 ${good.sensitivity}`)
})

// ---- 研究层（N-27 / N-28 / M1）--------------------------------------------

test('surpriseOf：高置信猜对是低惊喜，高置信猜错是高惊喜', () => {
  // 0.9 把握猜对 → 0.15 bit；0.9 把握猜错 → 3.32 bit。同样是"错了"，
  // 信息量差 20 倍——"猜对/猜错"这个二值指标看不出这件事。
  assert.equal(surpriseOf(0.9, true), 0.15)
  assert.equal(surpriseOf(0.9, false), 3.32)
  assert.equal(surpriseOf(0.5, true), 1)
  assert.equal(surpriseOf(0.5, false), 1, '五五开时对错都不提供信息，都应是 1 bit')
  assert.equal(surpriseOf(undefined, true), null, '没给置信度就没有惊喜度，不能编一个 0')
  assert.equal(surpriseOf(1.5, true), null, '越界的置信度不猜，返回 null')
})

test('N-28 每条记录都带 schema 版本', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'schema')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv' })
  const verify = ctx.tools.get('verify_claim')

  await verify.execute({
    id: 'S1',
    assertion: '两行数据的 v 都等于 1',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: JSON.stringify({ kind: 'range', var: 'i', from: 1, to: 2, step: 1 }),
    why_complete: 'i 只有 1 和 2 两个取值',
    code: 'import json\nfor i in (1,2): print(json.dumps({"i": i, "v": 1}))\n',
    judge: 'all',
    predicate: 'v == 1',
    single_impl_reason: '只跑两行，没有中间量',
    dir,
  })

  const recs = (await fsp.readFile(path.join(dir, '.cv', 'claims.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].schema, SCHEMA_VERSION, '没有版本号，历史记录的解释每加一个字段就要重算一次')
})

test('N-27 claim_key / supersedes 落盘，surprise 按预测算', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'lineage')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv' })
  const verify = ctx.tools.get('verify_claim')

  const base = await verify.execute({
    id: 'OLD',
    assertion: '在这个小论域上，及格线是 2',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: JSON.stringify({ kind: 'range', var: 'i', from: 1, to: 2, step: 1 }),
    why_complete: 'i 取 1、2 两个值',
    code: 'import json\nprint(json.dumps({"i": 1, "v": 2}))\nprint(json.dumps({"i": 2, "v": 2}))\n',
    judge: 'all',
    predicate: 'v >= 2',
    claim_key: 'toy-threshold',
    prediction: 'hold',
    confidence: 0.55, // 故意不自信：猜对了惊喜度也应当不低
    single_impl_reason: '只跑两行，没有中间量',
    dir,
  })

  const next = await verify.execute({
    id: 'NEW',
    assertion: '在这个小论域上，及格线是 2，且两行都严格取到 2',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: JSON.stringify({ kind: 'range', var: 'i', from: 1, to: 2, step: 1 }),
    why_complete: 'i 取 1、2 两个值',
    code: 'import json\nprint(json.dumps({"i": 1, "v": 2}))\nprint(json.dumps({"i": 2, "v": 2}))\n',
    judge: 'all',
    predicate: 'v == 2',
    claim_key: 'toy-threshold',
    supersedes: base.claim_hash,
    prediction: 'hold',
    confidence: 0.99,
    single_impl_reason: '只跑两行，没有中间量',
    dir,
  })

  const recs = (await fsp.readFile(path.join(dir, '.cv', 'claims.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse)
  const old = recs.find((r) => r.id === 'OLD')
  const nw = recs.find((r) => r.id === 'NEW')

  assert.equal(old.claim_key, 'toy-threshold')
  assert.equal(nw.claim_key, 'toy-threshold', '同一个语义键跨轮必须一致，这是跨轮认人的唯一依据')
  assert.deepEqual(nw.supersedes, [base.claim_hash], 'supersedes 必须记下被接替那条的 hash')

  // 同样是"猜对"，0.55 的把握比 0.99 的把握提供的信息多得多。
  assert.ok(old.surprise > nw.surprise, `低置信猜对(${old.surprise})应比高置信猜对(${nw.surprise})更有信息量`)
})

test('research_note 写死路，且不污染 claims.jsonl 的判定统计', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'notes')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv' })
  const note = ctx.tools.get('research_note')
  const verify = ctx.tools.get('verify_claim')

  await verify.execute({
    id: 'P1',
    assertion: '两行都满足 v=1',
    claim_type: 'value',
    evidence: 'exhaustive',
    space: JSON.stringify({ kind: 'range', var: 'i', from: 1, to: 2, step: 1 }),
    why_complete: 'i 取 1、2 两个值',
    code: 'import json\nfor i in (1,2): print(json.dumps({"i": i, "v": 1}))\n',
    judge: 'all',
    predicate: 'v == 1',
    single_impl_reason: '只跑两行，没有中间量',
    dir,
  })

  const r = await note.execute({
    dir,
    type: 'dead_end',
    id: 'DE-1',
    statement: '想用开区间采样证明实位完备性，结果漏掉临界点',
    blocked_at: '第 2 步：临界点 x=e_i 不在任何开区间里',
    needs: '需要单独处理 x=e_i 三种情形，或换成闭区间+端点检查',
  })
  assert.equal(r.ok, true)

  const claims = (await fsp.readFile(path.join(dir, '.cv', 'claims.jsonl'), 'utf8')).split('\n').filter(Boolean)
  const notes = (await fsp.readFile(path.join(dir, '.cv', 'notes.jsonl'), 'utf8')).split('\n').filter(Boolean)
  assert.equal(claims.length, 1, 'notes 不能写进 claims：它们没有 pass，会污染判定统计')
  assert.equal(notes.length, 1)

  const rec = JSON.parse(notes[0])
  assert.equal(rec.record_type, 'dead_end')
  assert.equal(rec.id, 'DE-1')
  assert.match(String(rec.needs), /单独处理/, 'needs 栏是下一轮派活的依据，不能空')
})

test('research_note 拒收非法类型，不许静默接受', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'notes-bad')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv' })
  const note = ctx.tools.get('research_note')
  // schema 层的 enum 校验会在 execute 之前就抛，不会静默放进来一条"凭感觉"的记录。
  await assert.rejects(
    () => note.execute({ dir, type: 'vibes', id: 'X', statement: '我觉得不行' }),
    /must be one of/,
  )
})

// 猜想要能当"成果"用，就必须能被判死。三栏缺一，它只是一个印象。
//
// 这条不是洁癖：13 轮里 3 条 conjecture 全部躺在账本里没人捡，根因是"猜想不算成果"。
// 一旦算成果，最省力的作弊就是写一句"应该和某个 K3 有关"。所以门槛放在
// falsifiable_by / missing_step / next_test——它们都是"下一轮能不能直接接着干"的检验，
// 不是"写得好不好"的检验。
test('research_note 的 conjecture 必须带可判三栏，缺一拒收', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'notes-conj')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv' })
  const note = ctx.tools.get('research_note')

  // 只写一句话：拒。
  const bare = await note.execute({ dir, type: 'conjecture', id: 'CJ-bare', statement: '应该和某个 K3 有关' })
  assert.equal(bare.ok, false)
  assert.match(String(bare.error), /falsifiable_by/)
  assert.match(String(bare.error), /missing_step/)
  assert.match(String(bare.error), /next_test/)

  // 少一栏也拒——"差一点"和"没有"在判据上是一回事。
  const partial = await note.execute({
    dir,
    type: 'conjecture',
    id: 'CJ-partial',
    statement: 'S3 是 A=E1×E2 的 Kummer 曲面，结点数据给出 A[2] 的结构',
    falsifiable_by: '把 16 个结点坐标代入 Kummer 商映射，看是否落在 E1[2]×E2[2] 里',
    missing_step: '定出 E1 与 E2 的方程',
  })
  assert.equal(partial.ok, false)
  assert.match(String(partial.error), /next_test/)

  // 三栏齐：收，且字段原样落盘。
  const okRec = await note.execute({
    dir,
    type: 'conjecture',
    id: 'CJ-kummer-abelian',
    statement: 'S3 是 A=E1×E2 的 Kummer 曲面，16 个结点里 8 个在 Q 上、8 个在 Q(√2) 上',
    detail: '由 C9b 的 16/8 随 (2|p) 跳变反推',
    falsifiable_by: '把 16 个结点坐标代入 Kummer 商映射，看是否落在 E1[2]×E2[2] 里',
    missing_step: '定出 E1 与 E2 的方程',
    next_test: 'python tools/kummer.py --p 7 13 17',
    implies: 'G1 等价于 A(Q) 里是否存在使 g∘π 为平方的点',
  })
  assert.equal(okRec.ok, true)
  const lines = (await fsp.readFile(path.join(dir, '.cv', 'notes.jsonl'), 'utf8')).split('\n').filter(Boolean)
  assert.equal(lines.length, 1, '被拒的两条不能落盘')
  const rec = JSON.parse(lines[0])
  assert.equal(rec.record_type, 'conjecture')
  assert.match(String(rec.next_test), /kummer\.py/)
  assert.match(String(rec.falsifiable_by), /Kummer 商映射/)
})

// ---- runner ---------------------------------------------------------------

// claim_audit 的返回值必须能被宿主无损序列化。
//
// 为什么单独一条：team8 实轮里 claim_audit(全部) 报
//   `invalid output: value is not lossless JSON`
// 而 claim_audit(某个 id) 正常。根因是 Lean 记录没有 `rows` 字段
// （它不跑 Python，没有"行数"这一维），record 里就留下了 `rows: undefined`。
// 单独查 id 时那条恰好是 predicate 记录，所以看不见。
//
// 这个 bug 的性质值得记住：**报错文本指向完全无关的方向**（"不是无损 JSON"听起来
// 像编码问题），而真实原因是某个可选字段没兜底。所以这里不测"哪个字段"，
// 直接递归扫整个返回值：任何键的值是 undefined 就失败。
test('claim_audit 全量返回里没有 undefined（Lean 记录没有 rows 也不能留洞）', async () => {
  const ctx = fakeCtx()
  const dir = path.join(TMP, 'audit-lossless')
  await apply(ctx, { pythonExe: PY, stateDir: '.cv', leanTimeoutMs: 120000 })
  const verify = ctx.tools.get('verify_claim')
  const audit = ctx.tools.get('claim_audit')
  const file = await LEAN(dir, 'ok.lean', 'set_option autoImplicit false\ntheorem t1 : 1 = 1 := rfl\n')

  // 一条 predicate 记录（有 rows）+ 一条 Lean 记录（没有 rows），混在同一本台账里。
  await verify.execute({
    id: 'P1', assertion: '两行都满足 v>0', claim_type: 'forall', evidence: 'exhaustive',
    code: 'import json\nprint(json.dumps({"v":1}))\nprint(json.dumps({"v":2}))\n',
    judge: 'all', predicate: 'v > 0',
    space: JSON.stringify({ kind: 'range', var: 'v', from: 1, to: 2 }),
    why_complete: 'v 只有这两个取值',
    code2: 'import json\nfor v in (1,2): print(json.dumps({"w":v}))\n',
    dir,
  })
  await verify.execute({
    id: 'L1', assertion: '1 = 1', claim_type: 'value', evidence: 'lean',
    lean_file: file, lean_decl: 't1', statement: '1 = 1', dir,
  })

  const a = await audit.execute({ dir })
  const bad = []
  const walk = (node, pathStr) => {
    if (node === undefined) { bad.push(pathStr); return }
    if (node === null || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) walk(v, pathStr ? `${pathStr}.${k}` : k)
  }
  walk(a, '')
  assert.equal(bad.length, 0, `返回值里有 undefined，宿主会整条拒收：${bad.join(', ')}`)
  // 顺带确认 Lean 那条的 rows 是 null 而不是缺键——缺键在前端读起来和 0 一样。
  const l1 = a.records.find((r) => r.id === 'L1')
  assert.equal(l1.rows, null, 'Lean 记录的 rows 应当是 null，不是缺字段')
})

let failed = 0
await fsp.mkdir(TMP, { recursive: true })

for (const c of cases) {
  try {
    await c.fn()
    console.log(`  ok   ${c.name}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL ${c.name}`)
    console.log(`       ${err.message.split('\n')[0]}`)
  }
}

await fsp.rm(TMP, { recursive: true, force: true })

console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed}/${cases.length} 失败`)
process.exit(failed === 0 ? 0 : 1)
