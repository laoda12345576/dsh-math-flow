#!/usr/bin/env node
/**
 * One-command environment for dsh-math-flow.
 *
 * Creates a dedicated dsh profile, installs the shipped plugins from this repo,
 * and (optionally) the three third-party packages the pipeline leans on. Every
 * install is pinned; nothing floats.
 *
 * Why this exists: the manual path in profiles/README.md is five commands with
 * four places to get a version wrong, and failure #7 in docs/03-failure-log.md
 * is exactly that — a bare package name that installed the previous release and
 * reported success. A script cannot forget to pin.
 *
 *   node scripts/install.mjs                 # core: kernel, claims, gate
 *   node scripts/install.mjs --tier full     # + memory, team, negative knowledge
 *   node scripts/install.mjs --dry-run       # print the plan, touch nothing
 *   node scripts/install.mjs --verify-only   # check an existing profile
 *
 * Exit codes: 0 ok, 1 bad arguments, 2 preflight failed, 3 install failed,
 * 4 verification failed.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── What goes in ────────────────────────────────────────────────────────────

/** Packages built in this repo. `id` is the cordis component id, used to verify. */
const SHIPPED = [
  {
    pkg: 'dsh-plugin-lean-math',
    dir: 'packages/lean-math',
    id: 'lean-math',
    role: 'kernel verdicts — the Lean 4 bridge, 13 tools',
  },
  {
    pkg: 'dsh-plugin-claim-verify',
    dir: 'packages/claim-verify',
    id: 'claim-verify',
    role: 'frozen claims — a verdict you cannot rewrite afterwards',
  },
  {
    pkg: 'dsh-plugin-research-gate',
    dir: 'packages/research-gate',
    id: 'research-gate',
    role: 'order gate — survey before computing',
  },
  {
    pkg: 'dsh-plugin-paper',
    dir: 'packages/paper',
    id: 'paper', // the component id is `paper`, not the package name
    role: 'literature — legitimate full text, and citations that exist',
  },
];

/** Other people's work. Consumed, never vendored. See docs/05-dependencies.md. */
const THIRD_PARTY = [
  {
    spec: 'meow-memory@0.32.4',
    pkg: 'meow-memory',
    version: '0.32.4',
    id: 'meow-memory',
    role: 'memory that survives compaction',
  },
  {
    spec: '@nanmicoder/dsh-agent-teams@0.1.28',
    pkg: '@nanmicoder/dsh-agent-teams',
    version: '0.1.28',
    id: 'agent-teams',
    role: 'persistent members, dependency-aware DAG',
  },
  {
    spec: 'misakanet@3.5.0',
    pkg: 'misakanet',
    version: '3.5.0',
    id: 'misakanet-mcp', // mounts under its own component name, not the package name
    role: 'negative knowledge — how this error was fixed',
  },
];

/**
 * dsh-purge supplies the patch layer the repo's cordis.patch.yml extends. It is
 * git-hosted, so pnpm blocks its build script until the key it prints is added
 * to pnpm-workspace.yaml — a manual step a script cannot safely fake. Hence
 * opt-in, never default.
 */
const PURGE = {
  spec: 'github:YuJunZhiXue/dsh-purge',
  pkg: 'dsh-purge',
  id: 'dsh-purge',
  role: 'patch layer, rewind, skill injection',
};

/**
 * Shipped, but not on the default path: mm-toolkit's twelve tools include seven
 * that need helper scripts the repo does not ship (browserd.py, the Doubao and
 * nano-banana bridges). It is a real package, it is just not something a first
 * install should silently pull in — the missing pieces would look like bugs.
 */
const OPTIONAL = [
  {
    pkg: 'dsh-plugin-mm-toolkit',
    dir: 'packages/mm-toolkit',
    id: 'mm-toolkit',
    role: 'plotting — Python / MATLAB / TikZ executors, 12 tools',
  },
];

/**
 * Skills are the other half of the pipeline and are installed by a different
 * mechanism: dsh reads `<DSH_HOME>/skills/<name>/SKILL.md`, and a plugin cannot
 * put one there. The protocol is not decoration — research-gate enforces the
 * *order*, this skill says what each step has to produce, and the scripts under
 * its `tools/` check that the run's own records are self-consistent. Shipping
 * the plugin without the skill is the failure this repo keeps warning about:
 * a gate that refuses without explaining what would have passed.
 */
