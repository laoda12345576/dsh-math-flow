# Measurement protocol

The question "is this pipeline useful" cannot be answered. Four questions that can:

| # | Question | Measured as | Baseline |
|---|---|---|---|
| 1 | **Memory effectiveness** | same 3-day task, memory on/off — turns to reach a workable state on a cold start | start-of-day reconstruction from scratch |
| 2 | **Duplicate-call rate** | share of identical tool+argument calls in a long session | 26% observed |
| 3 | **Constraint survival** | in a 60-turn session, do 5 sampled symbols still mean at turn 50 what they meant at turn 5 | manual symbol audit |
| 4 | **Negative-knowledge reuse** | the same error appears twice — turns to locate the existing lesson vs. debug from zero | from-scratch debugging |

## Three arms, minimum

| Arm | Configuration | Isolates |
|---|---|---|
| **A** baseline | base bundle + web app only | nothing: no memory, no team, no negative knowledge |
| **B** single | A + one memory plugin | memory's contribution alone |
| **C** full | the whole profile | the pipeline as shipped |

Same person, same task, same initial state. Record the session id, turn count, tool-call count and compaction count for every arm.

More arms are only worth adding if they isolate exactly one component. "A + everything except X" is usually more informative than "A + X".

## What every run records

One row per run in [`metrics.csv`](metrics.csv):

```
run_id,group,task,turns,tool_calls,dup_calls,compactions,human_interventions,recovered_within_turns,verdict,note
```

- `run_id` — `lab-YYYYMMDD-<arm><n>`, e.g. `lab-20261103-C1`
- `recovered_within_turns` — for memory and negative-knowledge arms: how many turns until the agent was working on the actual task again
- `verdict` — `pass` / `fail` / `inconclusive`. **`inconclusive` is a legitimate result and should be the most common one early on**
- `note` — anything you observed but cannot yet explain. These become the next experiment; they are not failures

## Discipline

1. **One session per run.** Write the `run_id` in the first message.
2. **Never run an experiment and write its conclusion in the same session.** After compaction the reviewer inherits the same wrong premises. This is failure #5 in the log, and it happened.
3. **Numbers go in the file, not in the conversation.** Compaction averages prose; it does not preserve a table.
4. **Record every 10 turns** during the run: turns / tool calls / duplicate calls / whether a compaction occurred. Reconstructing this afterwards is unreliable.
5. **Do not run experiments inside the real research directory.** Half-finished experiment artifacts pollute symbol tables and status files, and then the next run starts from a corrupted state.

## Fairness notes

- Same task difficulty across arms. If arm C needs a harder task to look good, that is the finding.
- Same model and same reasoning budget across arms. A larger model in arm C measures the model.
- Randomize the order of arms across repetitions. The first run of the day is systematically different from the fifth.
- Report the cost alongside the quality. A pipeline that halves duplicate calls and doubles token spend is a trade-off, not a win.

## Known limitations of this protocol

- n is small. These are single-machine, single-user observations; treat them as directional, not as statistics.
- The "constraint survival" metric is sampled by hand and therefore partly subjective. A machine-checkable version would require the symbol table to be the authority, which is exactly what `claim-verify` freezes but does not yet audit automatically.
- Baseline numbers were collected on one host version. Version skew can move them.
