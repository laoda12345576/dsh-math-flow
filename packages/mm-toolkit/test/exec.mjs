/**
 * Execution test for viz_python / viz_matlab source builders.
 *
 * The point of this file: before the rewrite, `ok` meant "a PNG appeared", so a
 * pure numeric run — the single most common thing an agent does — came back as
 * `ok: false, image: null` and the model read that as failure. These cases pin
 * the new contract:
 *
 *   1. compute only       → exit 0, stdout carries the answer, no image, ok true
 *   2. compute + plot     → exit 0, image written, ok true
 *   3. raising code       → exit != 0, ok false, traceback in stderr
 *
 * Run: node D:\tools\dsh-plugin-mm-toolkit\test\exec.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { matlabSource, pythonSource } from '../lib/source.js'
import * as plugin from '../lib/index.js'

// Override with MM_PYTHON when the interpreter on PATH has no matplotlib.
const PY = process.env.MM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const TMP = path.join(os.tmpdir(), 'mm-exec-smoke')

async function main() {
  await fsp.rm(TMP, { recursive: true, force: true })
  await fsp.mkdir(TMP, { recursive: true })

  // ---------------------------------------------------------- source sanity
  const ml = matlabSource('D:\\x\\y.png', 'disp(1)')
  const badLines = ml.split('\n').filter((l) => l.trimStart().startsWith('#'))
  assert.deepEqual(badLines, [], `MATLAB 源里混入了 # 注释行：${badLines.join(' | ')}`)
  assert.match(ml, /out = 'D:\\x\\y\.png';/, 'out 变量没写对')
  assert.match(matlabSource("C:\\a'b.png", ''), /out = 'C:\\a''b\.png';/, '单引号路径未转义')

  const py = pythonSource('D:\\x\\y.png', 'print(1)')
  assert.match(py, /^OUT = "D:\\\\x\\\\y\.png"$/m, 'OUT 未用 JSON 字面量写入')
  assert.match(py, /^plt = None$/m, 'matplotlib 失败时 plt 应有兜底值')

  // ------------------------------------------------------- live tool calls
  const tools = new Map()
  const ctx = { tools: { register: (t) => tools.set(t.name, t) } }
  await plugin.apply(ctx, { workspace: TMP, scriptsDir: TMP, pythonExe: PY })
  assert.ok(tools.has('viz_python'), 'viz_python 未注册')
  assert.ok(tools.has('viz_matlab'), 'viz_matlab 未注册')

  const runPy = tools.get('viz_python').execute

  const calc = await runPy({ code: 'print(int(np.arange(5).sum()))', name: 'calc', cwd: TMP })
  assert.equal(calc.exit_code, 0, `纯计算应退出 0，实际 ${calc.exit_code}\n${calc.stderr}`)
  assert.equal(calc.ok, true, '纯计算 ok 应为 true')
  assert.equal(calc.image, null, '纯计算不该凭空造图')
  assert.equal(calc.has_figure, false)
  assert.match(calc.stdout, /\b10\b/, `stdout 没带回结果：${JSON.stringify(calc.stdout)}`)
  assert.equal(calc.cwd, TMP, 'cwd 没生效')

  const plot = await runPy({ code: 'plt.plot([1,2,3],[1,4,9])\nprint("plotted")', name: 'plot', cwd: TMP })
  assert.equal(plot.ok, true)
  assert.equal(plot.has_figure, true, '画了图却没导出')
  assert.match(plot.stdout, /VIZ_SAVED:/, '缺少 VIZ_SAVED 标记')

  const boom = await runPy({ code: 'raise ValueError("boom")', name: 'boom', cwd: TMP })
  assert.equal(boom.ok, false, '抛异常时 ok 应为 false')
  assert.notEqual(boom.exit_code, 0, '抛异常时退出码应非零')
  assert.match(boom.stderr, /ValueError: boom/, `stderr 应含 traceback：${boom.stderr}`)

  const long = await runPy({ code: 'print("A"*12000); print("TAIL_MARK")', name: 'long', cwd: TMP })
  assert.match(long.stdout, /中间省略/, '超长输出应掐中间')
  assert.match(long.stdout, /TAIL_MARK/, '掐中间时必须保留尾部')

  console.log('python  : 纯计算 ok / 画图 ok / 异常 ok / 长输出裁剪 ok')
  console.log('matlab  : 源文件无非法注释、路径转义 ok')

  // MATLAB 真的要跑一次吗？启动 20-40s，且 R2024a 可能不在默认路径。
  if (process.argv.includes('--matlab')) {
    const mlTool = tools.get('viz_matlab').execute
    const mlRun = await mlTool({ code: 'fprintf("SUM=%d\\n", 1+2+3);', name: 'mlcalc', cwd: TMP })
    assert.equal(mlRun.ok, true, `MATLAB 纯计算失败：${mlRun.stderr}`)
    assert.match(mlRun.stdout, /SUM=6/, `MATLAB stdout 没带回结果：${mlRun.stdout}`)
  console.log('matlab  : 纯计算实跑 ok')
  }

  // MATLAB 退出后还会短暂占着 cwd 句柄，清理失败不算测试失败。
  try { await fsp.rm(TMP, { recursive: true, force: true }) } catch { /* EBUSY on Windows */ }
}

main().then(
  () => console.log('\nall exec checks passed'),
  (e) => {
    console.error('\nFAILED:', e.message)
    process.exit(1)
  },
)