const SKILLS = [
  {
    name: 'research-protocol',
    dir: 'skills/research-protocol',
    role: 'survey → synthesis → verify, and what each step must leave behind',
  },
  {
    name: 'cordis-plugin-development',
    dir: 'skills/cordis-plugin-development',
    role: 'how to inspect and extend this host instead of guessing its API',
  },
  {
    name: 'editing-cordis-compositions',
    dir: 'skills/editing-cordis-compositions',
    role: 'how a plugin row actually mounts — the composition rules',
  },
];

/**
 * Danus 不是流水线的一部分，它是另一套系统，所以不放进任何 tier：它需要你
 * 自己有一个 Danus 部署（一个完整的证明搜索引擎 + verify 服务）。`--with-danus`
 * 装的是**桥**，不是引擎。
 *
 * 它也不像别的包那样"装上就能用"：root 是每台机器不同的绝对路径，所以安装器
 * 会把这个路径写进 profile 的 patch 覆写里，而不是让它去猜。
 */
const DANUS = {
  pkg: 'dsh-plugin-danus',
  dir: 'packages/danus',
  id: 'danus',
  role: 'Danus proof-search orchestrator: role-gated gateway + worker lifecycle',
};

const DANUS_SKILLS = [
  {
    name: 'danus-main',
    dir: 'skills/danus-main',
    role: 'the main-agent contract — layers, cadence, forks, honesty',
  },
  {
    name: 'danus-elaboration',
    dir: 'skills/danus-elaboration',
    role: 'the five-section synthesis, then the strategy consult',
  },
  {
    name: 'danus-initialize',
    dir: 'skills/danus-initialize',
    role: 'the first-run interview, with verification instead of claims',
  },
];

const TIERS = {
  core: [...SHIPPED],
  full: [...SHIPPED, ...OPTIONAL, ...THIRD_PARTY],
};

// ── Arguments ───────────────────────────────────────────────────────────────

const USAGE = `
dsh-math-flow installer

  node scripts/install.mjs [options]

Options
  --profile <name>   profile to create or update   (default: math-flow)
  --tier core|full   core = the 4 shipped plugins  (default: core)
                     full = core + mm-toolkit + memory/team/negative-knowledge
  --with-viz         add mm-toolkit to whatever tier is selected
                     (7 of its 12 tools need bridge scripts you supply; it is
                      not in core because a first install should not pull in
                      things that cannot run yet)
  --with-purge       also install dsh-purge (git; needs a manual allowBuilds)
  --with-danus       also install the Danus bridge (needs an existing Danus deploy)
  --danus-root <p>   path to the Danus checkout (default: $DANUS_ROOT)
  --danus-role <r>   gateway role for this session (default: main)
  --patch            force copying cordis.patch.yml (default: full tier only)
  --no-patch         never copy cordis.patch.yml into the profile
  --skills-dir <p>   where to install skills (default: <DSH_HOME>/skills)
  --no-skills        install the plugins only, skip the three skills
  --force            reinstall even when the pinned version is already present
  --dry-run          print the plan and exit
  --verify-only      skip installing, only check the profile
  --help

What it installs, in order
  1. the plugins, into a profile of its own (your working profile is untouched)
  2. the skills, into <DSH_HOME>/skills — a plugin cannot install these, and
     without them the gate refuses without saying what would have passed

With --with-danus it also writes a '- id: danus' override into the profile's
cordis.patch.yml carrying the Danus root — a machine path that cannot ship in
the repo, and that --verify-only could not otherwise check.

What it does not do
  Installing Lean, Mathlib, Python, or Ollama. Those are toolchains, not
  plugins; scripts/doctor.mjs reports what is missing instead of installing it.
`.trim();

