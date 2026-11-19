/**
 * dsh-plugin-mm-toolkit — a persistent math-modelling toolkit for DSH.
 *
 * Six capability groups, all previously built as throwaway dynamic plugins and now
 * mounted as one durable profile row so they survive a DSH restart:
 *
 *   viz_*      plotting through Anaconda Python / MATLAB / LaTeX-TikZ
 *   viz_see    "reading" an image by driving the local Doubao desktop client
 *   viz_gen    image generation through nanobanana.com
 *   browser*   a stateful Playwright-driven Chrome daemon
 *   cnki       CNKI (知网研学) literature search
 *   think      Socratic multi-session deliberation over DeepSeek's web client
 *
 * Two structural wins from living in a profile plugin rather than the dynamic
 * sandbox: `node:child_process` is available, so every external program is invoked
 * as an argv ARRAY (no shell, no quote escaping, no PowerShell string mangling);
 * and `node:net` lets the tools talk to the automation daemon directly instead of
 * shelling out to a CLI client.
 *
 * @module dsh-plugin-mm-toolkit
 */

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { resolveDefineTool } from './toolkit.js'
import { registerAutomation } from './automation.js'
import { pythonSource, matlabSource } from './source.js'

/** Plugin name shown in the harness inventory. */
export const name = 'mm-toolkit'

/** Hard dependency: the tool registry. */
export const inject = ['tools']

/**
 * Defaults; every key can be restated by the profile's cordis.patch.yml row.
 *
 * Empty means "resolve at runtime": an empty `workspace` falls back to a temp
 * directory, an empty interpreter falls back to `python`/`python3` on PATH, and
 * empty `scriptsDir` means the helper bridges are absent. Nothing here points at
 * the author's machine, and no credential is stored in the repository — the CNKI
 * login is read from MM_CNKI_USER / MM_CNKI_PASS if the profile does not set it.
 */
const DEFAULTS = {
  workspace: '',
  pythonExe: '',
  matlabExe: '',
  xelatexExe: null,
  scriptsDir: '',
  doubaoExe: '',
  daemonPort: 8731,
  daemonTitle: 'mm-toolkit browserd',
  cnkiUser: '',
  cnkiPass: '',
}

/** Timestamp helper for auto-generated file names. */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Sanitise a caller-supplied base name. */
function safeName(value, fallback) {
  const v = String(value ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.]+/, '').slice(0, 60)
  return v || fallback
}

/** Keep only the tail of long tool output. */
function tail(text, n) {
  const s = String(text ?? '')
  return s.length > n ? s.slice(s.length - n) : s
}

/**
 * Keep BOTH ends of a long output.
 *
 * A pure tail() loses the header (tracebacks start there, and so do the
 * shape/dtype lines numpy prints first); a pure head() loses the final answer,
 * which for a numeric run is the only line that matters. Neither end is
 * droppable, so the middle goes instead.
 * @param {string} text - raw stream.
 * @param {number} [headN] - bytes kept from the start.
 * @param {number} [tailN] - bytes kept from the end.
 * @returns {string} clipped text.
 */
function clip(text, headN = 4000, tailN = 4000) {
  const s = String(text ?? '')
  if (s.length <= headN + tailN) return s
  const dropped = s.length - headN - tailN
  return `${s.slice(0, headN)}\n\n... [中间省略 ${dropped} 字符；需要全部输出就写文件再 read] ...\n\n${s.slice(s.length - tailN)}`
}

/** Clamp a caller-supplied timeout into a sane window. */
function clampTimeout(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.max(Math.round(n), 1000), max)
}

/** True when UTF-8 decoding produced replacement chars (usually a GBK stream). */
function looksGarbled(s) {
  return String(s ?? '').includes('\uFFFD')
}

/**
 * Run an external program.
 *
 * argv is an ARRAY, so nothing is ever re-parsed by a shell: a Windows path with
 * spaces, a URL with '&', or a Chinese argument with quotes all arrive intact.
 * @param {string} exe - absolute executable path.
 * @param {string[]} args - argument vector.
 * @param {{cwd?: string, timeoutMs?: number, env?: Record<string,string>}} [opts] - options.
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>} the outcome.
 */
