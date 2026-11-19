/**
 * dsh-plugin-lean-math — Lean 4 proof-assistant bridge.
 *
 * Gives the harness agent "hands and eyes" on a real Lean environment:
 *
 *   - `lean_status`         toolchain (elan/lean/lake) + curl availability;
 *   - `lean_search_premise` search Mathlib (LeanSearch / Moogle / premise-search);
 *   - `lean_verify_proof`   check complete code with the Lean kernel (the judge);
 *   - `lean_open_file`      start an interactive proof session;
 *   - `lean_get_goals`      read the current goals + diagnostics (the eyes);
 *   - `lean_run_tactic`     append a tactic and read the new state (the hands);
 *   - `lean_close_session`  end an interactive session.
 *
 * Interactive goal state comes from the Lean CLI itself: an incomplete proof
 * reports `error: unsolved goals` followed by the pretty-printed goal, and a
 * failed tactic reports its message followed by the goal context that survived
 * it. That is a stable, documented surface — unlike the Lean LSP goal channel,
 * which in Lean 4.33 is served only over the version-specific `$/lean/rpc`
 * protocol (the server advertises `rpcProvider` and no `plainGoal`). A session
 * therefore holds source text, not a language-server process.
 *
 * @module dsh-plugin-lean-math
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveDefineTool } from './toolkit.js'
import { LeanServerPool, pathToUri } from './server.js'

/** Plugin name shown in the harness plugin inventory. */
export const name = 'lean-math'

/** Hard dependency: the tool registry. */
export const inject = ['tools']

/** Fallback budget for one `lean` run. A healthy Mathlib load is ~30-60s; this is
 * several times that, and the budget is now actually enforceable, so a hang costs
 * minutes rather than hours. */
const DEFAULT_TIMEOUT_MS = 240000

/**
 * Fallback budget for one interactive step. Lower than a one-shot verification
 * because a session re-checks the whole script each step, and an unbounded step
 * is what made an early version look hung.
 */
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 300000

/** Fallback timeout for one search request. */
const DEFAULT_SEARCH_TIMEOUT_MS = 30000

/**
 * How long a resident server may sit unreferenced before it is shut down.
 *
 * A Mathlib server pins a multi-GB image in RAM. Keeping it alive across sessions
 * is the whole point (imports load once), but it must not outlive the work by much.
 */
const DEFAULT_SERVER_IDLE_MS = 600000

/** Where the toolchain installer lives, for the help text. */
const INSTALL_HINT =
  'Install elan from https://leanprover-community.github.io/elan/ (Windows: run the elan-init.ps1 script, ' +
  'or `winget install Leanprover.Lean4`), then `lake new mathproj math` to create a Mathlib project. ' +
  'Restart the DSH host afterwards so the updated PATH takes effect.'

/**
 * Lean metaprogram prepended to a `lean_deps` probe file.
 *
 * Walks `Environment.find?` over each declaration's type and value to build the
 * transitive constant graph, then prints one `@@DGRAPH` line per root. Doing this
 * in Lean itself keeps the tool independent of LeanDojo and of the version-pinned
 * `$/lean/rpc` protocol, and needs nothing beyond the toolchain already required.
 */
const DEPS_PRELUDE = `import Lean
open Lean Elab Command

private def _lmConstExprs (ci : ConstantInfo) : Array Expr :=
  match ci with
  | .defnInfo v => #[v.type, v.value]
  | .thmInfo v => #[v.type, v.value]
  | .opaqueInfo v => #[v.type, v.value]
  | .axiomInfo v => #[v.type]
  | .inductInfo v => #[v.type]
  | .ctorInfo v => #[v.type]
  | .recInfo v => #[v.type]
  | .quotInfo v => #[v.type]

private def _lmCollect (env : Environment) (root : Name) : Array Name × Array (Name × Name) := Id.run do
  let mut seen : NameSet := {}
  let mut stack : Array Name := #[root]
  let mut nodes : Array Name := #[]
  let mut edges : Array (Name × Name) := #[]
  while !stack.isEmpty do
    let n := stack.back!
    stack := stack.pop
    if seen.contains n then continue
    seen := seen.insert n
    nodes := nodes.push n
    match env.find? n with
    | none => pure ()
    | some ci =>
      for e in _lmConstExprs ci do
        for c in e.getUsedConstants do
          edges := edges.push (n, c)
          if !seen.contains c then stack := stack.push c
  return (nodes, edges.filter fun p => seen.contains p.2)

elab "#lmDepsGraph " n:ident : command => do
  let env <- getEnv
  let (nodes, edges) := _lmCollect env n.getId
  let modOf (d : Name) : String :=
    match env.getModuleIdxFor? d with
    | some i => (env.header.moduleNames[i]!).toString
    | none => ""
  let nodeJson := nodes.map fun d => Json.arr #[Json.str d.toString, Json.str (modOf d)]
  let edgeJson := edges.map fun p => Json.arr #[Json.str p.1.toString, Json.str p.2.toString]
  IO.println s!"@@DGRAPH\t{n.getId}\t{Json.compress (Json.mkObj [("nodes", Json.arr nodeJson), ("edges", Json.arr edgeJson)])}"
`

/**
 * Register every tool of this plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context.
 * @param {Record<string, unknown>} [config] - the row configuration from the profile patch.
 * @returns {Promise<void>} completion.
 */
