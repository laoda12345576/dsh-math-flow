# Failure log

Every rule in this repo was paid for. This file is the receipt.

Written as post-mortems: what we expected, what happened, what changed. None of these are hypothetical.

---

## 1. Roles split by resource instead of by verifiability

**Expected.** A team of three: a literature member, a computation member, a drafting member. Each gets the tools its job needs.

**Happened.** The split constrained *what members could use* and left completely unconstrained *whether what they returned was correct*. The literature member produced claims it could not check; the computation member produced numbers with no source. Both were busy. Neither was right.

**Changed.** Split along decidability instead: things a function can decide go to a function; things that need judgment go to a member; things that need taste go to the captain.

---

## 2. Turning "checking" into an agent position

**Expected.** If verification matters, give it a dedicated member. Call it `check`. It reads the task, writes a script, runs it, reports pass/fail.

**Happened.** `check` lived 103 seconds and returned **zero verdicts**. It did not fail at checking. It failed at a five-step loop: read context → understand task → write script → execute → report. Any one of those steps can break, and step three broke.

The same check, exposed as a tool call, takes a few hundred milliseconds, is reproducible, needs no context, and cannot forget to report.

**Changed.** The `check` role was deleted. `verify_claim` replaced it: run a script, compare against a pre-declared expectation, freeze the claim by hash. Judgment about *whether the criterion is worth checking at all* moved to the adversarial member — the only position that generates new information.

**Rule.** Anything mechanically decidable becomes a function. Using an agent for it is using five steps to do one call.

---

## 3. A hundred checks of a tautology

**Expected.** Run a batch of numeric verifications on a conjecture; passing checks are evidence.

**Happened.** 46 of the checks verified `p² + 1 ≡ 1 (mod p)` — true for every prime, carrying zero information. All PASS. The batch looked strong and proved nothing. No function can catch this: the criterion was well-formed, the script was correct, the expectation was met.

**Changed.** The adversarial member's job is explicitly to ask "is this criterion a cheap substitute?" and "is it vacuously true?". A passing check is only evidence if someone tried to destroy the criterion first.

**Rule.** Verification volume is not evidence. One member must be paid to attack the criterion, not the claim.

---

## 4. A watchdog that watched itself

**Expected.** Watch long-running `lean` / `lake` processes for stalls and push a warning into context so the agent notices a hang.

**Happened.** `trackDescendants: true` pulled *every* descendant of the host process into the watch set — including the shell the watchdog itself spawns on every sample, and that shell's console host. Those processes idle after their WMI query finishes, so CPU growth is zero by construction. Three consecutive samples later, they were declared stalled:

```
[watchdog] <shell>.exe PID 25052 stalled 143s (CPU +0ms, disk +0KB/sample)
```

Two of these snapshots landed inside a 258-second reasoning gap. The captain spent the gap investigating a fault that did not exist.

**Changed.** Descendant tracking disabled; the plugin stays installed for its `watchNames` path (real `lean`/`lake` hangs) but contributes nothing else.

**Rule.** Noise is not free. It bought exactly one thing here: a wrong attribution.

---

## 5. Self-review inside the same session

**Expected.** The agent that did the work reviews the work before delivering. Cheap, no extra process.

**Happened.** Reviewing its own output, the agent used the same wrong premises that produced the output. It found style issues and missed the structural error, consistently. After a compaction it was worse: the summary it inherited was written by the same process that made the mistake.

**Changed.** Verification goes to the kernel when the claim is formal, and to a **read-only fresh session** when it is not. Never to the working session.

**Rule.** The one who does cannot be the one who judges. This applies to agents exactly as it applies to people.

---

## 6. Four descriptions, four linters

**Expected.** The project maintained a prose report, a Lean development, a set of scripts, and a status table. They drifted, so: add a linter for each. Four consistency checkers.

**Happened.** Four linters meant four specifications of what "consistent" means, and the checkers disagreed with each other before they disagreed with the content. The maintenance cost grew faster than the drift shrank.

**Changed.** One description is authoritative; the others are generated from it. Concretely: statements are frozen into single-declaration Lean files with a manifest, and the prose is checked against *that*, not against another prose file.

**Rule.** Do not add a checker to each copy. Demote three copies.

---

## 7. Silent version downgrade

**Expected.** `pnpm add package-name` installs the current version.

**Happened.** It installed the *previous* version and reported success. Two days lost to a feature that was documented, present in the source, and absent from the installed tree.

**Changed.** Pin exact versions everywhere (`name@x.y.z`), never bare names. Lock files are committed.

**Rule.** A package manager that reports success is not evidence of which code is running.

---

## 8. Two memory plugins

**Expected.** Memory is important, so use two — one for global facts, one for project facts.

**Happened.** Both competed for the same system-prompt injection slot. Every session got the same memory content injected twice, roughly doubling the token cost of memory and moving the decay point *earlier*, because the duplicated block crowded out actual task content.

**Changed.** One memory plugin, two scopes inside it (global / project). The discipline also got explicit: write only what will be needed again — project facts, preferences, pits already fallen into, conclusions already falsified. Never write the process; the process lives in the session log.

**Rule.** In any layer that injects into context, one is one and two is zero.

---

## 9. Treating compaction as a lifeline

**Expected.** When the context fills, compaction summarizes and work continues.

**Happened.** Compaction is a disaster point, not a continuation point. Constraints dissolve; the summary preserves conclusions and drops the conditions they were derived under. Work that spans days and relies on the summary being faithful is work that will silently change subject.

**Changed.** Do not wait for the automatic compaction on multi-day work. Open a new session deliberately, and re-enter through memory (which re-injects the snapshot plus the files read and written) rather than through a summary.

**Rule.** Cross days by restarting, not by compacting.

---

## 10. Two host-level traps worth documenting

**`--help` killed a live session.** A preflight wrapper decided whether to treat an invocation as a long-running server by matching arguments, and matched too broadly. Running `dsh web --help` to look up a flag terminated the user's running instance. The fix required patching **two copies** of the preflight entry — the plugin's own and the copy the host had extracted into its `lib/`. Fixing one copy changed nothing observable.

**A stale local key blanked the sidebar.** A UI plugin read a persisted view object and called `Object.entries()` on a field that older versions of the persisted object did not have (the field was added later; existing users had the old shape). One `TypeError` crashed the whole `sidebar.workspaces` slot, so both the workspace list and the session list disappeared — with no visible error unless you opened the console.

**Rule.** Both are version-skew bugs, and both are invisible from the outside. Before concluding "the feature is broken", dump the actual config and read the console. And when a patch targets `node_modules`, patch every copy the host loads, then verify by behaviour, not by file content.
