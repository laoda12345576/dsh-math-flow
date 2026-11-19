/**
 * epistemic.js — 证据等级与提升闸。
 *
 * 要挡的那件事：**数值实验的结果被直接当成数学结论用**。
 *
 * 它在实验台里反复出现，每次形态不同、机理相同：
 *   - 146k 组有界搜索没找到仿射点 → 报告写「E(Q) 无仿射点」；
 *   - 只查了 p=2,5 的局部可解性 → 报告写「无局部障碍」（实位根本没查）；
 *   - 46 个素数验了一条对任意素数恒真的同余式 → 报告写「已验证」。
 * 三次都不是算错，是**算出来的东西支持的命题，比写出来的命题弱**。
 *
 * 关键的不对称：找到点 → 存在性命题成立（一次计算就够了）；
 * 没找到点 → 什么也不成立（除非搜索的论域是有限且被证明穷尽的）。
 * 所以判据不是「计算对不对」，而是**论域是有限穷尽的，还是无限抽样的**。
 *
 * 于是有两个轴，都必须由调用方显式声明，不能由脚本文本推断：
 *   claim_type  命题形式：forall / exists / none_in / value / approx
 *   evidence    证据种类：proof / exhaustive / search / literature
 * 组合错了就在**调用时**拒收（不是报告里审计）。拒收时同时给出等价的
 * 诚实写法——只拒绝不给替代，模型会绕过闸门，而不是修正说法。
 *
 * 机械的部分只有一半，另一半必须承认：
 *   能机械查：你穷尽了你声称的那个论域吗（space 展开后逐个对账）；
 *   不能机械查：你声称的论域本身是不是完整的（why_complete 那句话）。
 * 后者交给 refute 去攻，但它现在是一个**有 hash 的、可被引用的对象**，
 * 而不是散在报告里的一句默认假设。
 *
 * @module dsh-plugin-claim-verify/epistemic
 */

/** 命题形式。名字即语义，不要用 value 装 forall。 */
export const CLAIM_TYPES = ['forall', 'exists', 'none_in', 'value', 'approx']

/** 证据种类。按"能支持多强的命题"从强到弱排列。 */
export const EVIDENCE_KINDS = ['lean', 'proof', 'exhaustive', 'search', 'literature']

/**
 * 等级强度。X=已作废，U=未声明，S=抽样/搜索，E=穷尽计算，L=文献，D=推导，P=Lean 已核。
 * 比较用 rank：一条推导的强度**不超过它最弱的前提**——这是防洗白的关键。
 * X 取 -1，保证它在取最小值时一定胜出：只要前提里有一条作废，结论就作废。
 */
// 等级次序。`?`（blocked：判决没跑成）必须独立成一档，不能和 X 合并：
//   X = 判过，判死了 —— 事实已经确定，结论作废，下游全废；
//   ? = 没判成（工具链坏、超时、编译环境缺）—— 事实未知，既不能当已证引用，
//       也不能算作废。把两者塞进同一档，一次环境抖动就会把整轮结论沿引用链清零，
//       而且看起来比真判死还严谨——这是 N-9，两轮都记着"该修但没修"。
// 次序：X < ? < U < S < E/L < D < P。`?` 排在 U 之下，是因为它连"我知道自己多弱"都不成立。
export const LEVEL_RANK = { X: -2, '?': -1, U: 0, S: 1, E: 2, L: 2, D: 3, P: 4 }

export const LEVEL_NAME = {
  P: 'Lean 已核（语句由内核展开、公理表干净）',
  D: '推导（前提逐条已判）',
  E: '穷尽计算（论域有限且已对账）',
  L: '文献（未复核，除非另有标注）',
  S: '抽样/搜索（只支持存在性，或带界的否定）',
  U: '未声明（等同最弱，不可用于任何全称结论）',
  '?': '未判定（blocked：工具链/超时/编译环境，事实未知——不是作废，也不能当已证）',
  X: '已作废（Lean 判定失败，或引用了作废的判据）',
}

