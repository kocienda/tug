<!-- brief-skeleton v1 -->

# tugcast for many pages: identity, addressing, ownership and the bus

**Purpose:** tugcast admits any number of WebSocket pages and serves them as if they were one deck: inputs are single-writer per feed, session frames go to everyone, control frames and evals are broadcasts the first page answers, a session is held by the client that spawned it, and a sweep reaps what no client holds. A shell page and one body page per card cannot be built on that. This brief gives tugcast page identity and roles, addressed delivery, per-client ownership, per-session subscription, seating-based holding, and a bus the pages talk over, all testable without the host.

Stage 1 of `briefs/per-card-web-views-program-brief.md`.

---

## Purpose {#purpose}

Every later stage puts a second, third and twentieth page on one tugcast. The protocol has to know who is asking before the host has a second web view to ask with, and this is the stage that needs no Swift and ships invisibly.

---

## Evidence {#evidence}

**[F01] Connections are anonymous beyond a counter.** A client is a `client_id` from an `AtomicU64` (`tugrust/crates/tugcast/src/router.rs:202, 378, 1086`) with a `ClientSink` whose `subscription` is a set of FeedIds or everything (`:814-860`). The handshake carries `{protocol:"tugcast", version}` and nothing about the page (`:468-575`; client half `tugdeck/src/lib/ingest/wire-socket.ts`). **(verified, read)**

**[F02] Input feeds are single-writer per feed, not per client.** `authorize_and_claim_input` (`router.rs:1051-1080`) keys ownership by `(FeedId, tug_session_id?)`; only `CODE_INPUT` carries a session id, so `RENDER_INPUT`, `FILETREE_QUERY`, `FILE_WATCH_QUERY`, `GIT_*_QUERY`, `SHELL_INPUT`, `REFS_INPUT`, `OVERVIEW_INPUT`, `USAGE_QUERY` and `TERMINAL_*` (`boot/supervisor.rs:689-701`) belong to the first client that writes them until it disconnects; a second gets `input_claimed` (`:1512-1519`). The motion hold, display period, resync and find all ride `RENDER_INPUT`. **(verified, read)**

**[F03] Session frames go to every client; a client cannot subscribe to one session.** `SessionScopedFeed`s splice the session id into each frame and broadcast (`feeds/session_scoped.rs:1-15`); replay brackets go to every client too (`control/session.rs:41-46, 785+`). The deck filters by session id in the Worker (`ingest-host.ts:1-50`). With twenty bodies every body would receive every session's stream. **(verified, read)**

**[F04] A session is held by the client that spawned it.** `CODE_INPUT` is admitted only for sessions in `client_sessions[client_id]` (`router.rs:1066-1072`, filled at `spawn.rs:520, 720, 780`); a resume from another client is `session_live_elsewhere` (`spawn.rs:520-531, 715-738`). The orphan sweep arms a 60 s timer on any connect and closes every live bridge no client holds (`agent_supervisor/mod.rs:4534-4600`, `BRIDGE_ORPHAN_SETTLE` at `ledger_entry.rs:732`): a body reloading while another page connects can have its session reaped. **(verified, read)**

**[F05] Control, eval and ask are broadcasts.** The host's `sendControl` tell is broadcast as a CONTROL frame to every client (`control.rs:109-135`, `actions.rs:507-525`); `/api/eval` broadcasts `{action:"eval"}` and the first `eval-response` wins (`server.rs:1476-1580`, `actions.rs:262-280`); `/api/ask` would open a dialog on every page. `pending_evals` and `pending_asks` are process-global (`router.rs:219-240`). No per-client addressed send exists beyond replies on the requesting socket (`router.rs:1366, 1460, 1490-1519`). **(verified, read)**

