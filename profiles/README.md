# profiles

Two tiers. `package.json` in each directory is **what the installer writes**, kept here so you can read the shape without running anything — not a file to hand-copy and edit. Use the installer.

```bash
node scripts/install.mjs                  # tier=core, profile=math-flow
node scripts/install.mjs --tier full      # + memory, team, negative knowledge
```

| Tier | Contents | Use |
|---|---|---|
| `core` | lean-math + claim-verify + research-gate | the minimum that produces a kernel verdict and refuses to compute before surveying. Confirm your Lean install here before blaming the pipeline. |
| `full` | core + meow-memory + agent-teams + misakanet | memory across compaction, persistent members, negative knowledge. The pipeline proper. |

`profiles/full/cordis.patch.yml` is the patch layer: team policy, per-role tool allow-lists, and the watchdog decision (installed, descendants off — the comments in that file are the design). The installer copies it only for `--tier full`, because every block in it configures a bundle core does not have; applying it to core produces boot warnings about entries nobody asked for. `--patch` forces it, `--no-patch` forbids it.

## What the installer actually does

1. Preflight: `node` ≥ 22.5, `dsh`, `pnpm` on PATH. It stops rather than half-installing.
2. Writes the profile manifest with `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`. A profile name with no shipped template would otherwise boot with `dsh-base` only — no UI.
3. `dsh plugin --profile <name> add <spec>` per package, one at a time. Not a batch: a failure leaves a resumable profile instead of an unclear one.
4. Skips anything already at the pinned version, so re-running is a no-op.
5. Reads `dsh --profile <name> --dump-config` and checks each plugin's **actual component id**, resolved from the package's own `cordis.patch.yml`.

Step 5 exists because step 3 succeeding means nothing. `dsh plugin add` reports success when pnpm installed the package; it says nothing about whether the component mounted. And the component id is not the package name — `misakanet@3.5.0` mounts as `misakanet-mcp`, which a name-matching verifier reports as a broken install.

## When it fails

**`dsh plugin` exits non-zero.** Re-run; installs are idempotent. If the failing item is third-party, read the pnpm output — a registry hiccup looks the same as a bad pin.

**Verification shows MISS but install succeeded.** Version skew, or the bundle list did not reconcile. Check `~/.dsh/profiles/<name>/package.json` for the entry under `dsh.profile.bundles`, then `--dump-config` and read stderr.

**Patch warnings at boot.** `patch: entry "watchdog" not found` is expected when that bundle is not installed — the patch carries a disabled block for it deliberately. The config still mounts.

**Toolchain missing.** `node scripts/doctor.mjs` — separate problem, separate report. The plugins mount without Lean; they just return errors instead of verdicts.

Versions are pinned on purpose. Before changing one: `dsh --version`, then the plugin's compatibility note, then pin the exact release.