/**
 * 断言里出现全称/否定语义时，必须显式声明 claim_type。
 *
 * 只在"危险的地方"强制，不是每条都要填：给 2^100 的位数做一次判定也要选
 * 五个枚举值，模型会随手乱选，闸门就退化成仪式。
 */
const UNIVERSAL_PATTERNS = [
  /对任意/, /对所有/, /任意[^。；]{0,12}都/, /所有[^。；]{0,12}都/,
  /∀/, /不存在/, /没有一个/, /恒成/, /恒真/, /必然成/, /必定成/,
  /always/i, /for all/i, /no such/i, /never/i, /every\s+\w/i,

  // ── 2026-11-05 补 ──────────────────────────────────────────────
  // 上面那张表漏掉了三起事故的原句：8 条历史措辞里放行了 6 条。
  // 「E(Q) 无仿射点」「无局部障碍」「16 类全部可判」全都不含表里任何词。
  //
  // 必须说清楚这张表的性质：它是**见过才补的黑名单，不是判据**。
  // 中文表达全称/否定的方式有几十种（无 / 没有 / 不含 / 一律 / 普遍 /
  // 无一例外 / 绝不…），补词永远追不上措辞变化。它只提高漏检成本。
  //
  // 真正的兜底不在这里，而在报告层：`run-audit` 的引用率检查——
  // 报告里不挂 hash 的结论，无论措辞怎么绕都数得出来。
  // 这套机制和 N-5（dsh-purge 被「攻击」二字整轮拒答）是同一个病根，
  // 区别只是这里命中的后果是"要求你声明"而不是"拒答"。
  /无[^。；，]{0,10}(点|解|障碍|例外|反例|整点)/,   // 无仿射点 / 无局部障碍 / 无例外
  /没有[^。；，]{0,10}(点|解|障碍|例外|反例)/,
  /不含[^。；，]{0,8}(点|解|整点|例外)/,
  /(一律|普遍|统统|无一例外|绝不)/,                 // 一律满足 / 普遍成立
  /均(存活|可判|成立|满足|通过|存在)/,              // 各类均存活（"均值"不匹配）
  /全[部都][^。；]{0,10}(存活|可判|成立|通过)/,      // 16 类全部可判
]

export function looksUniversal(assertion) {
  const s = String(assertion ?? '')
  return UNIVERSAL_PATTERNS.some((re) => re.test(s))
}

/** 把 space 声明展开成"应该被覆盖的全部格子"。 */
export function expandSpace(space) {
  if (!space || typeof space !== 'object') return { error: '缺少 space' }
  if (space.kind === 'product') {
    const factors = Array.isArray(space.factors) ? space.factors : []
    if (!factors.length) return { error: 'space.factors 为空' }
    let keys = ['']
    for (const f of factors) {
      if (!f?.name) return { error: 'space.factors 里有元素缺 name' }
      const vals = Array.isArray(f.values) ? f.values : null
      if (!vals || !vals.length) return { error: `space.factors[${f.name}] 缺 values` }
      keys = keys.flatMap((k) => vals.map((v) => (k === '' ? String(v) : `${k}\u0001${String(v)}`)))
      if (keys.length > 2_000_000) return { error: '声明的论域超过 200 万格，这不像是一次机械枚举' }
    }
    const set = new Set(keys)
    return { total: set.size, keys: set, kind: 'product', factors, fields: factors.map((f) => f.name) }
  }
  if (space.kind === 'range') {
    const from = Number(space.from)
    const to = Number(space.to)
    const step = Number(space.step ?? 1)
    if (!space.var) return { error: 'space.kind=range 缺 var' }
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0) {
      return { error: 'range 的 from/to/step 不合法' }
    }
    if (to < from) return { error: 'range 的 to 小于 from' }
    if ((to - from) / step > 2_000_000) return { error: '声明的区间超过 200 万格' }
    const set = new Set()
    for (let x = from; x <= to + 1e-12; x += step) set.add(String(Number(x.toPrecision(15))))
    return { total: set.size, keys: set, kind: 'range', var: space.var }
  }
  return { error: `space.kind 只能是 product 或 range，收到 ${space.kind}` }
}

