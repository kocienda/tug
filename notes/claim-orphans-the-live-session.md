# A claim that lands in ORPHANED

**Observed 2026-08-28, release-main, project `tugtool`.** `tugutil claim` reported `claimed 7 file(s)`, `tugutil changes` listed all seven as `op: claimed / origin: claim`, and the Changes shade showed every one of them under **ORPHANED — CLAIM TO BRING INTO THIS SESSION**, each labelled `claimed from tugtool/peachy-ridge`. The claim wrote exactly what it said it wrote. The card still refused to call it its own.

The short version: **attribution is keyed to a raw claude session id, and nothing in the changes path knows about the line.** [96b1396b] put the *session ledger* on lines — a card that rotates its id keeps one callsign, one name, one transcript, one ink history. The *changes* ledger and the changeset feed never joined that model. So the moment a card's id rotates, every file its previous segment proved becomes the property of a session the aggregate reads as dead, and the shade offers to sell the user back their own work.

## What is actually in the ledgers

**`changes.db` has no notion of a line.** The proof table is keyed by the raw id and nothing else:

```
CREATE TABLE file_events (
    tug_session_id TEXT NOT NULL,
    tool_use_id    TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    ...
    PRIMARY KEY (tug_session_id, tool_use_id, file_path)
);
```

Every edit this session made all day is recorded under `a1bef0fd-fd91-430e-8eff-5c7119164e9a`, including the seven rows the claim added.

**`sessions.db` knows the line and says the id is dead.** The row for that same id:

| session_id | state | card_id | line_id | last_used |
|---|---|---|---|---|
| `a1bef0fd…` (`tugtool/peachy-ridge`) | **closed** | `b7c7aeaf…` | `3bb27bbc-89a1-4474-aad3-ef3581753c92` | 17:49:55 |

The line is right there on the row. Two other rows on this project (`144da40e…` and `a3b3da90…`) share line `113dfe63…` — a rotation the line model already stitches correctly for identity, rename, and ink.

**No live row for this project at all.** Querying `state='live'` across the whole instance ledger at 18:33 returned exactly one row, and it was an app-test scratch session in `/tmp/tug-scratch-at0496-…`. Every `tugtool` row — including the card the user was typing into — read `closed`. So the aggregate had *no* live owner to hand these files to even in principle, which is why all sixteen files, across four different sessions (`peachy-ridge`, `tripwire-bringup`, `dash+join-xp`), landed in ORPHANED together.

## The mechanism, layer by layer

Three layers each key on the raw id, and the failure is their product.

**1. The changeset feed decides ownership and liveness by id.** In `tugrust/crates/tugcast/src/feeds/changeset.rs`:

- `apply_session_rows` (≈:709) builds `by_id: HashMap<&str, &SessionRow>` and sets each entry's `live` from `row.state == SessionState::Live`. `SessionRow` **carries `line_id`** (`session_ledger.rs:405`) — the feed has the line in hand and never reads it.
- The orphan lift ([D120], ≈:478) then does exactly what it promises: a file owned only by non-live sessions is lifted into `orphaned` with `prior_owner_id` / `prior_owner_name`. Given a dead id, this is correct behavior on a wrong premise.

The premise is wrong because "this id is closed" is not "this work is orphaned" — the same card, the same line, and the same person are still editing those files.

**2. The CLI defaults to an id frozen at spawn.** `tugutil claim|changes|disclaim|commit|draft` all default `--session` to `$TUG_SESSION_ID`, and that variable is baked into the agent's environment when its process starts. When the card rotates its claude id (a relaunch, a resume, a rewind-fork, a `--continue`, a crash respawn — every case [96b1396b] enumerates), nothing updates the environment of the already-running agent. The agent goes on writing proof rows and claims under the *pre-rotation* id for the rest of its life.

So the sequence that produced the screenshot is not exotic; it is the ordinary one:

