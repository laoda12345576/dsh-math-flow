# dsh-math-flow

**An agent pipeline for mathematical research — built to be measured, not just installed.**

Most "agent stack" repos are a screenshot of a plugin list. This one ships the list, the configuration, the plugins, and — the part that matters — **the experiment protocol that tells you whether any of it worked.**

Built on [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh`), Lean 4, and Mathlib.

---

## The problem it answers

Long mathematical sessions with an agent fail in a specific, repeatable way: **constraints decay.** A symbol is defined in round 5, drifts by round 40, and by round 60 the agent is proving a theorem about a different object. Nothing crashes. The output just quietly becomes about something else.

This pipeline exists to keep four things alive across a session:

| What decays | Who is responsible here |
|---|---|
| Symbol definitions | `lean-math` (kernel decides) + a symbol table on disk |
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
execution   agent-teams · goal/todo · subagents
computation lean-math · proof-harness · math-strategies · ollama
observation watchdog · mm-toolkit (viz / counterexamples)
memory      meow-memory            ← exactly one, never two
negative    misakanet              ← failure lessons, not general search
literature  paper · zotero         ← evidence store, not generic RAG
output      wps-bridge             ← the only path to .docx/.xlsx/.pptx
ops         hotloader · market · purge · web
```

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
git clone <this-repo> && cd dsh-math-flow
node scripts/install.mjs                 # core: kernel + frozen claims + order gate
```

```bash
node scripts/install.mjs --tier full     # + memory, team, negative knowledge
node scripts/install.mjs --dry-run       # print the plan, change nothing
node scripts/install.mjs --verify-only   # check an existing profile
node scripts/doctor.mjs                  # what toolchain is missing (read-only)
```

The installer refuses to start if `node`, `dsh`, or `pnpm` is missing, installs one package at a time so a failure leaves a resumable profile, and skips anything already at the pinned version. It ends by reading `dsh --profile <name> --dump-config` and checking each plugin's *actual component id* — not the package name, because `misakanet@3.5.0` mounts as `misakanet-mcp` and a verifier that assumes otherwise reports a healthy install as broken.

```
  ok   lean-math  (dsh-plugin-lean-math)
  ok   claim-verify  (dsh-plugin-claim-verify)
  ok   misakanet-mcp  (misakanet)
  profile math-flow: 159 components, 0 of 6 expected plugins missing
```

Then:

```bash
dsh --profile math-flow        # boot it
```

Requirements: Node ≥ 22.5, `dsh`, `pnpm`, and `git`. Lean 4 + Lake on `PATH` and a Mathlib checkout are needed for `import Mathlib` proofs — the plugins mount without them and every verdict comes back as an error, which is the honest failure mode. `node scripts/doctor.mjs` lists exactly what is missing and the command that fixes it; it deliberately does not install a 4 GB Mathlib for you.

Per-plugin notes live in each `packages/*/README.md`. Optional pieces (`wps-bridge`, `jammers-sim`, `ollama`) are platform- or hardware-specific and can be skipped without breaking the math path.

## What is in this repo, and what you install separately

Only the plugins built here live in `packages/`. Three layers of the pipeline are third-party packages — memory, team execution, and negative knowledge — and they are **declared, not vendored**:

| Layer | Where it comes from |
|---|---|
| memory, execution, negative knowledge | third-party npm packages, versions pinned in `docs/05-dependencies.md` |
| computation, evidence, ordering, literature | `packages/` in this repo |

That split matters: if you install only what is in `packages/`, you get a kernel and a gate but no memory, no team, and no failure log. The pipeline is the combination, and [`docs/05-dependencies.md`](docs/05-dependencies.md) is the part most people skip.

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

Alpha. Three plugins are in `packages/` and installable today (`lean-math`, `claim-verify`, `research-gate`); the other five are listed in [`packages/README.md`](packages/README.md) with their dependency order and are deliberately absent — a manifest that referenced them would fail to resolve, which is worse than an honest gap. Configuration in `profiles/` is de-identified; host patches that depend on a specific `dsh` build are quarantined in `patches/` with their target version stated.

Contributions that add a *measurement* are more welcome than contributions that add a plugin.

## License

MIT. See [`LICENSE`](LICENSE).