/**
 * 对账：脚本实际产出的每一行，落在声明的论域里吗？论域里的每一格都出现了吗？
 *
 * 这一步抓的是真实发生过的两种错：声明 16 类只算了 8 类（候选集口径串线）、
 * 声称查了 p=2,5 和实位，实际只查了 p=2,5（漏掉实位）。
 * 它抓不到的是"论域本身造错了"——那要人去攻 why_complete。
 */
export function checkCoverage(stdout, space, limit = 8) {
  const exp = expandSpace(space)
  if (exp.error) return { ok: false, error: exp.error }

  const seen = new Set()
  const offSpace = []
  const noKey = []
  const dup = []
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    let row
    try {
      row = JSON.parse(t)
    } catch {
      continue // 脏行交给判定器报，这里只数覆盖
    }
    if (!row || typeof row !== 'object') continue
    let key
    if (exp.kind === 'product') {
      const parts = []
      let ok = true
      for (const f of exp.fields) {
        if (!(f in row)) {
          ok = false
          noKey.push({ field: f, row })
          break
        }
        parts.push(String(row[f]))
      }
      if (!ok) continue
      key = parts.join('\u0001')
    } else {
      if (!(exp.var in row)) {
        noKey.push({ field: exp.var, row })
        continue
      }
      key = String(row[exp.var])
    }
    if (seen.has(key)) dup.push(key)
    seen.add(key)
    if (!exp.keys.has(key)) offSpace.push(key)
  }

  const missing = [...exp.keys].filter((k) => !seen.has(k)).slice(0, limit)
  const extra = offSpace.slice(0, limit)
  return {
    ok: missing.length === 0 && extra.length === 0 && noKey.length === 0,
    total: exp.total,
    seen: seen.size,
    missing,
    extra,
    bad_rows: noKey.length,
    duplicates: dup.length,
  }
}

