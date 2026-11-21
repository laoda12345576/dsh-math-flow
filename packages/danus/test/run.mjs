#!/usr/bin/env node
/**
 * 确定性测试：不依赖真 Danus，也不依赖 dsh 运行时。
 *
 * 盯的是会真出事的六件事：
 *   1. 角色边界：注册的工具集必须等于网关**广告**的，main 不能有 fact_submit
 *   2. 参数映射：MCP 的 JSON Schema 不能被翻成 dsh 装不下的形状（defineTool 会抛）
 *   3. argv 拼装：项目名/角色串/paper id 在本地就挡住，不把 traceback 丢给模型
 *   4. 进程死了/挂住了：要报出原因（stderr 尾行、超时），不能静默
 *   5. 不可逆动作：finalize 与 force stop 缺 approved 必须拒
 *   6. doctor：verify 服务不在要说出来，而不是让 fact_submit 自己去失败
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { buildCliArgs, condense, splitTarget, toToolResult, validateProject, readOutput } from '../lib/control.js'
import { mapSchema } from '../lib/schema.js'
import { shQuote, toWslPath, launchFor, resetWslCache } from '../lib/launch.js'
import { McpStdioClient, shapeResult } from '../lib/mcp.js'
import { doctor } from '../lib/doctor.js'
import { apply } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath
const GATEWAY = join(HERE, 'stub-gateway.mjs')
const CLI = join(HERE, 'stub-danus.mjs')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`[PASS] ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail += 1
    console.log(`[FAIL] ${label}${extra ? `  ${extra}` : ''}`)
  }
}
const section = (name) => console.log(`\n--- ${name} ---`)

const work = mkdtempSync(join(tmpdir(), 'danus-plugin-'))
const cleanup = []
process.on('exit', () => {
  for (const fn of cleanup) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 一个假的 Danus 根，结构够 doctor 检查。 */
const ROOT = join(work, 'danus-root')
mkdirSync(join(ROOT, 'bin'), { recursive: true })
mkdirSync(join(ROOT, 'danus', 'gateway'), { recursive: true })
mkdirSync(join(ROOT, 'runtime', 'projects', 'collatz'), { recursive: true })
writeFileSync(join(ROOT, 'bin', 'danus'), '#!/usr/bin/env bash\nexit 0\n', 'utf8')
writeFileSync(join(ROOT, 'bin', 'danus-mcp'), '#!/usr/bin/env bash\nexit 0\n', 'utf8')
try {
  chmodSync(join(ROOT, 'bin', 'danus'), 0o755)
  chmodSync(join(ROOT, 'bin', 'danus-mcp'), 0o755)
} catch {
  /* Windows: chmod is a no-op */
}

function withEnv(vars, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const baseConfig = (extra = {}) => {
  const solved = resolveConfig(
    {
      root: ROOT,
      verifyUrl: 'http://127.0.0.1:59999/verify',
      launch: { mode: 'command', command: { gateway: [NODE, GATEWAY], cli: [NODE, CLI] } },
      ...extra,
    },
    {},
  )
  return solved
}

// ═══ 1. 配置 ════════════════════════════════════════════════════════════════
section('config')
{
  const missing = resolveConfig({}, {})
  ok(!missing.ok && missing.problems.some((p) => /root/.test(p)), 'no root → 明确报错，不靠猜')

  const fromEnv = resolveConfig({}, { DANUS_ROOT: ROOT, VERIFY_PORT: '8091' })
  ok(fromEnv.ok && fromEnv.config.root === ROOT, 'DANUS_ROOT 可以顶替 config.root')
  ok(fromEnv.config.verifyUrl === 'http://127.0.0.1:8091/verify', 'verifyUrl 跟着 VERIFY_PORT 走')
  ok(fromEnv.config.agentsRoot === join(ROOT, 'runtime', 'projects'), 'agentsRoot 默认 <root>/runtime/projects')

  const bad = resolveConfig({ root: ROOT, launch: { mode: 'teleport' } }, {})
  ok(!bad.ok && bad.problems.some((p) => /launch.mode/.test(p)), '非法 launch.mode 被拒')

  const emptyCmd = resolveConfig({ root: ROOT, launch: { mode: 'command' } }, {})
  ok(!emptyCmd.ok, 'mode=command 但没有 argv → 拒')

  const argv = resolveConfig({ root: ROOT, launch: { command: [NODE, 'x.mjs'] } }, {})
  ok(argv.config.launch.command.gateway.join() === [NODE, 'x.mjs'].join(), 'argv 形式对两端都生效')
}

// ═══ 2. 参数映射 ════════════════════════════════════════════════════════════
section('schema mapping')
{
  const mapped = mapSchema({
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'k' },
      glossary: { type: 'object', description: 'symbols', additionalProperties: { type: 'string' } },
      predecessors: { type: 'array', items: { type: 'string' } },
      count: { type: 'integer' },
      mode: { type: 'string', enum: ['a', 'b'] },
      weird: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      nothing: {},
    },
    required: ['kind', 'predecessors'],
  })
  ok(mapped.parameters.kind.type === 'string', 'string 原样')
  ok(mapped.parameters.kind.required === true, 'required 从父级带下来')
  ok(mapped.parameters.glossary.type === 'object' && mapped.parameters.glossary.additionalProperties === true, 'object 退成开放对象')
  ok(mapped.parameters.predecessors.type === 'array' && mapped.parameters.predecessors.items.type === 'json', 'array 的 items 退成 json')
  ok(mapped.parameters.mode.enum.join() === 'a,b', 'enum 保留')
  ok(mapped.parameters.weird.type === 'json', 'anyOf 不猜，退成 json')
  ok(mapped.parameters.nothing.type === 'json', '无 type 退成 json')
  // object / array / anyOf / 无 type 各自变宽一次；string、integer、enum 是精确的。
  ok(mapped.widened === 4, '变宽计数准确（4 个退成弱约束）', `widened=${mapped.widened}`)
}