function parseArgs(argv) {
  const opts = {
    profile: 'math-flow',
    tier: 'core',
    purge: false,
    viz: false,
    danus: false,
    danusRoot: '',
    danusRole: 'main',
    patch: null,
    force: false,
    skills: true,
    skillsDir: null,
    dryRun: false,
    verifyOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--tier') opts.tier = argv[++i];
    else if (a === '--with-purge') opts.purge = true;
    else if (a === '--with-danus') opts.danus = true;
    else if (a === '--danus-root') opts.danusRoot = argv[++i];
    else if (a === '--danus-role') opts.danusRole = argv[++i];
    else if (a === '--with-viz') opts.viz = true;
    else if (a === '--patch') opts.patch = true;
    else if (a === '--no-patch') opts.patch = false;
    else if (a === '--skills-dir') opts.skillsDir = argv[++i];
    else if (a === '--no-skills') opts.skills = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verify-only') opts.verifyOnly = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(opts.profile ?? '')) throw new Error('profile name must be a plain word');
  if (!TIERS[opts.tier]) throw new Error(`unknown tier: ${opts.tier} (use core or full)`);
  if (opts.danus) {
    opts.danusRoot = opts.danusRoot || process.env.DANUS_ROOT || '';
    if (opts.danusRoot === '') {
      throw new Error('--with-danus needs --danus-root <path> (or DANUS_ROOT): the bridge mounts a specific Danus checkout');
    }
    if (!existsSync(join(opts.danusRoot, 'danus', 'gateway'))) {
      throw new Error(`${opts.danusRoot} does not look like a Danus checkout (no danus/gateway/)`);
    }
    if (!/^(main|worker|verifier|all)$/.test(opts.danusRole)) {
      throw new Error('--danus-role must be main|worker|verifier|all');
    }
  }
  return opts;
}

// ── Shell ───────────────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';

/** cmd.exe does not quote for us; a repo path with a space would split. */
function quote(arg) {
  return WIN && /\s/.test(arg) ? `"${arg}"` : arg;
}

function run(cmd, args, { capture = false } = {}) {
  const result = spawnSync(cmd, args.map(quote), {
    cwd: REPO,
    shell: WIN,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    timeout: 600000,
  });
  if (result.error) return { code: 127, out: '', err: result.error.message };
  return { code: result.status ?? 1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

const say = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stderr.write(`  ! ${msg}\n`);

// ── Preflight ───────────────────────────────────────────────────────────────

function nodeTooOld() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj < 22 || (maj === 22 && min < 5);
}

function preflight(opts) {
  const problems = [];
  const notes = [];

  if (nodeTooOld()) problems.push(`node ${process.versions.node} — the plugins declare engines >=22.5`);
  if (!existsSync(join(REPO, 'packages', 'lean-math', 'package.json'))) {
    problems.push(`packages/ not found under ${REPO} — run this from a clone of the repo`);
  }

  for (const bin of ['dsh', 'pnpm']) {
    const r = run(bin, ['--version'], { capture: true });
    if (r.code !== 0) problems.push(`${bin} not on PATH — ${bin === 'dsh' ? 'install the dsh CLI' : 'dsh plugin forwards to pnpm'}`);
    else notes.push(`${bin} ${r.out.trim().split('\n')[0]}`);
  }

  // Lean is required by the kernel path, but not by the plugins' install.
  const lean = run('lean', ['--version'], { capture: true });
  if (lean.code !== 0) {
    notes.push('lean NOT on PATH — lean-math will mount, but every verdict will come back as an error');
  } else {
    notes.push(lean.out.trim().split('\n')[0]);
  }
  const lake = run('lake', ['--version'], { capture: true });
  if (lake.code !== 0) notes.push('lake NOT on PATH — `lake env lean` and Mathlib search will not work');

  if (opts.tier === 'full' && !existsSync(join(REPO, '.git'))) {
    notes.push('no .git — third-party git dependencies still install, but nothing is pinned by lockfile here');
  }

  return { problems, notes };
}

// ── Profile ─────────────────────────────────────────────────────────────────

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = (name) => join(DSH_HOME, 'profiles', name);

/**
 * A profile with no shipped template would boot with `dsh-base` only — no web
 * UI, no TUI. Seed the manifest with the web tuple so `dsh --profile <name>`
 * opens something a person can use, then let `dsh plugin add` append to it.
 */
function ensureManifest(name, { dryRun }) {
  const dir = profileDir(name);
  const file = join(dir, 'package.json');
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, 'utf8'));
    const bundles = existing.dsh?.profile?.bundles ?? [];
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      warn(`profile ${name} has no web app bundle; mounting as-is (add it yourself if you expect a UI)`);
    }
    return { created: false, manifest: existing };
  }
  const manifest = {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'live',
      },
    },
  };
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { created: true, manifest };
}