/** 声明之间的一致性检查。返回 null 表示放行，否则给拒收理由 + 诚实写法。 */
export function epiGate(input = {}) {
  const assertion = String(input.assertion ?? '')
  const claimType = String(input.claim_type ?? '').trim()
  const evidence = String(input.evidence ?? '').trim()
  const scope = String(input.scope ?? '').trim()
  const whyComplete = String(input.why_complete ?? '').trim()
  const lemma = String(input.lemma ?? '').trim()
  const cite = String(input.cite ?? '').trim()
  const premises = Array.isArray(input.premises) ? input.premises.map(String) : []

  if (!claimType && !evidence) {
    if (looksUniversal(assertion)) {
      return {
        error:
          '这条断言是全称/否定形式（含"任意/所有/不存在/恒成立"），必须声明 claim_type 与 evidence。' +
          '否则一次有限搜索会被当成证明用——这正是要挡的那件事。',
        hint:
          '三种诚实写法：① 只是抽样 → claim_type=none_in + evidence=search + scope="h≤1e6"，' +
          '并把上界写进断言原文（它会被 hash 钉住）；② 论域有限且已穷尽 → evidence=exhaustive + space + why_complete；' +
          '③ 由已有判据推出 → evidence=proof + premises=[...]。',
      }
    }
    return { epi: null }
  }
  if (!claimType) return { error: '声明了 evidence 却没声明 claim_type' }
  if (!CLAIM_TYPES.includes(claimType)) return { error: `claim_type 只能是 ${CLAIM_TYPES.join(' / ')}` }
  if (!evidence) return { error: '声明了 claim_type 却没声明 evidence' }
  if (!EVIDENCE_KINDS.includes(evidence)) return { error: `evidence 只能是 ${EVIDENCE_KINDS.join(' / ')}` }

  // 存在性可以用一次搜索成立；全称性不行。这条是整个机制的核心。
  if (claimType === 'forall' && evidence === 'search') {
    return {
      error:
        'forall + search 是被禁止的组合：有限次搜索（哪怕 100 万次）不能支持"对任意…成立"。' +
        '找到反例可以否定全称，找不到不能肯定。',
      hint:
        '要么把命题降成带界的否定（claim_type=none_in，scope 写上界，并让断言原文包含这个上界），' +
        '要么把论域证明成有限且穷尽（evidence=exhaustive + space + why_complete），' +
        '要么改成由前提推导（evidence=proof + premises）。',
    }
  }
  if (claimType === 'value' && evidence === 'search') {
    return {
      error: 'value + search：抽到的样本算不出精确值。' + '要么穷尽论域（exhaustive + space），要么从前提推导（proof）。',
    }
  }
  if (claimType === 'exists' && looksUniversal(assertion)) {
    return { error: '断言是全称/否定形式，不能标成 exists。命题形式要和断言原文一致，否则 hash 钉住的是另一句话。' }
  }

  if (evidence === 'search') {
    if (!scope) {
      return {
        error: 'search 必须给 scope：搜索到的命题只在这个范围内成立，范围不写出来，它就会在报告里变成无界的。',
        hint: 'scope 例："h ≤ 1e6 且分母 ≤ 1e4"。它还必须原样出现在 assertion 里，这样 hash 就锁住了界。',
      }
    }
    if (!assertion.includes(scope)) {
      return {
        error: `scope "${scope}" 没有出现在断言原文里。界写在参数里而不写在断言里，引用 claim_hash 时就丢了。`,
        hint: `把断言改成带界的形式，例如「E(Q) 在 ${scope} 内无仿射点」。`,
      }
    }
  }

  if (evidence === 'exhaustive') {
    const exp = expandSpace(input.space)
    if (exp.error) {
      return {
        error: `exhaustive 必须给可对账的 space：${exp.error}`,
        hint:
          'space 是"我声称穷尽了的那个论域"的机械形式，例：' +
          '{"kind":"product","factors":[{"name":"b1","values":[1,-1,5,-5]},{"name":"b2","values":[1,-1]}]}，' +
          '或 {"kind":"range","var":"p","from":2,"to":20000,"step":1}。',
      }
    }
    if (!whyComplete) {
      return {
        error: 'exhaustive 必须给 why_complete：为什么这个有限论域覆盖了全部情形（约化引理）。',
        hint: '例："b_i 只能取 sf((e_i−e_j)(e_i−e_k)) 的平方自由因子，故 8 类穷尽"。这句话会被 hash 钉住，供 refute 逐条攻。',
      }
    }
  }

  if (evidence === 'proof') {
    if (!premises.length && !lemma) {
      return {
        error: 'proof 必须给 premises（被引用判据的 hash 列表）或 lemma（标准引理名）。空口说"由此推出"就是没有推导。',
        hint: 'premises 里的每一条都要能在台账里查到；其中若有一条是抽样，本条推导的等级会跟着降下去。',
      }
    }
  }

  if (evidence === 'literature' && !cite) {
    return { error: 'literature 必须给 cite（作者/年份/定理号），否则无法复核。' }
  }

  // lean：断言必须被形式化。这里只检查"有没有交付物"，
  // 真正的判决由 lean_audit 跑 Lean 给出，verify_claim 会自己调它。
  if (evidence === 'lean') {
    if (!input.lean_decl) {
      return {
        error: 'evidence=lean 必须给 lean_decl（Lean 里那条定理的名字）。没有名字就没有可判定的对象。',
        hint: '先写 .lean 文件，声明 `theorem my_thm : …`，再把 lean_file 与 lean_decl 一起传进来。',
      }
    }
    if (!input.lean_file) return { error: 'evidence=lean 必须给 lean_file（.lean 文件路径）。' }
  }

  const epi = {
    claim_type: claimType,
    evidence,
    ...(scope ? { scope } : {}),
    ...(whyComplete ? { why_complete: whyComplete } : {}),
    // space 必须落盘。第一版只把 coverage:{total,seen} 写进台账，
    // 于是"我声称穷尽了哪个论域"这件事过一天就查不到了：
    // 重判时只能凭输出自己反推 space——那等于让被判者自己定考纲。
    ...(evidence === 'exhaustive' && input.space ? { space: input.space } : {}),
    ...(lemma ? { lemma } : {}),
    ...(cite ? { cite } : {}),
    ...(premises.length ? { premises } : {}),
    ...(evidence === 'lean' ? { lean_file: input.lean_file, lean_decl: input.lean_decl } : {}),
  }
  return { epi: { ...epi, level: declaredLevel(epi) } }
}

