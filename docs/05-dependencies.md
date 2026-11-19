# Third-party dependencies

The plugins in `packages/` are the parts built here. They are not the whole pipeline — three of the eight layers are third-party packages that you install yourself. They are listed here instead of being vendored, because they are other people's work and should be consumed as such.

## One command, pinned

```bash
node scripts/install.mjs --tier full
```

That writes a dedicated profile, installs the three plugins below at these exact versions, and verifies each one mounted. The manual commands are kept further down because you should know what the script does, not because you need to type them.

Why a script and not three commands in a README: a bare package name can install the previous release and silently succeed (failure #7). A script cannot forget the version. It also asks each installed package which component ids it mounts, so `misakanet` is verified as `misakanet-mcp` rather than reported missing.

## The three that matter

| Package | Version | Layer | Why this one |
|---|---|---|---|
| `meow-memory` | `0.32.4` | memory | **Re-injects after compaction.** Not just "has memory": when the context is compressed it re-injects the long-term snapshot, the project panorama it saw this session, and the originals of content that was written. Most memory plugins go silent exactly when the context is most damaged. |
| `@nanmicoder/dsh-agent-teams` | `0.1.28` | execution | Persistent members + dependency-aware DAG + mailbox + optional quality gates. Compaction does not erase the roster. A plain subagent is single-level and forgets it was spawned. |
| `misakanet` | `3.5.0` | negative knowledge | Stores **"how this error was fixed"**, not "what this theorem says". The layer that keeps a refuted path from being walked again three days later. |

Install with exact versions. A bare package name can install the previous release and report success — see failure #7 in [`03-failure-log.md`](03-failure-log.md).

```bash
dsh plugin --profile <your-profile> add meow-memory@0.32.4
dsh plugin --profile <your-profile> add @nanmicoder/dsh-agent-teams@0.1.28
dsh plugin --profile <your-profile> add misakanet@3.5.0
```

## Supporting packages

| Package | Version / source | Layer | Note |
|---|---|---|---|
| `dsh-zotero` | `^0.9.0` | literature | evidence store; UI plus API |
| `dsh-purge` | `github:YuJunZhiXue/dsh-purge` | ops | rule injection, rewind, skills. Supplies the patch layer this repo's `cordis.patch.yml` extends. Opt-in: `node scripts/install.mjs --with-purge` — it is git-hosted, so pnpm blocks its build script until you add the `allowBuilds` key it prints, and a script must not fake that. |
| `dshmarket` | `^1.47.0` | ops | plugin market |
| `dsh-web` / `@linxin666/dsh-remote-web-ui` | git / `^0.3.23` | ops | UI skins. Pure decoration; not in the task flow |

## Skills are a separate axis

A skill is a `SKILL.md` the host offers to the model; it is not a package, it is not installed by `dsh plugin`, and it has no version to pin. Three ship in [`../skills/`](../skills/README.md) and are copied into `<DSH_HOME>/skills/` by the installer.

The ones below are **other people's** and are deliberately not bundled. They are listed because "install a skill" otherwise means "guess a URL", and because each one covers a stage this repo does not:

| Skill | Stage | Why it is not here |
|---|---|---|
| `paper-writing`, `math-beamer` ([VeryMath/AI4Math-Writing](https://github.com/VeryMath/AI4Math-Writing)) | output | A taste layer: house style, templates, slide layouts. It ages with the venue, not with the pipeline |
| `loogle-search` | literature | Mathlib's own type-signature index. Whatever ships next month is better than a copy made today |
| `rigorous-paper-reviewer` ([shubham0704/claude-skills](https://github.com/shubham0704/claude-skills)) | output | Notation and consistency audit over LaTeX; independent of the kernel |
| `lean-probe` (PyPI) | computation | An MCP probe into a Lean project. Overlaps `lean-math`, but reaches further into a project layout than this repo's bridge does |

**Declare, do not vendor.** A skill copied into this repo stops tracking its upstream and starts aging silently — the same argument as the three packages above, with no version pin to fall back on. The cost is real: an upstream rename breaks the table and nothing will tell you.

## Rules that are not negotiable

**One plugin per layer.** The memory layer especially: a large fraction of the ecosystem competes for the same system-prompt injection slot. Two memory plugins do not give two memories — they inject the same paragraph twice, which moves the decay point earlier rather than later.

**Versions are pinned, not floated.** Every breakage in this project that looked like a bug was version skew. Pin, then upgrade deliberately.

**Pin the host too.** `agent-teams` has a compatibility matrix; `clearai-dsh` and `dsh-context` need a newer host than some of these versions support. Upgrading the host is a connected job, not a casual one.

## What is intentionally missing

There is no third-party epistemology layer here — no ontology plugin, no evidence gate as a first-class component. `claim-verify` (in `packages/`) carries part of that role by freezing claims by hash, and human discipline carries the rest. It is a known gap, not a design decision.