function readManifest(name) {
  const file = join(profileDir(name), 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Skip work already done. Comparing the declared spec is the point: `^1.0.0` is not `1.0.0`. */
function alreadyPinned(manifest, item) {
  const deps = manifest?.dependencies ?? {};
  const have = deps[item.pkg];
  if (have === undefined) return false;
  // The manifest stores the bare version, not the `name@version` install spec.
  // Comparing against the spec made every third-party package look absent, so
  // each re-run reinstalled it and the patch check called it missing.
  if (item.version) return have === item.version;
  return true; // local packages are always taken from the working tree
}

/**
 * Component ids a package actually mounts, read from its own bundle patch.
 * Not the package name: `misakanet@3.5.0` mounts as `misakanet-mcp`, and a
 * verifier that assumed otherwise reports a healthy install as broken.
 */
function componentIds(profileName, item) {
  const dir = join(profileDir(profileName), 'node_modules', ...item.pkg.split('/'));
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) return [item.id];
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    const rel = pkg.dsh?.bundle?.patch;
    if (!rel) return [item.id];
    const yml = readFileSync(join(dir, rel), 'utf8');
    const ids = [...yml.matchAll(/^\s*-\s+id:\s*['"]?([\w@/.-]+)['"]?/gm)].map((m) => m[1]);
    return ids.length > 0 ? ids : [item.id];
  } catch {
    return [item.id];
  }
}

// ── Install ─────────────────────────────────────────────────────────────────

function installOne(name, item, opts) {
  const spec = item.spec ?? join(REPO, item.dir);
  const shown = item.spec ?? item.dir;
  say(`  → ${item.pkg}  (${shown})`);
  if (opts.dryRun) return 0;
  const r = run('dsh', ['plugin', '--profile', name, 'add', spec]);
  if (r.code === 0) return 0;
  warn(`failed: dsh plugin --profile ${name} add ${shown}`);
  if (item.spec?.startsWith('github:') || item.spec?.includes('git+')) {
    warn(`git-hosted packages build on install; pnpm prints the exact allowBuilds key to add to ${join(profileDir(name), 'pnpm-workspace.yaml')}`);
  }
  return r.code;
}

// ── Patch layer ─────────────────────────────────────────────────────────────

/**
 * The patch overrides components by id. Copying it into a profile that lacks
 * those bundles is not fatal (dsh warns "entry not found" and continues), but
 * it is noise, so say which blocks will land on nothing.
 */
function applyPatch(name, opts, installedIds) {
  const src = join(REPO, 'profiles', 'full', 'cordis.patch.yml');
  const dst = join(profileDir(name), 'cordis.patch.yml');
  // Auto: the patch is the team and memory policy layer. Applying it to a core
  // profile means four blocks riding on bundles that are not there, which only
  // produces boot warnings about entries nobody asked for.
  const wantPatch = opts.patch ?? opts.tier === 'full';
  if (!wantPatch) {
    say(`  · skipped — the patch configures team and memory bundles; tier=${opts.tier} has none (use --patch to force)`);
    return;
  }
  if (!existsSync(src)) {
    warn('profiles/full/cordis.patch.yml missing; nothing to apply');
    return;
  }
  const text = readFileSync(src, 'utf8');
  const targets = [...text.matchAll(/^-\s+id:\s*([\w@/.-]+)/gm)].map((m) => m[1]);
  const orphans = targets.filter((t) => !installedIds.has(t));
  if (orphans.length > 0) {
    warn(`patch targets not installed, will warn at boot: ${orphans.join(', ')}`);
  }
  if (opts.dryRun) {
    say(`  → cordis.patch.yml → ${dst}`);
    return;
  }
  writeFileSync(dst, text, 'utf8');
  say(`  → cordis.patch.yml written (${targets.length} blocks)`);
}

// ── Danus override ──────────────────────────────────────────────────────────

/** YAML 单引号标量：撇号翻倍。路径里有 `'` 的机器确实存在。 */
const yamlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * 把 Danus 的 root 写进 profile 的 patch，作为**覆写**而不是新组件：
 *
 *   - id: danus
 *     config: { root: '...' }
 *
 * 包自带的 bundle patch 已经把这一行建好了（config 里 root 留空），这里只改
 * 那一个字段。root 是绝对路径，进不了仓库，所以只能安装时写。
 */
function applyDanusOverride(name, opts) {
  if (!opts.danus) return;
  const dst = join(profileDir(name), 'cordis.patch.yml');
  const block = [
    '',
    '# Written by install.mjs --with-danus. The root is a machine path, so it cannot',
    '# ship in the package; this override is what makes the bridge point somewhere.',
    '- id: danus',
    '  config:',
    `    root: ${yamlString(opts.danusRoot)}`,
    `    role: ${yamlString(opts.danusRole)}`,
    '',
  ].join('\n');
  if (opts.dryRun) {
    say(`  → would append a danus override to ${dst}`);
    return;
  }
  const existing = existsSync(dst) ? readFileSync(dst, 'utf8') : '';
  if (/^-\s+id:\s*danus\s*$/m.test(existing)) {
    say('  · danus override already present, left as-is (edit it by hand to change the root)');
    return;
  }
  writeFileSync(dst, existing + block, 'utf8');
  say(`  → danus override appended (root=${opts.danusRoot}, role=${opts.danusRole})`);
}

// ── Skills ──────────────────────────────────────────────────────────────────

const skillsHome = (opts) => (opts.skillsDir ? resolve(opts.skillsDir) : join(DSH_HOME, 'skills'));

function listTree(root, base = root, out = []) {
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) listTree(p, base, out);
    else out.push(`${p.slice(base.length + 1).replace(/\\/g, '/')}:${st.size}`);
  }
  return out;
}

/** File names plus sizes, both sides. Enough to skip a rewrite; not a hash. */
function sameTree(a, b) {
  const left = listTree(a).sort().join('|');
  return left.length > 0 && left === listTree(b).sort().join('|');
}

const skillSet = (opts) => (opts.danus ? [...SKILLS, ...DANUS_SKILLS] : SKILLS);

function installSkills(opts) {
  const root = skillsHome(opts);
  say('');
  say(opts.dryRun ? 'Skills (would install)' : 'Skills');
  say(`  → ${root}`);
  let failed = 0;
  for (const s of skillSet(opts)) {
    const src = join(REPO, s.dir);
    const dst = join(root, s.name);
    if (!existsSync(join(src, 'SKILL.md'))) {
      warn(`${s.dir} missing — run this from a clone of the repo`);
      failed += 1;
      continue;
    }
    if (!opts.force && sameTree(src, dst)) {
      say(`  · ${s.name} already current`);
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(root, { recursive: true });
      cpSync(src, dst, { recursive: true, force: true });
    }
    say(`  → ${s.name}  (${s.role})`);
  }
  return failed;
}

function verifySkills(opts) {
  const root = skillsHome(opts);
  const rows = skillSet(opts).map((s) => ({ name: s.name, ok: existsSync(join(root, s.name, 'SKILL.md')) }));
  for (const r of rows) say(`  ${r.ok ? 'ok  ' : 'MISS'} skill ${r.name}`);
  const missing = rows.filter((r) => !r.ok).length;
  say(`  skills: ${rows.length - missing} of ${rows.length} present in ${root}`);
  return missing === 0 ? 0 : 4;
}

// ── Verify ──────────────────────────────────────────────────────────────────

function verify(name, expected, { quiet = false } = {}) {
  const r = run('dsh', ['--profile', name, '--dump-config'], { capture: true });
  if (r.code !== 0) {
    const err = r.err ?? '';
    if (/does not exist/.test(err)) {
      say(`  profile ${name} does not exist, so there is nothing to verify.`);
      say(`  create it first:  node scripts/install.mjs --profile ${name}`);
    } else if (/ENOENT|not recognized|command not found/i.test(err)) {
      say('verification failed: `dsh` is not on PATH.');
    } else {
      say('verification failed: --dump-config did not run');
      if (err) say(err.split('\n').slice(0, 4).join('\n'));
    }
    return 4;
  }
  const ids = new Set([...r.out.matchAll(/^-\s+id:\s*(\S+)/gm)].map((m) => m[1]));
  const rows = expected.map((e) => ({ e, want: componentIds(name, e) }));
  const missing = rows.filter(({ want }) => !want.some((id) => ids.has(id)));
  const components = ids.size;
  const notFound = r.err
    .split('\n')
    .filter((l) => /patch: entry .* not found/.test(l))
    .map((l) => l.replace(/^dsh:\s*/, '').trim());

  if (!quiet) {
    for (const { e, want } of rows) {
      const ok = want.some((id) => ids.has(id));
      say(`  ${ok ? 'ok  ' : 'MISS'} ${want.join(', ')}${want[0] === e.pkg ? '' : `  (${e.pkg})`}`);
    }
  }
  say(`  profile ${name}: ${components} components, ${missing.length} of ${expected.length} expected plugins missing`);
  if (notFound.length > 0) {
    say(`  patch warnings: ${notFound.length} (blocks whose bundle is not installed)`);
  }
  return missing.length === 0 ? 0 : 4;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    say(`error: ${e.message}\n\n${USAGE}`);
    return 1;
  }
  if (opts.help) {
    say(USAGE);
    return 0;
  }

  say(`dsh-math-flow installer · tier=${opts.tier} · profile=${opts.profile}`);
  say('');

  const { problems, notes } = preflight(opts);
  if (notes.length > 0) {
    say('Environment');
    for (const n of notes) say(`  · ${n}`);
    say('');
  }
  if (problems.length > 0) {
    say('Cannot continue:');
    for (const p of problems) say(`  ✗ ${p}`);
    say('');
    say('Nothing was changed. Fix the above and re-run.');
    return 2;
  }

  const expected = [...TIERS[opts.tier]];
  if (opts.viz && !expected.some((e) => e.id === 'mm-toolkit')) expected.push(...OPTIONAL);
  if (opts.purge) expected.push(PURGE);
  if (opts.danus) expected.push(DANUS);

  if (opts.verifyOnly) {
    const pluginCode = verify(opts.profile, expected);
    say('');
    const skillCode = opts.skills ? verifySkills(opts) : 0;
    return pluginCode !== 0 ? pluginCode : skillCode;
  }

  say(`Profile ${profileDir(opts.profile)}`);
  const { created } = ensureManifest(opts.profile, opts);
  say(created ? `  · ${opts.dryRun ? 'would create' : 'created'} (base + web app)` : '  · exists, updating in place');

  const manifest = readManifest(opts.profile);
  const todo = expected.filter((e) => opts.force || !alreadyPinned(manifest, e));
  const skipped = expected.length - todo.length;
  if (skipped > 0) say(`  · ${skipped} already at the pinned version, skipped`);

  if (todo.length === 0) {
    say('  · nothing to install');
  } else {
    say('');
    say(`${opts.dryRun ? 'Would install' : 'Installing'} ${todo.length} package${todo.length === 1 ? '' : 's'}`);
    for (const item of todo) {
      const code = installOne(opts.profile, item, opts);
      if (code !== 0) {
        say('');
        say(`Stopped at ${item.pkg}. The profile is half-built; re-run to resume — installs are idempotent.`);
        return 3;
      }
    }
  }

  let skillFailed = 0;
  if (opts.skills) skillFailed = installSkills(opts);

  say('');
  say('Patch layer');
  const installedIds = new Set(
    expected.flatMap((e) =>
      opts.dryRun ? [e.id] : componentIds(opts.profile, e),
    ),
  );
  applyPatch(opts.profile, opts, installedIds);
  applyDanusOverride(opts.profile, opts);

  say('');
  say('Verify');
  if (opts.dryRun) {
    say('  (skipped in --dry-run)');
    say('');
    say(`Plan only. Re-run without --dry-run to apply.`);
    return 0;
  }
  const code = verify(opts.profile, expected);
  if (opts.skills) {
    say('');
    verifySkills(opts);
  }
  say('');
  if (code === 0) {
    say('Ready. Start it with:');
    say(`  dsh --profile ${opts.profile}`);
    say('');
    say('Then check the toolchains the plugins call into (this is the part a script must not fake):');
    say('  node scripts/doctor.mjs');
  } else {
    say('Installed, but the mounted config does not contain every expected plugin.');
    say('Read the plugin output above; version skew is the usual cause (docs/03-failure-log.md #7).');
  }
  if (skillFailed > 0) {
    say('Skills did not all install; the gate will still refuse, it just will not explain what would have passed.');
  }
  return code;
}

process.exit(main());