function run(exe, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      exe,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 180000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err === null ? 0 : (typeof err.code === 'number' ? err.code : 1),
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: Boolean(err && err.killed),
        })
      },
    )
  })
}

/**
 * Talk to the automation daemon over its loopback TCP line protocol.
 * @param {number} port - daemon port.
 * @param {object} request - one JSON command.
 * @param {number} [timeoutMs] - socket timeout.
 * @returns {Promise<object>} the daemon's reply.
 */
function daemon(port, request, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let buf = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already closed */ }
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        try { finish(JSON.parse(buf.slice(0, nl))) } catch { finish({ ok: false, error: 'daemon reply was not JSON' }) }
      }
    })
    socket.on('timeout', () => finish({ ok: false, error: `daemon timed out after ${timeoutMs}ms` }))
    socket.on('error', (e) => finish({ ok: false, error: `daemon unreachable: ${e.message}`, notRunning: true }))
  })
}

/** Read a PNG/JPEG as a data URL (used when no HTTP route is mounted). */
async function dataUrl(file) {
  const buf = await fsp.readFile(file)
  const ext = path.extname(file).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.pdf' ? 'application/pdf' : 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** Plain-text content block renderer. */
const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }

  // Normalise once, here, so no tool body has to wonder whether a path is real.
  cfg.workspace = String(cfg.workspace ?? '').trim()
    ? path.resolve(cfg.workspace)
    : path.join(os.tmpdir(), 'mm-toolkit')
  cfg.cnkiUser = String(cfg.cnkiUser ?? '').trim() || process.env.MM_CNKI_USER || ''
  cfg.cnkiPass = String(cfg.cnkiPass ?? '').trim() || process.env.MM_CNKI_PASS || ''

  const { defineTool } = await resolveDefineTool()

  const OUT = path.join(cfg.workspace, 'viz_out')
  const SCRIPTS = path.join(OUT, 'scripts')
  const BOUT = path.join(cfg.workspace, 'browse_out')
  const TOOLS = cfg.scriptsDir
  const PY = String(cfg.pythonExe ?? '').trim() || (process.platform === 'win32' ? 'python' : 'python3')

  /** Resolve xelatex once, tolerating the fact that PATH was captured at boot. */
  let xelatexPromise = null
  function xelatex() {
    if (xelatexPromise === null) {
      xelatexPromise = (async () => {
        if (cfg.xelatexExe) return cfg.xelatexExe
        const guess = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64', 'xelatex.exe')
        try { await fsp.access(guess); return guess } catch { /* fall through */ }
        const r = await run('where', ['xelatex'])
        const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
        return first ?? null
      })()
    }
    return xelatexPromise
  }

  async function ensureDirs() {
    await fsp.mkdir(SCRIPTS, { recursive: true })
    await fsp.mkdir(BOUT, { recursive: true })
  }

  /** Remembered image metadata so kind/script survive within one process. */
  const meta = []

  /**
   * Build the Python preamble — see lib/source.js for the actual template.
   * Kept as a thin alias so the tool bodies below stay readable.
   */
  const pySource = pythonSource

  /** Build the MATLAB script — see lib/source.js. */
  const mlSource = matlabSource

  async function statOr(file) {
    try { return await fsp.stat(file) } catch { return null }
  }

  /**
   * The Doubao / nano-banana / browserd bridges are Python helpers that live in
   * `scriptsDir`, which is NOT part of this package. Return a sentence the reader
   * can act on instead of letting spawn fail with ENOENT on a path they never
   * chose -- "python: can't open file" is the error that makes people think the
   * plugin is broken rather than incomplete.
   */
  async function requireBridge(script, feature) {
    const dir = String(TOOLS ?? '').trim()
    if (!dir) {
      return {
        ok: false,
        error: `${feature} 依赖外部桥脚本 ${script}，但 scriptsDir 未配置。详见 packages/mm-toolkit/README.md「外部桥脚本」一节。`,
        missing: script,
      }
    }
    const full = path.join(dir, script)
    if ((await statOr(full)) === null) {
      return { ok: false, error: `${feature} 的桥脚本不存在：${full}`, missing: script, scriptsDir: dir }
    }
    return null
  }

  /**
   * Resolve the directory a script should RUN in.
   *
   * Scripts themselves always live in SCRIPTS (one place to find them later),
   * but the working directory has to be the caller's experiment folder: relative
   * paths in the code — `open('hits.txt','w')`, `np.load('data.npy')` — are
   * resolved against cwd. Getting this wrong writes output into the wrong
   * project, which is the kind of bug that only shows up a week later.
   * @param {string} [requested] - caller-supplied absolute or relative path.
   * @returns {Promise<string>} an existing directory; never throws.
   */
  async function resolveCwd(requested) {
    const want = requested ? path.resolve(String(requested)) : cfg.workspace
    try { await fsp.mkdir(want, { recursive: true }) } catch { /* read-only or invalid */ }
    const st = await statOr(want)
    if (st && st.isDirectory()) return want
    const fallback = await statOr(cfg.workspace)
    return fallback && fallback.isDirectory() ? cfg.workspace : process.cwd()
  }

  // ------------------------------------------------------------------ viz tools

  ctx.tools.register(defineTool({
    name: 'viz_doctor',
    description: '检查绘图与视觉工具链：Anaconda Python + matplotlib、MATLAB、LaTeX/xelatex、豆包视觉桥、浏览器守护进程。出图失败时先跑它。',
    parameters: {},
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 300000,
    async execute() {
      await ensureDirs()
      const [py, xl, doubao] = await Promise.all([
        run(PY, ['-c', 'import sys, matplotlib; print(sys.version.split()[0], matplotlib.__version__)'], { timeoutMs: 60000 }),
        xelatex(),
        statOr(path.join(TOOLS, 'doubao_bridge.py')),
      ])
      const pv = py.stdout.trim().split(/\s+/)
      const ml = await statOr(cfg.matlabExe)
      const ping = await daemon(cfg.daemonPort, { cmd: 'ping' }, 8000)
      return {
        workspace: cfg.workspace,
        python: { ok: py.code === 0, exe: PY, version: pv[0] ?? '', matplotlib: pv[1] ?? '', stderr: tail(py.stderr, 300) },
        matlab: { ok: ml !== null, exe: cfg.matlabExe },
        latex: { ok: xl !== null, xelatex: xl, hint: xl === null ? '未找到 xelatex；装 MiKTeX 后重启 DSH' : '' },
        doubao: { ok: doubao !== null, bridge: path.join(TOOLS, 'doubao_bridge.py') },
        browser: { ok: ping.ok === true, port: cfg.daemonPort, url: ping.url ?? null },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'viz_python',
    description: [
      '执行一段 Python 代码，返回 stdout / stderr / 退出码。本机数值实验的默认执行器（Anaconda + numpy / scipy）。',
      '纯计算不需要画图：直接 print 结果，结果就在返回值的 stdout 里。有 figure 时会自动存成 PNG 并返回 image 名（可用 viz_see 解读），没有图也照样算成功。',
      '预置变量：np（numpy）、plt（matplotlib.pyplot，Agg 后端、中文字体已配）、OUT（图片输出绝对路径）。',
      `cwd 默认 ${cfg.workspace}，做实验时建议显式指定到实验目录，脚本会写进 viz_out/scripts。`,
      '输出超过 8000 字符会掐掉中间、保留头尾，所以只 print 统计量与关键行，不要逐条打印。',
    ].join(''),
    parameters: {
      code: { type: 'string', required: true, description: 'Python 代码；纯计算就 print，画图则用 plt' },
      name: { type: 'string', description: '脚本/图片文件名（不含扩展名）' },
      cwd: { type: 'string', description: '工作目录，默认插件配置里的 workspace' },
      timeout_ms: { type: 'number', description: '超时毫秒，默认 300000，上限 600000' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 660000,
    async execute(args) {
      await ensureDirs()
      const base = safeName(args.name, `py_${stamp()}`)
      const script = path.join(SCRIPTS, `${base}.py`)
      const image = path.join(OUT, `${base}.png`)
      const cwd = await resolveCwd(args.cwd)
      const budget = clampTimeout(args.timeout_ms, 300000, 600000)
      await fsp.writeFile(script, pySource(image, args.code), 'utf8')
      const started = Date.now()
      const r = await run(PY, [script], { cwd, timeoutMs: budget })
      const info = await statOr(image)
      if (info) meta.unshift({ name: `${base}.png`, path: image, kind: 'python', script })
      return {
        ok: r.code === 0 && r.timedOut === false,
        exit_code: r.code,
        timed_out: r.timedOut,
        elapsed_s: Number(((Date.now() - started) / 1000).toFixed(2)),
        stdout: clip(r.stdout),
        stderr: clip(r.stderr),
        image: info ? `${base}.png` : null,
        has_figure: info !== null,
        script,
        cwd,
        hint: r.timedOut
          ? `超时（${budget}ms）被杀：缩小规模、加停止条件，或调大 timeout_ms`
          : r.code !== 0
            ? '非零退出：看 stderr 顶部的 traceback'
            : info
              ? `${base}.png 已生成`
              : '纯计算，未产生图片（正常）',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'viz_matlab',
    description: [
      '执行一段 MATLAB 代码（R2024a 批处理模式，启动约 20-40s），返回 stdout / stderr / 退出码。',
      '纯计算直接 fprintf 或 disp 结果；有 figure 时自动导出 PNG 并返回 image 名，没有图也算成功。',
      '预置变量：out（图片输出绝对路径），白底、中文字体已设。',
      `cwd 默认 ${cfg.workspace}，可用 cwd 指定。能用 Python 就别用这个：启动开销大。`,
    ].join(''),
    parameters: {
      code: { type: 'string', required: true, description: 'MATLAB 代码；算完用 fprintf/disp 输出结果' },
      name: { type: 'string', description: '文件名（仅字母数字下划线）' },
      cwd: { type: 'string', description: '工作目录，默认插件配置里的 workspace' },
      timeout_ms: { type: 'number', description: '超时毫秒，默认 600000，上限 900000' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 960000,
    async execute(args) {
      if (!String(cfg.matlabExe ?? '').trim()) {
        return {
          ok: false,
          error: '未配置 matlabExe。本工具需要一个本机 MATLAB 可执行文件；请在 profile 的 cordis.patch.yml 里设置 matlabExe，或改用 viz_python。',
          config: { matlabExe: cfg.matlabExe },
        }
      }
      await ensureDirs()
      let base = safeName(args.name, `ml_${stamp()}`).replace(/[^A-Za-z0-9_]/g, '_')
      if (!/^[A-Za-z]/.test(base)) base = `m_${base}`
      const script = path.join(SCRIPTS, `${base}.m`)
      const image = path.join(OUT, `${base}.png`)
      const cwd = await resolveCwd(args.cwd)
      const budget = clampTimeout(args.timeout_ms, 600000, 900000)
      await fsp.writeFile(script, mlSource(image, args.code), 'utf8')
      const started = Date.now()
      // -sd sets the working directory, so relative paths in the caller's code
      // land where the caller expects; the script itself lives in SCRIPTS and is
      // reached via addpath instead of by changing directory.
      const mlPath = SCRIPTS.replace(/'/g, "''")
      const r = await run(
        cfg.matlabExe,
        ['-nosplash', '-sd', cwd, '-batch', `addpath('${mlPath}'); ${base}`],
        { cwd, timeoutMs: budget },
      )
      const info = await statOr(image)
      if (info) meta.unshift({ name: `${base}.png`, path: image, kind: 'matlab', script })
      const garbled = looksGarbled(r.stdout) || looksGarbled(r.stderr)
      return {
        ok: r.code === 0 && r.timedOut === false,
        exit_code: r.code,
        timed_out: r.timedOut,
        elapsed_s: Number(((Date.now() - started) / 1000).toFixed(2)),
        stdout: clip(r.stdout),
        stderr: clip(r.stderr),
        image: info ? `${base}.png` : null,
        has_figure: info !== null,
        script,
        cwd,
        encoding_note: garbled ? '输出可能含非 UTF-8 字符导致乱码：改用英文标签，或把结果写进文件再 read' : null,
        hint: r.timedOut
          ? `超时（${budget}ms）被杀`
          : r.code !== 0
            ? '非零退出：看 stderr'
            : info
              ? `${base}.png 已导出`
              : '纯计算，未产生图片（正常）',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'viz_tex',
    description: '用 LaTeX/TikZ 画矢量图（论文级），编译为 PDF 并转出 PNG 预览。支持 ctex 中文，已开 MiKTeX 自动补装宏包，编译两遍收敛。适合流程图、框图、几何示意图。',
    parameters: {
      code: { type: 'string', required: true, description: 'TikZ 代码；给完整文档或只给绘图部分（会自动套 ctex+pgfplots 模板）' },
      name: { type: 'string', description: '文件名（不含扩展名）' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 900000,
    async execute(args) {
      await ensureDirs()
      const xl = await xelatex()
      if (xl === null) return { ok: false, error: '未找到 xelatex，请安装 MiKTeX 后重启 DSH' }
      const base = safeName(args.name, `tex_${stamp()}`)
      const tex = path.join(SCRIPTS, `${base}.tex`)
      const pdf = path.join(OUT, `${base}.pdf`)
      const png = path.join(OUT, `${base}.png`)
      let src = String(args.code ?? '')
      if (!src.includes('\\documentclass')) {
        src = [
          '\\documentclass[tikz,border=6pt]{standalone}',
          '\\usepackage{ctex}',
          '\\usepackage{amsmath,amssymb}',
          '\\usepackage{pgfplots}',
          '\\pgfplotsset{compat=1.18}',
          '\\usetikzlibrary{arrows.meta,positioning,shapes.geometric,calc,fit,backgrounds}',
          '\\begin{document}',
          src,
          '\\end{document}',
        ].join('\n')
      }
      await fsp.writeFile(tex, src, 'utf8')
      const args2 = ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', OUT, tex]
      const r1 = await run(xl, args2, { cwd: SCRIPTS, timeoutMs: 600000 })
      const r2 = await run(xl, args2, { cwd: SCRIPTS, timeoutMs: 600000 })
      if (await statOr(pdf)) {
        meta.unshift({ name: `${base}.pdf`, path: pdf, kind: 'latex', script: tex })
        // The PDF is the real output. The PNG is a convenience that needs an
        // external helper; when it is absent say so, do not report a spawn error
        // about a file the reader never mentioned.
        const noConv = await requireBridge('pdf2png.py', 'viz_tex 的 PNG 预览')
        if (noConv) {
          return { ok: true, pdf: `${base}.pdf`, image: null, preview_skipped: noConv.error }
        }
        const conv = await run(PY, [path.join(TOOLS, 'pdf2png.py'), pdf, png, '200'], { timeoutMs: 120000 })
        const gotPng = await statOr(png)
        if (gotPng) meta.unshift({ name: `${base}.png`, path: png, kind: 'latex', script: tex })
        return { ok: true, pdf: `${base}.pdf`, image: gotPng ? `${base}.png` : null, convert_error: gotPng ? null : tail(conv.stderr, 400) }
      }
      return { ok: false, error: 'xelatex 未产出 PDF', stdout: tail(r1.stdout + r2.stdout, 3000), stderr: tail(r1.stderr + r2.stderr, 2000) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'viz_see',
    description: '让本机的豆包客户端“看图”：把图片自动发给豆包并取回中文解读。模型本身没有强多模态能力，用这个工具理解图片内容（图表类型、坐标轴、趋势、是否中文乱码、布局遮挡、网页截图等）。务必给 image 一个绝对路径或 viz_* 返回的图片名。',
    parameters: {
      image: { type: 'string', required: true, description: '图片绝对路径或 viz_* 返回的文件名' },
      question: { type: 'string', description: '要问豆包的问题；省略则让它详细描述' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 600000,
    async execute(args) {
      await ensureDirs()
      let file = String(args.image)
      if (!path.isAbsolute(file)) {
        const mem = meta.find((m) => m.name === file)
        file = mem ? mem.path : path.join(OUT, file)
      }
      // Both can be wrong at once. Report the argument error first (it is the one
      // the caller can fix immediately) and carry the configuration problem
      // alongside it, so a missing bridge does not stay hidden behind a bad path.
      const miss = await requireBridge('doubao_bridge.py', 'viz_see')
      if ((await statOr(file)) === null) {
        return { ok: false, error: `找不到图片: ${file}`, ...(miss ? { blocked_by: miss.error } : {}) }
      }
      if (miss) return miss
      const qf = path.join(OUT, '_question.txt')
      await fsp.writeFile(qf, args.question ?? '请详细描述这张图：图表类型、坐标轴含义、数据趋势与关键结论，用中文回答。', 'utf8')
      const r = await run(PY, [path.join(TOOLS, 'doubao_bridge.py'), '--image', file, '--question-file', qf, '--json', '--timeout', '240'], { timeoutMs: 480000 })
      const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      let parsed = null
      try { parsed = JSON.parse(line) } catch { parsed = null }
      if (parsed === null) return { ok: false, error: '豆包桥返回无法解析', raw: tail(r.stdout, 1200), stderr: tail(r.stderr, 600) }
      return { ok: parsed.ok === true, reply: parsed.reply ?? '', blank: parsed.blank ?? false, image_attached: parsed.image_attached ?? null, seconds: parsed.seconds ?? null, error: parsed.error ?? null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'viz_gen',
    description: '用 nano banana（nanobanana.com）生成位图并保存到本地。需先在浏览器里登录 nanobanana.com。适合示意图/氛围图，不适合精确数据图。',
    parameters: {
      prompt: { type: 'string', required: true, description: '图片描述' },
      name: { type: 'string', description: '保存文件名（不含扩展名）' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    timeoutMs: 900000,
    async execute(args) {
      await ensureDirs()
      const base = safeName(args.name, `nb_${stamp()}`)
      const image = path.join(OUT, `${base}.png`)
      const miss = await requireBridge('nanobanana_bridge.py', 'viz_gen')
      if (miss) return miss
      const pf = path.join(OUT, '_prompt.txt')
      await fsp.writeFile(pf, String(args.prompt ?? ''), 'utf8')
      const r = await run(PY, [path.join(TOOLS, 'nanobanana_bridge.py'), '--generate-file', pf, '--out', image, '--timeout', '300'], { timeoutMs: 600000 })
      const got = await statOr(image)
      let detail = null
      try { detail = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop() ?? 'null') } catch { detail = null }
      if (got) meta.unshift({ name: `${base}.png`, path: image, kind: 'nanobanana' })
      return { ok: got !== null, image: got ? `${base}.png` : null, detail, stderr: tail(r.stderr, 800) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'viz_list',
    description: '列出 viz_out 目录里已有的所有图片/PDF（以磁盘为准，含以前生成的），返回文件名、大小与绝对路径。',
    parameters: {},
    output: { schema: { type: 'json' }, render: jsonRender },
    async execute() {
      await ensureDirs()
      const names = await fsp.readdir(OUT)
      const rows = []
      for (const n of names) {
        if (!/\.(png|jpe?g|pdf)$/i.test(n)) continue
        const st = await statOr(path.join(OUT, n))
        if (st) rows.push({ name: n, bytes: st.size, path: path.join(OUT, n), kind: (meta.find((m) => m.name === n) || {}).kind ?? 'other' })
      }
      rows.sort((a, b) => b.bytes - a.bytes)
      return { out_dir: OUT, count: rows.length, images: rows }
    },
  }))

  // ------------------------------------------------------- automation groups
  await registerAutomation(ctx, defineTool, cfg)
}