**[F06] The auth token is single-use.** `GET /auth?token=` consumes the token and sets the `tugcast_session` cookie (`auth.rs:95-110`, `:180-208`); `/ws` needs the cookie and an allowed origin (`router.rs:386-408`). A second page on the same `WKWebsiteDataStore` carries the cookie and loads `/` without `/auth`. The host sets no custom data store (`MainWindow.swift:574-600`), so the default store is shared. **(verified, read; the sharing is WebKit's default and the stage 2 spike confirms it)**

**[F07] Deck and card state are already per key and already broadcast.** Layout at `dev.tugapp.deck.layout/layout`, a bag per card at `dev.tugapp.deck.cardstate/<cardId>`, theme at `dev.tugapp.app/theme` (`settings-api.ts:1-30`), written by the page through `PUT /api/defaults/...` and delivered to every connection as the DEFAULTS snapshot on connect and on change (`feeds/defaults.rs:1-35`, `router.rs:1386-1408`). Nothing here needs to change for a body to read its own bag. **(verified, read)**

**[F08] Deck seatings are already per client and unioned.** `deck_seatings` (`feeds/deck_seatings.rs:34-72`, `control/deck.rs`) record which cards hold which sessions, per client, unioned across clients. This is the seating the sweep should read. **(verified, read)**

---

## Decisions {#decisions}

**[B01] A page identifies itself at the handshake.** The hello frame gains `role: "shell" | "body" | "tool"`, `page_id` (a UUID the page mints), and for a body `card_id`. tugcast keeps a registry of live pages per instance, and `tugtool deck pages` lists them. A connection without a role is a tool (the harness, `tugtool`, curl), as today.

**[B02] Control frames are addressed, and the shell is the default target.** A CONTROL tell carries `to: "shell" | {card: id} | "all"`; the host's `sendControl` and `/api/tell` default to the shell. `eval` and `ask` take a target and are answered by that page alone; `/api/eval` gains `card`, the eval door's verbs gain `--card`, and `ask` is shell-only. A page never receives a frame addressed to another.

**[B03] Input ownership is per client, and replies go to the asker.** The single-writer key becomes `(feed, session?, client_id)`: each page owns its own requests on `RENDER_INPUT`, `SHELL_INPUT`, the file, git, refs, overview and usage queries, and the reply feeds carry the requesting `client_id` so a body receives only its own answers. The motion hold and display period on `RENDER_INPUT` become per page; a body holds its own batches only when the host tells it it is crossing, and the shell's hold no longer parks anyone else's frames.

**[B04] A page subscribes to sessions, not only to feeds.** `subscribe_feeds` gains a session set; a `SessionScopedFeed` frame is delivered to a client only if the client subscribes to that session or to all sessions. A Session body subscribes to its one session; the Overview and Cards bodies subscribe to all; the shell subscribes to the facts its mastheads need, which [B06] carries instead. Replay respects the same filter.

**[B05] A session is held by a card seating, not by a client.** Ownership of `CODE_INPUT` follows the seating: the page whose `card_id` seats the session may write it, a resume by the body that seats the session is not `session_live_elsewhere`, and the orphan sweep reaps a bridge only when no seating holds it and no page carrying that card has reconnected within the settle. A body reload is a reconnect, not an orphan.

**[B06] A bus between pages.** A new feed, `DECK_BUS`, carries addressed JSON messages between the pages of one instance: `{from, to, kind, payload}`, delivered to the named page or role, never broadcast to tools. The first message kinds are the ones the body view needs: `card-facts` (title, masthead line, activity, telemetry summary) from a body to the shell; `card-command` (find, focus-prompt, interrupt, turn navigation, a chord the body did not own) from the shell to a body; `card-advice` (fold guard, close advice, sheet reservation, opening bid) from a body; `deck-facts` (theme, zoom, keyboard access, modifier latch, app active) from the shell to all bodies. The vocabulary lives in `tugproto/src/bus.ts` with a parity test against the Rust types, as `ingest.ts` has.

**[B07] Tested without the host.** The bun suite drives two or more `WireSocket`s against a tugcast with `--no-auth` and asserts: addressed control reaches one page; an eval targeted at a body is answered once by that body; two pages each own `RENDER_INPUT`; a body receives only its session's frames and its own replies; a body reload within the settle keeps its session; the bus delivers to a role and to a card and never to a tool. The ingest Worker's `IngestHost` gains the role and session set in its init and is the only client code that changes in this stage.

**[B08] The law is written with the code.** `tuglaws/ingest-and-render.md` (from the honesty arc) gains the page registry, addressed delivery, per-client ownership, session subscription and the bus; `design-decisions.md` records the reversal of "the deck is one client."

---

## Open Questions {#open-questions}

- **Does the shell keep a `CODE_INPUT` path at all?** The picker spawns a session today from the shell page. The cleaner shape is that the shell asks the host for a body view first and the body spawns; if that ordering is wrong for the arrival beat, the shell spawns and hands the seating to the body with [B05]'s rule. Stage 2 decides from the arrival's reading.
- **How much does per-session filtering save on the wire?** Read with three streams and three bodies; expected to be most of the session traffic.

---

## Non-goals {#non-goals}

- **A second WebSocket per page.** One socket in the ingest Worker, as today.
- **Replacing the control socket between host and tugcast.** It gains a `to` field and nothing else.
- **Changing the RENDERED feed's content.** Its delivery is filtered by [B04]; its frames are unchanged.

---

## Exit {#exit}

**An arc.** The shape: identity and the page registry ([B01]); addressed control, eval and ask ([B02]); per-client ownership and reply routing ([B03]); session subscription ([B04]); seating-based holding and the sweep ([B05]); the bus ([B06]); the suite ([B07]) beside each; the law last ([B08]). It joins with the single-page deck behaving exactly as before, which `at0725`, `at0726` and `at0730` assert, and the multi-page suite green.
