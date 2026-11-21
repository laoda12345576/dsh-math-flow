/**
 * 一个够用的 MCP stdio 客户端。
 *
 * 为什么自己写、而不是让 profile 去挂 `@deepseek-ai/dsh-mcp-client`：
 *
 * 1. **谁能看见哪个工具，是 Danus 的权限边界**。网关按角色决定 `tools/list`
 *    返回什么（`main` 根本没有 `fact_submit`）。如果把挂载交给 profile 里另一行
 *    配置，插件就看不见那份清单，也就无法在测试里断言"main 看不到写入口"。
 *    这里每次启动都读一次 `tools/list`，注册的就是它原样广告出来的东西——
 *    多一个都不注册，少一个也不补。
 * 2. 插件要能在网关起不来时说清楚为什么（doctor 里的 stderr 尾行、退出码），
 *    而不是让宿主在启动日志里翻一段栈。
 * 3. 只用协议本身（initialize / tools/list / tools/call），不依赖宿主的内部
 *    API；宿主升级不会让这里失配。
 *
 * 协议细节：MCP 的 stdio 传输是**每行一条 JSON-RPC**，没有 Content-Length 头。
 */

import { spawn } from 'node:child_process'

/** 我们愿意协商的版本，从新到旧。服务器回的版本我们照单全收。 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const STDERR_KEEP = 40

export class McpError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.data = data
  }
}

export class McpStdioClient {
  /**
   * @param {object} spec
   * @param {string} spec.command 可执行文件
   * @param {string[]} [spec.args]
   * @param {Record<string,string>} [spec.env] 追加到 process.env 之上（不是替换）
   * @param {string} [spec.cwd]
   * @param {string} [spec.label] 出错时用的名字
   * @param {number} [spec.startupTimeoutMs]
   * @param {number} [spec.callTimeoutMs]
   */
  constructor(spec) {
    this.spec = spec
    this.label = spec.label ?? 'mcp'
    this.startupTimeoutMs = spec.startupTimeoutMs ?? 20000
    this.callTimeoutMs = spec.callTimeoutMs ?? 3600000

    this.child = null
    this.state = 'idle' // idle | starting | ready | failed | closed
    this.failure = null
    this.serverInfo = null
    this.protocolVersion = null
    this.stderrTail = []
    this.toolList = null

    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.starting = null
  }

  /** 启动 + 握手 + 取工具清单。重复调用复用同一次。 */
  async start() {
    if (this.state === 'ready') return this
    if (this.state === 'closed') throw new McpError(`${this.label}: client is closed`)
    if (this.starting !== null) return this.starting
    this.starting = this.#boot()
    try {
      await this.starting
      return this
    } finally {
      this.starting = null
    }
  }

  async #boot() {
    this.state = 'starting'
    this.failure = null
    const { command, args = [], env = {}, cwd } = this.spec
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.state = 'failed'
      this.failure = `could not spawn ${command}: ${error.message}`
      throw new McpError(`${this.label}: ${this.failure}`)
    }
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() !== '') this.stderrTail.push(line)
      }
      while (this.stderrTail.length > STDERR_KEEP) this.stderrTail.shift()
    })
    child.on('error', (error) => {
      this.#die(`process error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`
      this.#die(`exited with ${how}`)
    })

    try {
      const init = await this.#handshake()
      this.serverInfo = init?.serverInfo ?? null
      this.protocolVersion = init?.protocolVersion ?? null
      this.toolList = await this.#listTools()
      this.state = 'ready'
    } catch (error) {
      this.state = 'failed'
      this.failure = error.message
      this.kill()
      throw error
    }
  }

  async #handshake() {
    let lastError = null
    for (const protocolVersion of PROTOCOL_VERSIONS) {
      try {
        const result = await this.#request(
          'initialize',
          {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'dsh-plugin-danus', version: '0.1.0' },
          },
          this.startupTimeoutMs,
        )
        this.#notify('notifications/initialized', {})
        return result
      } catch (error) {
        lastError = error
        // 版本不对通常会在 result 里回自己的版本，而不是报错；真报错多半是
        // 解释器/依赖问题，换版本没用，直接抛。
        break
      }
    }
    throw new McpError(`${this.label}: initialize failed: ${lastError?.message ?? 'unknown'}${this.#tail()}`)
  }

  async #listTools() {
    const tools = []
    let cursor
    for (let page = 0; page < 20; page += 1) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {}, this.startupTimeoutMs)
      for (const tool of Array.isArray(result?.tools) ? result.tools : []) tools.push(tool)
      cursor = result?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  /** 调用一个工具。返回 {ok, text, structured, isError}，不抛协议外的东西。 */
  async call(name, args, { timeoutMs } = {}) {
    await this.start()
    try {
      const result = await this.#request(
        'tools/call',
        { name, arguments: args ?? {} },
        timeoutMs ?? this.callTimeoutMs,
      )
      const shaped = shapeResult(result)
      if (shaped.isError) {
        // FastMCP 把真正的异常打在 stderr，客户端只收到一句
        // "Error executing tool foo"。等一下让 stderr 落盘，再把最后一条
        // 异常行捞出来——否则模型看到的是一个没有原因的错误。
        await sleep(50)
        const detail = this.#errorDetail()
        if (detail !== '' && !shaped.text.includes(detail)) {
          shaped.text = `${shaped.text}\n${detail}`
          shaped.detail = detail
        }
      }
      return shaped
    } catch (error) {
      return {
        ok: false,
        isError: true,
        text: error.message,
        error: error.message,
        hint: this.#hint(),
      }
    }
  }

  /** stderr 里最后一条看起来像异常的行。Python traceback 的最后一行就是它。 */
  #errorDetail() {
    for (let i = this.stderrTail.length - 1; i >= 0; i -= 1) {
      const line = this.stderrTail[i].trim()
      if (/^[A-Za-z_][\w.]*(Error|Exception|Warning):\s+\S/.test(line)) return line
      if (/^(PermissionError|RuntimeError|ValueError|FileNotFoundError|KeyError):/.test(line)) return line
    }
    return ''
  }

  async #request(method, params, timeoutMs) {
    if (this.child === null || this.state === 'closed' || this.state === 'failed') {
      throw new McpError(`${this.label}: ${this.failure ?? 'not running'}`)
    }
    const id = this.nextId++
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`${this.label}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.child.stdin.write(line)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new McpError(`${this.label}: write failed: ${error.message}${this.#tail()}`))
      }
    })
  }

  #notify(method, params) {
    if (this.child === null) return
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch {
      /* 通知丢了不影响握手结果，下一次请求会暴露 */
    }
  }

  #onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.#onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // 不走协议就打到 stderr 的服务器（print 调试、警告）不该让客户端崩。
      this.stderrTail.push(line)
      while (this.stderrTail.length > STDERR_KEEP) this.stderrTail.shift()
      return
    }
    if (message.id === undefined || message.id === null) return // 服务器通知
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) {
      entry.reject(
        new McpError(
          `${this.label}: ${entry.method} failed: ${message.error?.message ?? 'unknown error'}`,
          { code: message.error?.code ?? null, data: message.error?.data ?? null },
        ),
      )
    } else {
      entry.resolve(message.result)
    }
  }

  #die(reason) {
    const wasReady = this.state === 'ready'
    if (this.state !== 'closed') this.state = 'failed'
    this.failure = reason
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new McpError(`${this.label}: process died during ${entry.method} (${reason})${this.#tail()}`))
    }
    this.pending.clear()
    if (!wasReady && this.state === 'failed') {
      // 启动阶段就死：start() 里的 await 会拿到 rejection，这里只留状态。
    }
  }

  #tail() {
    const lines = this.stderrTail.slice(-6).join(' | ')
    return lines === '' ? '' : `\n  server stderr: ${lines}`
  }

  #hint() {
    if (this.state === 'ready') return null
    return (
      `${this.label} is not running (${this.failure ?? this.state}). ` +
      'Run danus_doctor; a misconfigured root, a missing interpreter, or a ' +
      'Python venv without the mcp package all look like this.'
    )
  }

  kill() {
    if (this.child === null) {
      this.state = 'closed'
      return
    }
    try {
      this.child.stdin.end()
    } catch {
      /* already gone */
    }
    try {
      this.child.kill()
    } catch {
      /* already gone */
    }
    this.child = null
    if (this.state !== 'failed') this.state = 'closed'
  }
}

/** MCP 的 content 数组 → 一段文本 + 可选的结构化结果。 */
export function shapeResult(result) {
  const isError = result?.isError === true
  const parts = Array.isArray(result?.content) ? result.content : []
  const texts = []
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (part?.type !== undefined) texts.push(`[${part.type}]`)
  }
  const text = texts.join('\n').trim()
  const structured = result?.structuredContent ?? tryJson(text)
  return {
    ok: !isError,
    isError,
    text: text === '' ? (isError ? 'gateway returned an error with no message' : 'ok') : text,
    structured,
  }
}

function tryJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const first = text[0]
  if (first !== '{' && first !== '[') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