1. Card seats session `a1bef0fd`; the agent's env gets `TUG_SESSION_ID=a1bef0fd`.
2. The agent edits files all session. `file_events` fills up under `a1bef0fd`.
3. The user rebuilds and relaunches. The id rotates (or the row is quiesced to `closed` and never flipped back).
4. The agent — same process, same conversation — runs `tugutil claim`. It writes seven rows under `a1bef0fd`, and reports success, truthfully.
5. The feed reads `a1bef0fd` as not-live, lifts all seven into `orphaned`, and labels them `claimed from tugtool/peachy-ridge`.

**3. `CLAIM ALL` is a treadmill, not a fix.** The button writes fresh rows under the card's *current* id, which is right until the next rotation, at which point the same files orphan again. Nothing accumulates; the user re-claims after every relaunch. Two sessions on the same line each hold half the proof of one body of work, and neither can see the other's half.

## Why [96b1396b] did not cover this

That commit's claims are about identity, restore, and ink: one callsign and one name across relaunch (at0480), rename read back from a later segment (at0481), `$` shell ink restored onto the segment the card rotated into (at0482). It fixed a real precedence bug in `record_spawn` and gave the ledger `lines`, `sessions.line_id`, `line_of()`, `lineage_chain()`, `resume_lineage_chain()`.

What it did not touch: `changes.db`, `tugchanges-core`, `feeds/changeset.rs`, and the tugutil verbs. The line model stops at the session ledger's edge. Everything downstream still asks "which id?" where it means "which line?" — the same class of defect as the vanished `/commit` receipts, where restore had to become lineage-aware before ink stopped disappearing.

## What a fix has to cover

Sketch, not a plan — the shapes worth weighing:

- **Resolve owners by line in the aggregate.** Group `owners` by `line_id` (falling back to `session_id` for a row with no line), take `live` as *any* segment of the line being live, and let the entry's display name be the line's identity. This needs no schema change: `SessionRow.line_id` is already delivered to the feed. It also fixes the multi-segment split — two segments of one line stop being two owners of one body of work.
- **Make the CLI's default id line-aware.** `--session $TUG_SESSION_ID` should resolve *through* the line to the line's current segment, so a stale env var addresses the right owner instead of a dead one. This is the smaller half, and it is subsumed by the first if the aggregate resolves by line — but a stale id also poisons `just app-test-changed` (its selector reads `TUG_SESSION_ID` and would select from a dead session's bucket), so both are worth having.
- **Consider a `line_id` column on `file_events`.** Not required if the aggregate joins through `sessions`, but it makes the join cheap and survives a sessions-ledger prune. Shared-ledger schema changes need a `CHANGES_SCHEMA_VERSION` bump and a registered migration.
- **Decide what ORPHANED means once lines exist.** It should mean "no segment of this line is live" — a genuinely abandoned line, which is the case the bucket was built for.

## Open questions, not yet proven

- **Why was there no live row for `tugtool` at all?** Two candidates: (a) the relaunch quiesce marks rows `closed` and a restored card only flips back to `live` on some event that had not happened; (b) the card rotated to a new id whose row was never written to this instance's ledger. Worth settling before designing, because (a) is a liveness bug that the line fix would paper over rather than cure. Check: watch `sessions.state` across a relaunch and a first submit.
- **App-tests are writing into the release instance's ledger.** `release-main/sessions.db` was accumulating `tug-scratch-at0…` sessions during the same window (18:36–18:40). If app-test runs share the user's live instance ledger, that is its own contamination problem and it makes every liveness reading above noisier than it should be. Unconfirmed; check which instance the harness binds.

## How to reproduce

1. In a card, have the agent edit a few files (rows land under id A).
2. Relaunch the app (or otherwise rotate the card's session id).
3. From the same still-running agent: `tugutil claim <paths>` → reports success.
4. Open the Changes shade: the files sit under ORPHANED, `claimed from <A's callsign>`.

The tell that separates this from a plain claim failure: `tugutil changes --json` shows the files present, `op: "claimed"`, `origin: "claim"`, while `tugutil host changesets` shows them in `orphaned[]` with `prior_owner_id` equal to the id the CLI just wrote under.
