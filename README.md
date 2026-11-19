# dsh-math-flow

**An agent pipeline for mathematical research — built to be measured, not just installed.**

Most "agent stack" repos are a screenshot of a plugin list. This one ships the list, the configuration, the plugins, and — the part that matters — **the experiment protocol that tells you whether any of it worked.**

Built on DeepSeek Harness (`dsh`), Lean 4, and Mathlib. — [中文](README.zh-CN.md)

> **What is actually here today.** Five plugins, one installer, one measurement protocol. The architecture below is eight layers and names fourteen plugins: five are in `packages/` (four on the default path, one optional), three are third-party packages pinned by version, and six still sit in the single-machine setup they were written for — listed, with reasons, in [`packages/README.md`](packages/README.md). The repo does not pretend otherwise, because a manifest naming packages that do not exist is worse than an honest gap.

---

## The problem it answers

Long mathematical sessions with an agent fail in a specific, repeatable way: **constraints decay.** A symbol is defined in round 5, drifts by round 40, and by round 60 the agent is proving a theorem about a different object. Nothing crashes. The output just quietly becomes about something else.

This pipeline exists to keep four things alive across a session:

| What decays | Who is responsible here |
|---|---|
| Symbol definitions | `lean-math` — the kernel refuses a proof about the wrong object. Beyond that it is a convention you keep by hand: there is no symbol-table plugin, and the original design assumed one |
| Negative results ("this path is dead") | `misakanet` — lessons from failures, not search |
| Task ownership across compaction | `agent-teams` — persistent members, DAG, mailbox |
| Everything, when the context is compacted | `meow-memory` — re-injects after compaction |

A plugin list is not a pipeline. **The order and the prohibitions are the pipeline.** See [`docs/01-architecture.md`](docs/01-architecture.md).

---

## Three design rules

These are not slogans; each one is the residue of a design that failed first. The full post-mortems are in [`docs/03-failure-log.md`](docs/03-failure-log.md).

**1. Anything mechanically decidable becomes a function, not an agent.**
A `check` role that ran scripts took 103 seconds and returned zero verdicts — it died on step 3 of a five-step loop (read context → understand → write script → execute → report). The same check as a tool call takes 300 ms and cannot forget to report. Agents are for judgment, not for comparison.

**2. Whoever proposes a claim may not be the one who certifies it.**
The formalization member is deliberately a separate member with a deliberately restricted toolset: it can translate a statement into Lean and compile it, but it cannot generate the strategy, and it cannot audit the claim. Self-certification is the cheapest form of cheating available to a machine.

**3. One description is authoritative; the others are generated from it.**
The original failure was maintaining four independent, each-plausible, each-unchecked descriptions of the same mathematics (prose report / Lean / scripts / status table). The fix is not four linters. The fix is demoting three of them.

---

## Architecture

Eight layers, one plugin family per layer. **Two plugins in the same layer fight** — memory especially, where every candidate competes for the same system-prompt injection slot.

```
execution   agent-teams
computation lean-math · proof-harness* · math-strategies* · ollama*
observation watchdog* · mm-toolkit (viz / counterexamples, optional)
memory      meow-memory            ← exactly one, never two
negative    misakanet              ← failure lessons, not general search
literature  paper · zotero*       ← evidence store, not generic RAG
output      wps-bridge*            ← the only path to .docx/.xlsx/.pptx
ops         hotloader* · market · purge · web
```

`*` — designed, running on the author's machine, **not in this repo yet**. [`packages/README.md`](packages/README.md) lists them in dependency order with what each one is waiting on. The layout is documented rather than trimmed because a layer diagram with holes is more useful than a smaller diagram that lies about the shape.

Data flow for one task, and the one ordering constraint that is not negotiable:

```
memory re-inject → lean_status → (on failure) misakanet_search
   → strategies → kernel verdict → visualization → document
```

**Kernel first, prose second.** Reversing this produces a document that describes an unverified result — which is the single most common failure mode of agent-assisted mathematics.

Tool-by-tool reference: [`docs/02-tool-reference.md`](docs/02-tool-reference.md).

---

## Quick start

One command. It creates its own profile (`math-flow`) so your working profile is not touched, installs every plugin at a pinned version, and verifies what actually mounted:

```bash
git clone https://github.com/laoda12345576/dsh-math-flow && cd dsh-math-flow
node scripts/install.mjs                 # core: kernel + frozen claims + order gate + literature
```

```bash
node scripts/install.mjs --with-viz      # + plotting: Python / MATLAB / TikZ, 12 tools
node scripts/install.mjs --tier full     # + plotting, memory, team, negative knowledge
node scripts/install.mjs --dry-run       # print the plan, change nothing
node scripts/install.mjs --verify-only   # check an existing profile
node scripts/doctor.mjs                  # what toolchain is missing (read-only)
```

`--with-viz` is a separate switch rather than part of core because seven of `mm-toolkit`'s twelve tools need bridge scripts this repo does not carry. They are reported as missing, with the file name, rather than failing at spawn — see [`packages/mm-toolkit/README.md`](packages/mm-toolkit/README.md) for which five work out of the box.

The installer refuses to start if `node`, `dsh`, or `pnpm` is missing, installs one package at a time so a failure leaves a resumable profile, and skips anything already at the pinned version. It ends by reading `dsh --profile <name> --dump-config` and checking each plugin's *actual component id* — not the package name, because `misakanet@3.5.0` mounts as `misakanet-mcp` and a verifier that assumes otherwise reports a healthy install as broken.

What the last step prints at the core tier (measured, not illustrative):

