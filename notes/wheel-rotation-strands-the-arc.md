# The Wheel's rotation strands the arc that asked for it

**Observed 2026-08-31, release-main, project `tug`, dash `lens-breakout`, line `29e4df00` (`tug/fresh-lever`).** An implement stage crossed the compaction line, the Wheel rotated the card into a fresh session, and the session it seated went on running `tugtool dash` verbs under the id of a session that had been closed and demoted two rotations earlier. The dash's step 3 committed and closed correctly. The card showed no dash, the Z2 placard showed no steps, and nothing prompted step 4. A repair attempt — `tugtool dash bind` — reported success and wrote onto the corpse.

The short version: **`$TUG_SESSION_ID` is frozen at spawn, and the arc's own verbs resolve the calling session from it with no line expansion.** This is the same root cause as [claim-orphans-the-live-session.md](claim-orphans-the-live-session.md), one layer up and one degree worse. There, a rotation was an occasional hazard you hit by relaunching. Here the Wheel *rotates on purpose*, on a threshold any long implement stage will cross, so the hazard is not occasional — it is the design's normal path.

## What the two sources say

**The environment, inside the seated session:**

```
TUG_SESSION_ID=a8bc743f-96da-4f73-b884-fc2f77669ba0
TUG_DASH_ARC=lens-breakout
TUG_INSTANCE_ID=release-main
```

**The ledger, for the same line, same card:**

| session_id | dash_name | stage | state | demoted | last used |
|---|---|---|---|---|---|
| `f49f9e49…` | — | — | closed | 1 | 12:40 |
| `58fcb543…` | — | devise | closed | 1 | 12:49 |
| `79643900…` | — | review | closed | 1 | 12:56 |
| **`a8bc743f…`** | lens-breakout | review | **closed** | **1** | **14:32** |
| `28b4ed67…` | — | implement | closed | 1 | 15:32 |
| **`37c0ee00…`** | lens-breakout | implement | **live** | 0 | **16:01** |

`tugtool dash arc lens-breakout` carries the reason in its own notes: `compacted at 341531 > 300000`, then a second implement stage seated at 22:32:27Z. The env names the **review** segment. The live segment is two rotations further on.

## The mechanism

**One resolver, read raw.** `tugrust/crates/tugtool/src/dash.rs:1335`:

```rust
pub(crate) fn calling_session_id(subject: &str) -> Result<String, String> {
    std::env::var("TUG_SESSION_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ...)
}
```

No line lookup. Its callers are `dash run` (which *opens the arc*), `dash bind`, `dash stop`, `dash unbind` — the four verbs whose whole subject is "which session is working this dash". `dash run`'s own comment states the stakes: *"the arc runs on a card: every stage is a rotation of the calling session's own tugcode ([B05])"*. An arc opened or re-anchored from a rotated session anchors to a segment that no longer exists.

**The write lands on the exact segment.** `tugrust/crates/tugcast/src/session_ledger.rs:5034`:

```sql
UPDATE sessions SET dash_id = ?2, dash_name = ?3 WHERE session_id = ?1
```

`run_bind` posts `tug_session_id: <frozen id>` and the server obeys it. So a bind from a rotated session moves a column on a closed, demoted row and returns `affected > 0` — a truthful success about the wrong session.

**The neighbours were each hardened; this path was not.** Two adjacent subsystems already know about this exact failure and solve it, separately:

- `tugrust/crates/tugchanges-core/src/ledger.rs:411` — *"`$TUG_SESSION_ID` is frozen at spawn, so after an id rotation it names an older segment — the expansion is what keeps `tugtool changes` answering for the whole conversation ([P01])"* — solved with `line_segments()`.
- `tugrust/crates/tugdash-core/src/ops.rs:2659`, `session_citation_for` — joins `sessions` to `lines` so *"a citation written from inside an arc stage resolves to the conversation rather than to the segment that happened to be seated."*

Three call sites, two of them defended, one not. That distribution is the finding: the hazard is being answered per-caller, so the next caller written will have it again.

## The part that is genuinely alarming

A rotated session cannot repair itself, and cannot tell that it failed.

