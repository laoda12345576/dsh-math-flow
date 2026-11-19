// 只读 shell 判定的回归测试。
//
// 起因：实测中 Get-ChildItem 被判成草稿级计算，八次之后连列目录都被拦，
// 模型只好改用 glob/read 绕过。看一眼文件系统不该消耗计算额度。

import assert from 'node:assert/strict'
import { isReadOnlyShell, computeTier, createState } from '../lib/gate.js'

const SHELL = 'pw' + 'sh'
const BASH = 'ba' + 'sh'

const readOnly = [
  [SHELL, { command: 'Get-ChildItem D:\\refs\\*.txt | Select-Object Name, Length' }],
  [SHELL, { command: 'Select-String -Path refs\\*.txt -Pattern "search"' }],
  [SHELL, { command: 'Get-Content notes.md -TotalCount 40' }],
  [BASH, { command: 'ls -la refs && head -20 berry1990.txt' }],
  [BASH, { command: 'grep -n "Kummer" refs/berry1990.txt' }],
]

const notReadOnly = [
  [SHELL, { command: 'python -c "print(sum(range(10**6)))"' }],
  [SHELL, { command: '1..100000 | ForEach-Object { $_ * $_ }' }],
  [SHELL, { command: 'for ($i=0; $i -lt 100000; $i++) { $s += $i }' }],
  [BASH, { command: 'node -e "console.log(1)"' }],
  [BASH, { command: 'while true; do echo x; done' }],
]

for (const [name, args] of readOnly) {
  assert.equal(isReadOnlyShell(name, args), true, `应判为只读：${args.command}`)
}
for (const [name, args] of notReadOnly) {
  assert.equal(isReadOnlyShell(name, args), false, `不该判为只读：${args.command}`)
}

// 非 shell 工具一律不适用。
assert.equal(isReadOnlyShell('viz_python', { code: 'print(1)' }), false)

// ── 验证脚本不算草稿级计算（2026-11-06）────────────────────────────
//
// 实测（team11）：`node tools/terminate-check.mjs` 被吃掉草稿额度，8 次之后
// 连"跑一次收工门"都要跨会话委派，三次都没回报，最后派了三个"跑门"任务把
// 收口率凑成 8/8。病因是配额按工具名算，而它想管的是算力。
//
// 这里的判据是路径 + 时间：tools/ test/ bench/ 下、**且在本轮开工前就存在**的脚本，
// 算验证；内联求值（-e/-c）和开工后才写出来的脚本一律算计算。
{
  const { isVerificationScript } = await import('../lib/gate.js')
  const fs = await import('node:fs')
  const path = await import('node:path')

  // 自己造一个"开工前就在"的脚本，别依赖仓库里某个文件的 mtime。
  const dir = path.join(process.cwd(), 'test', '.tmp-verify')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'check.mjs')
  fs.writeFileSync(script, 'console.log(1)\n')
  const past = new Date(Date.now() - 3600e3)
  fs.utimesSync(script, past, past)
  const rel = path.relative(process.cwd(), script)

  const t0 = Date.now()
  assert.equal(isReadOnlyShell(SHELL, { command: `node ${rel} --dir x` }, t0), true, '开工前存在的判据脚本应放行')
  assert.equal(isReadOnlyShell(SHELL, { command: `node ${rel} --dir x` }, null), true, '不锚时间时也放行')

  // 开工之后冒出来的脚本 = 现写的暴力脚本，必须仍按计算处理。
  const fresh = path.join(dir, 'brute.mjs')
  fs.writeFileSync(fresh, 'for (;;) {}\n')
  assert.equal(
    isReadOnlyShell(SHELL, { command: `node ${path.relative(process.cwd(), fresh)}` }, Date.now() - 60e3),
    false,
    '开工后新建的脚本不该豁免',
  )

  // 内联求值永远是通用计算器。
  assert.equal(isVerificationScript('node -e "1"', null), false)
  assert.equal(isVerificationScript('python -c "print(1)"', null), false)
  // 套在循环里跑判据 = 批量。
  assert.equal(isVerificationScript(`for f in ${rel}; do node $f; done`, null), false)
  // 不在 tools/test/bench 下的脚本不算判据。
  assert.equal(isVerificationScript('node runs/team11/scan.mjs', null), false)

  fs.rmSync(dir, { recursive: true, force: true })
}

// 只读命令不吃草稿额度：额度用尽后仍然放行。
const state = createState('测试问题')
state.scratchCalls = 99
assert.equal(computeTier({ command: 'Get-ChildItem' }, state, {}, SHELL).tier, 'scratch')

console.log('readonly-shell: ok')
