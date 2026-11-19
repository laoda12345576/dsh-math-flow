# patches

Empty on purpose.

This directory is where fixes that depend on one specific `dsh` build are quarantined — the ones that cannot live in `packages/` because they patch a host file instead of extending it. A patch here must state its target version and must be opt-in; anything that silently edits `node_modules` on install is malware by another name, even when it is your own code.

## What belongs here

A patch earns a place here only if all three hold:

1. **It targets a host file**, not a plugin. A plugin that extends `ctx.tools` is a plugin, not a patch.
2. **It names the version it was written against**, and refuses to apply to another one. Silent application on a version it was not written for is how a working install becomes a mysterious one.
3. **It is reversible**, and says how.

## What was kept out

On the machine this repo was extracted from, two patches of this kind exist: a client-side fix for a workspace-sidebar crash caused by a persisted-state shape change, and a fix for a preflight check that killed its own process on `--help`. Neither is here.

Both are bound to `dsh 0.1.5-rc.2` and to a Windows host, and neither touches the mathematical path — with them absent, the pipeline reasons exactly the same, one panel renders nothing. Shipping them would have added two files that a reader has to audit to conclude "not relevant", which is the cost this directory exists to avoid.

If a host bug ever blocks the kernel path, the patch that fixes it goes here with its target version, and this note gets replaced by the actual reason.