// ═══ 3. argv 拼装 ═══════════════════════════════════════════════════════════
section('control argv')
{
  ok(buildCliArgs('list', {}).args.join(' ') === 'list --json', 'list 默认要 --json')
  ok(buildCliArgs('new', { project: 'collatz', roles: 'high:3,xhigh:4' }).args.join(' ') === 'new collatz --roles high:3,xhigh:4', 'new 带 roles')
  ok(!buildCliArgs('new', { project: 'bad name' }).ok, '项目名带空格 → 拒（网关用的是同一个正则）')
  ok(!buildCliArgs('new', { project: 'x', roles: 'high三个' }).ok, 'roles 形状不对 → 拒')
  ok(!buildCliArgs('assign', { target: 'collatz' }).ok, 'assign 不接受裸项目名')
  ok(buildCliArgs('assign', { target: 'collatz/w1', task: 'prove lemma 3' }).args.join(' ') === 'assign collatz/w1 --task prove lemma 3', 'assign 传 task')
  ok(!buildCliArgs('assign', { target: 'collatz/w1', task: '   ' }).ok, '空 task → 拒（TASK.md 不能空）')
  ok(buildCliArgs('finalize', { project: 'collatz', fact_ids: ['a', 'b'] }).args.join(' ') === 'finalize collatz a b', 'finalize 多个 fact')
  ok(buildCliArgs('finalize', { project: 'collatz', paper: 'p1', fact_ids: ['a'] }).args.join(' ') === 'finalize collatz --paper p1 a', 'finalize 指定 paper')
  ok(!buildCliArgs('finalize', { project: 'collatz', paper: '../etc', fact_ids: ['a'] }).ok, 'paper id 越界 → 拒')
  ok(buildCliArgs('stop', { target: 'collatz', force: true }).args.join(' ') === 'stop collatz --force', 'stop --force')
  ok(!buildCliArgs('status', { target: 'a/b/c' }).ok, '三段 target → 拒')
  ok(splitTarget('collatz/w1').worker === 'w1', 'splitTarget 拆出 worker')
  ok(validateProject('erdos-42').ok, '合法项目名通过')
  ok(readOutput('{"a":1}').json.a === 1, 'JSON 输出被解析')
  ok(readOutput('plain text').json === null, '非 JSON 原样')

  const traceback = [
    'Traceback (most recent call last):',
    '  File "D:////tmp////danus-src////danus////orchestration////cli.py", line 25, in <module>',
    '    import fcntl',
    "ModuleNotFoundError: No module named 'fcntl'",
  ].join('\n')
  const condensed = condense(traceback)
  ok(/ModuleNotFoundError: No module named 'fcntl'/.test(condensed), 'traceback 压成结论那一句')
  ok(/line 25/.test(condensed), '顺带保留出错位置（便于定位）')
  ok(condense(traceback).length < traceback.length, '压缩确实更短')

  const fcntlResult = toToolResult('list', { code: 1, stdout: '', stderr: traceback, timedOut: false })
  ok(fcntlResult.ok === false && /POSIX/.test(fcntlResult.hint), 'fcntl 失败 → 指出这是 POSIX 限制，不是配置错')
  ok(/WSL/.test(fcntlResult.hint), '并且给出可执行的出路')
}

