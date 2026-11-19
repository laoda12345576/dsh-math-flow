/** Run every test file in this directory and report a summary. */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const only = process.argv[2]
// `bench-*` and `probe-*` are run deliberately, not by default: they start real
// servers and can load Mathlib (minutes), which would make `run-all` useless as a
// quick check.
const files = readdirSync(here)
  .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
  .filter((name) => only !== undefined || (!name.startsWith('bench-') && !name.startsWith('probe-')))
  .filter((name) => only === undefined || name.includes(only))
  .sort()

let failedFiles = 0
for (const file of files) {
  console.log(`\n--- ${file} ---`)
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failedFiles += 1
}

console.log(`\n${files.length - failedFiles}/${files.length} test files passed`)
process.exit(failedFiles === 0 ? 0 : 1)
