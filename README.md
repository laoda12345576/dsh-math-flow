# dsh-math-flow

**An agent workflow for mathematical research. Not a plugin count — a protocol: find out where other people stopped, turn the obstacle into a criterion that can be judged true or false, and only then allow computing.**

Most "agent stack" repos are a screenshot of a plugin list. This one ships a 730-line research protocol ([`skills/research-protocol/`](skills/research-protocol/SKILL.md)), five plugins whose job is to refuse, eight audit scripts, and a measurement protocol. Plugins are replaceable parts. The protocol is what survived a dozen experiment rounds going wrong.

[中文](README.zh-CN.md) · Built on DeepSeek Harness (`dsh`), Lean 4, and Mathlib.

---

## What it is for

Long mathematical sessions with an agent fail in three specific ways, and nothing ever crashes:

| Failure | What it looks like | Measured |
|---|---|---|
| **Constraint decay** | A symbol is defined in round 5, drifts by round 40, and by round 60 the agent is proving a theorem about a different object | By round 3 the agenda said only "which `m` to take" |
| **Compute first** | A number in ten minutes; a literature pass yields nothing in ten minutes — so everything becomes computing | "Searched to 10⁵, no solutions" submitted as progress |
| **Self-certification** | Whoever proposes a claim also announces it is true | `theorem trivial_thing : 1 = 1` with an unrelated `assertion`: verdict P, zero axioms, every check green |

Three failures, three rules, and each rule has an owner:

| Rule | Enforced by |
|---|---|
| Anything mechanically decidable becomes a function, not an agent | `claim-verify` (`verify_claim`) · `lean-math` (`lean_audit`) |
| Whoever proposes a claim may not certify it | `research-gate`'s three-role tool whitelist: `draft` cannot reach `lean_audit` |
| One description is authoritative; the rest are generated | `claim-verify` freezes the assertion text by hash; one changed character is a different claim |

## The protocol: three steps, one order

```
survey ──→ synthesis ──→ verify
read only     write criteria   compute
```

Each step must leave something the next round can pick up — not a summary:

| Step | Must leave behind | If it does not |
|---|---|---|
| **survey** | Four answers: who did it (down to the paper) · what they reduced it to (which algebraic object the geometry became) · by what method · **where it stopped** | The gate will not advance |
| | ≥2 **verbatim** quotes from different local files, as `[refs/x.txt] "a sentence from the text"` | Each quote is substring-matched against the file; paraphrase, splicing, or translation does not count |
| **synthesis** | One criterion that reads directly as `judge` + `predicate` + `value`, plus "what result would refute this" | A criterion that cannot become a table row is a wish, and cannot be handed out |
| **verify** | `prediction` and `confidence` written *before* the run; a `claim_hash` on every claim afterwards | surprise ≈ 0 across a round means the round notarised what it already knew |

Four more are in the protocol: computation is graded three ways (scratch / evidence / explore — only the last two wait for verify); a verdict has three outcomes and **"no conclusion" must exist**, or "no counterexample found" gets written as "holds"; numbers are never a proof (`forall` + `search` is rejected at call time); every statement in a report is tagged `[literature]` `[computed]` `[scratch]` `[guess]`.

## Who enforces, who only reminds

The most easily blurred line in this design, so it is stated:

| | What it is | What it can do | What it cannot |
|---|---|---|---|
| **skill** | a `SKILL.md`, loaded when the task matches | say what each step must produce, and why | enforce anything. Unloaded means absent |
| **audit scripts** (`skills/research-protocol/tools/`) | read-only over `goal.md` / `state.json` / `claims.jsonl` | judge whether a round's own records hold together | stop anyone. You have to run them |
| **plugin** | a component mounted into the host | actually refuse — the tool call returns a failure | judge anything but the mechanical part |

`research-gate` is the only thing that blocks. When it refuses it has to name what is missing, and it renders that message from the tools **actually visible in the current session** — it does not name tools that are not installed (that was a bug, fixed; see [`docs/03-failure-log.md`](docs/03-failure-log.md)).

## Install

One command. It creates its own profile (yours is untouched), installs each package, and then **installs the skills** — a plugin cannot do that, which is why the installer has a second step:

```bash
git clone https://github.com/laoda12345576/dsh-math-flow && cd dsh-math-flow
node scripts/install.mjs                 # core: kernel + frozen claims + order gate + literature + 3 skills
```

```bash
node scripts/install.mjs --with-viz      # + plotting: Python / MATLAB / TikZ
node scripts/install.mjs --tier full     # + plotting, memory, team, negative knowledge (third-party)
node scripts/install.mjs --with-purge    # + dsh-purge (the patch layer extends it; git-hosted, needs allowBuilds)
node scripts/install.mjs --no-skills     # plugins only
node scripts/install.mjs --skills-dir <dir>   # install skills elsewhere
node scripts/install.mjs --dry-run       # print the plan, change nothing
node scripts/install.mjs --verify-only   # check an existing install
node scripts/doctor.mjs                  # what toolchain is missing (read-only)
```

Measured output at the core tier — not illustrative:

```
  ok   lean-math  (dsh-plugin-lean-math)
  ok   claim-verify  (dsh-plugin-claim-verify)
  ok   research-gate  (dsh-plugin-research-gate)
  ok   paper  (dsh-plugin-paper)
  profile math-flow: 156 components, 0 of 4 expected plugins missing

  ok   skill research-protocol
  ok   skill cordis-plugin-development
  ok   skill editing-cordis-compositions
  skills: 3 of 3 present in <DSH_HOME>/skills
```

The check reads `dsh --profile <name> --dump-config` and compares each plugin's **actual component id**, not its package name: `misakanet@3.5.0` mounts as `misakanet-mcp`, and a verifier that assumes otherwise reports a healthy install as broken.

## Requirements

| Need | How | Note |
|---|---|---|
| Node ≥ 22.5 | any install | the plugins are ESM with `engines` set |
| `dsh` | `npm i -g @deepseek-ai/dsh` | **verified on 0.1.5-rc.2.** npm `latest` is 0.2.2-rc.5 and has not been tested against these pins |
| `pnpm` | `npm i -g pnpm` | `dsh plugin` forwards to it |
| Lean 4 + Lake | `elan default leanprover/lean4:stable` | the kernel; without it verdicts return errors, not false passes |
| Mathlib | `git clone`, then `lake exe cache get` | needed for `import Mathlib`; ~4 GB |

Only Lean and Mathlib are optional, and "optional" means the pipeline installs without them: the plugins mount, and every verdict then returns an error instead of a false pass. `node scripts/doctor.mjs` reports which are missing and the command that fixes each; it deliberately does not install Mathlib for you, because that is a disk decision, not a prerequisite.

## What is in the repo

| | Count | Where |
|---|---|---|
| Plugins: `lean-math` (kernel verdicts, 13 tools) · `claim-verify` (frozen claims, 4) · `research-gate` (order gate, 1) · `paper` (literature, 6) | 4 | [`packages/`](packages/) |
| Optional plugin: `mm-toolkit` (plotting / counterexamples, 12 tools, 5 work on a clean install) | 1 | [`packages/mm-toolkit`](packages/mm-toolkit) |
| Skills: `research-protocol` (the protocol itself) · `cordis-plugin-development` · `editing-cordis-compositions` | 3 | [`skills/`](skills/README.md) |
| Audit scripts: goal/state reconciliation, stop test, report audit, domain audit, handoff, team metrics, encoding-safe read, clock anchor | 8 | [`skills/research-protocol/tools/`](skills/research-protocol/tools/) |
| Third-party **packages**: `meow-memory` (memory) · `dsh-agent-teams` (teams) · `misakanet` (negative knowledge) | 3 | pinned, not vendored — [`docs/05-dependencies.md`](docs/05-dependencies.md) |
| Third-party **skills**: `paper-writing` · `math-beamer` · `loogle-search` · `rigorous-paper-reviewer` · `lean-probe` | 5 | other people's; declared, not vendored — [`skills/README.md`](skills/README.md) |

**Six more sit in the author's single-machine setup and are not here**: `watchdog`, `wps-bridge`, `hotloader`, `ollama`, `math-strategies`, `proof-harness`. [`packages/README.md`](packages/README.md) lists them with what each is waiting on. They are absent because they are not de-identified yet, depend on a specific host build, or measured out as worthless — not because they were forgotten.

Install only what is in `packages/` and you get a kernel and a gate: no memory, no team, no failure log. The pipeline is the combination above.

## How it is measured

`lab/` contains the protocol, not a benchmark score. Four questions that have answers:

1. **Memory effectiveness** — same 3-day task, memory on/off: how many turns to reach a workable state on a cold start?
2. **Duplicate-call rate** — share of identical tool+argument calls in a long session (baseline observed: 26%).
3. **Constraint survival** — in a 60-turn session, do 5 sampled symbols still mean at round 50 what they meant at round 5?
4. **Negative-knowledge reuse** — the same error appears twice: how many turns to find the existing lesson, versus debugging from scratch?

Minimum viable design: three arms (baseline / + memory / full pipeline), same person, same task, same starting state, one row per run in [`lab/metrics.csv`](lab/metrics.csv).

**Do not run an experiment and write its conclusion in the same session.** After compaction the reviewer inherits the same wrong premises. This is failure #5 in the log, and it happened.

## What this does not do

- It does not make a weak model prove hard theorems. The kernel is a judge, not a generator.
- It does not remove the need to read. `paper` fetches and verifies citations; `survey` insists on verbatim quotes precisely to stop "I know" from passing as "I read".
- It is not portable to every host version. Version skew is the top source of breakage.
- It has no benchmark score to advertise. The measurement protocol is the honest substitute.

## Status

Alpha. Plugins, skills and scripts are all installable today; third-party packages are pinned; the six single-machine plugins are listed, not shipped. Configuration in `profiles/` is de-identified. Host patches that depend on a specific `dsh` build belong in [`patches/`](patches/README.md), which currently and deliberately holds none.

If you read only two files, read [`skills/research-protocol/SKILL.md`](skills/research-protocol/SKILL.md) — the protocol, and the only document here written *from* the experiments rather than about them — and [`docs/03-failure-log.md`](docs/03-failure-log.md), ten post-mortems, three of which became the rules above.

Contributions that add a *measurement* are more welcome than contributions that add a plugin.

## License

MIT. See [`LICENSE`](LICENSE).
