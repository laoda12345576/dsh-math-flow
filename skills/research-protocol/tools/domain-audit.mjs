#!/usr/bin/env node
/**
 * domain-audit —— 内层论域审计（N-25）
 *
 * 要解决的问题：
 *   `space` 声明的是**外层论域**（16 个候选类），判定器按它逐格对账。
 *   但判据里通常还有一层**内层参数**（x = u/p^m 里的 m、扫描步长、取模的 k），
 *   那些取值写在脚本的循环里，`space` 里没有它们的位置。
 *   于是 coverage 16/16 全绿，而"m 到底该取到哪"从来没被问过。
 *
 * 实测的那个样本（team6 的 D-ENUM）：
 *   for m in list(range(0, K)) + [-1, -2, -3]:
 *   9 个 m 里 **8 个是冗余的**，唯一承重的是 m = -3——它恰好是"顺手多取一个"取到的。
 *   若像 p=5 那条一样只取到 -2，|Sel₂| 会从 2 变成 1，结论直接翻面。
 *
 * 所以这个工具只问一件事：**脚本里那些有限取值集合，凭什么就是全部？**
 *
 * 判据（尽量结构化，不靠自然语言同义词）：
 *   ① 循环的 iterable 里出现「参数化上界」（range(0, K)、range(K) 且 K 是变量）
 *      → 必须解释「为什么 K 够」；
 *   ② 循环的 iterable 里出现「硬编码列表尾巴」（+ [-1, -2, -3]）
 *      → 必须解释「为什么到此为止」；
 *   ③ 解释是否写了，看 why_complete 里有没有出现**该变量名**——
 *      变量名是代码里的标识符，模型要解释它就得提到它，
 *      这比查"无解/完备/闭合"这类同义词稳定得多（N-5 / N-14 的教训）。
 *
 * 输出 `--json` 供审计消费。退出码：有 FAIL 即 1。
 */

import fs from 'node:fs'
import path from 'node:path'

const CONST_OK = 12        // range(N) 里 N ≤ 这个数，多半是"遍历三个元素"，不报
const VARISH = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 从一行 for 语句里抽出变量名与 iterable 表达式。 */
function parseForLine(line) {
  const m = line.match(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?):\s*(?:#.*)?$/)
  return m ? { varName: m[1], iter: m[2].trim() } : null
}

/**
 * 分析 iterable，返回两类发现。
 * - bounded：参数化上界 { upper, expr }
 * - tail：硬编码列表 [{ values, expr }]
 *
 * ctx.consts / ctx.params 用来区分「参数化上界」与「计数循环」：
 *   `for _ in range(b)`（b 是外层循环变量）跑的是" répète b 次"，不是参数域；
 *   `for m in range(0, K)`（K 是模数 / 函数参数）才是内层论域。
 * 没有这个区分，任何嵌套计数循环都会被报成 FAIL —— 第一版就是这么误报 team7 的。
 */
function analyzeIterable(iter, varName, ctx) {
  const out = { bounded: [], tail: [], plainConst: false }
  if (varName === '_' || /^_/.test(varName)) return out   // 惯例：丢弃变量，是计数不是参数

  const rangeRe = /range\(\s*(?:(\d+)\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*|\d+)\s*(?:,\s*[^)]*)?\)/g
  let rm
  while ((rm = rangeRe.exec(iter)) !== null) {
    const upper = rm[2]
    if (!VARISH.test(upper)) {
      if (Number(upper) > CONST_OK) out.bounded.push({ upper, expr: rm[0], literal: true })
      else out.plainConst = true
      continue
    }
    if (ctx.loopVars.has(upper)) continue              // 外层循环变量 → 计数循环
    if (ctx.consts.has(upper) || ctx.params.has(upper)) {
      out.bounded.push({ upper, expr: rm[0] })
    }
  }

  // 硬编码列表：+ [-1, -2, -3] —— 这个信号与"计数 vs 参数"无关，一律报
  const tailRe = /\+\s*\[([^\]]*)\]/g
  let tm
  while ((tm = tailRe.exec(iter)) !== null) {
    const vals = tm[1].split(',').map((s) => s.trim()).filter(Boolean)
    if (vals.length > 0) out.tail.push({ values: vals, expr: tm[0].trim() })
  }

  if (out.tail.length === 0) {
    const wholeList = iter.match(/^\[([^\]]*)\]$/)
    if (wholeList) {
      const vals = wholeList[1].split(',').map((s) => s.trim()).filter(Boolean)
      // 只有"取值不像连续小整数"的列表才算参数域：[-1,-2,-3] 是，[0,1] 是位枚举不是
      const numeric = vals.map((v) => Number(v.replace(/[+\s]/g, '')))
      const allInt = numeric.every((n) => Number.isInteger(n) && Math.abs(n) <= CONST_OK)
      const looksLikeBits = allInt && vals.length <= 4 && numeric.every((n) => n === 0 || n === 1)
      if (vals.length > 0 && !looksLikeBits) out.tail.push({ values: vals, expr: iter })
    }
  }

  return out
}

