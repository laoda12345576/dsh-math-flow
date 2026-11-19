# dsh-plugin-claim-verify

Turn a research claim into a function call.

The point is a separation, not a check: **the script that produces data and the process that judges it are two different executions.** A script that can compute `0` can also append `print("PASS")`, and in the return value the two look identical. That gap is the whole problem this package exists to close.

## Tools

| Tool | What it does |
|---|---|
| `verify_claim` | Run a script, read its JSON lines, judge them against a **pre-declared** `expect`, freeze the claim by hash |
| `claim_audit` | Check whether a criterion was changed *after* it was judged |
| `lean_audit` | Compile a Lean file with the kernel and emit a verdict |
| `research_note` | Append to the research ledger (lean / coverage_incomplete / python) |

## How the contract works

The script prints one JSON object per line. `judge.py` decides — in a separate process, from `expect` alone — whether that counts as passing. The script contributes data. It never contributes a verdict.

```
verify_claim(script, expect, claim_id)
      │
      ├─ spawn python -u script.py        → stdout: {"n": 44, ...}
      │
      └─ spawn judge.py --expect ...      → verdict: pass | fail
                                              │
                                              └─ freeze claim by hash
```

Freezing by hash is what makes `claim_audit` possible: a claim that was rewritten after its verdict no longer matches its hash, which is reported as a distinct event rather than silently accepted.

## Requirements

- Node ≥ 22.5
- Python 3 on `PATH` (or set `pythonExe`)
- For `lean_audit`: `lean` and `lake` on `PATH`, plus a Mathlib project directory

## Why this is not a test runner

A test runner answers "does the code work". This answers "is the claim true, and has anyone changed the claim since". The second question is the one that matters when the thing being verified is a research assertion produced by an agent that could plausibly have revised its own success criterion.
