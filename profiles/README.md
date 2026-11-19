# profiles

Two profiles. Start with `least`, move to `full` once the kernel path works.

| Profile | Contents | Use |
|---|---|---|
| `least` | lean-math + claim-verify + base | the minimum that can produce a kernel verdict. Use this to confirm your Lean install before blaming the pipeline. |
| `full` | the shipped pipeline | memory, team, negative knowledge, literature, output |

## Installing

A dsh profile is a directory with its own `package.json`. Copy the one you want:

```bash
mkdir -p ~/.dsh/profiles/math
cp profiles/least/package.json ~/.dsh/profiles/math/
dsh --profile math --dump-config      # confirm what is actually mounted
```

`--dump-config` is the safe command: it reports the mounted bundle and component count and does not start a server.

Then apply the patch layer, if you want the team policy:

```bash
cp profiles/full/cordis.patch.yml ~/.dsh/profiles/math/cordis.patch.yml
```

## Version skew is the main failure mode

Plugin packages are not all released at the same host version. Before adding anything:

1. Read the host version: `dsh --version`
2. Check the plugin's compatibility note in its README
3. Pin exact versions (`name@x.y.z`). A bare name can install the previous version and report success — see failure #7 in [`../docs/03-failure-log.md`](../docs/03-failure-log.md).

If a plugin fails to mount, do not assume the plugin is broken. Dump the config and read the console first; both are version-skew symptoms in practice.