/** 收集文件级的常量赋值、函数参数、循环变量，供作用域粗判。 */
function collectScope(code) {
  const consts = new Set()
  const params = new Set()
  const loopVars = new Set()
  for (const line of code.split(/\r?\n/)) {
    let m
    if ((m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*-?\d+\s*(?:#.*)?$/))) consts.add(m[1])
    if ((m = line.match(/^\s*def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/))) {
      for (const p of m[1].split(',')) {
        const name = p.split('=')[0].trim()
        if (VARISH.test(name)) params.add(name)
      }
    }
    if ((m = line.match(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+/))) loopVars.add(m[1])
  }
  return { consts, params, loopVars }
}

/** 把源码里所有 for 循环扫一遍，只保留"有内层参数意味"的。 */
function scanInnerDomains(code) {
  const finds = []
  const ctx = collectScope(code)
  const lines = code.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseForLine(lines[i])
    if (!parsed) continue
    const a = analyzeIterable(parsed.iter, parsed.varName, ctx)
    if (a.bounded.length === 0 && a.tail.length === 0) continue
    finds.push({
      varName: parsed.varName,
      iter: parsed.iter,
      line: i + 1,
      bounded: a.bounded,
      tail: a.tail,
      source: lines[i].trim(),
    })
  }
  return finds
}

/** 解释里有没有真的提到这个变量（作为独立标识符）。 */
function mentions(text, name) {
  if (!text) return false
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`)
  return re.test(text)
}

function judgeRecord(rec) {
  const epi = rec.epi || {}
  if (epi.evidence !== 'exhaustive') return null
  if (!rec.script || !fs.existsSync(rec.script)) return null
  const code = fs.readFileSync(rec.script, 'utf8')
  const finds = scanInnerDomains(code)
  if (finds.length === 0) return null

  const why = String(epi.why_complete || '')
  const out = []
  for (const f of finds) {
    const issues = []
    if (f.bounded.length > 0) {
      const uppers = f.bounded.map((b) => b.upper).join(', ')
      issues.push({
        kind: 'bounded_by_param',
        detail: `循环 \`${f.varName}\` 的上界来自 \`${uppers}\`（不是常数）`,
        why: '必须说明为什么这个上界已含全部情形（例如"模 2^k 下 m ≥ k 时条件稳定"）',
      })
    }
    if (f.tail.length > 0) {
      const vals = f.tail.map((t) => t.values.join(',')).join(' | ')
      issues.push({
        kind: 'hardcoded_tail',
        detail: `循环 \`${f.varName}\` 拼了一段硬编码取值 \`${vals}\``,
        why: '硬编码尾巴是"多取几个保险"，不是论证。必须说明为什么到这里就够',
      })
    }
    const explained = mentions(why, f.varName)
    out.push({
      var: f.varName,
      line: f.line,
      source: f.source,
      iter: f.iter,
      issues,
      explained_in_why_complete: explained,
      verdict: issues.length === 0 ? 'ok' : explained ? 'warn' : 'fail',
    })
  }
  return out
}

