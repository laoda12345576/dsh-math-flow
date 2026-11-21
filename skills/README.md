# skills

A dsh skill is a `SKILL.md` with frontmatter. The host shows its description, the model loads the body when the task matches, and that is the entire mechanism — there is no runtime, nothing is enforced by loading it. This is why the pipeline is split the way it is: **the skill says what each step must produce, the plugin refuses when it was not produced.**

`scripts/install.mjs` copies these into `<DSH_HOME>/skills/<name>/`; `dsh plugin add` cannot do that, which is why the installer has a second step at all.

## Shipped

| Skill | What it is | Pairs with |
|---|---|---|
| `research-protocol` | The order: survey → synthesis → verify, what each step has to leave on disk, and ~30 named failure modes with the round they came from. 730 lines. | `research-gate`, `claim-verify`, `paper`, `mm-toolkit` |
| `cordis-plugin-development` | How to inspect this host before extending it: ask for the real service/slot/schema instead of inferring an API from a name. | writing plugins — read it before `packages/` |
| `editing-cordis-compositions` | Composition rules: when a plugin row mounts, when it mounts and contributes nothing, and where a patch layer is allowed to touch. | `profiles/full/cordis.patch.yml` |
| `danus-main` | The main-agent contract for running Danus from dsh: data model, the strategic loop, layer boundaries, which decisions need the operator, and the honesty rule. | `danus` (installed only with `--with-danus`) |
| `danus-elaboration` | The five-section synthesis template (verdict → routes → interfaces → dangers → bridges) and the consult that turns it into `master_guidance`. | `danus-main` |
| `danus-initialize` | The first-run interview for a Danus deployment, with verification instead of "it should work". | a fresh Danus install |

`research-protocol` is written in Chinese. It is the one document here that was written *from* the experiment rounds rather than about them, and a rushed translation would cost more than it buys. An English version is a welcome contribution.

## The division of labour

This table is the whole design. Anything in the middle column that a machine can check is in the right column — not in the left one.

| Step | Must leave behind | Who refuses | What the refusal looks like |
|---|---|---|---|
| survey | four answers (who / reduced to what / by what method / stuck where) and ≥2 **verbatim** quotes from different local files | `research-gate` | `research_stage(advance)` fails when a quote is not a whitespace-normalised substring of the file it cites |
| synthesis | one criterion that maps onto `judge` + `predicate` + `value`, plus a refutation condition | `research-gate`, then `claim-verify` | the gate will not advance on prose; `verify_claim` rejects a criterion it cannot translate |
| verify | `prediction` + `confidence` written *before* the run; `claim_hash` attached to every claim in the report | `claim-verify` | `pass: null` with `verdict: "vacuous"` when perturbing every input row flips nothing |
| theorem | a `lean_audit` verdict in `{proven, computed, failed, blocked}` | `lean-math` | `proven` requires axioms ⊆ {propext, Classical.choice, Quot.sound} **and** `autoImplicit` off |
| close | `state.json` consistent with `claims.jsonl` and `notes.jsonl`; every `blocking` carries an `attempt` that appears in `run.log` | the protocol, checked by script | `research-state` / `terminate-check` report the inconsistency — they do **not** block |

That last row is deliberate. The scripts in `research-protocol/tools/` are **auditors, not gates**: they read a run directory and say whether its own records hold together. They cannot stop a turn; `research-gate` can. A skill that claimed otherwise would be lying about its own authority.

```
skills/research-protocol/tools/
  research-state.mjs    goal/state reconciliation, distance, surprise, --slice for the next round
  terminate-check.mjs   can this round stop? (transfer, blocking.attempt, disjunctive floor)
  run-audit.mjs         report vs ledger: hashes, 等级 promotion, 作废 propagation, 回收
  domain-audit.mjs      the inner-parameter question `space` cannot ask
  handoff.mjs           builds the next round's summary from report + claims, never from memory
  team-metrics.mjs      collapse / handoff cost / verdict coverage, from the session log
  read-any.mjs          reads UTF-16LE files that a `>` redirect produced
  clock-stamp.mjs       one citable timestamp, because the model cannot keep time
```

## Third-party skills this protocol expects you may want

None are vendored, none are pinned. They are other people's work and are listed so that "install a skill" does not turn into "guess a URL". See [`../docs/05-dependencies.md`](../docs/05-dependencies.md).

| Skill | Use it for | Where |
|---|---|---|
| `paper-writing`, `math-beamer` | turning a verified result into a paper or a talk | [VeryMath/AI4Math-Writing](https://github.com/VeryMath/AI4Math-Writing) |
| `loogle-search` | Mathlib type-signature search — "what is this lemma called" | loogle, Mathlib's own index |
| `rigorous-paper-reviewer` | notation and consistency audit over LaTeX | [shubham0704/claude-skills](https://github.com/shubham0704/claude-skills) |
| `lean-probe` | probing a Lean project over MCP instead of shell round-trips | PyPI: `lean-probe` |

The rule from `docs/05-dependencies.md` applies to skills too: **declare, do not vendor.** A skill copied into this repo stops tracking its upstream and starts aging silently.