// ═══ 4. launch ══════════════════════════════════════════════════════════════
section('launch')
{
  ok(toWslPath('D:\\Danus') === '/mnt/d/Danus', 'D:\\Danus → /mnt/d/Danus')
  ok(toWslPath('C:/a b/c') === '/mnt/c/a b/c', 'C:/a b/c → /mnt/c/a b/c')
  ok(toWslPath('/mnt/d/x') === '/mnt/d/x', '已是 POSIX 路径不动')
  ok(toWslPath('\\\\wsl$\\Ubuntu\\home\\x') === '/home/x', '\\\\wsl$ 的 UNC 转成 /home/x')
  ok(shQuote("it's") === `'it'\\''s'`, '单引号转义')
  resetWslCache()

  const { config } = baseConfig()
  const gw = launchFor(config, 'gateway')
  ok(gw.command === NODE && gw.args[0] === GATEWAY, 'command 模式：网关用给定 argv')
  const cli = launchFor(config, 'cli', ['list', '--json'])
  ok(cli.args.slice(-2).join(' ') === 'list --json', 'command 模式：CLI 参数追加在后')

  const wslCfg = { ...config, launch: { ...config.launch, mode: 'wsl' } }
  const wsl = launchFor(wslCfg, 'cli', ['status', "proj'x"])
  ok(wsl.args.includes('-lc'), 'wsl 模式走 bash -lc')
  ok(wsl.args[wsl.args.indexOf('_') + 1] === toWslPath(ROOT), 'wsl 模式下 root 作为 argv 传入并被转成 /mnt 路径')
  ok(wsl.args[wsl.args.length - 1] === "proj'x", '参数走 argv，不拼进 shell 字符串')

  const split = { ...config, launch: { ...config.launch, mode: { gateway: 'python', cli: 'wsl' } } }
  ok(launchFor(split, 'gateway').mode === 'python', '两个进程可以各用各的启动方式：网关 python')
  ok(launchFor(split, 'cli').mode === 'wsl', '两个进程可以各用各的启动方式：CLI wsl')

  const bashCfg = { ...config, launch: { ...config.launch, mode: 'bash' } }
  const bash = launchFor(bashCfg, 'gateway')
  ok(bash.command === 'bash' && bash.args[0].endsWith('danus-mcp'), 'bash 模式用 bin/danus-mcp')
}

