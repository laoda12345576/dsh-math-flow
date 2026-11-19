# lab

Where the pipeline gets judged. Read [`../docs/04-measurement.md`](../docs/04-measurement.md) first — the protocol matters more than the tooling here.

```
lab/
  metrics.csv     one row per run. Do not summarize into prose.
  runs/           one file per run: <run_id>.md
  notes/          observations you cannot explain yet. These are the next experiment.
```

## Run file template

```markdown
# <run_id>

- arm: A | B | C
- task: <one sentence, identical across arms>
- model / reasoning effort: <must be identical across arms>
- started: <timestamp>
- host version: <dsh version, plugin pins if changed>

## Log (every 10 turns)

| turn | tool calls | duplicate calls | compaction | note |
|---|---|---|---|---|
| 10 |  |  |  |  |
| 20 |  |  |  |  |

## Result

- verdict: pass | fail | inconclusive
- metric under test: <which of the four>
- value: <number>
- what would have falsified this: <state it before looking at the result>

## What surprised me

<Anything unexplained. Write it even if it contradicts the hypothesis.>
```

## Rules

1. One session per run. `run_id` goes in the first message of that session.
2. Never write the conclusion in the same session that produced the data.
3. Numbers in the file, not in the chat.
4. Do not run experiments in a real research directory. Half-finished artifacts corrupt the symbol table and the next run starts from a broken state.
5. `inconclusive` is a real result. Early on it should be the most common one.