```
  ok   lean-math  (dsh-plugin-lean-math)
  ok   claim-verify  (dsh-plugin-claim-verify)
  ok   research-gate  (dsh-plugin-research-gate)
  ok   paper  (dsh-plugin-paper)
  profile math-flow: 156 components, 0 of 4 expected plugins missing
```

`--with-viz` adds `mm-toolkit`; `--tier full` adds it plus `agent-teams`, `meow-memory`, `misakanet-mcp`.

Then:

```bash
dsh --profile math-flow        # boot it
```

## Requirements

| Need | How | Note |
|---|---|---|
| Node ≥ 22.5 | any install | the plugins are ESM with `engines` set |
| `dsh` | `npm i -g @deepseek-ai/dsh` | **verified on 0.1.5-rc.2.** npm `latest` is 0.2.2-rc.5 and has not been tested against these pins |
| `pnpm` | `npm i -g pnpm` | `dsh plugin` forwards to it |
| Lean 4 + Lake | `elan default leanprover/lean4:stable` | the kernel; without it verdicts return errors, not false passes |
| Mathlib | `git clone`, then `lake exe cache get` | needed for `import Mathlib`; ~4 GB |

Only Lean and Mathlib are optional, and only in the sense that the pipeline installs without them: the plugins mount, and every verdict then returns an error instead of a false pass. `node scripts/doctor.mjs` reports which are missing and the command that fixes each; it deliberately does not install Mathlib for you, because that is a disk decision, not a prerequisite.

If the mount check reports `MISS` on a newer host, that is version skew rather than a broken plugin — see failure #7 in [`docs/03-failure-log.md`](docs/03-failure-log.md).

## What is in this repo, and what you install separately

Three kinds of thing end up in a working pipeline, and they come from three different places. Conflating them is why most "agent stack" repos cannot be reproduced:

| Layer | Where it comes from | Status |
|---|---|---|
| kernel (`lean-math`), evidence (`claim-verify`), ordering (`research-gate`), literature (`paper`) | `packages/` in this repo | shipped |
| plotting (`mm-toolkit`) | `packages/`, `--with-viz` | shipped, optional — 5 of its 12 tools run without bridge scripts |
| memory, execution, negative knowledge | third-party npm packages, **declared not vendored** | pinned in [`docs/05-dependencies.md`](docs/05-dependencies.md) |
| watchdog, document output, ops | still in the author's single-machine setup | listed in [`packages/README.md`](packages/README.md), not installable yet |

That split matters: if you install only what is in `packages/`, you get a kernel and a gate but no memory, no team, and no failure log. The pipeline is the combination.

Per-plugin notes — what it refuses to do, not just what it does — live in each `packages/*/README.md`.

## Repository layout

```
packages/     5 shipped plugins; the other 6 are listed, not present
profiles/     core + full manifests, and the patch layer that encodes team policy
scripts/      install.mjs (one command) and doctor.mjs (read-only toolchain report)
docs/         01 architecture · 02 tool reference · 03 failure log · 04 measurement · 05 dependencies
lab/          the measurement protocol and metrics.csv schema — no fabricated numbers
patches/      host-specific patches, quarantined with their target version
```

If you read only two files, read [`docs/03-failure-log.md`](docs/03-failure-log.md) and [`docs/04-measurement.md`](docs/04-measurement.md). The first is ten post-mortems — three of them became the design rules above, the other seven are why the configuration looks the way it does. The second is how you would check whether any of this works. The plugins are the least interesting part: they are replaceable, and the log is not.

---

## How it is measured

This is the part that is usually missing. `lab/` contains the protocol, not a benchmark score.

Four questions that have answers:

1. **Memory effectiveness** — same 3-day task, memory on/off: how many turns to reach a workable state on a cold start?
2. **Duplicate-call rate** — share of identical tool+argument calls in a long session (baseline observed: 26%).
3. **Constraint survival** — in a 60-turn session, do 5 sampled symbols still mean at round 50 what they meant at round 5?
4. **Negative-knowledge reuse** — the same error appears twice: how many turns to find the existing lesson, versus debugging from scratch?

Minimum viable design: three arms, same person, same task, same starting state.

| Arm | Configuration | Isolates |
|---|---|---|
| A | base + web app only | no memory, no collaboration, no negative knowledge |
| B | A + memory | memory's contribution alone |
| C | full pipeline | the whole thing |

Every run records: turns, tool calls, duplicate calls, compactions, human interventions, reproducibility. One row per run in `lab/metrics.csv`.

**Do not run an experiment and write its conclusion in the same session.** After compaction the reviewer inherits the same wrong premises. This is failure #5 in the log, and it happened.

---

## What this does not do

- It does not make a weak model prove hard theorems. The kernel is a judge, not a generator.
- It does not remove the need to read. `paper` fetches and verifies citations; it does not understand them for you.
- It is not portable to every host version. The pins are in `profiles/full/package.json`; version skew is the top source of breakage.
- It has no benchmark score to advertise. The measurement protocol is the honest substitute.

---

## Status

Alpha. Five plugins are in `packages/` and installable today — `lean-math`, `claim-verify`, `research-gate`, `paper`, and optionally `mm-toolkit`; the other six are listed in [`packages/README.md`](packages/README.md) in dependency order with what each is waiting on, and are deliberately absent — a manifest that referenced them would fail to resolve, which is worse than an honest gap. Configuration in `profiles/` is de-identified. Host patches that depend on a specific `dsh` build belong in [`patches/`](patches/README.md), which currently and deliberately holds none.

Contributions that add a *measurement* are more welcome than contributions that add a plugin.

## License

MIT. See [`LICENSE`](LICENSE).
