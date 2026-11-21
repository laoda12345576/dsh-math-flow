#!/usr/bin/env node
/**
 * 桩网关：真的说 MCP stdio（每行一条 JSON-RPC），真的按角色裁工具。
 *
 * 存在的理由：要断言"main 看不到 fact_submit"，就得有一个**会按角色裁剪**的
 * 对端。用真网关跑测试要么需要 Python 环境，要么慢，而且没法构造"进程中途死掉"
 * "调用挂住不返回"这类失败——而那正是客户端最容易写错的地方。
 *
 * 开关（环境变量）：
 *   DANUS_ROLE       main(默认) | worker | verifier | all，规则抄自 roles.py
 *   DANUS_STUB_LOG   每次 tools/call 追加一行 JSON 到这个文件
 *   DANUS_STUB_MODE  ok(默认) | die（启动即退） | hang_tool（tools/call 不回）
 *                    | garbage（先往 stdout 打一行非 JSON，再正常工作）
 *                    | traceback_error（错误细节只在 stderr，回一句没信息的话）
 *   DANUS_STUB_CALL_DELAY_MS  每次 tools/call 前等一会
 */

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const ROLE_TOOLS = {
  worker: ['gm_add', 'gm_search', 'fact_submit', 'fact_search', 'search_arxiv_theorems'],
  main: ['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems'],
  verifier: ['search_arxiv_theorems'],
  all: ['gm_add', 'gm_search', 'fact_submit', 'fact_search', 'fact_revoke', 'search_arxiv_theorems'],
}

const MODE = process.env.DANUS_STUB_MODE ?? 'ok'
const ROLE = process.env.DANUS_ROLE ?? 'main'
const LOG = process.env.DANUS_STUB_LOG ?? ''
const DELAY = Number(process.env.DANUS_STUB_CALL_DELAY_MS ?? '0')

const TOOLS = {
  gm_add: {
    description: 'Publish a finding to shared global memory (claim + evidence).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'master_guidance / elaboration / obstacle …' },
        claim: { type: 'string', description: 'the finding itself' },
        evidence: { type: 'string' },
        verifiable: { type: 'boolean' },
        glossary: {
          type: 'object',
          description: 'symbol → definition, reused across the project',
          additionalProperties: { type: 'string' },
        },
        links: { type: 'object', additionalProperties: true },
        project: { type: 'string', description: 'project name; there is no default' },
      },
      required: ['kind', 'claim'],
    },
  },
  gm_search: {
    description: 'BM25 over shared global-memory findings.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string' } },
        limit_per_kind: { type: 'integer' },
        project: { type: 'string' },
      },
      required: ['query'],
    },
  },
  fact_submit: {
    description: 'The only way to write a fact. Worker-only.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string' },
        proof: { type: 'string' },
        predecessors: { type: 'array', items: { type: 'string' } },
        external_refs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['statement', 'proof'],
    },
  },
  fact_search: {
    description: 'BM25 over the verified fact graph.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' }, project: { type: 'string' } },
      required: ['query'],
    },
  },
  fact_revoke: {
    description: 'Cascade-revoke a wrong fact. Destructive.',
    inputSchema: {
      type: 'object',
      properties: {
        fact_id: { type: 'string' },
        reason: { type: 'string' },
        project: { type: 'string' },
      },
      required: ['fact_id', 'reason'],
    },
  },
  search_arxiv_theorems: {
    description: 'Matlas arXiv theorem search — verbatim statements.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, num_results: { type: 'integer' } },
      required: ['query'],
    },
  },
}

const visible = () => ROLE_TOOLS[ROLE] ?? ROLE_TOOLS.verifier

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

if (MODE === 'die') {
  process.stderr.write('stub-gateway: DANUS_STUB_MODE=die, exiting before handshake\n')
  process.exit(3)
}

const rl = createInterface({ input: process.stdin })
let greeted = false

rl.on('line', async (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (message.id === undefined || message.id === null) return // 通知，不回
  const { id, method, params } = message

  if (method === 'initialize') {
    greeted = true
    if (MODE === 'garbage') process.stdout.write('stub-gateway: booting (not json)\n')
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'danus-gateway-stub', version: '0.0.0' },
    })
    return
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: visible().map((name) => ({ name, ...TOOLS[name] })),
    })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (!visible().includes(name)) {
      fail(id, -32601, `unknown tool: ${name} (role=${ROLE})`)
      return
    }
    if (LOG !== '') {
      appendFileSync(LOG, `${JSON.stringify({ name, args: params?.arguments ?? {}, role: ROLE })}\n`)
    }
    if (MODE === 'hang_tool') return
    if (MODE === 'traceback_error') {
      // 复刻 FastMCP 的真实行为：客户端只收到一句没信息的话，原因在 stderr。
      process.stderr.write(
        [
          'Traceback (most recent call last):',
          '  File "server.py", line 79, in _project',
          "RuntimeError: no such project: 'ghost' (under D:\\\\danus\\\\runtime\\\\projects)",
          '',
        ].join('\n'),
      )
      reply(id, { isError: true, content: [{ type: 'text', text: `Error executing tool ${name}` }] })
      return
    }
    if (DELAY > 0) await new Promise((r) => setTimeout(r, DELAY))
    if (name === 'fact_revoke' && String(params?.arguments?.fact_id ?? '') === '') {
      reply(id, { isError: true, content: [{ type: 'text', text: 'fact_id is required' }] })
      return
    }
    reply(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, tool: name, role: ROLE, args: params?.arguments ?? {} }),
        },
      ],
      structuredContent: { ok: true, tool: name, role: ROLE, args: params?.arguments ?? {} },
    })
    return
  }
  fail(id, -32601, `unknown method: ${method}`)
})

rl.on('close', () => {
  if (!greeted) process.exit(4)
  process.exit(0)
})
