# packages

The plugins, extracted from a working single-machine setup. Migration is in progress, in dependency order.

## Order and status

| # | package | tools | lines | depends on | status |
|---|---|---|---|---|---|
| 1 | `lean-math` | 13 | ~2.5k | — | done |
| 2 | `math-strategies` | 7 | ~3.8k | lean-math | done |
| 3 | `proof-harness` | 4 | ~1.1k | lean-math | done |
| 4 | `claim-verify` | 4 | ~2.2k | — | done |
| 5 | `research-gate` | 1 | ~1.2k | — | done |
| 6 | `paper` | 6 | ~1.7k | — | pending |
| 7 | `mm-toolkit` | 12 | ~1.3k | — | pending |
| 8 | `watchdog` | 1 | ~0.9k | — | pending |
| 9 | `wps-bridge` | 8 | ~1.2k | — | pending |
| 10 | `hotloader` | 1 | ~0.6k | — | pending |
| 11 | `ollama` | 5 | ~0.7k | — | pending |

Every package is MIT, ESM, no build step (`lib/index.js` is the entry), Node ≥ 22.5.

## Migration checklist

Do these in order for each package. The first two are blocking.

- [ ] **De-identify.** No absolute paths (`C:\Users\...`, `D:\...`), no usernames, no machine names. Absolute paths become config options with a documented default of `undefined`.
- [ ] **Strip data.** Delete `data/*.jsonl`, trace files, `.bak` files, and anything else generated locally. They contain session content and paths.
- [ ] **Remove the other plugin's internals.** Local cross-links (`link:D:/...`) become either a workspace path or a real version dependency.
- [ ] **README.** What it does, what it needs, what it refuses to do, one minimal example. The "refuses to do" section is not optional — it is what stops misuse.
- [ ] **Test entry.** `npm test` or `node test/run-all.mjs` must exist and pass on a clean checkout.
- [ ] **Version.** Start from the version in the table, do not reuse `1.0.0` for something that changed during extraction.

## Not being published

- Local-only experiments that did not survive contact with a real task.
- Anything whose activation depends on a specific host build. Those go to `../patches/` with the target version stated, and they are opt-in.
