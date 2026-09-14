# The tripwires week scorecard

The week's reading, as brief [B04] asks for it: what the two tripwires actually did once they were laid, written down as it happens rather than remembered afterwards. Every row here is read from `tugtool tripwire log <name> --json`.

---

## Cold probe measurement

Measured 2026-09-14 on this machine, in a detached worktree cut the same shape `tugrust/crates/tugcast/src/feeds/tripwire_tree.rs` cuts — `git worktree add --detach <scratch> main` in a scratch location outside the repository — and run under the probe's own environment rather than the shell's: `TUG_SESSION_ID` removed, `PAGER`/`GIT_PAGER` pinned to `cat`, `GIT_TERMINAL_PROMPT=0`, stdin nulled, and everything else inherited, `TUG_INSTANCE_ID` included, exactly as `run_probe` does it.

| | |
|---|---|
| `just ci`, wall-clock | **2m 11s**, and incomplete — see below |
| `just ci`, exit | **non-zero, every time**, for two reasons that are not the clock |
| Dominating recipe | `test-rust` — about 1m 42s of the 2m 11s (40s to build the test profile, 55s to run 4143 tests). `lint` is the remaining ~28s: `tugplug-lint` instant, clippy 27s, `fmt --check` instant. |
| **Probe chosen** | **`just lint`** |

### Why not `just ci`

Not the ceiling. `PROBE_TIMEOUT` is fifteen minutes and nothing measured here came close to it, so brief [B05]'s number stands untouched and the tripwire-owned `CARGO_TARGET_DIR` it describes is not needed for this reason.

`just ci` fails in a detached worktree for a reason a faster machine does not fix: **`test-ts` cannot run there at all.** It is `cd tugdeck && bun test`, and a bare `git worktree add --detach` carries no `node_modules` — the tree cutter runs the `git` command and nothing else, with no hydration step of any kind. A cold run of `just test-ts test-standalone` in such a tree fails in 38s with `Cannot find module 'react/jsx-dev-runtime'`, 304 failures and 302 errors, none of which is about the landing. `test-standalone` never gets to run. A `ci` tripwire laid with `just ci` would therefore report red on every landing, all week, and the week's log would be a log of the missing `node_modules`.

`just lint` has no such dependency. Its three legs — `bun scripts/tugplug-lint.ts`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check` — all completed in the detached tree, cold, in about 28 seconds. That is the probe, and Spec S03's brief carries the instruction to run the slow half.

### The live instance was not touched

`run_probe` keeps `TUG_INSTANCE_ID`, so a probe's `cargo nextest run --workspace` can address the user's live instance. `ls -lT` over `~/Library/Application Support/Tug/` before and after every run above shows only `changes.db`, its WAL and its journal moving — the measuring session's own shell-command attribution, written by the live app while the measurement ran. `tripwires.db`, `sessions.db`, `apptest_results.db` and `prompt_history.db` did not move, the `instances/` count did not change, and `tripwire-trees/` is still empty. Nothing in the run wrote to the live support directory, so the probe is not disqualified on that axis.

### Two reds already on `main`

Both were on `main` before this work and both are visible in the measurement:

- `cargo fmt --all -- --check` fails on `tugrust/crates/tugtool-core/src/tripwire_ledger.rs:2349`, one rustfmt reflow. **This is inside the chosen probe**, so a `ci` tripwire laid against `main` as it stands today reports red on every landing until the reflow lands. It is fixed on this arc's branch.
- `cargo nextest run --workspace` fails on `the_retired_words_stay_out_of_the_tripwire_surface`, which reads `tier="chip"` in `tugdeck/src/components/tripwires/tripwires-card.tsx:806` as one of the four retired nouns. It is a `TugSessionIdentity` prop — the size a session chip is drawn at — rather than this feature's noun, so the guard was reading a foreign component's prop as retired vocabulary. It is outside `just lint` and never affected the chosen probe, but it is the slow half's only red on `main`, and the brief tells a summoned session to run that half; it is fixed on this arc's branch by the one exemption the guard's own list is for.

---

## Week

Every `failed` row with its cause; every `awaiting` row with a yes-or-no on whether the question was worth reading; every `busy` or `queued` row as a mark against the ceiling.

### `ci`

_Nothing yet._

### `edits`

_Nothing yet._

---

## Follow-ons

- **Hand-fire is a follow-on ([P06]).** Firing a tripwire by hand to exercise it, rather than waiting for a landing, is not part of this arc. It is written down here so the week's reading can say whether it was wanted.

---

The reading is read from `tugtool tripwire log <name> --json`.
