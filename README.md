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

```bash
# 1. a dsh profile that already works
dsh --profile web --dump-config     # confirm what is actually mounted

# 2. add the pipeline
dsh plugin --profile web add <this-repo>/packages/lean-math

# 3. verify the kernel path end to end
#    (in a session) lean_status → lean_verify_proof on a trivial lemma
```

Requirements: Node ≥ 22.5, `elan` + Lean 4 + Lake on `PATH`, and a local Mathlib checkout for `import Mathlib` proofs.

Per-plugin install notes live in each `packages/*/README.md`. Optional pieces (`wps-bridge`, `jammers-sim`, `ollama`) are platform- or hardware-specific and can be skipped without breaking the math path.

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

Alpha. The plugins are extracted from a working single-machine setup and are being moved into `packages/` one at a time, in dependency order (`lean-math` → `math-strategies` / `proof-harness` → `claim-verify` → rest). Configuration in `profiles/` is de-identified; host patches that depend on a specific `dsh` build are quarantined in `patches/` with their target version stated.

Contributions that add a *measurement* are more welcome than contributions that add a plugin.

## License

MIT. See [`LICENSE`](LICENSE).