/**
 * 写记录时的名义等级。最终等级还要看前提（computeLevels），
 * 因为"由一条抽样推出的结论"仍然是抽样。
 *
 * 注意 `lean` 这里给的是 P，但**调用方必须在 Lean 判定通过之后才落这个值**；
 * 判决失败时应当是 X（作废），不是 P。等级不是声明的，是判出来的。
 */
export function declaredLevel(epi) {
  if (!epi) return 'U'
  // 已经落定的等级优先于"由证据种类推出的等级"。
  // 单实现的 exhaustive 是 S、两实现分歧是 ?、blocked 是 ? —— 这三件事
  // 都不可能从 evidence 种类推出来，只能由判定过程写下来。
  // 不认这个字段，N-17 的降级和 N-9 的三态都会在最后一步被 declaredLevel 抹平。
  if (epi.level && LEVEL_RANK[epi.level] !== undefined) return epi.level
  if (epi.evidence === 'lean') return 'P'
  if (epi.evidence === 'proof') return 'D'
  if (epi.evidence === 'exhaustive') return 'E'
  if (epi.evidence === 'literature') return 'L'
  if (epi.evidence === 'search') return 'S'
  return 'U'
}

/**
 * 台账上的等级传播：proof 的等级 = 前提里最弱的那条。
 *
 * 没有这一步，闸门只要被分成两步就能绕过：
 *   先把搜索记成 S（合规），再写一条 proof "由 C7 可得 E(Q) 无仿射点"（合规），
 *   于是 S 洗成了 D。所以 D 不是标签，是**对前提的递归最小值**。
 */
export function computeLevels(records) {
  const byHash = new Map()
  for (const r of records) if (r?.hash) byHash.set(r.hash, r)
  const memo = new Map()
  const stack = new Set()

  function lvl(hash, depth = 0) {
    if (memo.has(hash)) return memo.get(hash)
    if (depth > 32) return { level: 'U', laundered_from: [], note: '前提链超过 32 层，放弃解析' }
    const rec = byHash.get(hash)
    if (!rec) return { level: 'U', laundered_from: [], missing: true }
    if (stack.has(hash)) return { level: 'U', laundered_from: [], cycle: true }
    stack.add(hash)
    let out
    const epi = rec.epi
    if (rec.invalidated === true) {
      // Lean 判死过的判据，本身就是 X；它的全部下游也跟着 X。
      out = { level: 'X', laundered_from: [], invalidated_by: [rec.id ?? hash] }
    } else if (rec.blocked === true) {
      // 判决没跑成。不去污染下游为 X，但必须切断它的支撑力：下游降为 `?`。
      out = { level: '?', laundered_from: [], blocked_by: [rec.id ?? hash] }
    } else if (!epi) {
      out = { level: 'U', laundered_from: [] }
    } else if (epi.evidence === 'lean') {
      out = {
        level: epi.level === 'X' ? 'X' : epi.level === '?' ? '?' : 'P',
        laundered_from: [],
        ...(epi.level === '?' ? { blocked_by: [rec.id ?? hash] } : {}),
      }
    } else if (epi.evidence === 'proof') {
      const ids = Array.isArray(epi.premises) ? epi.premises : []
      if (!ids.length) {
        out = { level: epi.lemma ? 'D' : 'U', laundered_from: [] }
      } else {
        const res = ids.map((id) => ({ id, ...lvl(id, depth + 1) }))
        const dead = res.filter((x) => x.level === 'X')
        const unknown = res.filter((x) => x.level === '?')
        if (dead.length) {
          // 作废沿引用链下传：一条前提作废，结论就没有支撑，不管它自己写得多漂亮。
          out = { level: 'X', laundered_from: [], invalidated_by: dead.flatMap((x) => x.invalidated_by ?? [x.id]) }
        } else if (unknown.length) {
          // 前提没判成 ≠ 前提是错的。结论既不能被当成已证，也不该被划掉——它只是不知道。
          out = {
            level: '?',
            laundered_from: [],
            blocked_by: unknown.flatMap((x) => x.blocked_by ?? [x.id]),
          }
        } else {
          const min = res.reduce((a, b) => (LEVEL_RANK[a.level] <= LEVEL_RANK[b.level] ? a : b))
          const weak = res.filter((x) => LEVEL_RANK[x.level] < LEVEL_RANK.D)
          out = { level: min.level, laundered_from: weak.map((x) => x.id) }
        }
      }
    } else {
      out = { level: declaredLevel(epi), laundered_from: [] }
    }
    stack.delete(hash)
    memo.set(hash, out)
    return out
  }

  const levels = new Map()
  for (const r of records) if (r?.hash) levels.set(r.hash, lvl(r.hash))
  return levels
}