section('pycompat（Windows 上的 POSIX 缺口）')
{
  const compat = join(dirname(fileURLToPath(import.meta.url)), '..', 'pycompat')
  ok(existsSync(join(compat, 'fcntl.py')), 'fcntl shim 随包发布')
  ok(existsSync(join(compat, 'sitecustomize.py')), 'sitecustomize 随包发布')

  const fcntlSrc = readFileSync(join(compat, 'fcntl.py'), 'utf8')
  ok(/def flock/.test(fcntlSrc) && /msvcrt\.locking/.test(fcntlSrc), 'flock 用 msvcrt.locking 实现')
  ok(/BlockingIOError/.test(fcntlSrc), 'LOCK_NB 失败转成 BlockingIOError（cli.py 只捕这个）')
  ok(/os\.lseek\(fd, 0/.test(fcntlSrc), '每次锁都把偏移归零（msvcrt 从当前位置锁）')

  const siteSrc = readFileSync(join(compat, 'sitecustomize.py'), 'utf8')
  ok(/OpenProcess/.test(siteSrc), '存活探测走 OpenProcess')
  ok(/os\.kill = kill/.test(siteSrc), 'os.kill 被替换（Windows 原版 sig=0 会 TerminateProcess）')
  ok(/taskkill/.test(siteSrc), 'killpg 换成 taskkill /T')

  const base = baseConfig().config
  const pySpec = launchFor(
    { ...base, launch: { ...base.launch, mode: 'python', python: 'python' } },
    'cli',
  )
  const entries = pySpec.env.PYTHONPATH.split(process.platform === 'win32' ? ';' : ':')
  ok(entries[0].endsWith('pycompat'), 'pycompat 排在 PYTHONPATH 最前（sitecustomize 只认第一个）', entries[0])
  ok(entries.includes(ROOT), 'root 仍在 PYTHONPATH 里，否则 import danus 失败')
}

// ═══ 5. MCP 客户端 ══════════════════════════════════════════════════════════
section('mcp client')
{
  const log = join(work, 'gateway-calls.jsonl')
  const mk = (env = {}) =>
    new McpStdioClient({
      command: NODE,
      args: [GATEWAY],
      env: { DANUS_ROLE: 'main', DANUS_STUB_LOG: log, ...env },
      label: 'stub gateway',
      startupTimeoutMs: 8000,
      callTimeoutMs: 4000,
    })

  const main = mk()
  cleanup.push(() => main.kill())
  await main.start()
  const names = main.toolList.map((t) => t.name)
  ok(names.includes('gm_add') && names.includes('fact_revoke'), 'main 看得见 gm_add / fact_revoke')
  ok(!names.includes('fact_submit'), 'main 看不到 fact_submit（这是边界，不是缺功能）')

  const call = await main.call('gm_add', { kind: 'master_guidance', claim: 'x', project: 'collatz' })
  ok(call.ok && call.structured?.role === 'main', 'tools/call 结果被解出 structuredContent')
  const logged = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  ok(logged[0].args.project === 'collatz', '参数原样透传（project 没被吞掉）')

  const unknown = await main.call('fact_submit', { statement: 's', proof: 'p' })
  ok(!unknown.ok && /unknown tool/.test(unknown.text), '越权调用被网关拒，插件如实转达')

  const worker = mk({ DANUS_ROLE: 'worker' })
  cleanup.push(() => worker.kill())
  await worker.start()
  ok(worker.toolList.some((t) => t.name === 'fact_submit'), 'worker 才有 fact_submit')

  const verifier = mk({ DANUS_ROLE: 'verifier' })
  cleanup.push(() => verifier.kill())
  await verifier.start()
  ok(verifier.toolList.length === 1 && verifier.toolList[0].name === 'search_arxiv_theorems', 'verifier 只剩检索')

  const dead = mk({ DANUS_STUB_MODE: 'die' })
  let deadError = ''
  try {
    await dead.start()
  } catch (error) {
    deadError = error.message
  }
  ok(/exited with code 3/.test(deadError), '启动即死 → 报退出码', deadError.slice(0, 60))
  ok(/DANUS_STUB_MODE=die/.test(deadError), '把服务器 stderr 带出来（否则只看到"exit 3"）')

  const garbage = mk({ DANUS_STUB_MODE: 'garbage' })
  cleanup.push(() => garbage.kill())
  await garbage.start()
  ok(garbage.toolList.length > 0, 'stdout 里混进非 JSON 也不崩')

  const hang = mk({ DANUS_STUB_MODE: 'hang_tool' })
  cleanup.push(() => hang.kill())
  await hang.start()
  const started = Date.now()
  const hung = await hang.call('gm_search', { query: 'x' }, { timeoutMs: 1200 })
  ok(!hung.ok && /timed out/.test(hung.text), '调用挂住 → 超时而不是永远等', `${Date.now() - started}ms`)

  const tb = mk({ DANUS_STUB_MODE: 'traceback_error' })
  cleanup.push(() => tb.kill())
  await tb.start()
  const tbResult = await tb.call('fact_search', { query: 'x', project: 'ghost' })
  ok(!tbResult.ok && /no such project/.test(tbResult.text), '错误细节从 stderr 捞回来（FastMCP 只回一句空话）', tbResult.text.replace(/\n/g, ' | ').slice(0, 80))

  ok(shapeResult({ content: [{ type: 'text', text: 'plain' }] }).text === 'plain', 'content 文本')
  ok(shapeResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }).ok === false, 'isError 被识别')
}

