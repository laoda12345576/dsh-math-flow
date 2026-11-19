/**
 * A resident Lean language server, used as the engine for interactive proofs.
 *
 * Why this exists: the previous interactive loop re-spawned `lean` for EVERY step
 * and re-parsed its stdout with regexes. That costs a full process start (~4s for
 * pure Lean) plus a full re-load of the imports (48-69s for `import Mathlib`) on
 * every single tactic. One resident process pays the import cost once.
 *
 * The plugin README claims `$/lean/plainGoal` does not respond on Lean 4.33. That
 * is wrong — measured here, it returns structured goals:
 *   {"goals":["case zero\n⊢ 0 + 0 = 0", "case succ\n..."], "rendered":"..."}
 * The earlier probe almost certainly queried before elaboration settled: Lean first
 * republishes an EMPTY diagnostic set, then the real one. Waiting on the first
 * version-matching diagnostic is what made goals look empty.
 *
 * Two rules learned the hard way, both encoded below:
 *   1. A document must exist on disk before didOpen (the server reads it), but must
 *      NOT be rewritten afterwards — the server's own file watcher would then
 *      re-process it and races the didChange we just sent.
 *   2. "Settled" means: diagnostics for our version arrived AND the notification
 *      stream has been quiet. Not just one of the two.
 *
 * @module dsh-plugin-lean-math/server
 */

import { spawn } from 'node:child_process'

/** How long the notification stream must be quiet before we call a step settled. */
const DEFAULT_QUIET_MS = 700

/** Fallback budget for one server request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300000

/**
 * Turn an absolute OS path into the file URL the LSP wants.
 * @param {string} osPath - absolute path, either slash direction.
 * @returns {string} a `file:///` URL.
 */
export function pathToUri(osPath) {
  const p = String(osPath).replace(/\\/g, '/').replace(/^\/+/, '')
  // A Windows drive letter must keep its colon; encode everything else conservatively.
  return `file:///${p.replace(/ /g, '%20').replace(/#/g, '%23')}`
}

/**
 * Minimal JSON-RPC over stdio client for Lean's language server.
 *
 * Deliberately not a general LSP library: it implements exactly the six messages
 * the interactive loop needs, with hard timeouts on every request so a wedged
 * server can never hang a tool call.
 */
export class LeanServer {
  /**
   * @param {{leanPath: string, cwd: string, env?: Record<string,string>, quietMs?: number,
   *          requestTimeoutMs?: number, onExit?: (info: {code: number|null}) => void}} options - configuration.
   */
  constructor(options) {
    this.leanPath = options.leanPath
    this.cwd = options.cwd
    this.env = options.env ?? process.env
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.onExit = options.onExit

    /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
    this.child = null
    /** Pending requests by id. @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map()
    /** Latest diagnostics per uri. @type {Map<string, {version: number, items: any[]}>} */
    this.diagnostics = new Map()
    /**
     * Latest `$/lean/fileProgress` state per uri: how many regions the server is
     * still elaborating. `processing === 0` means the document is done — the only
     * settled signal Lean cannot fake with an early empty diagnostics batch.
     * @type {Map<string, {processing: number, version: number, at: number}>}
     */
    this.fileProgress = new Map()
    /** Document version per uri. @type {Map<string, number>} */
    this.versions = new Map()
    /** Text currently held by the server, per uri (the server's copy). @type {Map<string, string>} */
    this.texts = new Map()

    this.nextId = 0
    this.buffer = Buffer.alloc(0)
    this.lastActivityAt = Date.now()
    this.started = null
    this.dead = false
    this.exitInfo = null
    /** Consecutive request timeouts; a wedged server must be replaced, not retried. */
    this.timeouts = 0
  }

  get alive() {
    return this.child !== null && !this.dead && this.child.exitCode === null
  }

  /**
   * Launch the server and complete the LSP handshake.
   * @returns {Promise<void>} resolves once initialized.
   */
  async start() {
    if (this.started !== null) return this.started
    this.started = this.#start()
    return this.started
  }

