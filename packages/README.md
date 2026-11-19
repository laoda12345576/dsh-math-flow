# packages

The plugins, extracted from a working single-machine setup. Only the five marked **in repo** are here; the rest are still in that setup and are listed so the dependency order is documented rather than remembered.

## Order and status

| # | package | tools | lines | depends on | status |
|---|---|---|---|---|---|
| 1 | `lean-math` | 13 | ~2.5k | — | **in repo** |
| 4 | `claim-verify` | 4 | ~2.2k | — | **in repo** |
| 5 | `research-gate` | 1 | ~1.2k | — (reads `paper_*` if present) | **in repo** |
| 2 | `math-strategies` | 7 | ~3.8k | lean-math | not extracted |
| 3 | `proof-harness` | 4 | ~1.1k | lean-math | not extracted |
| 6 | `paper` | 6 | ~1.9k | — | **in repo** |
| 7 | `mm-toolkit` | 12 | ~1.3k | MATLAB / Python / xelatex; 7 tools need bridge scripts | **in repo** — optional tier |
| 8 | `watchdog` | 1 | ~0.9k | — | not extracted |
| 9 | `wps-bridge` | 8 | ~1.2k | local WPS install | not extracted — platform-coupled |
| 10 | `hotloader` | 1 | ~0.6k | — | not extracted — dev tool |
| 11 | `ollama` | 5 | ~0.7k | local Ollama | not extracted — optional |

`node scripts/install.mjs` installs the four core packages; `--with-viz` adds `mm-toolkit`, and `--tier full` adds it together with the three third-party ones. Anything above marked *not extracted* will fail to resolve if you add it to a manifest by hand — that is why the profile templates no longer list them.

`mm-toolkit` is shipped but not on the default path on purpose: five of its twelve tools work on a clean install, seven need helper scripts the repo does not carry. See its README for the matrix.

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