// ═══ 6. 插件装配 ════════════════════════════════════════════════════════════
section('plugin apply')
{
  const log = join(work, 'cli-calls.jsonl')
  process.env.DANUS_STUB_LOG = log
  const registered = new Map()
  let promptText = null
  const ctx = {
    tools: { register: (def) => registered.set(def.name, def) },
    systemPrompt: { section: (spec) => { promptText = spec.text() } },
  }
  const { config } = baseConfig({ launch: { mode: 'command', command: { gateway: [NODE, GATEWAY], cli: [NODE, CLI] } } })
  const state = await apply(ctx, {
    root: ROOT,
    verifyUrl: config.verifyUrl,
    launch: { mode: 'command', command: { gateway: [NODE, GATEWAY], cli: [NODE, CLI] } },
  })
  cleanup.push(() => state?.client?.kill())

  const names = [...registered.keys()]
  ok(names.includes('danus_doctor'), '控制面注册 danus_doctor')
  for (const verb of ['list', 'new', 'assign', 'finalize', 'start', 'status', 'stop']) {
    ok(names.includes(`danus_${verb}`), `控制面注册 danus_${verb}`)
  }
  ok(names.includes('danus_gm_add') && names.includes('danus_fact_search'), '网关工具带 danus_ 前缀')
  ok(!names.includes('danus_fact_submit'), 'main 面没有 danus_fact_submit')
  ok(promptText !== null && /不做数学/.test(promptText), '系统提示注入成功')

  // defineTool 在注册时就校验参数 schema：走到这里说明映射全部合法。
  const gw = registered.get('danus_gm_add')
  ok(gw.parameters.properties.project !== undefined, 'gm_add 的 project 参数保留')
  ok(gw.parameters.required?.includes('kind'), 'required 保留')

  const r1 = await gw.execute({ kind: 'master_guidance', claim: 'go left', project: 'collatz' }, {})
  ok(r1.ok && r1.data.role === 'main', 'danus_gm_add 代理到网关')

  const listTool = registered.get('danus_list')
  const listResult = await listTool.execute({}, {})
  ok(listResult.ok && Array.isArray(listResult.data) && listResult.data.length === 2, 'danus_list 解析 --json')

  const fin = registered.get('danus_finalize')
  const denied = await fin.execute({ project: 'collatz', fact_ids: ['fa'] }, {})
  ok(denied.ok === false && /approval/.test(denied.error), 'finalize 没有 approved → 拒')
  const allowed = await fin.execute({ project: 'collatz', fact_ids: ['fa'], approved: true }, {})
  ok(allowed.ok === true, '带 approved 才放行', JSON.stringify(allowed).slice(0, 80))

  const stopTool = registered.get('danus_stop')
  const forceDenied = await stopTool.execute({ target: 'collatz', force: true }, {})
  ok(forceDenied.ok === false, 'force stop 没有 approved → 拒')
  const graceful = await stopTool.execute({ target: 'collatz' }, {})
  ok(graceful.ok === true, '优雅 stop 不需要审批')

  ok(readFileSync(log, 'utf8').includes('"finalize"'), '拒绝的那次没有真的调 CLI，放行的那次调了')

  const doc = await registered.get('danus_doctor').execute({}, {})
  const byName = Object.fromEntries(doc.checks.map((c) => [c.name, c]))
  ok(byName.gateway.ok === true, 'doctor 认为网关正常（工具清单按角色核对过）')
  ok(byName['tool surface'].ok === true, 'doctor 核对"广告的都注册了"')
  ok(byName.cli.ok === true, 'doctor 能跑通 CLI')
  ok(byName['verify service'].ok === false, 'verify 服务不在 → 报红（不装没事）')
}

// ═══ 7. doctor 的 verify 探测 ═══════════════════════════════════════════════
section('doctor / verify probe')
{
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  cleanup.push(() => server.close())

  const { config } = baseConfig({ verifyUrl: `http://127.0.0.1:${port}/verify` })
  // DSH_HOME 指向一个不存在的目录：这条用例断言的是「没装 skill 要红」，不能因为
  // 运行测试的机器上恰好装了（现在这台就装了）就变绿。
  const noSkills = { ...process.env, DSH_HOME: join(tmpdir(), 'danus-test-no-such-home') }
  const report = await doctor(config, {
    env: noSkills,
    reprobe: async () => ({ ok: true, tools: ['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems'] }),
    registered: [],
  })
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]))
  ok(byName['verify service'].ok === true, 'verifyUrl 的 /verify 被换写成 /health 探测')
  ok(byName.gateway.ok === true, '角色应有的工具都在 → 绿')
  ok(byName.skills.ok === false, 'skill 没装 → 红（提示去哪装）')
  ok(report.ok === false && report.failed.includes('skills'), '总判定为 false 且点名 failures')

  const leaked = await doctor(config, {
    reprobe: async () => ({ ok: true, tools: ['gm_add', 'fact_submit'] }),
  })
  const gwCheck = leaked.checks.find((c) => c.name === 'gateway')
  ok(gwCheck.ok === false && /LEAKED/.test(gwCheck.detail), 'main 面出现 fact_submit → doctor 报 LEAKED')
}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail} =====`)
if (fail > 0) process.exitCode = 1
else setTimeout(() => process.exit(0), 50)
