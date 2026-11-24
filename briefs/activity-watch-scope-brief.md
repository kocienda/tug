# Activity Watch Scope

**Purpose:** The activity tapes on the Workspaces card are flat for every session, however hard the session is working. A page that lists sessions must hear their activity.

---

## Purpose {#purpose}

The report, 2026-11-24, with two sessions mid-turn: "The sparkline in the Workspaces card seems to have lost the connection to the session." The row for `liven/marine-bark` read "Executing 7/7" beside a flat line.

This is the first of four briefs from one sketch. The other three widen what the tape measures (`activity-session-accounting-brief.md`, `activity-machine-channel-brief.md`) and make its past the same on every page (`activity-session-tape-brief.md`). This one repairs the connection and adds the test that would have caught the break.

---

## Evidence {#evidence}

**[F01] Every tape on the Workspaces page is at rest while the sessions' own pages tick.** Read from the live release deck through the eval door on 2026-11-24: the Workspaces card's page held eight `.session-activity-spark` elements and all eight carried `data-tape-rest`, including `liven/marine-bark` and the session doing the reading. The Session card pages for those two sessions showed their tapes without `data-tape-rest` at the same moment. **(verified)**

**[F02] A body page's connection is scoped to no sessions until its own card binds one.** `tugdeck/src/connection.ts:391` sets `sessionScope = []` for a page whose role is `body`. The only code that widens it is `rescope` in `tugdeck/src/body/body-main.ts` (about line 897), which returns early when the card has no binding, and `replayBodyIntent` in `tugdeck/src/body/body-intent.ts`, which narrows to the card's one session. **(verified)**

**[F03] tugcast refuses a session-scoped frame outside a connection's scope, and ACTIVITY is session-scoped.** `admits_session` in `tugrust/crates/tugcast/src/router.rs` passes a frame only when the connection takes every session, the feed is not session-scoped, or the frame's `tug_session_id` is in the connection's set. ACTIVITY is registered with `register_session_feed`. `tugtool deck pages` lists the Workspaces page with `sessions: none`. **(verified)**

**[F04] Three cards list other cards' sessions.** `LISTS_SESSIONS` in `tugdeck/src/body/body-main.ts:208` names the Cards card (Workspaces), the Overview card and the Arcs card. Each attaches its own `SessionActivityStore` to its own connection (`body-main.ts:1102`), and each store is fed only by ACTIVITY frames on that connection (`tugdeck/src/lib/session-activity-store.ts:242`). **(verified)**

**[F05] The break dates from the move to per-card pages.** `git log -S'fn admits_session'` and `-S'this.sessionScope = []'` both land on 2026-10-13 (`52cbbbb94`, `52714669b`). Before that, one page held every store and heard every session. **(verified)**

**[F06] No test covers a listing page's tape.** The instrument's state is readable in test mode through `peekSparklineHost` (`tugdeck/src/components/tugways/tug-sparkline.tsx`) and `tugdeck/src/test-surface.ts`, but I found no app-test that asserts a Workspaces row's tape moves. This is inference from a search of the sparkline's references, not a census of the corpus; `just app-test-select` over the files this arc touches would confirm it.

---

## Decisions {#decisions}

**[B01] A connection carries a second scope: the sessions it watches.** The existing scope says which sessions a page is bound to and so receives everything for. The watch scope says which sessions a page lists and so receives glance-level frames for. They are separate because widening the bound scope would send a listing page every session's CODE_OUTPUT.

**[B02] The router admits a frame on a watch feed when either scope takes it, and ACTIVITY is the only watch feed.** The set of watch feeds is registered beside the session feeds, so a later glance feed joins by registration rather than by a new rule.

**[B03] A dormant body still hears nothing.** `admits_while_dormant` refuses every session-scoped frame for a body the host has declared dormant, and the watch scope does not open a way round it. A page WebKit has suspended cannot drain frames.

**[B04] The three listing pages declare `watch: all` at connect.** Workspaces, Overview and Arcs can show any session on the machine's instance, so naming ids would mean re-scoping on every row change for no saving: an ACTIVITY frame is a few dozen bytes at 4 Hz per working session.

**[B05] `tugtool deck pages` shows the watch scope.** The `sessions` column is how this fault was read in one command. The watch scope gets the same visibility.

**[B06] One app-test asserts the connection.** With a session streaming, a Workspaces row's tape for that session leaves rest. It reads the instrument's own state through the test surface, and it carries `@covers` for the router's scope code and the body page's connect path.

---

## Calls you have not seen {#unseen-calls}

- The field is named `watch` on the wire and in `tugtool deck pages`. Rename it in the brief before an arc opens if another word reads better.
- The watch scope rides the existing `sessions` message and the hello, as a second field, rather than a message of its own. Say so if it should be separate.

---

## Non-goals {#non-goals}

- **Widening a listing page's bound scope to `all`.** It would deliver every session's transcript frames to a page that draws none of them.
- **Making ACTIVITY an unscoped feed.** It would reach dormant bodies, which [B03] rules out, and every Session card page would receive every other session's samples.
- **Relaying activity from the shell over the deck bus.** The shell already hears every session, but a relay puts a second hop and a second clock in front of an instrument whose point is that it is live.
- **Backfilling the tape's past on a page that starts listening.** That is `activity-session-tape-brief.md`.

---

## Exit {#exit}

An arc. The first steps, in the order they must land:

1. The watch scope in tugcast: the connection's record, the hello and `sessions` message parse, `admits_session`, the watch-feed registration, and unit tests beside the existing `admits_*` tests.
2. `tugtool deck pages` prints it.
3. The deck declares it: `TugConnection` carries the watch scope, and a `LISTS_SESSIONS` page sets `all` before its first subscription goes out.
4. The app-test of [B06], run once as the verdict, after `just app-test-build` since the change crosses Rust.
