#!/usr/bin/env node
/**
 * 桩 CLI：接受 `danus` 的 verb 形状，输出可断言的结果。
 *
 * 开关：
 *   DANUS_STUB_LOG   每次调用追加一行 {argv: [...]}
 *   DANUS_STUB_FAIL  逗号分隔的 verb，命中就以非零码失败并打 stderr
 *   DANUS_STUB_SLOW  verb 名，命中就睡 10 秒（测超时）
 */

import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const LOG = process.env.DANUS_STUB_LOG ?? ''
if (LOG !== '') appendFileSync(LOG, `${JSON.stringify({ argv })}\n`)

const failFor = new Set(String(process.env.DANUS_STUB_FAIL ?? '').split(',').filter((v) => v !== ''))
const verb = argv[0] ?? ''
const rest = argv.slice(1)
const has = (flag) => rest.includes(flag)

if (failFor.has(verb)) {
  process.stderr.write(`danus ${verb}: stub refuses (DANUS_STUB_FAIL=${verb})\n`)
  process.exit(2)
}
if (process.env.DANUS_STUB_SLOW === verb) {
  await new Promise((r) => setTimeout(r, 10000))
}

const respond = (json, text) => {
  if (has('--json') && json !== undefined) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
  else process.stdout.write(`${text}\n`)
}

switch (verb) {
  case 'list':
    respond(
      [
        { project: 'collatz', workers: 7, live: 5, model: 'gpt-5.6-sol' },
        { project: 'erdos-42', workers: 3, live: 3, model: 'gpt-5.6-sol' },
      ],
      'collatz  7 workers (5 live)\nerdos-42 3 workers (3 live)',
    )
    break

  case 'new':
    respond(undefined, `created ${rest[0]} with ${rest[rest.indexOf('--roles') + 1] ?? 'high:3,xhigh:4'}`)
    break

  case 'assign':
    respond(undefined, `assigned ${rest[0]}`)
    break

  case 'finalize': {
    const ids = rest.filter((v) => !v.startsWith('--') && v !== rest[0])
    const paper = has('--paper') ? rest[rest.indexOf('--paper') + 1] : ''
    respond(
      undefined,
      ids.length === 0
        ? 'candidate terminal facts: fact_a1, fact_b2 (nothing written)'
        : `recorded ${ids.join(', ')} in ${rest[0]}${paper === '' ? '' : `/${paper}`}/TARGET.md`,
    )
    break
  }

  case 'start':
    respond(undefined, `started ${rest[0]}`)
    break

  case 'status':
    respond(
      { project: rest[0], workers: 7, live: 5, stuck: false, round: 12, last_activity: '2m ago' },
      `${rest[0]}: 5/7 live, round 12, last activity 2m ago`,
    )
    break

  case 'stop':
    respond(undefined, `stopped ${rest[0]}${has('--force') ? ' (force)' : ' (graceful)'}`)
    break

  default:
    process.stderr.write(`danus: unknown verb ${verb}\n`)
    process.exit(2)
}