// ── Lean 语句对齐（N-23 / N-15） ─────────────────────────────────
//
// 起因：一个 `theorem trivial_thing : 1 = 1 := rfl`，assertion 写成
// 「对任意椭圆曲线 E/Q，若 E(Q) 含 4 阶点则 rank E(Q) ≥ 1」，判 P、零公理。
// 原因是 assertion（自然语言）与 statement（内核展开的语句）之间**没有任何校验**，
// lean_decl 由调用方自己指，指到哪条判哪条。
//
// 自然语言 ↔ 形式语句的对应只能靠人审，所以这里不做"语义比对"，只做三件
// 结构性的、能挡住最廉价那类替换的检查：
//   1. statement 必须由调用方显式给出（把"被证的语句"从内核私藏变成公开声明）；
//   2. assertion 里出现的标识符，至少要有一个出现在 statement 里（挡"完全无关"）；
//   3. assertion 宣称无界全称而 statement 自带界限时拒收（挡"有界冒充无界"）。
// 剩下的部分不假装能自动验，而是把 assertion 与 proved_statement 并排写进台账，
// 让读者和 refute 都看得见——这才是 P 级该有的透明度。

/** 归一化 Lean 语句：去前导 `: `、压空白、去最外层多余括号。 */
export function normalizeLeanStatement(s) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim()
  t = t.replace(/^:\s*/, '')
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      else if (t[i] === ')') {
        depth--
        if (depth === 0 && i !== t.length - 1) { wraps = false; break }
      }
    }
    if (!wraps) break
    t = t.slice(1, -1).trim()
  }
  return t
}

/** assertion 里有意义的标识符：>=2 字符的 ASCII 单词，去掉常见虚词。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'all', 'any', 'has', 'have', 'with', 'that', 'this', 'then',
  'there', 'exist', 'exists', 'every', 'each', 'some', 'such', 'from', 'into',
])
export function statementIdentifiers(assertion) {
  const out = new Set()
  const re = /[A-Za-z][A-Za-z0-9_']{1,}/g
  let m
  const s = String(assertion ?? '')
  while ((m = re.exec(s))) {
    const w = m[0]
    if (w.length < 2) continue
    if (STOPWORDS.has(w.toLowerCase())) continue
    out.add(w)
  }
  return out
}

/** statement 里是否自带界限（N-15 的判据面）。 */
export function statementLooksBounded(statement) {
  const t = String(statement ?? '')
  return /\b(?:List|Finset)\.range\b|\bFin\s+\d+|\bFin\s+[A-Za-z_]|\bNat\.succ\s+\d+/.test(t) ||
    /(?:≤|<=|<)\s*\d+/.test(t)
}

