# Architecture

## 1. Why layers at all

A flat plugin list gives you no way to answer "can I add this one?" Layers exist to make that question decidable: **a plugin belongs to exactly one layer, and a layer holds exactly one plugin.**

The rule is not aesthetic. Every layer here corresponds to a place where information is either injected into the model's context or extracted from it. Two plugins in the same layer means two injections of the same kind, which means the same content arrives twice and the decay starts earlier, not later.

## 2. The eight layers

| Layer | Plugin | What it owns | What it must not do |
|---|---|---|---|
| execution | `agent-teams` | persistent members, dependency-aware DAG, mailbox, quality gates | be the only parallelism mechanism you have — plain subagents are single-level and lose their roster after compaction |
| computation | `lean-math` | the kernel as final judge: verify, axioms, goals, tactics | be trusted for anything it did not compile |
| computation | `proof-harness` | best-first tactic search with durable on-disk state | hold state in memory only — long proofs must be resumable |
| computation | `math-strategies` | strategy generation, batch runs, append-only trace | be treated as a verifier; it proposes, the kernel decides |
| computation | `ollama` | local small-model hints and pre-screening | ever be a verdict source |
| observation | `watchdog` | stall sampling for lean/lake processes | track every descendant process — see failure #4 |
| observation | `mm-toolkit` | plotting, numerical counterexamples, image reads | be the primary path for plain computation (it is slower than a script) |
| memory | `meow-memory` | re-injection after compaction | be paired with a second memory plugin |
| negative knowledge | `misakanet` | "how this error was fixed", searchable | be used as a literature search engine |
| literature | `paper` | multi-source search, open-access resolution, citation verification | silently accept a citation it could not resolve |
| output | `wps-bridge` | .docx / .xlsx / .pptx as real files | be replaced by markdown pretending to be a deliverable |
| ops | `hotloader`, `market`, `web` | mount / reload / unmount, skins, UI | participate in the task flow |

## 3. The three prohibitions

These are the rules that cost the most to learn.

**One memory plugin.** A large fraction of the plugin ecosystem competes for the same system-prompt injection slot. Installing two does not give you two memories; it gives you one paragraph written twice, which pushes the decay point earlier.

**Kernel before prose.** Never write the summary of a result before the kernel has returned a verdict on it. A `sorry` in a manifest is a text match, not a kernel conclusion. Documents generated in the other order describe mathematics that may not exist.

**No self-certification.** The member that proposes a claim is not the member that audits it. This is why the formalization role has a restricted toolset: it can translate and compile, but it cannot generate the strategy and cannot write the ledger verdict.

## 4. Data flow of one task

```
cold start
  │
  ├─ memory injects a long-term snapshot (once per session, no hit-testing on turn 1)
  │
  ├─ lean_status         confirm elan / lean / lake are present before any lean_*
  │
  ├─ misakanet_search    only on failure, never as a first move
  │     └─ get_lesson   read the full lesson, confirm it is the same pit
  │
  ├─ math_try_strategies multiple candidates in parallel
  │     └─ lean_verify_proof   kernel verdict — the only kind that counts
  │           └─ harness_prove best-first search for the long ones, resumable
  │
  ├─ viz_*               counterexamples and figures
  │
  ├─ wps_write           the deliverable, as a file
  │
  ├─ agent-teams         create → claim → mailbox → gates, for anything long
  │
  └─ compaction
        └─ memory re-injects: snapshot + files read this session + files written
```

The one constraint on ordering: **steps 5 and 6 cannot swap.** Search may resume after a compaction; a verdict may not be reconstructed from memory of a verdict.

## 5. What is deliberately absent

There is no dedicated epistemology layer here — no ontology plugin, no evidence gate as a first-class component. That role is played by `claim-verify` (which freezes a claim by hash so it cannot be rewritten after the fact) plus human discipline. This is a known structural gap, not a design choice; see the roadmap.