export async function apply(ctx, config = {}) {
  const { defineTool } = await resolveDefineTool()

  const subprocess = ctx.get('subprocess')
  const fs = ctx.get('fs')

  const defaultProjectDir =
    typeof config.projectDir === 'string' && config.projectDir !== '' ? config.projectDir : ''
  const defaultTimeoutMs = Number.isInteger(config.defaultTimeoutMs) ? config.defaultTimeoutMs : DEFAULT_TIMEOUT_MS
  const interactiveTimeoutMs = Number.isInteger(config.interactiveTimeoutMs)
    ? config.interactiveTimeoutMs
    : DEFAULT_INTERACTIVE_TIMEOUT_MS
  const searchTimeoutMs = Number.isInteger(config.searchTimeoutMs) ? config.searchTimeoutMs : DEFAULT_SEARCH_TIMEOUT_MS
  const serverIdleMs =
    Number.isInteger(config.serverIdleMs) && config.serverIdleMs >= 0 ? config.serverIdleMs : DEFAULT_SERVER_IDLE_MS

  // ── process / path helpers ────────────────────────────────────────────────

  /** Executable-resolution cache, so a missing tool is probed once. */
  const exeCache = new Map()

  /**
   * Resolve an executable on the provider's PATH.
   * @param {string} bin - bare executable name.
   * @returns {Promise<string|null>} canonical path, or null when absent.
   */
  async function findExe(bin) {
    if (exeCache.has(bin)) return exeCache.get(bin)
    let resolved = null
    if (subprocess !== undefined) {
      try {
        resolved = await subprocess.resolveExecutable(bin)
      } catch {
        resolved = null
      }
    }
    // Fall back to walking PATH ourselves. The provider's resolver is the first
    // choice (it knows about the harness' own PATH handling), but it is not
    // guaranteed to succeed — and when it fails, "Lean not installed" is a lie
    // that blocks every tool even though lean sits right there on PATH.
    if (typeof resolved !== 'string' || resolved === '') resolved = findOnPath(bin)
    exeCache.set(bin, resolved)
    return resolved
  }

  /**
   * Locate an executable on PATH without spawning anything.
   *
   * Spawning a helper like `where.exe` is exactly what fails in some shells
   * (MSYS reports EBUSY for it), so this walks the directories directly.
   * @param {string} bin - bare executable name.
   * @returns {string|null} the absolute path, or null when not found.
   */
  function findOnPath(bin) {
    const directories = String(process.env.PATH || '').split(delimiter).filter((d) => d !== '')
    const extensions = process.platform === 'win32'
      ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e !== '')
      : ['']
    const names = /\.[^/\\]+$/.test(bin) ? [bin] : [bin, ...extensions.map((ext) => bin + ext)]
    for (const directory of directories) {
      for (const name of names) {
        const candidate = join(directory, name)
        try {
          if (existsSync(candidate)) return candidate
        } catch {
          /* unreadable directory */
        }
      }
    }
    return null
  }

  /** Resolve curl, trying the Windows `.exe` spelling too. */
  async function findCurl() {
    const bare = await findExe('curl')
    if (bare !== null) return bare
    return findExe('curl.exe')
  }

  /** Cached workspace root, used as the default cwd for spawned processes. */
  let workspaceRoot = ''
  async function getWorkspaceRoot() {
    if (workspaceRoot !== '') return workspaceRoot
    if (fs !== undefined) {
      try {
        workspaceRoot = fs.processPath(await fs.resolve('.')) || ''
      } catch {
        workspaceRoot = ''
      }
    }
    return workspaceRoot
  }

  /** Monotonic counter for unique temp file names. */
  let fileCounter = 0

  /**
   * Scratch directory for the `.lean` files handed to the Lean CLI.
   *
   * Deliberately the OS temp dir rather than the `fs` service: that service
   * resolves relative paths against the harness home (so scratch files piled up
   * in `C:\Users\<user>\`) and offers no mkdir, while a scratch file for `lean`
   * is throwaway and belongs outside the user's workspace.
   */
  const scratchDir = join(tmpdir(), 'dsh-lean-math')

  /**
   * Write Lean source to a scratch file and return its path.
   * @param {string} code - the Lean source.
   * @returns {{ok: true, path: string}|{ok: false, error: string}} the path or a failure.
   */
  function writeSource(code) {
    try {
      mkdirSync(scratchDir, { recursive: true })
      const file = join(scratchDir, `check_${++fileCounter}.lean`)
      writeFileSync(file, code, 'utf8')
      return { ok: true, path: file }
    } catch (error) {
      return { ok: false, error: `write failed: ${error.message}` }
    }
  }

  /**
   * Run one argv command, collecting stdout/stderr.
   * @param {string[]} argv - argv, executable first.
   * @param {{cwd?: string, maxBytes?: number, graceMs?: number, signal?: AbortSignal}} [opts] - invocation options.
   * @returns {Promise<{ok: boolean, error?: string, exitCode: number|null, stdout: string, stderr: string}>} the outcome.
   */
  async function runCmd(argv, opts = {}) {
    if (subprocess === undefined) {
      return { ok: false, error: 'subprocess service unavailable', exitCode: null, stdout: '', stderr: '', timedOut: false }
    }
    // `graceMs` is the graceful-termination grace period, NOT a run budget, so the
    // wall-clock bound has to come from an AbortSignal of our own.
    const controller = new AbortController()
    const external = opts.signal
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const spec = {
      argv,
      cwd: opts.cwd || (await getWorkspaceRoot()) || '.',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: opts.maxBytes || 1000000, spill: { maxBytes: 4000000 } },
        stderr: { maxBytes: opts.maxBytes || 1000000, spill: { maxBytes: 4000000 } }
      },
      graceMs: opts.graceMs || 5000,
      signal: controller.signal
    }
    if (opts.env !== undefined) spec.env = opts.env

    let proc
    try {
      proc = subprocess.spawn(spec)
    } catch (error) {
      return { ok: false, error: `spawn failed: ${error.message}`, exitCode: null, stdout: '', stderr: '', timedOut: false }
    }

    const readCollected = () => {
      let stdout = ''
      let stderr = ''
      try {
        if (proc.collected?.stdout) stdout = proc.collected.stdout.readFrom(0).text
      } catch {
        /* spill-only output */
      }
      try {
        if (proc.collected?.stderr) stderr = proc.collected.stderr.readFrom(0).text
      } catch {
        /* spill-only output */
      }
      return { stdout, stderr }
    }

    // A run budget must do THREE things, not just signal: abort, force-terminate the
    // child, and — if the handle still never settles — stop waiting. Signalling alone
    // is not enough when the child spawned a grandchild that holds the output pipe:
    // the handle then waits for that grandchild, which is how one verification once
    // blocked for 88 minutes despite a 10-minute budget.
    const timeoutMs = opts.timeoutMs || 0
    const abandonAfterMs = 15000
    let timedOut = false
    let releaseGiveUp = () => {}
    const giveUp = new Promise((resolve) => {
      releaseGiveUp = resolve
    })
    const handle = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
          try {
            if (typeof proc.terminate === 'function') proc.terminate()
          } catch {
            /* provider may not support forced termination */
          }
          setTimeout(() => releaseGiveUp('give-up'), abandonAfterMs)
        }, timeoutMs)
      : null

    let outcome = null
    let abandoned = false
    let failure = null
    try {
      const settled = await Promise.race([
        proc.done.then(
          (value) => ({ kind: 'done', value }),
          (error) => ({ kind: 'error', error })
        ),
        giveUp.then(() => ({ kind: 'abandoned' }))
      ])
      if (settled.kind === 'done') outcome = settled.value
      else if (settled.kind === 'error') failure = settled.error
      else abandoned = true
    } finally {
      if (handle !== null) clearTimeout(handle)
    }

    const { stdout, stderr } = readCollected()

    if (abandoned) {
      return {
        ok: false,
        error: `process did not exit within ${timeoutMs + abandonAfterMs} ms and was abandoned`,
        exitCode: null,
        stdout,
        stderr,
        timedOut: true
      }
    }
    if (failure !== null) {
      return { ok: false, error: `process failed: ${failure.message}`, exitCode: null, stdout, stderr, timedOut }
    }
    return { ok: true, exitCode: outcome.exitCode, stdout, stderr, timedOut }
  }

  /**
   * Build the argv that checks one Lean file in the chosen project.
   * @param {string} osPath - file to check.
   * @param {string} projectDir - lake project, or '' for plain `lean`.
   * @returns {Promise<{ok: true, argv: string[], cwd: string}|{ok: false, error: string}>} the invocation.
   */
  async function leanInvocation(osPath, projectDir) {
    if (projectDir) {
      const lake = await findExe('lake')
      if (lake === null) return { ok: false, error: 'lake not found; cannot run inside project_dir' }
      const lean = await findExe('lean')
      const env = lean !== null ? await resolveLakeEnv(lake, projectDir) : null
      if (lean !== null && env !== null) {
        // Preferred: spawn `lean` DIRECTLY with the project environment. Going through
        // `lake env lean` inserts a middle process, and killing the middle process does
        // not kill the real one — which defeats the run budget entirely.
        return { ok: true, argv: [lean, osPath], cwd: projectDir, env }
      }
      return { ok: true, argv: [lake, 'env', 'lean', osPath], cwd: projectDir }
    }
    const lean = await findExe('lean')
    if (lean === null) return { ok: false, error: `Lean not installed on PATH. ${INSTALL_HINT}` }
    return { ok: true, argv: [lean, osPath], cwd: (await getWorkspaceRoot()) || '.' }
  }

  /** Cached `lake env` output, keyed by project directory. */
  const lakeEnvCache = new Map()

  /**
   * Resolve a project's lake environment once, so later runs can launch `lean` directly.
   *
   * `lake env` with no command prints the environment it would run a command in,
   * including `LEAN_PATH`. Capturing it turns every subsequent verification into a
   * single direct child process, which is what makes the run budget enforceable.
   * @param {string} lakePath - resolved lake executable.
   * @param {string} projectDir - the lake project.
   * @returns {Promise<Record<string,string>|null>} the merged environment, or null.
   */
  async function resolveLakeEnv(lakePath, projectDir) {
    if (lakeEnvCache.has(projectDir)) return lakeEnvCache.get(projectDir)
    const result = await runCmd([lakePath, 'env'], { cwd: projectDir, timeoutMs: 120000 })
    let env = null
    if (result.ok && result.exitCode === 0) {
      const parsed = {}
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const at = line.indexOf('=')
        if (at > 0) parsed[line.slice(0, at)] = line.slice(at + 1)
      }
      if (typeof parsed.LEAN_PATH === 'string' && parsed.LEAN_PATH !== '') {
        // Merge over the host environment: `lake env` lists what the project adds and
        // overrides, not necessarily every variable a process needs.
        env = { ...process.env, ...parsed }
      }
    }
    // Cache SUCCESSES ONLY. Caching a null froze a transient failure (a slow or
    // failed `lake env`) into a permanent one: every later run silently lost
    // LEAN_PATH and reported "unknown module prefix 'Mathlib'" forever after.
    if (env !== null) lakeEnvCache.set(projectDir, env)
    return env
  }

  /**
   * Parse Lean's `path:line:col: severity: message` diagnostics.
   *
   * The severity may carry an error code: Lean emits both
   * `foo.lean:3:1: error: unknown tactic` and
   * `foo.lean:3:1: error(lean.invalidField): Invalid field ...`.
   * Requiring the colon directly after the severity silently dropped every coded
   * diagnostic, which left `errors` empty while the exit code said failure — and the
   * caller's fail-closed rule then threw away the whole batch. On the difficulty
   * ladder that accounted for 15 candidates across 3 goals, including batches in which
   * some candidates had produced no error at all.
   * @param {string} text - combined process output.
   * @returns {Array<{file: string, line: number, column: number, severity: string, message: string}>} diagnostics.
   */
  function parseLeanDiagnostics(text) {
    const out = []
    const pattern = /^(.*?):(\d+):(\d+):\s+(error|warning|info)(?:\([^)]*\))?:\s*(.*)$/
    for (const line of (text || '').split(/\r?\n/)) {
      const match = pattern.exec(line)
      if (match) {
        out.push({
          file: match[1],
          line: Number.parseInt(match[2], 10),
          column: Number.parseInt(match[3], 10),
          severity: match[4],
          message: match[5]
        })
      }
    }
    return out
  }

  /**
   * Extract the pretty-printed goal blocks Lean prints at the end of its output.
   *
   * Two shapes are covered:
   *   - `error: unsolved goals` followed by EVERY remaining goal, separated by
   *     blank lines — each becomes its own entry (taking only the trailing block
   *     silently dropped all but the last goal);
   *   - a failed tactic whose message is followed by the surviving goal context.
   * @param {string} text - combined process output.
   * @returns {string[]} goal blocks; empty when the output carries none.
   */
  function extractGoals(text) {
    const lines = (text || '').split(/\r?\n/)
    const isDiagnostic = (line) => /^(.*?):(\d+):(\d+):\s+(error|warning|info)(?:\([^)]*\))?:/.test(line)

    for (let index = 0; index < lines.length; index++) {
      if (!/error:\s*unsolved goals\s*$/.test(lines[index])) continue
      const block = []
      for (let scan = index + 1; scan < lines.length && !isDiagnostic(lines[scan]); scan++) block.push(lines[scan])
      const sections = block
        .join('\n')
        .split(/\n\s*\n/)
        .map((section) => section.trim())
        .filter((section) => section.includes('⊢'))
      if (sections.length > 0) return sections
    }

    let end = lines.length - 1
    while (end >= 0 && lines[end].trim() === '') end--
    if (end < 0) return []
    let start = end
    while (start > 0) {
      const previous = lines[start - 1]
      if (previous.trim() === '' || isDiagnostic(previous)) break
      start--
    }
    const tail = lines.slice(start, end + 1).join('\n').trim()
    return tail.includes('⊢') ? [tail] : []
  }

  /**
   * Check one snippet and return the parsed verdict.
   * @param {string} code - Lean source.
   * @param {string} projectDir - lake project, or '' for plain `lean`.
   * @param {number} timeoutMs - wall-clock budget.
   * @param {AbortSignal|undefined} signal - cancellation.
   * @returns {Promise<Record<string, unknown>>} the verdict, including goals on failure.
   */
  async function checkCode(code, projectDir, timeoutMs, signal) {
    const written = writeSource(code)
    if (!written.ok) return { ok: false, error: written.error }
    try {
      const invocation = await leanInvocation(written.path, projectDir)
      if (!invocation.ok) return { ok: false, error: invocation.error }
      const result = await runCmd(invocation.argv, {
        cwd: invocation.cwd,
        timeoutMs,
        signal,
        ...(invocation.env === undefined ? {} : { env: invocation.env })
      })
      if (!result.ok) return { ok: false, error: result.error }
      const combined = `${result.stdout}\n${result.stderr}`
      const diagnostics = parseLeanDiagnostics(combined)
      const errors = diagnostics.filter((entry) => entry.severity === 'error')
      if (result.timedOut) {
        return {
          ok: true,
          success: false,
          timed_out: true,
          exit_code: result.exitCode,
          errors,
          diagnostics,
          goals: [],
          stdout: result.stdout,
          stderr: result.stderr,
          project_dir: projectDir || null,
          note:
            `Lean did not finish within ${timeoutMs} ms and was terminated. A cold \`import Mathlib\` takes minutes ` +
            'and needs several GB of RAM; narrow the imports (e.g. `import Mathlib.Tactic`) or raise ' +
            'interactiveTimeoutMs / defaultTimeoutMs.'
        }
      }
      return {
        ok: true,
        success: result.exitCode === 0,
        exit_code: result.exitCode,
        errors,
        diagnostics,
        goals: result.exitCode === 0 ? [] : extractGoals(combined),
        stdout: result.stdout,
        stderr: result.stderr,
        project_dir: projectDir || null
      }
    } finally {
      try {
        rmSync(written.path, { force: true })
      } catch {
        /* scratch file already gone */
      }
    }
  }

  // ── theorem search ────────────────────────────────────────────────────────

  /**
   * POST a JSON body with curl (the `web` service is GET-only).
   * @param {string} url - target URL.
   * @param {unknown} payload - JSON-serializable body.
   * @param {{headers?: string[], maxTime?: number}} [opts] - request options.
   * @returns {Promise<{ok: boolean, raw?: string, error?: string, detail?: string}>} the response text.
   */
  async function httpPostJson(url, payload, opts = {}) {
    const curl = await findCurl()
    if (curl === null) return { ok: false, error: 'curl not found on PATH (needed for HTTP POST)' }
    const maxTime = opts.maxTime || searchTimeoutMs
    const argv = [curl, '-sS', '-X', 'POST', '--max-time', String(maxTime)]
    for (const header of opts.headers ?? []) argv.push('-H', header)
    argv.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(payload), url)
    const result = await runCmd(argv, { cwd: '.', graceMs: maxTime * 1000 + 8000 })
    if (!result.ok) return { ok: false, error: result.error }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `HTTP request failed (exit ${result.exitCode})`,
        detail: (result.stderr || result.stdout || '').trim().slice(0, 800)
      }
    }
    return { ok: true, raw: result.stdout }
  }

  /**
   * GET a URL with curl.
   * @param {string} url - target URL.
   * @param {{maxTime?: number}} [opts] - request options.
   * @returns {Promise<{ok: boolean, raw?: string, error?: string, detail?: string}>} the response text.
   */
  async function httpGet(url, opts = {}) {
    const curl = await findCurl()
    if (curl === null) return { ok: false, error: 'curl not found on PATH' }
    const maxTime = opts.maxTime || searchTimeoutMs
    const argv = [curl, '-sS', '--max-time', String(maxTime), url]
    const result = await runCmd(argv, { cwd: '.', graceMs: maxTime * 1000 + 8000 })
    if (!result.ok) return { ok: false, error: result.error }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `HTTP request failed (exit ${result.exitCode})`,
        detail: (result.stderr || result.stdout || '').trim().slice(0, 800)
      }
    }
    return { ok: true, raw: result.stdout }
  }

  /**
   * Search LeanSearch (semantic).
   * @param {string} query - natural-language description.
   * @param {number} limit - max results.
   * @returns {Promise<Record<string, unknown>>} normalized results.
   */
  async function searchLeanSearch(query, limit) {
    const response = await httpPostJson(
      'https://leansearch.net/search',
      { query: [query], num_results: limit },
      { headers: ['accept: application/json'] }
    )
    if (!response.ok) return { ok: false, backend: 'leansearch', error: response.error, detail: response.detail }
    let parsed
    try {
      parsed = JSON.parse(response.raw)
    } catch {
      return { ok: false, backend: 'leansearch', error: 'unparseable response', raw: (response.raw || '').slice(0, 400) }
    }
    const inner = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : []
    const results = []
    for (const item of inner) {
      const entry = item?.result
      if (!entry) continue
      results.push({
        name: Array.isArray(entry.name) ? entry.name.join('.') : entry.name || null,
        kind: entry.kind || null,
        type: entry.type || entry.signature || null,
        docstring: entry.docstring || entry.informal_description || null,
        informal_name: entry.informal_name || null,
        module: Array.isArray(entry.module_name) ? entry.module_name.join('.') : null,
        distance: typeof item.distance === 'number' ? item.distance : null
      })
    }
    return { ok: true, backend: 'leansearch', count: results.length, results }
  }

  /**
   * Search Moogle.
   * @param {string} query - natural-language description.
   * @param {number} limit - max results.
   * @returns {Promise<Record<string, unknown>>} normalized results.
   */
  async function searchMoogle(query, limit) {
    const response = await httpPostJson('https://www.moogle.ai/api/search', [{ isFind: false, contents: query }])
    if (!response.ok) return { ok: false, backend: 'moogle', error: response.error, detail: response.detail }
    let parsed
    try {
      parsed = JSON.parse(response.raw)
    } catch {
      return { ok: false, backend: 'moogle', error: 'unparseable response', raw: (response.raw || '').slice(0, 400) }
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : []
    const results = rows.slice(0, limit).map((row) => ({
      name: row.declarationName || null,
      kind: row.declarationType || null,
      docstring: row.declarationDocString || null
    }))
    return { ok: true, backend: 'moogle', count: results.length, results }
  }

  /**
   * Search premise-search (LeanStateSearch).
   * @param {string} query - goal state or description.
   * @param {number} limit - max results.
   * @returns {Promise<Record<string, unknown>>} normalized results.
   */
  async function searchPremiseSearch(query, limit) {
    const url =
      'https://premise-search.com/api/search?query=' + encodeURIComponent(query) + `&results=${limit}&rev=v4.33.0`
    const response = await httpGet(url)
    if (!response.ok) return { ok: false, backend: 'premise-search', error: response.error, detail: response.detail }
    let parsed
    try {
      parsed = JSON.parse(response.raw)
    } catch {
      return { ok: false, backend: 'premise-search', error: 'unparseable response' }
    }
    const rows = Array.isArray(parsed) ? parsed : []
    const results = rows.slice(0, limit).map((row) => ({
      name: row.name || null,
      kind: row.kind || null,
      type: row.formal_type || row.type || null,
      docstring: row.doc || null
    }))
    return { ok: true, backend: 'premise-search', count: results.length, results }
  }

  /**
   * Search one backend, falling back leansearch → moogle.
   * @param {{query: string, backend?: string, num_results?: number}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} normalized results.
   */
  async function searchPremise(args) {
    const limit = args.num_results || 5
    const backend = args.backend || 'leansearch'
    if (backend === 'moogle') return searchMoogle(args.query, limit)
    if (backend === 'premise-search') return searchPremiseSearch(args.query, limit)
    const primary = await searchLeanSearch(args.query, limit)
    if (primary.ok) return primary
    const fallback = await searchMoogle(args.query, limit)
    if (fallback.ok) return { ...fallback, fell_back_from: 'leansearch', leansearch_error: primary.error }
    return primary
  }

  // ── toolchain status ──────────────────────────────────────────────────────

  /** Report whether the Lean toolchain and curl are reachable. */
  async function toolchainStatus() {
    const tools = {}
    for (const bin of ['elan', 'lean', 'lake']) {
      const path = await findExe(bin)
      tools[bin] = path === null ? { found: false } : { found: true, path }
    }
    const curl = await findCurl()
    const installed = tools.lean.found || tools.lake.found
    return {
      ok: installed,
      tools,
      curl: { found: curl !== null },
      default_project_dir: defaultProjectDir || null,
      hint: installed ? 'Lean toolchain detected.' : `Lean toolchain NOT found on PATH. ${INSTALL_HINT}`
    }
  }

  // ── kernel verification ───────────────────────────────────────────────────

  // Failure classification. A raw Lean error dump costs the caller extra
  // round-trips: it has to guess whether the fix is a name, a type, a tactic or
  // a timeout. Every known failure shape maps to one code plus one next action.
  // (Design borrowed from LeanProbe's `error_code` + `hint` contract.)
  const FAILURE_PATTERNS = [
    {
      code: 'unknown_ident',
      test: /unknown identifier|unknown constant|unknown namespace|unknown module/i,
      hint: 'Name is wrong or not imported. Call lean_search_premise to find the real name, or lean_query #check on the prefix.'
    },
    {
      code: 'type_mismatch',
      test: /type mismatch|application type mismatch|is not a function|has type .* but is expected/i,
      hint: 'Term has the wrong type. lean_query #check the term to see its real type before rewriting.'
    },
    {
      code: 'unsolved_goals',
      test: /unsolved goals/i,
      hint: 'Proof stopped early. Call lean_get_goals to see what remains, then run one more tactic — do not resend the whole proof.'
    },
    {
      code: 'sorry_left',
      test: /declaration uses 'sorry'|uses 'sorry'|sorryAx/i,
      hint: 'Proof is incomplete: it still rests on sorryAx. lean_axioms reporting uses_sorry=true is NOT a pass.'
    },
    {
      code: 'synth_instance',
      test: /failed to synthesize|failed to infer instance|instance expected/i,
      hint: 'Missing typeclass instance. Name it explicitly, or narrow the import to the module that provides it.'
    },
    {
      code: 'syntax',
      test: /unexpected token|unexpected end of input|expected ['"]?[\w\s]+['"]?$/im,
      hint: 'Syntax error — fix the surface form only. The mathematical content was never checked.'
    },
    {
      code: 'ambiguous',
      test: /ambiguous|multiple interpretations/i,
      hint: 'Overload not resolved. Annotate the type explicitly, e.g. (x : ℝ).'
    }
  ]

  /**
   * Turn a Lean failure into a stable code plus one next action.
   * @param {Array<{message?: string}>} errors - error-severity diagnostics.
   * @param {boolean} timedOut - whether the run was killed by the budget.
   * @returns {{error_code: string, hint: string}} the diagnosis.
   */
  function diagnose(errors, timedOut) {
    if (timedOut) {
      return {
        error_code: 'timeout',
        hint:
          'Lean never finished, so nothing was refuted. Open a session with lean_open_file to pay the ' +
          'import cost once, narrow the imports, or raise timeout_ms. Never read a timeout as a rejection.'
      }
    }
    const text = (errors || []).map((entry) => entry.message || '').join('\n')
    for (const pattern of FAILURE_PATTERNS) {
      if (pattern.test.test(text)) return { error_code: pattern.code, hint: pattern.hint }
    }
    return {
      error_code: 'rejected',
      hint: 'Lean rejected the snippet but the failure shape is unrecognised. Read errors[0].message directly.'
    }
  }

  /**
   * Verify a complete snippet with the Lean kernel.
   * @param {{code: string, project_dir?: string, timeout_ms?: number}} args - tool arguments.
   * @param {AbortSignal|undefined} signal - cancellation.
   * @returns {Promise<Record<string, unknown>>} the verdict.
   */
  async function verifyProof(args, signal) {
    const code = args.code || ''
    if (code.trim() === '') return { success: false, error: 'empty code' }
    // An explicit "" means "plain `lean`, no project"; only an absent key uses the default.
    const projectDir = args.project_dir !== undefined ? args.project_dir : defaultProjectDir
    const result = await checkCode(code, projectDir || '', args.timeout_ms || defaultTimeoutMs, signal)
    if (!result.ok) return { success: false, timed_out: result.timed_out === true, error: result.error }
    return {
      success: result.success,
      // A caller MUST be able to tell "Lean rejected this" from "Lean never finished".
      // Dropping the timeout flag made a bounded run indistinguishable from a real
      // rejection, so downstream fail-closed logic had to guess.
      timed_out: result.timed_out === true,
      exit_code: result.exit_code,
      errors: result.errors,
      diagnostics: result.diagnostics,
      stdout: result.stdout,
      stderr: result.stderr,
      project_dir: result.project_dir,
      // Only meaningful on failure; a pass gets no diagnosis so it cannot be
      // mistaken for a separate verdict.
      ...(result.success ? {} : { diagnosis: diagnose(result.errors, result.timed_out === true) }),
      ...(result.note === undefined ? {} : { note: result.note })
    }
  }

  /**
   * Report the axioms each named declaration depends on.
   *
   * `sorryAx` in the list means the proof is not actually complete, so this is the
   * honest completeness check behind a script that otherwise looks finished.
   * @param {{code: string, names?: string[], project_dir?: string, timeout_ms?: number}} args - tool arguments.
   * @param {AbortSignal|undefined} signal - cancellation.
   * @returns {Promise<Record<string, unknown>>} one entry per declaration.
   */
  async function checkAxioms(args, signal) {
    const code = args.code || ''
    if (code.trim() === '') return { ok: false, error: 'empty code' }

    const names = Array.isArray(args.names)
      ? args.names.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      : []
    if (names.length === 0) {
      const declaration =
        /^[ \t]*(?:@\[[^\]]*\][ \t]*)?(?:noncomputable[ \t]+|private[ \t]+|protected[ \t]+)*(?:theorem|lemma|def|abbrev)[ \t]+([A-Za-z_][\w'.]*)/gm
      for (const match of code.matchAll(declaration)) names.push(match[1])
    }
    if (names.length === 0) {
      return {
        ok: false,
        error: 'no named declaration found; pass `names` explicitly or add a `theorem` / `lemma` / `def`'
      }
    }

    const projectDir = args.project_dir !== undefined ? args.project_dir : defaultProjectDir
    const probe = `${code}\n\n${names.map((name) => `#print axioms ${name}`).join('\n')}\n`
    const result = await checkCode(probe, projectDir || '', args.timeout_ms || defaultTimeoutMs, signal)
    if (!result.ok) return { ok: false, error: result.error }
    if (result.timed_out) return { ok: false, timed_out: true, error: result.note }

    const text = `${result.stdout}\n${result.stderr}`
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const declarations = names.map((name) => {
      const depends = new RegExp(`'${escape(name)}' depends on axioms:\\s*\\[([^\\]]*)\\]`).exec(text)
      if (depends) {
        const axioms = depends[1]
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
        return { name, axioms, uses_sorry: axioms.includes('sorryAx'), complete: !axioms.includes('sorryAx') }
      }
      if (new RegExp(`'${escape(name)}' does not depend on any axioms`).test(text)) {
        return { name, axioms: [], uses_sorry: false, complete: true }
      }
      return { name, axioms: null, uses_sorry: null, complete: null, note: 'Lean reported no axioms line for this name' }
    })
    return {
      ok: true,
      declarations,
      any_sorry: declarations.some((entry) => entry.uses_sorry === true),
      errors: result.errors
    }
  }

  /**
   * Build the dependency graph of each named declaration.
   *
   * Nodes carry their defining module, so a caller can see at a glance whether a
   * proof rests on core, on Mathlib, or on declarations from its own snippet.
   * @param {{code: string, names?: string[], project_dir?: string, transitive?: boolean, module_prefix?: string, max_nodes?: number, timeout_ms?: number}} args - tool arguments.
   * @param {AbortSignal|undefined} signal - cancellation.
   * @returns {Promise<Record<string, unknown>>} one graph per declaration.
   */
  async function checkDeps(args, signal) {
    const code = args.code || ''
    if (code.trim() === '') return { ok: false, error: 'empty code' }

    const names = Array.isArray(args.names)
      ? args.names.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      : []
    if (names.length === 0) {
      const declaration =
        /^[ \t]*(?:@\[[^\]]*\][ \t]*)?(?:noncomputable[ \t]+|private[ \t]+|protected[ \t]+)*(?:theorem|lemma|def|abbrev)[ \t]+([A-Za-z_][\w'.]*)/gm
      for (const match of code.matchAll(declaration)) names.push(match[1])
    }
    if (names.length === 0) {
      return {
        ok: false,
        error: 'no named declaration found; pass `names` explicitly or add a `theorem` / `lemma` / `def`'
      }
    }

    // Every import must lead the file, so hoist the user's imports above the
    // prelude and strip them from the body.
    const importLines = []
    const bodyLines = []
    for (const line of code.split(/\r?\n/)) {
      if (/^\s*import\s+\S/.test(line)) importLines.push(line.trim())
      else bodyLines.push(line)
    }

    const probes = names.map((name) => `#lmDepsGraph ${name}`).join('\n')
    const probe = `${importLines.join('\n')}\n${DEPS_PRELUDE}\n${bodyLines.join('\n')}\n${probes}\n`

    const projectDir = args.project_dir !== undefined ? args.project_dir : defaultProjectDir
    const result = await checkCode(probe, projectDir || '', args.timeout_ms || defaultTimeoutMs, signal)
    if (!result.ok) return { ok: false, error: result.error }
    if (result.timed_out) return { ok: false, timed_out: true, error: result.note }

    const maxNodes = Number.isInteger(args.max_nodes) && args.max_nodes > 0 ? args.max_nodes : 400
    const prefix = typeof args.module_prefix === 'string' && args.module_prefix !== '' ? args.module_prefix : null
    const transitive = args.transitive !== false

    const declarations = []
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
      if (!line.startsWith('@@DGRAPH\t')) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      let parsed
      try {
        parsed = JSON.parse(parts[2])
      } catch {
        continue
      }
      const root = parts[1]
      const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
      const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : []
      const moduleOf = new Map(rawNodes.map((pair) => [pair[0], pair[1]]))

      const directNames = new Set(rawEdges.filter((pair) => pair[0] === root).map((pair) => pair[1]))

      let selected = transitive
        ? rawNodes.map((pair) => pair[0])
        : rawNodes.map((pair) => pair[0]).filter((name) => name === root || directNames.has(name))
      if (prefix !== null) {
        selected = selected.filter((name) => name === root || String(moduleOf.get(name) || '').startsWith(prefix))
      }
      const selectedSet = new Set(selected)

      const keptEdges = transitive
        ? rawEdges.filter((pair) => selectedSet.has(pair[0]) && selectedSet.has(pair[1]))
        : []

      const byModule = {}
      for (const name of selected) {
        if (name === root) continue
        const moduleName = String(moduleOf.get(name) || '(this snippet)')
        byModule[moduleName] = (byModule[moduleName] || 0) + 1
      }

      const truncated = selected.length > maxNodes
      declarations.push({
        name: root,
        root_module: moduleOf.get(root) || '(this snippet)',
        node_count: selected.length,
        edge_count: keptEdges.length,
        direct_count: directNames.size,
        truncated,
        by_module: byModule,
        nodes: selected.slice(0, maxNodes).map((name) => ({ name, module: moduleOf.get(name) || '(this snippet)' })),
        edges: keptEdges
          .slice(0, maxNodes * 3)
          .map((pair) => ({ from: pair[0], to: pair[1] }))
      })
    }

    if (declarations.length === 0) {
      return {
        ok: false,
        error: 'Lean produced no dependency graph; the declaration name may be wrong or the file may not compile',
        errors: result.errors,
        stdout: result.stdout.slice(0, 2000),
        stderr: result.stderr.slice(0, 2000)
      }
    }
    return { ok: true, declarations, errors: result.errors }
  }

  // ── interactive sessions (resident Lean server) ───────────────────────────

  /** Live interactive sessions, keyed by session id. */
  const sessions = new Map()

  /** Monotonic session counter. */
  let sessionCounter = 0

  /**
   * One resident server per project directory, so `import Mathlib` is loaded once
   * per project instead of once per tactic.
   */
  const serverPool = new LeanServerPool({
    resolveLean: () => findExe('lean'),
    resolveEnv: (projectDir) => resolveLakeEnvFor(projectDir),
    quietMs: 700,
    requestTimeoutMs: interactiveTimeoutMs,
    installHint: INSTALL_HINT,
    idleMs: serverIdleMs,
  })

  /**
   * Lake environment for a project, or undefined for plain Lean.
   *
   * Wraps the existing resolver so a failure degrades to the host environment
   * rather than blocking an interactive session from ever opening.
   * @param {string} projectDir - lake project, or ''.
   * @returns {Promise<Record<string,string>|null>} the environment, or null.
   */
  async function resolveLakeEnvFor(projectDir) {
    if (!projectDir) return null
    const lake = await findExe('lake')
    if (lake === null) return null
    return resolveLakeEnv(lake, projectDir)
  }

  /** Where session state is persisted so a restart can pick proofs back up. */
  const sessionStoreDir = join(
    process.env.DSH_HOME || join(process.env.USERPROFILE || tmpdir(), '.dsh'),
    '.lean-sessions'
  )

  /**
   * Persist a session so it survives a host restart.
   * @param {object} session - the session record.
   * @returns {void} nothing.
   */
  function persistSession(session) {
    try {
      mkdirSync(sessionStoreDir, { recursive: true })
      writeFileSync(
        join(sessionStoreDir, `${session.id}.json`),
        JSON.stringify(
          {
            id: session.id,
            name: session.name,
            projectDir: session.projectDir,
            source: session.source,
            history: session.history.slice(-50),
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf8'
      )
    } catch {
      /* persistence is a convenience, never a reason to fail a step */
    }
  }

  /**
   * Load persisted session metadata.
   * @param {string} id - session id.
   * @returns {object|null} the record, or null.
   */
  function loadSession(id) {
    try {
      return JSON.parse(readFileSync(join(sessionStoreDir, `${id}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * Forget a persisted session.
   * @param {string} id - session id.
   * @returns {void} nothing.
   */
  function forgetSession(id) {
    try {
      rmSync(join(sessionStoreDir, `${id}.json`), { force: true })
    } catch {
      /* already gone */
    }
  }

  /**
   * Append a tactic as a new line of the proof.
   *
   * `bullet: true` emits `· tactic`, which is how a specific goal in a
   * multi-goal state is addressed — without it a session could only ever walk
   * goals in the order Lean happens to pick.
   * @param {string} source - current script.
   * @param {string} tactic - the tactic to add.
   * @param {{bullet?: boolean}} [options] - formatting options.
   * @returns {string} the new script.
   */
  function appendTactic(source, tactic, options = {}) {
    const text = (tactic || '').trim()
    const prefix = options.bullet === true ? '  · ' : '  '
    return `${(source || '').replace(/\s*$/, '')}\n${prefix}${text}\n`
  }

  /**
   * Convert LSP diagnostics into the shape this plugin has always returned.
   * @param {Array<{severity?: number, message: string, range?: any, source?: string}>} items - LSP diagnostics.
   * @returns {Array<{file: string, line: number, column: number, severity: string, message: string}>} diagnostics.
   */
  function fromServerDiagnostics(items, file) {
    const bySeverity = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }
    return (items ?? []).map((item) => ({
      file,
      line: (item.range?.start?.line ?? 0) + 1,
      column: (item.range?.start?.character ?? 0) + 1,
      severity: bySeverity[item.severity] ?? 'info',
      message: String(item.message ?? ''),
    }))
  }

  /**
   * Read the goals of a session's current source from the resident server.
   * @param {object} session - the session record.
   * @returns {Promise<{goals: string[], diagnostics: object[]}>} goals and diagnostics.
   */
  async function readState(session) {
    const server = await serverPool.get(session.projectDir)
    const lines = session.source.split('\n')
    const position = { line: lines.length - 1, character: lines[lines.length - 1].length }
    const goals = await server.goalsAt(session.uri, position, interactiveTimeoutMs)
    const diagnostics = fromServerDiagnostics(server.diagnosticsFor(session.uri), session.filePath)
    return { goals, diagnostics }
  }

  /**
   * Push a new source into the server and read the resulting state.
   * @param {object} session - the session record.
   * @param {string} source - the new source.
   * @returns {Promise<{goals: string[], diagnostics: object[]}>} the new state.
   */
  async function commit(session, source) {
    session.source = source
    // "use", not "hold": commit happens many times per session and must not inflate
    // the server's reference count, or it could never be released.
    const server = await serverPool.get(session.projectDir)
    await server.updateDocument(session.uri, source, interactiveTimeoutMs)
    const state = await readState(session)
    persistSession(session)
    return state
  }

  /**
   * Start an interactive proof session.
   * @param {{name?: string, content?: string, project_dir?: string}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} the session descriptor.
   */
  async function openFile(args) {
    const id = `lean_${++sessionCounter}`
    const projectDir = args.project_dir !== undefined ? args.project_dir : defaultProjectDir
    const content = args.content || ''
    const name = args.name || `proof${sessionCounter}`

    // didOpen makes the server read the file itself, so the document has to exist
    // on disk before we announce it.
    mkdirSync(scratchDir, { recursive: true })
    const filePath = join(scratchDir, `${name}-${id}.lean`)
    writeFileSync(filePath, content, 'utf8')

    const session = {
      id,
      name,
      source: content,
      projectDir: projectDir || '',
      filePath,
      uri: pathToUri(filePath),
      goals: [],
      diagnostics: [],
      // Checkpoints for `lean_undo`. The old code could only roll back one step
      // because a step cost a full re-run; here rollback is just a text swap.
      history: [],
      server: null,
    }
    sessions.set(id, session)

    try {
      const server = await serverPool.acquire(session.projectDir)
      session.server = server
      await server.openDocument(session.uri, content, interactiveTimeoutMs)
      const state = await readState(session)
      session.goals = state.goals
      session.diagnostics = state.diagnostics
      persistSession(session)
    } catch (error) {
      // A session that cannot talk to Lean is worse than none: drop it so the
      // caller sees a real failure instead of a half-open session.
      sessions.delete(id)
      throw error
    }

    return {
      ok: true,
      session_id: id,
      file_name: `${name}.lean`,
      project_dir: projectDir || null,
      source: content,
      goals: session.goals,
      diagnostics: session.diagnostics,
      engine: 'resident lean server (incremental)',
      note:
        'Interactive session started against a RESIDENT Lean server: imports are loaded once, ' +
        'and every later step only re-elaborates the changed proof (~1s instead of a full re-run). ' +
        'Use lean_run_tactic to apply a tactic, lean_undo to step back, lean_query to #check a term. ' +
        'Keep the script an INCOMPLETE proof so the remaining goal stays visible.'
    }
  }

  /**
   * Read the current goal state of a session.
   * @param {{session_id: string}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} goals + diagnostics.
   */
  async function getGoals(args) {
    let session = sessions.get(args.session_id)
    if (session === undefined) {
      // A restart drops in-memory sessions, but each step was persisted — so the
      // proof can be resumed instead of telling the agent to start over.
      const stored = loadSession(args.session_id)
      if (stored === null) {
        return { ok: false, error: `unknown session_id: ${args.session_id}` }
      }
      mkdirSync(scratchDir, { recursive: true })
      const filePath = join(scratchDir, `${stored.name}-${stored.id}.lean`)
      writeFileSync(filePath, stored.source, 'utf8')
      session = {
        ...stored,
        filePath,
        uri: pathToUri(filePath),
        goals: [],
        diagnostics: [],
        server: null,
      }
      sessions.set(session.id, session)
      const server = await serverPool.acquire(session.projectDir)
      session.server = server
      await server.openDocument(session.uri, session.source, interactiveTimeoutMs)
      const state = await readState(session)
      session.goals = state.goals
      session.diagnostics = state.diagnostics
    } else if (args.refresh === true) {
      const state = await readState(session)
      session.goals = state.goals
      session.diagnostics = state.diagnostics
    }
    // Normally this is a memory read: the goals were already computed by the last
    // step. That is the whole point of holding a resident server.
    const errors = session.diagnostics.filter((entry) => entry.severity === 'error')
    return {
      ok: true,
      session_id: session.id,
      source: session.source,
      goals: session.goals,
      diagnostics: session.diagnostics,
      errors,
      proven: session.goals.length === 0 && errors.length === 0,
      no_goals: session.goals.length === 0,
      steps: session.history.length,
      engine: 'resident lean server (incremental)'
    }
  }

  /**
   * Append a tactic and read the resulting state.
   * @param {{session_id: string, tactic: string}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} the new state.
   */
  async function runTactic(args) {
    const session = sessions.get(args.session_id)
    if (!session) return { ok: false, error: `unknown session_id: ${args.session_id}` }
    const tactic = (args.tactic || '').trim()
    if (tactic === '') return { ok: false, error: 'empty tactic' }

    const previousSource = session.source
    const previousGoals = session.goals
    const previousDiagnostics = session.diagnostics

    // Checkpoint BEFORE mutating, so a rollback is a text swap rather than a re-run.
    session.history.push({ source: previousSource, goals: previousGoals, diagnostics: previousDiagnostics })

    let state
    try {
      state = await commit(session, appendTactic(session.source, tactic, { bullet: args.bullet === true }))
    } catch (error) {
      session.history.pop()
      session.source = previousSource
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    // "unsolved goals" means the tactic was accepted and goals remain; any other
    // error means the tactic itself was rejected.
    const errors = state.diagnostics.filter((entry) => entry.severity === 'error')
    const tacticFailed = errors.some((entry) => !/unsolved goals/.test(entry.message))
    let goals = state.goals
    if (tacticFailed) {
      // A rejected tactic is undone so the next attempt starts from the last good
      // state — and the goals reported are THAT state's, because a rejected tactic
      // often carries no goal at all and the model must not be told it vanished.
      const restored = await commit(session, previousSource)
      goals = restored.goals.length > 0 ? restored.goals : previousGoals
      session.history.pop() // the rejected step is not part of the history
      state = { goals, diagnostics: restored.diagnostics }
    } else {
      session.goals = state.goals
      session.diagnostics = state.diagnostics
    }

    const finalErrors = state.diagnostics.filter((entry) => entry.severity === 'error' && !/unsolved goals/.test(entry.message))
    return {
      ok: true,
      session_id: session.id,
      tactic,
      source: session.source,
      goals,
      diagnostics: state.diagnostics,
      errors: finalErrors,
      tactic_accepted: !tacticFailed,
      rolled_back: tacticFailed,
      proven: goals.length === 0 && finalErrors.length === 0,
      no_goals: goals.length === 0,
      steps: session.history.length,
      engine: 'resident lean server (incremental)'
    }
  }

  /**
   * End an interactive session.
   * @param {{session_id: string}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} the receipt.
   */
  async function closeSessionTool(args) {
    const session = sessions.get(args.session_id)
    if (session === undefined) return { ok: false, session_id: args.session_id, closed: false }
    if (session.server !== null) {
      try {
        await session.server.closeDocument(session.uri)
      } catch {
        /* the server is going away anyway */
      }
      serverPool.release(session.projectDir)
    }
    try {
      rmSync(session.filePath, { force: true })
    } catch {
      /* scratch file already gone */
    }
    if (args.keep !== true) forgetSession(session.id)
    sessions.delete(args.session_id)
    return { ok: true, session_id: args.session_id, closed: true, persisted: args.keep === true }
  }

  /**
   * Step a session back to an earlier checkpoint.
   * @param {{session_id: string, steps?: number}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} the restored state.
   */
  async function undoTool(args) {
    const session = sessions.get(args.session_id)
    if (!session) return { ok: false, error: `unknown session_id: ${args.session_id}` }
    const count = Number.isInteger(args.steps) && args.steps > 0 ? args.steps : 1
    if (session.history.length === 0) {
      return { ok: false, error: 'nothing to undo: the session is at its opening state' }
    }
    const take = Math.min(count, session.history.length)
    let checkpoint = null
    for (let i = 0; i < take; i++) checkpoint = session.history.pop()
    const state = await commit(session, checkpoint.source)
    session.goals = state.goals
    session.diagnostics = state.diagnostics
    return {
      ok: true,
      session_id: session.id,
      undone: take,
      source: session.source,
      goals: session.goals,
      diagnostics: session.diagnostics,
      steps: session.history.length,
      ...(take < count ? { note: `only ${take} step(s) were available` } : {})
    }
  }

  /**
   * Replace a session's WHOLE source — swap to a different theorem while keeping
   * the resident server (and its already-loaded imports) alive.
   *
   * Why this exists: opening a NEW file re-elaborates the whole `import` block
   * (~40-60s for `import Mathlib.Tactic`, measured on Lean 4.33) even though the
   * modules are already in RAM, because Lean elaborates imports per-file. Reusing
   * the SAME document via a full-text update only re-elaborates what changed
   * (~1s when the import line is unchanged). For a search loop that tries many
   * theorems this is the difference between N×60s and N×1s.
   *
   * Keep the `import` line(s) identical to reuse the loaded environment fastest;
   * changing imports still works, it just re-elaborates whatever is new.
   * @param {{session_id: string, content?: string}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} the new state.
   */
  async function updateSourceTool(args) {
    const session = sessions.get(args.session_id)
    if (!session) return { ok: false, error: `unknown session_id: ${args.session_id}` }
    const content = args.content
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'content is required and must be non-empty Lean source' }
    }

    // Checkpoint BEFORE replacing, so lean_undo can return to the previous theorem.
    session.history.push({ source: session.source, goals: session.goals, diagnostics: session.diagnostics })

    let state
    try {
      state = await commit(session, content)
    } catch (error) {
      session.history.pop()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    session.goals = state.goals
    session.diagnostics = state.diagnostics

    const errors = state.diagnostics.filter((entry) => entry.severity === 'error' && !/unsolved goals/.test(entry.message))
    return {
      ok: true,
      session_id: session.id,
      source: session.source,
      goals: session.goals,
      diagnostics: session.diagnostics,
      errors,
      proven: session.goals.length === 0 && errors.length === 0,
      no_goals: session.goals.length === 0,
      steps: session.history.length,
      engine: 'resident lean server (incremental)',
      note:
        'Source replaced on the SAME resident session: the import block was NOT reloaded. ' +
        'Keep the import lines unchanged to stay at ~1s per swap; a fresh lean_open_file would ' +
        're-elaborate the imports (~40-60s for Mathlib.Tactic).'
    }
  }

  /**
   * Ask Lean about a term in the context of the session: `#check`, `#eval`,
   * `#print`, `#reduce`.
   *
   * This one deliberately goes through the CLI rather than the resident server:
   * measured on Lean 4.33, the language server publishes NO diagnostic for
   * `#check` (its output goes to an infoview channel the protocol does not
   * expose), so a resident query would silently return nothing. The CLI prints it
   * on stdout. The cost is one `lean` run, which is why the result says so.
   *
   * The session's own source is never touched: the command is appended to a
   * throwaway copy, so the proof cannot be disturbed by asking about it.
   * @param {{session_id: string, command?: string, expr?: string}} args - tool arguments.
   * @returns {Promise<Record<string, unknown>>} the answers.
   */
  async function queryTool(args) {
    const session = sessions.get(args.session_id)
    if (!session) return { ok: false, error: `unknown session_id: ${args.session_id}` }
    const command = String(args.command || '#check').trim()
    if (!['#check', '#eval', '#print', '#reduce'].includes(command)) {
      return { ok: false, error: `unsupported command: ${command}` }
    }
    const expr = String(args.expr || '').trim()
    if (expr === '') return { ok: false, error: 'expr is required' }

    const probe = `${session.source.replace(/\s*$/, '')}\n\n${command} ${expr}\n`
    const written = writeSource(probe)
    if (!written.ok) return { ok: false, error: written.error }
    let stdout = ''
    let diagnostics = []
    try {
      // Reuse the resident server's environment rather than re-deriving it: a query
      // must see the same imports the session was elaborated against, otherwise a
      // Mathlib session answers "unknown module prefix 'Mathlib'".
      const lean = await findExe('lean')
      if (lean === null) return { ok: false, error: `Lean not installed on PATH. ${INSTALL_HINT}` }
      const env = await serverPool.envFor(session.projectDir)
      const cwd = session.projectDir || (await getWorkspaceRoot()) || '.'
      const result = await runCmd([lean, written.path], {
        cwd,
        timeoutMs: defaultTimeoutMs,
        ...(env === null || env === undefined ? {} : { env }),
      })
      if (!result.ok) return { ok: false, error: result.error }
      stdout = result.stdout || ''
      diagnostics = parseLeanDiagnostics(`${stdout}\n${result.stderr}`)
    } finally {
      try { rmSync(written.path, { force: true }) } catch { /* already gone */ }
    }

    // The command's answer is whatever comes AFTER the last goal line: an
    // unfinished proof dumps `unsolved goals` plus its pretty-printed cases, and
    // Lean prints them with no blank line before the `#check` output, so neither
    // "skip to the next blank line" nor "drop blocks containing ⊢" separates them
    // correctly. Anchoring on the LAST `⊢` handles both the multi-case shape and
    // the clean case (no goals at all, where everything non-diagnostic is output).
    const isDiagnostic = (line) => /^(.*?):(\d+):(\d+):\s+(error|warning|info)/.test(line)
    const lines = stdout.split(/\r?\n/)
    let lastGoalLine = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('\u22a2')) lastGoalLine = i // ⊢
    }
    const answers = lines
      .slice(lastGoalLine + 1)
      .filter((line) => line.trim() !== '')
      .filter((line) => !isDiagnostic(line))

    return {
      ok: true,
      session_id: session.id,
      command,
      expr,
      answers,
      errors: diagnostics.filter((entry) => entry.severity === 'error').map((entry) => entry.message),
      engine: 'cli (the LSP does not expose #check output)',
      note:
        'the session source is unchanged; this query costs one `lean` run, so it re-loads ' +
        'the imports (cheap without Mathlib, expensive with it)'
    }
  }

  /**
   * List open sessions and any persisted ones from a previous run.
   * @returns {Promise<Record<string, unknown>>} the inventory.
   */
  async function listSessionsTool() {
    const live = [...sessions.values()].map((s) => ({
      id: s.id, name: s.name, project_dir: s.projectDir || null,
      steps: s.history.length, goals: s.goals.length, proven: s.goals.length === 0,
    }))
    let stored = []
    try {
      const { readdirSync } = await import('node:fs')
      stored = readdirSync(sessionStoreDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .filter((id) => !sessions.has(id))
        .map((id) => {
          const rec = loadSession(id)
          return rec === null ? null : { id, name: rec.name, project_dir: rec.projectDir || null, updatedAt: rec.updatedAt }
        })
        .filter((x) => x !== null)
    } catch {
      stored = []
    }
    return { ok: true, live, persisted: stored }
  }

  // ── tool registration ─────────────────────────────────────────────────────

  /**
   * Declare one tool with a JSON result rendered as pretty text.
   * @param {string} toolName - tool name.
   * @param {string} description - model-facing description.
   * @param {Record<string, unknown>} parameters - parameter DSL.
   * @param {(args: any, exec: any) => unknown} execute - handler.
   * @returns {Record<string, unknown>} the definition.
   */
  function declare(toolName, description, parameters, execute) {
    return defineTool({
      name: toolName,
      description,
      parameters,
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        }
      },
      execute
    })
  }

  ctx.tools.register(
    declare(
      'lean_status',
      'Check whether the Lean proof assistant toolchain (elan/lean/lake) is installed and reachable on PATH. Call this before any other lean_* tool to know whether verification, goals and tactics are available. Also reports whether curl (used for theorem search) is present, and this plugin default Mathlib project directory.',
      {},
      () => toolchainStatus()
    )
  )

  ctx.tools.register(
    declare(
      'lean_search_premise',
      'Search Mathlib for existing theorems/definitions matching a natural-language description or a Lean type signature. Backends: leansearch (default, semantic), moogle, premise-search. Returns candidate names, kinds, types and docstrings to use as premises in a proof. Needs no Lean install.',
      {
        query: {
          type: 'string',
          required: true,
          description: 'Natural-language description or type signature, e.g. "commutativity of addition on natural numbers".'
        },
        backend: {
          type: 'string',
          enum: ['leansearch', 'moogle', 'premise-search'],
          description: 'Search backend. Defaults to leansearch (auto-falls back to moogle on failure).'
        },
        num_results: { type: 'integer', description: 'Max results, default 5.' }
      },
      (args) => searchPremise(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_verify_proof',
      'Verify a complete Lean 4 proof/code snippet with the Lean kernel. Writes the code to a temp file and runs `lean` (or `lake env lean` inside project_dir, which this plugin defaults to its configured Mathlib project). Returns a strict success boolean plus parsed error locations — the final authority on whether a proof is correct.',
      {
        code: {
          type: 'string',
          required: true,
          description: 'Complete Lean 4 code, e.g. "import Mathlib\\n\\nexample : 1 + 1 = 2 := by norm_num".'
        },
        project_dir: {
          type: 'string',
          description:
            'Absolute path to a Mathlib lake project, or "" for plain `lean` (no Mathlib). Omit to use this plugin\'s configured projectDir.'
        },
        timeout_ms: { type: 'integer', description: 'Optional timeout in ms.' }
      },
      (args, exec) => verifyProof(args, exec?.signal)
    )
  )

  ctx.tools.register(
    declare(
      'lean_axioms',
      "Report which axioms each named declaration in a snippet depends on (via Lean's `#print axioms`). Use it as the completeness check behind a script that looks finished: `uses_sorry: true` means the declaration still rests on `sorryAx`, i.e. the proof is NOT complete. Declarations are discovered from the code, or named explicitly via `names`.",
      {
        code: {
          type: 'string',
          required: true,
          description: 'Lean 4 code containing the declarations to inspect, e.g. "import Mathlib\\n\\ntheorem t : 1 + 1 = 2 := by norm_num".'
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit declaration names to check. Omit to discover `theorem`/`lemma`/`def`/`abbrev` names from the code.'
        },
        project_dir: {
          type: 'string',
          description:
            'Absolute path to a Mathlib lake project, or "" for plain `lean`. Omit to use this plugin\'s configured projectDir.'
        },
        timeout_ms: { type: 'integer', description: 'Optional timeout in ms.' }
      },
      (args, exec) => checkAxioms(args, exec?.signal)
    )
  )

  ctx.tools.register(
    declare(
      'lean_deps',
      'Build the dependency graph of named declarations: every constant their type and proof term transitively use, each tagged with its defining module, plus the edges between them. Use it to see what a proof actually rests on, to spot which Mathlib modules are really involved, or to find the local lemmas that carry a proof. Runs entirely inside Lean (no LeanDojo, no LSP).',
      {
        code: {
          type: 'string',
          required: true,
          description: 'Lean 4 code containing the declarations to analyse.'
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit declaration names. Omit to discover `theorem`/`lemma`/`def`/`abbrev` names from the code.'
        },
        transitive: {
          type: 'boolean',
          description: 'true (default) returns the full transitive closure; false returns only direct dependencies of each root.'
        },
        module_prefix: {
          type: 'string',
          description: 'Optional module filter, e.g. "Mathlib" keeps only Mathlib nodes (plus each root). Use "Mathlib.Algebra" to narrow further.'
        },
        max_nodes: { type: 'integer', description: 'Cap on returned nodes per declaration, default 400. `node_count` still reports the true size.' },
        project_dir: {
          type: 'string',
          description:
            'Absolute path to a Mathlib lake project, or "" for plain `lean`. Omit to use this plugin\'s configured projectDir.'
        },
        timeout_ms: { type: 'integer', description: 'Optional timeout in ms.' }
      },
      (args, exec) => checkDeps(args, exec?.signal)
    )
  )

  ctx.tools.register(
    declare(
      'lean_open_file',
      'Start an interactive Lean proof session and return a session_id. Entry point for step-by-step proof: open a script containing an INCOMPLETE proof (Lean reports the remaining goal as "unsolved goals"), then drive it with lean_run_tactic and inspect it with lean_get_goals. Requires the Lean toolchain.',
      {
        name: { type: 'string', description: 'Short name for the proof (no extension). Defaults to an auto-generated name.' },
        content: {
          type: 'string',
          description:
            'Initial Lean source. Keep the proof incomplete so the goal is visible, e.g. "import Mathlib\\n\\nexample : 0 < 1 := by". Do not end the proof with `sorry` — that suppresses the goal.'
        },
        project_dir: {
          type: 'string',
          description:
            'Absolute path to a Mathlib lake project, or "" for plain `lean`. Omit to use this plugin\'s configured projectDir.'
        }
      },
      (args) => openFile(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_get_goals',
      "Read the current proof state of an interactive Lean session: the open goals and the latest diagnostics/errors. This is the Agent's \"eyes\" — read it before choosing the next tactic. Normally instant: the goals were already computed by the last step. Pass refresh=true to re-ask the server (costs one elaboration).",
      {
        session_id: { type: 'string', required: true, description: 'session_id returned by lean_open_file.' },
        refresh: {
          type: 'boolean',
          description: 'Re-read state from the server instead of the cached goals. Default false.'
        }
      },
      (args) => getGoals(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_run_tactic',
      "Run one tactic in an interactive Lean session by appending it to the proof script, then re-check with the Lean CLI and return the new goal state and any errors. This is the Agent's \"hands\" — the core trial-and-error loop. A rejected tactic still returns the goal that survived it, so the next attempt starts from real state.",
      {
        session_id: { type: 'string', required: true, description: 'session_id returned by lean_open_file.' },
        tactic: {
          type: 'string',
          required: true,
          description: 'The Lean tactic to run, e.g. "intro h", "rw [Nat.add_comm]", "exact Nat.zero_lt_one".'
        },
        bullet: {
          type: 'boolean',
          description:
            'Emit the tactic as a bullet (`· tactic`). Use it when the state has several goals and you want to address them one by one instead of letting Lean pick the order.'
        }
      },
      (args) => runTactic(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_close_session',
      'End an interactive Lean session and release its state.',
      {
        session_id: { type: 'string', required: true, description: 'session_id returned by lean_open_file.' },
        keep: {
          type: 'boolean',
          description: 'Keep the persisted copy so the proof can be resumed by session_id after a restart. Default false.'
        }
      },
      (args) => closeSessionTool(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_update_source',
      "Replace an interactive session's ENTIRE source — swap to a different theorem while reusing the same resident Lean server. Use this in a search/attempt loop: opening a fresh session re-elaborates the whole import block (~40-60s for import Mathlib.Tactic), but swapping the source on an existing session only re-elaborates what changed (~1s when the import lines are unchanged). Keep the import line(s) identical for maximum reuse. Undoable via lean_undo.",
      {
        session_id: { type: 'string', required: true, description: 'session_id returned by lean_open_file.' },
        content: {
          type: 'string',
          required: true,
          description:
            'The new full Lean source for this session. Keep the proof incomplete so the goal stays visible. Reuse the same import lines as before to avoid a reload.'
        }
      },
      (args) => updateSourceTool(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_undo',
      'Step an interactive session back to an earlier checkpoint. Each accepted tactic pushes a checkpoint, so undo restores the exact source and goal state without re-running anything from scratch. Use it to abandon a line of attack cleanly.',
      {
        session_id: { type: 'string', required: true, description: 'session_id returned by lean_open_file.' },
        steps: { type: 'integer', description: 'How many checkpoints to step back. Default 1.' }
      },
      (args) => undoTool(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_query',
      "Ask Lean a question inside the session's context: `#check` a term's type, `#eval` an expression, `#print` a declaration, `#reduce` a term. The command is appended, read, and removed again, so the proof script is left untouched.",
      {
        session_id: { type: 'string', required: true, description: 'session_id returned by lean_open_file.' },
        expr: {
          type: 'string',
          required: true,
          description: 'The term or name to ask about, e.g. "Nat.add_comm", "1 + 1", "List.map".'
        },
        command: {
          type: 'string',
          enum: ['#check', '#eval', '#print', '#reduce'],
          description: 'Which command to use. Default #check.'
        }
      },
      (args) => queryTool(args)
    )
  )

  ctx.tools.register(
    declare(
      'lean_sessions',
      'List interactive sessions: the live ones and any persisted from a previous run (resumable by session_id via lean_get_goals).',
      {},
      () => listSessionsTool()
    )
  )

  // Release every session and shut the resident servers down when this row unloads.
  // Leaving a server alive would pin a multi-GB Mathlib image in RAM for nothing.
  ctx.effect(() => () => {
    sessions.clear()
    serverPool.stopAll().catch(() => {})
  })
}
