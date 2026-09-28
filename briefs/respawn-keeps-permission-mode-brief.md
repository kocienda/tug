# A respawn keeps the session's live permission mode

**Purpose:** A session the user has switched to a different permission mode comes back in the mode it was born in the next time tugcast respawns it — a wheel rotation, an arc Resume, a crash-loop respawn — silently undoing a direct action the user took.

---

## Purpose {#purpose}

The user, mid-arc: "Changing to bypass is broken. When I resume to arc, it jumps back to auto.... maddeningly. This is a horrid bug which undoes a direct action I've taken."

The action was the chip's Bypass choice on the arc's Session card. The chip did what it says — the running claude flipped to `bypassPermissions`, and the mode was persisted per card. Then the arc stopped `implement idle`, the user resumed it, and the session that came back was in `auto` again. Three times in one sitting. The arc it was carrying (`session-fold-frames`) is paused on this until it lands and the app is relaunched.

---

## Evidence {#evidence}

**[F01] The supervisor's ledger entry takes its `permission_mode` at birth and never again.** `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs:5433-5440` stamps `entry.permission_mode` only `if inserted || entry.spawn_state == SpawnState::Idle`, and the comment above it states the rule as a design: *"Never while running — the live tugcode was spawned with the original `--permission-mode` and a post-spawn `permission_mode` frame is the path for live changes."* The second stamp, at `agent_supervisor.rs:6022`, is the fresh-insert path of the same handler. There is no third write. **(verified, read out of the code)**

**[F02] The live `permission_mode` frame passes the supervisor without touching the entry.** The CODE_INPUT dispatch at `agent_supervisor.rs:11755` journals `user_message` frames and lets the rest — `tool_approval`, `interrupt`, `permission_mode`, `model_change`, `session_command`, `stop_task`, `request_replay` — "fall through unchanged" to tugcode. So the frame that is, per [F01], "the path for live changes" changes the running claude and nothing else. **(verified)**

**[F03] Every respawn spawns from the birth mode.** `agent_supervisor.rs:12930-12935` reads `entry.permission_mode` off the ledger entry and hands it to `run_session_bridge`; `agent_bridge.rs:343-350` appends it to the child's argv as `--permission-mode`. That path is the one a wheel rotation, an arc Resume and a crash-loop respawn all take. The bridge's own comment names the consequence without noticing it: *"`--permission-mode` is fixed at spawn; a post-spawn `permission_mode` frame can only change it at runtime."* **(verified)**

**[F04] The deck already knows the right answer and is not asked.** `tugdeck/src/lib/session-lifecycle.ts:61` `resolveSpawnPermissionMode` reads the per-card persisted mode from tugbank's `dev.permission-mode` domain, else the deck-wide default, and forwards it on a `spawn_session`. tugbank on `release-main` holds `bypassPermissions` for the user's card `3dd62fc2` — the chip's persistence worked. But that resolver runs only on a deck-initiated `spawn_session`, and a wheel rotation is a supervisor-side respawn on a card that stays mounted, so neither it nor `usePermissionMode`'s mount-time seed frame fires. **(verified: code read, and `tugbank --instance release-main read dev.permission-mode`)**

**[F05] Observed on the live instance.** All four tugcode subprocesses under `release-main` were running with `--permission-mode auto` — each one's birth mode, from the deck-wide default of `auto` — while the card the user had switched read Bypass in the chip until the resume. **(verified: `ps`, and the user's report of three consecutive reverts)**

---

## Decisions {#decisions}

**[B01] The ledger entry's `permission_mode` tracks the session's live mode.** When a `permission_mode` frame passes through the supervisor for a session that is running, the supervisor also stamps `entry.permission_mode` with the frame's mode before forwarding it. This overturns the comment at `agent_supervisor.rs:5433` on purpose, and the argument is one sentence: a respawn must carry the mode the session is *in*, not the one it was born in. The comment's original worry — flipping a live tugcode's mode from under it — is not what a ledger write does; the live tugcode still gets its change from the forwarded frame, and the entry only decides what the *next* spawn says. [F02] makes this a two-line change at one site: the frame is already inspected there, and the entry is already locked on the paths beside it.

**[B02] The deck-side seed is left exactly as it is.** `resolveSpawnPermissionMode` and the mount-time seed in `usePermissionMode` are correct for the case they serve — a fresh spawn on a card that has a remembered or default mode. Making the deck re-resolve on every rotation would fix wheel rotations and leave crash-loop respawns broken, because the deck is not in that loop at all. The supervisor is the one place every respawn passes through, so it is the one place the fix goes.

**[B03] The fix ships with a test that a live change survives a respawn.** A supervisor test: spawn a session with mode A, send a `permission_mode` frame naming mode B, respawn, and assert the child's argv carries `--permission-mode B`. This is the shape [F01]'s comment ruled out, so the test is what keeps the rule from being restored by someone reading the old comment's logic back into the code.

**[B04] And with a check at the wheel's altitude.** Either a wheel-level test that a rotation preserves an off-cycle mode, or an app-test that switches a card to Bypass, drives a rotation, and reads the chip — whichever the existing harness can express without new plumbing. The unit test proves the entry; this proves the thing the user saw.

---

## Non-goals {#non-goals}

- **Changing which modes the `Shift+Tab` cycle offers, or whether Bypass is in it.** `tugdeck/src/lib/permission-mode.ts` keeps `bypassPermissions` out of the cycle and reachable through the sheet, and that is unrelated: the mode the user chose was persisted and applied correctly. Only the respawn forgot it.
- **Persisting anything new in tugbank.** The per-card domain already holds the right value ([F04]). The gap is that the supervisor never consults it and its own copy is stale; giving the supervisor a fresh copy at the moment of change ([B01]) closes the gap without a second store.
- **Touching tugcode's `--permission-mode` handling.** `tugcode/src/permissions.ts` validates and forwards the flag correctly. It is handed the wrong value.
- **Having the wheel's `RotationRequest` carry a permission mode.** Considered and rejected: `wheel/mod.rs` says of itself that `session` names which card rotates and "is never a parameter of what the card rotates into," and a rotation that named a mode would be one more thing for a caller to get wrong. The entry already knows; it just needs to be told when the answer changes.

---

## Exit {#exit}

An arc, short. The order that matters:

1. In the supervisor's CODE_INPUT dispatch, on a `permission_mode` frame for a running session, stamp `entry.permission_mode` and rewrite the comment at the fresh-insert stamp so it states [B01]'s rule rather than the old one ([B01]).
2. The supervisor test of [B03], written first so it is red before the stamp lands.
3. The wheel-altitude check of [B04].
4. Relaunch `release-main` on the joined build; the `session-fold-frames` arc resumes from its Step 4 once a Bypass session survives a resume.
