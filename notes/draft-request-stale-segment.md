# The Changes shade requests its draft under a retired segment

2026-09-02. A session that had compacted (id rotation: new segment, same line)
could not write a commit message on the Changes shade: Auto-Message did
nothing, and Commit refused with "Write a commit message" over a healthy
18-file changeset. This brief is the diagnosis, verified in the live ledgers
and logs; the fix has not been made. A fresh session should be able to
implement from this note alone.

## The incident, in one trace

The card's line is `8530e2a8-ba99-4151-99bf-84fc9fe5b7ca`, three segments in
`instances/release-main/sessions.db`:

| segment | state | note |
|---|---|---|
| `f1a5bad4-…` | closed, demoted | oldest |
| `2767fe75-f07e-42b3-a203-341ca031f358` | closed, demoted | **frozen `TUG_SESSION_ID`; the card's binding id** |
| `5c9797a1-b7fb-4eb6-b245-b91733ccfc9e` | live | **the line's seat** |

`tugcast.log.2026-09-02` at 15:09:40:

```
deck: commit land refused: Write a commit message
{"kind":"gate","turnInProgress":false,"commitPhase":"idle","fileCount":18,"messageLen":0}
```

Every gate green except the message. `fileCount: 18` matched `git status`
exactly — the changeset display was correct — and there is **not one scribe
or draft-engine line in the whole day's log**: Auto-Message was pressed and
never ran.

## Root cause: one identity, two readings

The shade's **read** path is line-aware. `deriveChangesRouteSnapshot`
(`tugdeck/src/lib/changes-route-controller.ts`) matches the entry by exact
`owner_id` first, then falls back to `line_id` via
`sessionLineStore.lineOf(binding.tugSessionId)`. Server-side the changeset
feed keys each session entry by the line's *seat*
(`owner_key` / `line_ownership` in `tugrust/crates/tugcast/src/feeds/changeset.rs`
and `session_ledger.rs`). So the 18 files resolved through the line and
painted normally — which is what made the failure look impossible.

The shade's **request** paths are not line-aware. They send the card's raw
binding id:

1. **Auto-Message.** `ChangesRouteController.requestDraft` sends
   `this.tugSessionId` (`2767fe75-…`). In
   `tugrust/crates/tugcast/src/feeds/draft_engine.rs`,
   `spawn_on_demand_draft` matches `eligible_entries` by exact string
   compare on `owner_id` — but those entries are keyed by the line seat
   (`5c9797a1-…`). No match, and the miss is `return false` into silence: no
   log, no state change, no notice. The user sees the button do nothing.
2. **Draft persistence.** The composer's debounced `persistMessage` writes a
   `changeset_drafts` row under the binding id, while `tugtool draft show`
   (and anything resolving "the calling session") resolves to the live seat.
   Observed directly: a deck-written row under `2767fe75-…` coexisting with
   "no draft on file for session:5c9797a1-…". Same card, two addresses — a
   typed draft persisted where nothing reads it.
3. **Commit correlation.** `ChangesRouteController.entryKey` is
   `session:${binding.tugSessionId}` — the verb-store commit/draft
   correlation key. Audit every consumer for the same split (the commit
   round-trip appeared to work here, but the key is built from the same raw
   id).

Note the two-layer shape: `eligible_entries` in `draft_engine.rs` has exactly
**one** caller (`spawn_on_demand_draft`). There is no background draft
maintainer — the commit message is only ever filled by typing or by
Auto-Message, so when Auto-Message silently no-ops, the field is empty
forever and Commit's refusal reads as gaslighting.

## The fix

Doctrine already exists — the stale-segment class was closed structurally for
the server (`POST /api/session {op:"resolve"}` chokepoint,
`no_raw_session_id_reads` guard) and for the shade's *display*. The requests
were missed. Three changes:

1. **Route requests through the resolved entry, not the binding.** The
   controller already holds the matched entry (`snapshot.entry`, found
   line-first). `requestDraft`, the draft persist/read, and the
   verb-correlation `entryKey` should carry that entry's `owner_id` — the id
   the server keyed the entry by — falling back to the binding id only when
   no entry resolved. One reading of identity for display and request alike.
   Mind the lifecycle: the seat can change mid-session (another rotation), so
   derive at call time, never cache at construction the way `entryKey`
   currently is.
2. **Make the miss loud.** `spawn_on_demand_draft` returning `false` for an
   unmatched owner is a silent early return ([L31]). It should emit the same
   `draft_state`-shaped answer the engine already sends (an `error`/refused
   state naming the unmatched owner), and log at warn, so the shade can say
   "couldn't reach the scribe" instead of looking idle. Version skew: an old
   deck ignoring the new state must degrade to today's behavior, never
   refuse.
3. **Structural guard.** Same mold as `no_raw_session_id_reads` /
   `no_ad_hoc_binding_writes`: a deck-side test (or lint) that
   `changes-route-controller.ts` builds no server-bound owner identity from
   `binding.tugSessionId` directly. Enumerate the allowed derivations; fail
   the build on a new raw use.

## Two things the task list must size

Both are visible in the three steps above but neither is scoped by them, and
a door that folds them in silently will under-size the work.

**The `entryKey` audit is its own beat.** Step 1 rewrites where `entryKey` is
derived; it does not tell you what depends on the old value. Every consumer of
the verb-store correlation key has to be read for the same split — the commit
round-trip appeared to work through the incident, which means either a
consumer that resolves line-first already or a second latent address nobody
has hit yet, and those two want different fixes. Walk the consumers before
changing the derivation, not after, and write the finding down: it is the
difference between a fix and a coincidence.

**The structural guard will widen.** A lint that enumerates the allowed
derivations of a server-bound owner identity will almost certainly find raw
`binding.tugSessionId` uses beyond `changes-route-controller.ts`. That is the
guard working — a class closed structurally is closed everywhere or it is not
closed ([L31]'s sibling argument) — but it is not work this brief scoped, and
the cost is unknown until the guard is written. Write the guard first, read
what it catches, then decide with the user whether the outside-the-shade hits
land in this arc or as a follow-on. Do not quietly fix them all, and do not
quietly allowlist them all.

## Acceptance

An app-test in the `at0504` family: seed a line whose binding id is a
retired segment (spawn, close/demote, spawn successor on the same line —
the fixture machinery from `at0504-arc-rotation-carries-the-binding` does
this), put attributed changes on the line, then from the card:

- Auto-Message **generates** (draft engine spawns; `draft_state` reaches the
  shade),
- the typed message **persists** to the row `tugtool draft show` reads (one
  row, keyed by the seat),
- Commit **lands** with the message,
- and an unmatched owner (no entry at all) surfaces a visible refusal, not
  silence.

Unit-side: a `deriveChangesRouteSnapshot`-adjacent test that the request
identity equals the displayed entry's `owner_id` when they differ from the
binding.

## Cleanup already done

Two probe rows I wrote during diagnosis were deleted
(`tugtool draft clear --owner session:<id>` for both segments);
`changeset_drafts` carries no rows for this project. Nothing else was
modified — the fix is entirely unimplemented.