  async #start() {
    this.child = spawn(this.leanPath, ['--server'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.on('exit', (code) => {
      this.dead = true
      this.exitInfo = { code: code ?? null }
      // Reject anything outstanding: a dead server must fail loudly, not hang.
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`lean server exited (code ${code})`))
      }
      this.pending.clear()
      if (typeof this.onExit === 'function') this.onExit(this.exitInfo)
    })
    this.child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.child.stderr.on('data', () => { /* Lean's stderr is chatter, not protocol */ })

    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToUri(this.cwd),
      capabilities: {},
      workspaceFolders: null,
    }, this.requestTimeoutMs)
    this.notify('initialized', {})
  }

  /** Feed raw bytes through the Content-Length framing. @param {Buffer} chunk - bytes. */
  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, headerEnd).toString('ascii'))
      if (!match) { this.buffer = this.buffer.slice(headerEnd + 4); continue }
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.slice(bodyStart + length)
      let message
      try { message = JSON.parse(body) } catch { continue }
      this.#onMessage(message)
    }
  }

  /** @param {any} message - a decoded JSON-RPC message. */
  #onMessage(message) {
    this.lastActivityAt = Date.now()
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      this.timeouts = 0
      if (message.error !== undefined) entry.reject(new Error(`${message.error.message ?? 'server error'}`))
      else entry.resolve(message.result)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const uri = message.params?.uri
      if (typeof uri === 'string') {
        this.diagnostics.set(uri, {
          version: Number(message.params.version ?? -1),
          items: Array.isArray(message.params.diagnostics) ? message.params.diagnostics : [],
        })
      }
    }
    if (message.method === '$/lean/fileProgress') {
      const td = message.params?.textDocument
      const uri = td?.uri
      if (typeof uri === 'string') {
        const processing = Array.isArray(message.params?.processing) ? message.params.processing.length : 0
        this.fileProgress.set(uri, { processing, version: Number(td?.version ?? -1), at: Date.now() })
      }
    }
  }

  /** @param {string} method - method name. @param {any} params - params. */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Send a request and wait for its response.
   * @param {string} method - method name.
   * @param {any} params - params.
   * @param {number} [timeoutMs] - per-request budget.
   * @returns {Promise<any>} the result.
   */
  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.alive && method !== 'initialize') {
      return Promise.reject(new Error('lean server is not running'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.timeouts += 1
        // Missing the budget once can be a slow load; missing it repeatedly means the
        // server is wedged. Mark it dead so the pool replaces it on the next call
        // instead of timing out on every step forever after.
        if (this.timeouts >= 3) {
          this.dead = true
          try { this.child?.kill() } catch { /* already gone */ }
        }
        reject(
          new Error(
            `lean server request timed out after ${timeoutMs} ms: ${method}. ` +
              'If this is the first step of a session with heavy imports it may simply still be ' +
              'loading — raise interactiveTimeoutMs. Repeated timeouts replace the server.'
          )
        )
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** @param {any} message - message to send. */
  #write(message) {
    if (this.child === null || this.child.stdin.destroyed) {
      throw new Error('lean server stdin is closed')
    }
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }

  /**
   * Open a document. The file must already exist on disk.
   * @param {string} uri - document uri.
   * @param {string} text - initial source.
   * @param {number} [timeoutMs] - budget.
   * @returns {Promise<{diagnostics: any[]}>} the settled state.
   */
  async openDocument(uri, text, timeoutMs = this.requestTimeoutMs) {
    await this.start()
    this.versions.set(uri, 1)
    this.texts.set(uri, text)
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'lean', version: 1, text },
    })
    await this.#settled(uri, 1, timeoutMs)
    return { diagnostics: this.diagnosticsFor(uri) }
  }

  /**
   * Replace a document's whole text.
   * @param {string} uri - document uri.
   * @param {string} text - the new source.
   * @param {number} [timeoutMs] - budget.
   * @returns {Promise<{diagnostics: any[], version: number}>} the settled state.
   */
  async updateDocument(uri, text, timeoutMs = this.requestTimeoutMs) {
    await this.start()
    const version = (this.versions.get(uri) ?? 0) + 1
    this.versions.set(uri, version)
    this.texts.set(uri, text)
    const lines = text.split('\n')
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1].length },
        },
        text,
      }],
    })
    await this.#settled(uri, version, timeoutMs)
    return { diagnostics: this.diagnosticsFor(uri), version }
  }

  /**
   * Wait until the server has settled for a document version.
   * @param {string} uri - document uri.
   * @param {number} version - version we are waiting on.
   * @param {number} timeoutMs - budget.
   * @returns {Promise<void>} resolves when settled.
   */
  async #settled(uri, version, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    const startedAt = Date.now()
    // A stale `processing: 0` left over from a previous version would settle us
    // instantly, so require proof that THIS version was elaborated: either we saw
    // the server go busy for it, or the drained signal arrived after we started.
    let sawBusy = false
    for (;;) {
      const prog = this.fileProgress.get(uri)
      const seen = this.diagnostics.get(uri)
      const quiet = Date.now() - this.lastActivityAt >= this.quietMs
      if (prog !== undefined) {
        if (prog.version >= version && prog.processing > 0) sawBusy = true
        const drainedFresh = prog.processing === 0 && prog.at >= startedAt
        // The signal Lean cannot fake: no region of this document is still being
        // elaborated. (The old empty-diagnostics batch fooled the previous check.)
        if (prog.version >= version && prog.processing === 0 && (sawBusy || drainedFresh) && quiet) return
      } else if (Date.now() - startedAt > 5000) {
        // The server never emitted fileProgress for this document (older Lean that
        // does not send it). Only then fall back to the diagnostics heuristic.
        if (seen !== undefined && seen.version >= version && quiet) return
      }
      if (!this.alive) throw new Error('lean server died while elaborating')
      if (Date.now() > deadline) {
        throw new Error(
          `lean server did not settle for ${uri} v${version} within ${timeoutMs} ms ` +
            `(diagnostics v${seen?.version ?? 'none'}, ` +
            `fileProgress ${prog !== undefined ? `processing=${prog.processing} v${prog.version}` : 'none'}). ` +
            'A cold Mathlib load can take minutes — raise interactiveTimeoutMs, or narrow the imports.'
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /**
   * Latest diagnostics for a document.
   * @param {string} uri - document uri.
   * @returns {any[]} diagnostics (possibly empty).
   */
  diagnosticsFor(uri) {
    return this.diagnostics.get(uri)?.items ?? []
  }

  /**
   * Structured goals at a position.
   * @param {string} uri - document uri.
   * @param {{line: number, character: number}} position - 0-based position.
   * @param {number} [timeoutMs] - budget.
   * @returns {Promise<string[]>} the pretty-printed goals; empty when there are none.
   */
  async goalsAt(uri, position, timeoutMs = this.requestTimeoutMs) {
    const result = await this.request('$/lean/plainGoal', { textDocument: { uri }, position }, timeoutMs)
    return Array.isArray(result?.goals) ? result.goals : []
  }

  /**
   * The expected type of the term at a position ("term goal").
   * @param {string} uri - document uri.
   * @param {{line: number, character: number}} position - 0-based position.
   * @param {number} [timeoutMs] - budget.
   * @returns {Promise<string|null>} the rendered type, or null.
   */
  async termGoalAt(uri, position, timeoutMs = this.requestTimeoutMs) {
    const result = await this.request('$/lean/plainTermGoal', { textDocument: { uri }, position }, timeoutMs)
    return typeof result?.goal === 'string' ? result.goal : null
  }

  /**
   * Close a document in the server.
   * @param {string} uri - document uri.
   * @returns {Promise<void>} completion.
   */
  async closeDocument(uri) {
    if (!this.alive) return
    this.notify('textDocument/didClose', { textDocument: { uri } })
    this.versions.delete(uri)
    this.texts.delete(uri)
    this.diagnostics.delete(uri)
    this.fileProgress.delete(uri)
  }

  /**
   * Shut the server down.
   * @returns {Promise<void>} completion.
   */
  async stop() {
    if (this.child === null) return
    const child = this.child
    this.child = null
    this.dead = true
    try {
      this.notify('shutdown', {})
      this.notify('exit', {})
    } catch { /* stdin may already be gone */ }
    // A server holding a multi-GB Mathlib image may not exit promptly; don't wait forever.
    await Promise.race([
      new Promise((resolve) => child.on('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    try { child.kill() } catch { /* already gone */ }
  }
}

/**
 * A pool of resident servers, one per project directory.
 *
 * Keyed by project dir so `import Mathlib` is loaded ONCE per project and then
 * shared by every session and every tactic, instead of once per step.
 */
export class LeanServerPool {
  /**
   * @param {{resolveLean: () => Promise<string|null>, resolveEnv: (projectDir: string) => Promise<Record<string,string>|null>,
   *          quietMs?: number, requestTimeoutMs?: number, installHint?: string, idleMs?: number}} options - configuration.
   */
  constructor(options) {
    this.resolveLean = options.resolveLean
    this.resolveEnv = options.resolveEnv
    this.quietMs = options.quietMs
    this.requestTimeoutMs = options.requestTimeoutMs
    this.installHint = options.installHint ?? ''
    /** How long an unreferenced server may sit idle before being shut down. 0 = never. */
    this.idleMs = options.idleMs ?? 0
    /** @type {Map<string, {server: LeanServer, refs: number, lastUsedAt: number}>} */
    this.servers = new Map()
    /** Resolved environments, so CLI-side callers can reuse the same LEAN_PATH. */
    this.envs = new Map()
  }

  /**
   * The environment a project's server runs with, resolved once and cached.
   *
   * Used by callers that must spawn `lean` directly (a `#check` query) so they see
   * the same imports as the resident server instead of an empty LEAN_PATH.
   * @param {string} projectDir - lake project, or '' for plain Lean.
   * @returns {Promise<Record<string,string>|null>} the environment, or null for plain Lean.
   */
  async envFor(projectDir) {
    if (!projectDir) return null
    if (this.envs.has(projectDir)) return this.envs.get(projectDir)
    const env = await this.resolveEnv(projectDir)
    if (env !== null) this.envs.set(projectDir, env)
    return env
  }

  /**
   * Shut down servers nobody is using any more.
   *
   * A resident Mathlib server pins a multi-GB image in RAM, which is only worth it
   * while proofs are actually running. Reaping is lazy (on acquire) rather than on
   * a timer, so it cannot keep the host process alive.
   * @returns {void} nothing.
   */
  #reapIdle() {
    if (this.idleMs <= 0) return
    const now = Date.now()
    for (const [key, entry] of this.servers) {
      if (entry.refs > 0) continue
      if (now - entry.lastUsedAt < this.idleMs) continue
      this.servers.delete(key)
      entry.server.stop().catch(() => {})
    }
  }

  /**
   * Get (or lazily start) the server for a project.
   * @param {string} projectDir - lake project, or '' for plain Lean.
   * @returns {Promise<LeanServer>} the live server.
   */
  /**
   * Get a server WITHOUT holding a reference — for the many calls made inside an
   * already-open session. Callers that own a session's lifetime must use acquire().
   * @param {string} projectDir - lake project, or '' for plain Lean.
   * @returns {Promise<LeanServer>} the live server.
   */
  async get(projectDir) {
    const key = projectDir || '(plain)'
    const entry = this.servers.get(key)
    if (entry !== undefined && entry.server.alive) {
      entry.lastUsedAt = Date.now()
      return entry.server
    }
    // Nothing live (first use, or the server died). Start one WITHOUT taking a
    // reference: this path is a borrow, and a reference that nobody releases would
    // pin a multi-GB Mathlib image forever.
    const server = await this.#startServer(projectDir)
    this.servers.set(key, { server, refs: 0, lastUsedAt: Date.now() })
    return server
  }

  /**
   * Take a reference on the server for a project.
   * @param {string} projectDir - lake project, or '' for plain Lean.
   * @returns {Promise<LeanServer>} the live server.
   */
  async acquire(projectDir) {
    this.#reapIdle()
    const key = projectDir || '(plain)'
    const existing = this.servers.get(key)
    if (existing !== undefined && existing.server.alive) {
      existing.refs += 1
      existing.lastUsedAt = Date.now()
      return existing.server
    }
    if (existing !== undefined) this.servers.delete(key) // it died; replace it

    const server = await this.#startServer(projectDir)
    this.servers.set(key, { server, refs: 1, lastUsedAt: Date.now() })
    return server
  }

  /**
   * Launch and initialize a server for a project.
   * @param {string} projectDir - lake project, or '' for plain Lean.
   * @returns {Promise<LeanServer>} the running server.
   */
  async #startServer(projectDir) {
    const lean = await this.resolveLean()
    if (lean === null) throw new Error(`Lean not installed on PATH. ${this.installHint}`.trim())
    const env = (await this.envFor(projectDir)) ?? process.env
    const server = new LeanServer({
      leanPath: lean,
      cwd: projectDir || '.',
      env,
      ...(this.quietMs === undefined ? {} : { quietMs: this.quietMs }),
      ...(this.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.requestTimeoutMs }),
    })
    await server.start()
    return server
  }

  /**
   * Give a server back. It is only actually stopped once nothing references it and
   * it has been idle past `idleMs`.
   * @param {string} projectDir - the project the server belongs to.
   * @returns {void} nothing.
   */
  release(projectDir) {
    const entry = this.servers.get(projectDir || '(plain)')
    if (entry === undefined) return
    entry.refs = Math.max(0, entry.refs - 1)
    entry.lastUsedAt = Date.now()
    if (entry.refs === 0 && this.idleMs <= 0) {
      // No idle policy configured: releasing is the only signal we get, so stop now
      // rather than pinning a multi-GB image forever.
      this.servers.delete(projectDir || '(plain)')
      entry.server.stop().catch(() => {})
    }
  }

  /** Shut every server down. @returns {Promise<void>} completion. */
  async stopAll() {
    const all = [...this.servers.values()]
    this.servers.clear()
    await Promise.all(all.map((entry) => entry.server.stop().catch(() => {})))
  }
}
