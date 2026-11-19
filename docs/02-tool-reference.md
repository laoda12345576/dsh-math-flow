# Tool reference

Grouped by layer. The "use this when" column is the actual discipline; most wrong tool calls are a right tool used at the wrong time.

## Computation

### `lean-math` — the hands and eyes

| Tool | Use when |
|---|---|
| `lean_status` | **always first.** Confirms elan / lean / lake are on PATH before any other `lean_*` |
| `lean_search_premise` | you need a Mathlib lemma by informal description or type signature |
| `lean_verify_proof` | **the final judge.** Full source in, success/failure with error positions out |
| `lean_axioms` | checking whether a declaration still depends on `sorryAx` — this is the only real "no sorry" check |
| `lean_deps` | dependency tree of a declaration |
| `lean_query` | declarations and instances present in the environment |
| `lean_open_file` | start an interactive session (stores source text, not an LSP process) |
| `lean_get_goals` | read the current goal; a rejected tactic is rolled back automatically |
| `lean_run_tactic` | append one tactic |
| `lean_update_source` | edit the session source |
| `lean_undo` | step back |
| `lean_sessions` | list sessions |
| `lean_close_session` | end a session |

`projectDir` defaults to a configured Mathlib checkout, so proofs importing `Mathlib` do not need `project_dir` passed each time.

### `proof-harness` — resumable search

`harness_prove` (start) · `harness_resume` (continue) · `harness_runs` (history) · `harness_status` (current).

State lives on disk. Long searches survive a crash, a reboot, and a compaction. Use it only after `math-strategies` has produced candidates worth searching.

### `math-strategies` — proposals, not verdicts

`math_solve_direct` · `math_try_strategies` · `math_generate_strategies` · `math_judge_premises` · `math_prove_with_strategy` · `math_record_attempt` · `math_read_trace`.

The trace is append-only JSONL. In a batch, **all goals share one `run_id`**, so a single `math_read_trace {run_id}` retrieves the whole run afterwards.

### `claim-verify` — turning a claim into a function call

`verify_claim` · `claim_audit` · `lean_audit` · `research_note`

`verify_claim` runs a numeric script and judges the output against a **pre-declared** expectation, then freezes the claim by hash so it cannot be rewritten after the fact. This is the replacement for the deleted `check` role (failure #2): same work, seconds instead of minutes, no context, no forgetting to report.

`claim_audit` answers a different and more valuable question than "was the verdict right": **was the criterion changed after it was judged?** A silently swapped criterion is more common than a wrong verdict, and no function catches it.

`lean_audit` reads a Lean file, runs the kernel, and emits a verdict. The member that runs it does not get to write the ledger entry — that separation is the point.

### `research-gate` — ordering, enforced

`research_stage`

Prior art before computation; a falsifiable criterion before numeric verification. It is one tool because it is one gate. Enforcing order as a gate, not as a reminder, is what turns "I should have checked first" into a blocked call.

### `ollama` — hints only

`llm_status` · `llm_load` · `llm_unload` · `llm_suggest` · `llm_premise_hint`.

A local small model is useful for pre-screening and premise hints. It is never a verdict source. Treat its output as a candidate generator with a nonzero error rate.

---

## Memory

### `meow-memory`

`memory_home` / `memory_project` (two scopes) · `memory_remember` (dedup + merge) · `memory_search` (BM25) · `memory_read` · `memory_update` · `memory_find_similar` · `memory_dream` (manual consolidation: atomic facts → topics → project summary; also runs automatically after ≥3h idle) · `/dream` (immediate).

**What makes it different from other memory plugins:** after a compaction it re-injects the snapshot *plus* the project panorama it saw this session *plus* the originals of content that was written. Most memory plugins go silent exactly when the context is most damaged.

Writing discipline:

- Write what will be needed again: project facts, preferences, pits, falsified conclusions.
- Do not write process ("first I tried A, then B"). Process belongs in the session log.
- Do not hand-copy conclusions before compaction. Re-injection already does it; copying duplicates.

---

## Negative knowledge

### `misakanet`

Read path: `misakanet_search` → `misakanet_get_lesson` → `misakanet_me_events`.
Write path: `misakanet_submit_intake` · `misakanet_write_lesson` · `misakanet_preflight` · `misakanet_register` · `misakanet_submit_usage` · `misakanet_usage_status` · `misakanet_memory_context`.

It stores **"how this error was fixed"**, not "what this theorem says". Using it as a general search engine wastes the whole layer. The value is that an already-refuted path does not get walked again three days later.

---

## Execution

### `agent-teams`

`create` · `add_member` · `remove_member` · `create_task` · `claim_task` · `assign` · `update_task` · `amend_task` · `edit_plan` · `send_message` · `approve` · `resume` · `status` · `delete`.

Mechanism: captain + persistent members + dependency-aware DAG + mailbox + optional quality gates (requirement → implementation → verification → review → integration contract, with automatic return-to-review on failure).

This is the only source of genuine parallelism in the pipeline. A plain subagent is single-level, has no mailbox and no DAG, and — after compaction — forgets it was ever spawned.

Tool policies matter more than role descriptions. See `profiles/full/cordis.patch.yml` for the working split: a drafting member with high-entropy generation rights, a formalization member that may compile but not strategize, an adversarial member whose tools are chosen to make refutation cheap.

---

## Literature

### `paper`

Multi-source search (OpenAlex / Crossref / arXiv / zbMATH), open-access resolution (Unpaywall, OpenAlex locations, arXiv), three-level fetch degradation with local PDF extraction, and citation verification against hallucination.

It also exposes channel and resolution tools used by the adversarial member to look for known counterexamples — a different information source, not a different personality. Personality is free and therefore worthless as a source of independence.

---

## Output

### `wps-bridge`

`wps_open` · `wps_write` · `wps_read` · `wps_sheet` · `wps_slides` · `wps_to_pdf` · `wps_close` · `wps_status`.

Parameters take literal values, not shell expressions. Passing `$(Get-Content ...)` into a tool argument is carrying shell habits into a tool call and fails in a way that looks like a plugin bug.

### `mm-toolkit`

`viz_gen` · `viz_python` · `viz_tex` · `viz_matlab` · `viz_list` · `viz_see` · `viz_doctor` — plotting and counterexample images via local Anaconda Python / MATLAB / LaTeX-TikZ.

`browser` · `browser_read` · `browser_status` — persistent browser automation daemon.

`cnki` — Chinese literature index.

`think` — multi-session Socratic deliberation; useful when a decision needs to be argued out rather than computed.

`viz_python` is an executor: whatever it prints comes back, and a run with no figure is still a success. This matters — an earlier version bound success to the existence of a PNG, so pure computation returned `ok:false`, and members concluded their work had failed and looped.

---

## Ops

`watchdog_status` — stall sampling for `lean`/`lake`, exposed as a service other plugins can register work with. Read failure #4 before enabling descendant tracking.

`plugin_hotload` — mount / reload / unmount other plugins in a running host. Gives a plugin author a real activation verdict without restarting.

`dsh-purge` — rule injection, rewind, skill management: `purge` · `purge_apply` · `purge_revert` · `purge_status` · `rewind` · `rules` · `skills`.

`dshmarket` · `dsh-web` · `remote-web-ui` — plugin market, skins, remote UI. Decoration. Not in the task flow.