/** 对一份台账做内层论域审计，返回 { results, fails, warns }。供 run-audit 复用。 */
export function auditInnerDomains(dir) {
  const ledger = path.join(dir, '.claim-verify', 'claims.jsonl')
  if (!fs.existsSync(ledger)) return { results: [], fails: [], warns: [], missing: true }
  const recs = fs.readFileSync(ledger, 'utf8')
    .split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))

  // 每条 id 只看最新一条（与 run-audit 的口径一致，避免重判留痕被算成两次违规）
  const latest = new Map()
  for (const r of recs) latest.set(r.id, r)

  const results = []
  for (const r of latest.values()) {
    const j = judgeRecord(r)
    if (j) results.push({ id: r.id, hash: r.hash, inner: j })
  }
  const fails = results.filter((r) => r.inner.some((x) => x.verdict === 'fail')).map((r) => r.id)
  const warns = results.filter((r) => r.inner.some((x) => x.verdict === 'warn')).map((r) => r.id)
  return { results, fails, warns, missing: false }
}

function main() {
  const argv = process.argv.slice(2)
  const dirIdx = argv.indexOf('--dir')
  const asJson = argv.includes('--json')
  if (dirIdx === -1) {
    console.error('用法: node tools/domain-audit.mjs --dir <run 目录> [--json]')
    process.exit(2)
  }
  const dir = argv[dirIdx + 1]
  const { results, fails, warns, missing } = auditInnerDomains(dir)
  if (missing) {
    console.error(`台账不存在: ${path.join(dir, '.claim-verify', 'claims.jsonl')}`)
    process.exit(2)
  }

  if (asJson) {
    console.log(JSON.stringify({ dir, results, fails, warns }, null, 2))
    process.exit(fails.length > 0 ? 1 : 0)
  }

  console.log('内层论域审计（N-25）  对象：exhaustive 判据里的循环取值集合')
  console.log('口径：只查"这个有限取值集合凭什么就是全部"，不查取值集合里的计算对不对')
  console.log('')
  if (results.length === 0) {
    console.log('  未发现带内层参数域的 exhaustive 判据。')
  }
  for (const r of results) {
    for (const x of r.inner) {
      const mark = x.verdict === 'fail' ? 'FAIL' : x.verdict === 'warn' ? 'WARN' : ' ok '
      console.log(`  [${mark}] ${r.id}  ${x.var}  (第 ${x.line} 行)`)
      console.log(`         ${x.source}`)
      for (const i of x.issues) {
        console.log(`         · ${i.detail}`)
        console.log(`           ${i.why}`)
      }
      if (x.issues.length > 0) {
        if (!x.explained_in_why_complete) {
          console.log(`         · why_complete 里没有提到 \`${x.var}\` —— 连取值集合都没交代`)
        } else {
          console.log(`         · why_complete 提到了 \`${x.var}\`；但要分辨它是「复述了取值列表」`)
          console.log(`           还是「论证了这个列表闭合」。前者是最常见的假交代（team6 就是这样）。`)
        }
      }
    }
  }
  console.log('')
  console.log(`  FAIL ${fails.length} 条，WARN ${warns.length} 条。`)
  console.log('  注：澄清一句在 why_complete 里就能消掉 FAIL——本工具查的是"有没有交代"，')
  console.log('      不查交代得对不对。后者要人看，或按 mdomain-sensitivity 那样逐格删了试。')
  process.exit(fails.length > 0 ? 1 : 0)
}

// 只有被直接运行时才执行 CLI；被 run-audit.mjs import 时只取 auditInnerDomains。
const invokedDirectly = process.argv[1]
  && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/').replace(/^\//, '')}`
if (invokedDirectly) main()
