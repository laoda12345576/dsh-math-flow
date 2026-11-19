#!/usr/bin/env node
/**
 * Report what this pipeline can actually reach on this machine.
 *
 * Read-only on purpose: installing Lean or a 4 GB Mathlib checkout is a decision
 * with a disk cost, and a plugin installer should not make it on your behalf.
 * Everything it prints is a command you can run yourself.
 *
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --profile math-flow    # also check the profile
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  if (r.error) return { ok: false, out: '' };
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function version(cmd, args = ['--version']) {
  const r = run(cmd, args);
  if (!r.ok) return null;
  return r.out.split('\n')[0].trim();
}

const rows = [];
function add(need, ok, detail, fix) {
  rows.push({ need, ok, detail, fix });
}

// Node — the plugins are ESM and declare engines >=22.5.
const [maj, min] = process.versions.node.split('.').map(Number);
add(
  'node >= 22.5',
  maj > 22 || (maj === 22 && min >= 5),
  process.versions.node,
  'install Node 22.5 or newer',
);

const dsh = version('dsh', ['--version']);
add('dsh CLI', dsh !== null, dsh ?? 'not on PATH', 'install the dsh CLI (npm i -g @deepseek-ai/dsh)');

const pnpm = version('pnpm', ['--version']);
add('pnpm', pnpm !== null, pnpm ?? 'not on PATH', 'npm i -g pnpm — dsh plugin forwards to it');

// Lean: the kernel. Without it every verdict is an error, not a false pass.
const lean = version('lean');
add('lean 4', lean !== null, lean ?? 'not on PATH', 'install elan, then `elan default leanprover/lean4:stable`');

const lake = version('lake');
add('lake', lake !== null, lake ?? 'not on PATH', 'comes with elan; check ~/.elan/bin is on PATH');

// Mathlib: optional but this is where `lean_search` and `lake env lean` get slow.
const mathlibCandidates = [
  process.env.MATHLIB_DIR,
  join(homedir(), 'mathlib4'),
  join(REPO, 'mathlib4'),
].filter(Boolean);
const mathlib = mathlibCandidates.find((p) => existsSync(join(p, 'Mathlib')));
let mathlibDetail = mathlib ?? `not found (checked ${mathlibCandidates.length} paths)`;
if (mathlib) {
  const cache = existsSync(join(mathlib, '.lake', 'packages'));
  mathlibDetail = `${mathlib}${cache ? '' : ' (no .lake/packages — run `lake exe cache get`)'}`;
}
add('Mathlib checkout', Boolean(mathlib), mathlibDetail, 'git clone mathlib4, then `lake exe cache get`');

// Python: claim-verify runs a judge script in a subprocess.
const py = version('python') ?? version('python3');
add('python 3', py !== null, py ?? 'not on PATH', 'install Python 3 and put it on PATH');

const git = version('git');
add('git', git !== null, git ?? 'not on PATH', 'install git — needed to clone Mathlib and to update plugins');

// Ollama is optional: the local model only suggests, never decides.
const ollama = version('ollama', ['--version']);
add('ollama (optional)', true, ollama ?? 'absent — hints disabled, nothing else changes', 'ollama.com/download');

// ── Profile ────────────────────────────────────────────────────────────────

const profileArg = process.argv.indexOf('--profile');
const profileName = profileArg > -1 ? process.argv[profileArg + 1] : 'math-flow';
const manifestPath = join(DSH_HOME, 'profiles', profileName, 'package.json');

let profileLine = null;
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deps = Object.keys(manifest.dependencies ?? {});
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const ours = deps.filter((d) => d.startsWith('dsh-plugin-'));
  const patch = existsSync(join(DSH_HOME, 'profiles', profileName, 'cordis.patch.yml'));
  profileLine = `${deps.length} deps (${ours.length} pipeline plugins), ${bundles.length} bundles, patch ${patch ? 'yes' : 'no'}`;
}

// ── Print ──────────────────────────────────────────────────────────────────

const width = Math.max(...rows.map((r) => r.need.length));
process.stdout.write('\ndsh-math-flow · environment\n\n');
for (const r of rows) {
  const mark = r.ok ? 'ok  ' : 'MISS';
  process.stdout.write(`  ${mark}  ${r.need.padEnd(width)}  ${r.detail}\n`);
  if (!r.ok) process.stdout.write(`        ${' '.repeat(width)}  → ${r.fix}\n`);
}
process.stdout.write('\n');
if (profileLine) {
  process.stdout.write(`  profile ${profileName}: ${profileLine}\n\n`);
} else {
  process.stdout.write(`  profile ${profileName}: not created yet — run node scripts/install.mjs\n\n`);
}

const blocking = rows.filter((r) => !r.ok && !r.need.includes('optional'));
if (blocking.length === 0) {
  process.stdout.write('  Nothing blocking. The kernel path is reachable.\n\n');
  process.exit(0);
}
process.stdout.write(`  ${blocking.length} blocking item(s) above. The plugins install fine without them;\n`);
process.stdout.write('  they will mount and return errors until the toolchain exists.\n\n');
process.exit(1);