/** assertion 自己有没有把界写出来。写了就不算"无界冒充有界"。 */
export function assertionDeclaresBound(assertion) {
  const s = String(assertion ?? '')
  return /(?:≤|<=|<|>=|≥)\s*\d|\d\s*(?:以内|以下|之内|范围)|范围|区间|至|不超过|上限|前\s*\d|h\s*≤|n\s*≤|t\s*</.test(s)
}

/**
 * 判 assertion 与 Lean 语句是否"说的是同一件事"。返回 null 表示放行。
 * 这是廉价版检查，只挡"完全无关"和"有界冒充无界"两类；不做语义等价判断。
 */
export function statementMismatch({ assertion, statement, proved }) {
  const claimed = String(statement ?? '').trim()
  if (!claimed) {
    return {
      reason: 'missing_statement',
      hint:
        'evidence=lean 必须给 statement：你要证的那条 Lean 语句原文（如 `∀ t : ℕ, t * 1 = t`）。' +
        '它会被并入同一次编译的 #check 结果一起存进台账，报告引用 P 级判据时要逐字带上它。' +
        '不给的话，台账里只有内核私藏的一行，读者无法判断"被证的"是不是"你说的那件事"。',
    }
  }
  const provedNorm = normalizeLeanStatement(proved)
  // 注意：这里**不要求逐字相等**。Lean 打印 `∀` 还是 `forall`、括号怎么加，
  // 都不是调用方能控制的；强行逐字比对只会逼人去抄 #check 输出，那反而等于没声明。
  // 逐字一致只作为一个记录字段（statement_exact），拒收交给下面两条结构性检查。
  if (looksUniversal(assertion) && statementLooksBounded(provedNorm) && !assertionDeclaresBound(assertion)) {
    return {
      reason: 'bounded_as_unbounded',
      hint:
        `assertion 说的是无界全称，但 Lean 语句自带界限：${provedNorm}\n` +
        '这两种写法只能选一种：要么把界写进 assertion（"对所有 t<200"），要么把 Lean 语句改成无界形式。' +
        'P 级是最高证据等级，不能靠"证了小范围"拿到。',
    }
  }
  const ids = statementIdentifiers(assertion)
  if (ids.size > 0) {
    const pool = `${provedNorm} ${String(claimed)}`
    const hit = [...ids].filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(pool))
    if (hit.length === 0) {
      return {
        reason: 'statement_unrelated',
        hint:
          `assertion 里的标识符 ${[...ids].slice(0, 6).join(', ')} 在 Lean 语句里一个都找不到：${provedNorm}\n` +
          '这说明被判的定理与你写的断言不是同一件事。' +
          '要么让 Lean 语句使用 assertion 里的记号，要么把 assertion 改成与被证语句一致的说法。',
      }
    }
  }
  return null
}

// ── 自报覆盖（N-19） ────────────────────────────────────────────
//
// `exhaustive` + `count` 是设计死角：count 判行数，天然要求脚本只打印匹配行；
// coverage 要求 space 每格都出现。两者不可同时满足，于是"遍历 16 格、命中 8 格"
// 永远落 coverage_incomplete，唯一能过的写法是把断言改成"16"——工具在逼人改命题。
//
// 解法：count 模式下允许脚本自报遍历量，写在注释行里（judge 与 coverage 都跳过 # 行）：
//     #@coverage {"seen": 16}
// 台账记 mode='self-reported'，与逐格对账的 mode='grid' 显式区分。
// 自报可能撒谎，但撒谎要主动写一个数字，而"忘了打印全部行"是无意的——
// 前者留痕、后者被卡死，这个不对称是对的。
export function readSelfReportedCoverage(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    const m = line.match(/^\s*#@coverage\s+(\{.*\})\s*$/)
    if (!m) continue
    try {
      const v = JSON.parse(m[1])
      const seen = Number(v?.seen)
      if (!Number.isFinite(seen) || seen < 0) return { error: '#@coverage 的 seen 不是非负整数' }
      return { seen, raw: v }
    } catch (e) {
      return { error: `#@coverage 不是合法 JSON：${e.message}` }
    }
  }
  return null
}