`tugtool dash bind lens-breakout` — the documented gesture for exactly this situation — printed `"tug_session_id": "a8bc743f-…"` and exited ok. It bound a dead segment. It was a no-op only by luck: that row already carried the same `dash_id` and `dash_name` from before it was demoted. Had the live segment been the unbound one, the "fix" would have written the binding onto a corpse, reported success, and left the card exactly as broken while looking repaired.

So the failure mode is silent in both directions — the verb that breaks it and the verb that would fix it both report success.

## What did NOT break, which matters for the diagnosis

The ledger's live row is **correct**:

```
37c0ee00… | tugdash/lens-breakout#1788211945834-6a9a27 | lens-breakout | implement | live | 0
```

Right `dash_id`, right `dash_name`, live, not demoted. And `tugtool dash arc` reports `stopped: null`, `done: false`. So the blank card and the empty Z2 placard are **not** explained by a wrong binding in the data — something downstream is not reading what the ledger holds, or is reading it keyed on the id the arc was opened under. That is a second defect and it is not yet located. Do not treat the rotation fix as covering it.

The dash's work was never at risk: `d5bcaa64d` is on `tugdash/lens-breakout` and the task ledger's rows moved correctly, because commits and document writes do not go through the session id.

## Why the Wheel makes this structural rather than incidental

The Wheel's promise is that a stage rotation is invisible to the work: the arc compacts in place above `implement_compact_tokens`, and rotates when a compaction cannot bring the context back under the line. Both acts are deliberate, both are routine, and the second one silently invalidates every id the seated agent holds.

If transparency has to be delivered by each subsystem remembering to expand a segment to its line, it is not transparency — it is a convention, and `calling_session_id` is the caller that did not follow it. A facility that rotates sessions by design cannot leave a stale id reachable.

## What a fix has to cover

Two chokepoints, not mutually exclusive:

- **Stop the id being stale.** The rotation re-exports `TUG_SESSION_ID` into the seated tugcode's environment, so no caller ever observes an old segment. This is the only option that also fixes `just app-test-changed` (its selector reads the raw variable), the tugtool verbs that default `--session` from it, and any future caller nobody has written yet. Cost: the env of a running child is not writable from outside, so this wants either a re-spawn on rotation or a live channel the CLI consults instead of `std::env::var`.
- **Stop the id being usable raw.** `calling_session_id` resolves through the line to the line's current live segment, and `set_dash_binding` refuses a segment that is `closed`/`demoted` rather than obeying it. Cheaper and local, but it is a discipline unless a guard test enforces it — the same shape as `no_ad_hoc_ledger_opens`, which is the precedent worth copying: make `WHERE session_id = ?` structurally unwritable outside one resolver.

Whichever is chosen, **a bind that lands on a demoted segment should be an error, not a success.** That single refusal would have turned this into a two-minute diagnosis.

## Open questions

- **Why is the card blank when the live row is right?** Unlocated. Candidates: the surface reads the binding keyed on the id the arc recorded at `dash run` time rather than the live segment; or the `sessions_changed` notification fired against the wrong id and the card never re-read. Settle this before designing, because if it is the first, the arc's own stage record carries a stale id too and the rotation fix has to reach that as well.
- **Do `dash create` and `dash step start` record their claims through this path?** The skill states both record the claim themselves, but neither appears among `calling_session_id`'s callers, so their write path is unverified. If they resolve the session some other way, that is a third spelling of the same question.
- **How does the arc's stage list address its stages?** `tugtool dash arc` lists each stage with a `session_id`. If a stage is addressed by segment rather than by line, the arc's own resume path has the same hazard as the binding.

## How to reproduce

1. Open an arc on a dash with a multi-step ledger: `tugtool dash run <name>`.
2. Let an implement stage cross `implement_compact_tokens` (default 300000) far enough that the compaction cannot bring it back under — the Wheel rotates and seats a fresh session.
3. In the seated session: `printenv TUG_SESSION_ID`, and compare against `SELECT session_id, state, demoted FROM sessions WHERE line_id = <the line> AND state = 'live'`.

The tell: the env names a row whose `state` is `closed` and whose `demoted` is `1`. From there, `tugtool dash bind <name>` will report success and change nothing a surface can see.
