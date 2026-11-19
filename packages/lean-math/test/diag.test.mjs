/**
 * diag.test.mjs —— 验证失败分类器（diagnose）的正则真的匹配真实 Lean 报错。
 *
 * 这些字符串取自 Lean 4 的真实输出形态。为什么要有这个测试：
 * 分类器判错的代价不是崩溃，而是**给错下一步**——模型会照着错的 hint
 * 绕更远的路。所以每条 pattern 至少要有正例和一条必须不匹配的负例。
 *
 * 运行：node test/diag.test.mjs
 */

import { readFileSync } from 'node:fs'

// 分类器住在 index.js 的闭包里，无法直接 import。这里从源码提取
// FAILURE_PATTERNS 字面量并重建，保证测的是真代码而不是副本。
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const block = src.slice(src.indexOf('const FAILURE_PATTERNS = ['), src.indexOf('function diagnose'))
const patterns = [...block.matchAll(/code: '([a-z_]+)',\s*test: \/(.+?)\/([im]*),/g)].map((m) => ({
  code: m[1],
  test: new RegExp(m[2], m[3])
}))

const CASES = [
  // [期望的 code, Lean 真实报错文本]
  ['unknown_ident', "error: unknown identifier 'Nat.adc'"],
  ['unknown_ident', "error: unknown constant 'Foo.bar'"],
  ['type_mismatch', 'error: type mismatch\n  ℝ\n  ℕ'],
  ['type_mismatch', 'error: application type mismatch\n  f x'],
  ['unsolved_goals', 'error: unsolved goals\ncase succ\nn : Nat\n⊢ n + 1 = 1 + n'],
  ['sorry_left', "warning: declaration uses 'sorry'"],
  ['synth_instance', 'error: failed to synthesize instance\n  OfNat ℝ 1'],
  ['syntax', 'error: unexpected token \'=\'; expected term'],
  ['ambiguous', 'error: ambiguous, multiple interpretations'],
  // 反例：一条正常诊断不应被归入任何失败码
  [null, 'warning: declaration uses deprecated syntax']
]

let failed = 0
for (const [want, text] of CASES) {
  const hit = patterns.find((p) => p.test.test(text))
  const got = hit ? hit.code : null
  const ok = got === want
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} 期望 ${String(want).padEnd(15)} 实得 ${String(got).padEnd(15)} ${JSON.stringify(text.slice(0, 44))}`)
}

console.log(`\n共 ${patterns.length} 条 pattern，${CASES.length} 个用例，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
