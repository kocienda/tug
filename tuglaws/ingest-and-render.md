# Ingest and render

*How session data reaches the deck: who reduces the wire, how its results cross to the page, when they are allowed to land, who renders a row's markdown, how many rows the page keeps mounted, and how many pages share the wire. The law lines are [L34], [L35] and [L36] in [tuglaws.md](tuglaws.md); the reversals that shaped them are [D208], [D209], [D210] and [D213] in [design-decisions.md](design-decisions.md).*

The main thread is the one thread that draws, so this page is about keeping work off it. Four rules carry that. The wire is reduced somewhere else. What crosses to the page arrives at most once per display period, and never while a motion is held. A streamed row's markdown is rendered by tugcast, not by the page. And the page mounts only the rows near the viewport. Each rule below names the code that is its single source and the tests that hold it.

---

## The authority and the mirror {#authority}

**The ingest Worker is the authority for every session's state, and the page's store is its mirror.** [L34]

The Worker (`tugdeck/src/lib/workers/ingest-worker.ts`) runs one `IngestHost` (`tugdeck/src/lib/ingest/ingest-host.ts`). The host holds tugcast's WebSocket (`WireSocket`) and peels its frames once (`FramePeeler`). It keeps the feed subscription the page has accumulated and re-sends it on every handshake. Each open session is one `SessionEngine` running the reducer and its effects. A CODE_OUTPUT, SESSION_STATE or CONTROL frame is decoded once and routed to every open engine whose session id it carries, by exact match, so an untagged frame reaches none. The CODE_OUTPUT types that only a narrow per-session store folds (`ROUTED_CODE_OUTPUT_TYPES`: skills, hooks and side-question answers) skip the engine and go to the session's mirror as a `routed-frame` patch. Every other feed's frame goes to the page as a raw `frame` patch with its buffer transferred.

`CodeSessionStore` (`tugdeck/src/lib/code-session-store.ts`) reduces nothing. It applies the engine's patches: structure patches are merged field by field, so everything a patch does not name keeps its identity, and stream writes go into the `PropertyStore` that `TugMarkdownView` reads. It publishes to React once per batch. A local action is assembled on the page, where the page's stores are, and posted to the engine as a finished event with a sequence number. The engine acknowledges it after the patches it produced, and `whenSettled()` is how a reader waits on its own action. An engine that throws still acknowledges, so no reader waits on an answer that cannot come.

The same `IngestHost` class runs on the calling thread in unit tests (`InProcessIngestChannel`, which structured-clones every message), so the code under test is the code that ships. Only the flush policy differs, and the next section says how.

## The patch protocol {#protocol}

The protocol between whatever reduces the wire and the page that draws it is `tugproto/src/ingest.ts`. Page-to-sender messages are `IngestControl`s; sender-to-page messages are `IngestPatch`es, posted as one `IngestBatch` whose entries apply in order in one task. **The protocol never names its sender**, so a later sender can emit the same patches unchanged. Payloads that are deck types are type parameters, because tugproto cannot import the deck. The deck narrows them in one place: `tugdeck/src/lib/ingest/session-patch.ts`.

The vocabularies are two lists, `INGEST_PATCH_KINDS` and `INGEST_CONTROL_KINDS`. A compile-time check in `ingest.ts` rejects a list that disagrees with its union. `tugproto/src/__tests__/ingest-kinds.test.ts` reads the file as text for the same check, so `bun test` fails on drift even where nothing type-checks the file. Keep one interface per message, with its `kind` literal on its own line, and one literal per line in each list.

The render feed has its own pair of types, `tugproto/src/rendered.ts` for the page and `render_bridge.rs` for tugcast. Both halves are held to one fixture, `tugproto/src/__tests__/fixtures/rendered-parity.json`: `rendered-parity.test.ts` on the TypeScript side and the bridge's own tests on the Rust side. A field renamed or retyped on either side fails one half.

## The cadence and the hold {#cadence}

**One batch per display period.** In the Worker the flush policy is a `Pacer` (`tugdeck/src/lib/ingest/pacer.ts`), a finisher in the sense of the animation doctrine's [D7](animation-doctrine.md#d7-event-clock). The first pending patch arms it, it fires at the next multiple of the period since the last flush, and nothing is armed while nothing is pending. The page tells the Worker the display period (`display-period`), learned from the settle engine's frame sampler. The kinds somebody is waiting on post at once and carry whatever is pending with them: `wire-state`, `disconnect-state`, `ack` and `find-result`. The Worker's host also waits for the page's `batch-applied` before it posts again (`awaitPageAck`). So a page slower than the period sees fewer, fuller batches rather than a queue that grows. On the calling thread the policy is `PerMessageFlush`, which posts at the end of every handled message so unit tests stay synchronous.

**None while a motion is held, and the hold is capped on every side.** The settle engine closes its motion gate (`gestureScope.holdMotion`) with a cap of `holdCapMs` (`settle-plan.ts`): twice the settle window scaled by the timing token, and never under 1,000 ms. The page's connection observes the gate and posts each hold and its release to the host ([P08] of `briefs/ingest-worker-brief.md`). Three places then keep the motion sealed:

| Where | What it holds | Its cap |
|---|---|---|
| The Worker's host | Every patch except `wire-state` and `disconnect-state`, which are page state rather than pixels and post through the hold in a batch of their own. The engines keep reducing while held. | The latest cap any hold asked for, floored at `MIN_HOLD_CAP_MS` (1,000 ms). The release posts everything as one batch, and so does the host's own deadline if the release never comes. |
| tugcast's render bridge | Every render for the page that asked, merged into one bundle per holder (`RENDER_INPUT` `motion`, under a holder id the host mints). Holds are per page: one page's hold parks no other page's renders ([many pages](#many-pages)). | The same floor, `MIN_HOLD_CAP_MS` in `render_bridge.rs`. The release, or the last holder's expiry, publishes the bundle. |
| The page's connection | A batch that was already in flight when the gate closed, which the host posted before it heard of the hold. It is parked, unless it holds wire state alone. | The gate's own cap, which releases the parked batches with the gate. |

A gate that never opens therefore cannot strand the deck's data ([L23], [L32], [L33]). The page-side gate in `gesture-scope.ts` still holds the page's own tells and observer deliveries. What moved to the Worker is the wire.

## The sealed wire {#sealed-wire}

**No ingest batch is applied inside a motion.** This is the invariant the hold exists for, and it is asserted rather than assumed. Every applied batch is a deck-trace `ingest-batch` row. `at0725-streaming-settle-reading` drives each gesture with three sessions streaming and asserts that the motion window's `ingest_batches` is empty, on the quiet drives and the instrumented ones alike. `TugConnection.deliverHeldWire` lets a test push the wire through a closed gate on purpose. It exists so that a test of what a surface does with data that changed mid-motion can fail. It is test-surface only.

Streaming text needs no React commit to reach the page. A `stream` patch writes the session's `PropertyStore` path, and `TugMarkdownView` draws from that path by observing the store directly ([L22]). The streaming block's own frame flush (`tugdeck/src/lib/markdown/streaming-flush.ts`) checks `isMotionHeld()`. If the gate is closed it re-arms for the release instead of reconciling, so a streaming row's content pops once at the release. That is a card rendered in the shell's page: a card in its own page streams through the shell's settles, its gate never held, and the pop is no longer one the animation doctrine accepts ([the set-up solves the end state](animation-doctrine.md#fully-solved)). A structural publish (new turn, phase, tool call or result, error, rewind, restore) is what React hears, once per batch ([D209]).

## Many pages {#many-pages}

**tugcast serves each connection as the page it says it is, and addresses every frame that is meant for some pages and not others.** [D213]

**The hello and the registry.** A connection names itself in its handshake hello: a `role` (`shell`, `body` or `tool`), a `page_id` minted once per page load, and for a body the `card_id` it renders. A hello that names no role is a tool, which is how the harness's Workers, test clients and curl are served, exactly as every connection was before pages had names. A malformed identity closes the socket with `CLOSE_BAD_HANDSHAKE` before the wire opens. The parse is `parse_page_hello` (`tugrust/crates/tugcast-core/src/pages.rs`), and the handshake reply echoes the identity and the `client_id`. The deck's connection (`tugdeck/src/connection.ts`) says it is one shell page, with a `pageId` minted once per connection object, so a reconnect is the same page. Every live connection is one record in one `PageRegistry` (`tugrust/crates/tugcast/src/pages.rs`), shared by the router, the supervisor, the file-watch service and the render bridge. `GET /api/pages` and `tugtool deck pages` list it.

**Addressed delivery, resolved when a frame is published.** A frame meant for some pages rides an addressed lane as an `AddressedFrame`: the frame's bytes unchanged, and a `Delivery` (`All`, `Client`, `Clients` or `AllExcept`) beside them. Each connection's forwarder (`forward_addressed` in `tugrust/crates/tugcast/src/router.rs`) passes only what admits its own id. A target (`shell`, `body`, a card, a page, or `all`) becomes a delivery once, at publish time, in `PageRegistry::resolve`, and a target no live page answers resolves to nothing, which the publisher reports. **Where two live pages answer one target**, two shells or a card's old and new page during a reload, **the newest connection is addressed**: the one with the highest `client_id`, since ids only count up. A tool is reached only by `All` or `AllExcept`, never by name. Every page-addressed CONTROL frame (tells, evals, asks and `ask-rescind`) and every bus delivery rides one page lane, so the frames on it reach each connection in the order they were published. tugcast's own internal CONTROL broadcasts stay on the CONTROL stream, to every connection.

**Who answers a tell, an eval and an ask.** A tell from the host (UDS or `POST /api/tell`) goes to the shell unless its `to` names another target (`tugtool host tell --card`). An eval goes to the shell unless the request names a card (`--card` on the `tugtool deck motion` verbs that run one), and an eval no page answers fails at once with a 503 instead of waiting out its timeout. An ask goes to the shell alone. A tell one connection sends on its own CONTROL goes to every connection unless it names a target. The defaults are `ActionContext::default_to` (`tugrust/crates/tugcast/src/actions.rs`) and the handlers in `tugrust/crates/tugcast/src/server.rs`.

**Inputs are owned per page, and replies go to the asker.** `PER_PAGE_INPUTS` (`router.rs`) lists the inputs any number of pages may write at once. Only the terminal pair and `CODE_INPUT` still have one writer, because there is one tmux pane and one writer per session.

| Input | Owner | Reply delivery |
|---|---|---|
| `CODE_INPUT` | one writer per session; a page whose card seats it takes over | the session subscription |
| `TERMINAL_INPUT`, `TERMINAL_RESIZE` | one writer per feed | every connection |
| `RENDER_INPUT` | per page | the page's own pacer; a find answer and the hello batch to the asker |
| `SHELL_INPUT`, `REFS_INPUT` | per page | the session subscription |
| `FILETREE_QUERY`, `GIT_DIFF_QUERY`, `GIT_LOG_QUERY`, `GIT_COMMIT_FILES_QUERY`, `USAGE_QUERY` | per page | the asker |
| `FILE_WATCH_QUERY` | per page; `reset` and departure clear only that page's watches | every page watching the path |
| `OVERVIEW_INPUT` | per page | every connection, a shared channel by design |

An input that answers a page reaches its service as a `ClientFrame` carrying the sender's `client_id`, set by the router so a page cannot answer as another. A page's departure is published on `PageRegistry::departures()`, and each service that keeps per-page state drops that page's. A service whose departures receiver lags reconciles instead of guessing: it keeps only the pages the registry's snapshot still lists, so a missed departure cannot leak a page's watches or pacer.

**Session-scoped frames go to the pages that subscribe to the session.** `subscribe_feeds` may carry `sessions`, an array of ids or `"all"`; absent means all. A frame on a session-scoped feed (`CODE_OUTPUT`, `SHELL_OUTPUT`, `REFS_OUTPUT`, `SESSION_STATE`, `SESSION_SIDEBAND`, `ACTIVITY`) reaches a page only for a session it subscribes to. `session_of` (`router.rs`) reads the id from the spliced leading `tug_session_id` without a parse when it can, and a frame that names no session is admitted. CONTROL is never session-filtered.

**The render bridge paces and holds per page.** Every shell and body page has its own `PagePacer` (`tugrust/crates/tugcast/src/feeds/render_bridge.rs`): its display period, its motion holders and its buffer. The stage renders once per tick, at the shortest period any page asked for. Each tick's batch is cut to the page's sessions and sent to that page alone, or merged into its buffer while the page is held or not yet due, so one page's hold parks only its own renders. A tool takes every batch whole through `AllExcept` the paced pages.

**A session is held by its card's seating, not by a socket.** A page may write `CODE_INPUT` for a session it spawned, or for one its card seats: the session's ledger entry names that card, or a deck's `deck_seatings` report pairs the card with it (`card_seats_session` in `tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs`, over `feeds/deck_seatings.rs`). A body page whose card seats the session takes the claim over from whichever page holds it, so a reloaded body is not refused by its own previous socket. Any other second writer is still `input_claimed`, and a page whose card does not seat the session is `session_not_owned` (`authorize_and_claim_input` in `router.rs`). The orphan sweep (`reap_orphan_bridges`) spares a session the seating board seats, and one whose card has a live page or a page that departed less than `BRIDGE_ORPHAN_SETTLE` (60 s) ago, because a body reload is a reconnect and not an orphan.

**Pages talk to each other over the deck bus.** `DECK_BUS` (0xD0) carries one JSON envelope per frame in both directions. A shell or body page sends a target and a kind, and tugcast delivers it on the page lane with `from` stamped from the sender's registered identity, so a `from` the page wrote is ignored (`route_bus` in `router.rs`). A tool's bus frame is `bus_refused`, one with no target or a kind the envelope does not name is `bus_malformed`, and a target no live page answers is `bus_undeliverable`, each a CONTROL error to the sender. Bus frames are exempt from the feed filter, as CONTROL is, because addressing already scopes them. The envelope's kinds are closed; every field beside `to` and `kind` passes through verbatim:

| `kind` | What it is | Fields beside `payload` |
|---|---|---|
| `hello` | a page announcing itself, or answering another's announcement | — |
| `state` | a shared store's snapshot | `key`, `card`, `version`, `ack` |
| `action` | a routed action, or a proposal to a store's owner | `key`, `card`, `proposal` |
| `request` | a request that wants a reply, or its withdrawal | `key`, `requestId`, `withdraw` |
| `reply` | the reply to a request | `key`, `requestId` |

The router does not enforce a direction and reads no payload. Each store, action and request is declared once, in TypeScript, beside the codec that validates its payload (`tugdeck/src/bus/declarations/`), and the receiving page refuses a malformed one where it can be seen ([D215], [shell-and-bodies.md](shell-and-bodies.md)). The Rust half of the envelope is `tugrust/crates/tugcast-core/src/bus.rs` and the TypeScript half is `tugproto/src/bus.ts`, held to one fixture, `tugproto/src/__tests__/fixtures/bus-parity.json`.

## The render feed {#render-feed}

**A streamed assistant row draws tugcast's render; the page parses only what tugcast does not serve.** [L35]

tugcast's render stage (`tugrust/crates/tugcast/src/feeds/render_stage.rs`) keeps every live session's assistant text and thinking prose. Each tick it renders them with `tugmark::render_blocks`: parsed, sanitized, and highlighted in the shared `tug-syn-*` classes. The bridge (`render_bridge.rs`) ships them on `RENDERED` (0xB0), at most once per display period, bundling every session's renders into one frame. The deck answers on `RENDER_INPUT` (0xB1) with the display period, each motion hold and release, find queries, and after every handshake a resync of every message.

An emission carries a message's ordered block list from the first block that changed, read against the emission it names (`base_seq`). It carries HTML only for hashes new since that emission. Block hashes are FNV-1a 64, the same crate in both places (`tugmark`, which also builds `tugmark-wasm`), so a hash computed by tugcast and by the page agree. The Worker's engine expands a diff where the wire lands, so the page's store only ever sees whole records. A diff off a base the engine does not hold asks for the whole message, backing off from 250 ms to 8 s, at most six times (`render-tracker.ts`).

Both directions carry `RENDERED_FEED_VERSION`. tugcast answers a handshake's resync with an empty `render-batch` at its version. Until one arrives at the deck's version on the current socket, the engines mint no `pending` state. So a tugcast that does not render, or renders at another version, leaves every row parsing its own text with no wait.

**The display rule** is `chooseRenderedBlocks` (`tugdeck/src/lib/markdown/rendered-record.ts`), over the `.rendered` state the engine's `RenderTracker` writes beside a Message's `.text`:

| State | The row |
|---|---|
| never written, or `null` | parses its own text |
| `pending` (minted, no render yet) | keeps its DOM |
| a streaming record | draws its blocks, even a tick behind the text |
| a streaming record whose `textLength` exceeds the row's text | parses (the page's own feed dropped a delta) |
| a finalized record whose text length and hash match the Message's text (`current`) | draws its blocks |
| a finalized record that is not current | keeps its DOM, never parses at once, since a turn's end routinely overtakes tugcast's last tick |
| any record with a block whose HTML is missing | parses |

Two finishers of `RENDER_FINISHER_MS` (250 ms) bound the waits. A pending Message with no render that long after it minted, or a finalized one with no current record that long after it stopped streaming, is written `null` once, and the row parses.

**The page parse is permanent for the paths tugcast does not serve.** A restored (replayed) row is never rendered by tugcast: replay is indexed rather than rendered, so a resume does not cost a burst of renders on every handshake. Restored rows parse once on the page, through the shared parse cache. The page parse also serves static `initialText` blocks, `TugMarkdownView`, the beat line, transcript copy HTML, find's projection of user bodies and notes, and every row the table above sends to parse. `tugmark-wasm` and DOMPurify stay for those.

**One barrier, one allow-list, and a policy beneath them.** tugcast's sanitizer (`tugmark`'s `ammonia` builder) is the one barrier between a model's output and an `innerHTML` write ([D210]). It reads the same allow-list file the page's DOMPurify reads, `tugdeck/src/lib/markdown/sanitize-allowlist.json`, so the two sanitize to one policy by construction. Edit the lists there and nowhere else. `class` is held to pulldown-cmark's vocabulary (`language-*`, `footnote-*`), so the `tugx-*` and `tug-syn-*` classes exist only after sanitizing. `id` survives only on a footnote definition, moved under the page-owned `tugfn-` prefix. Beneath the sanitizer, the deck's Content-Security-Policy (`tugdeck/index.html`) admits no inline script: `script-src` carries no `'unsafe-inline'`, and the deck's own inline scripts are admitted by hash (`tugdeck/vite.config.ts`). So a sanitizer miss renders a string rather than running one. The tests that hold the barrier are `tugmark_invariant.rs` (every golden block and DOMPurify's own regression payloads, reparsed with html5ever), the page's `sanitize-invariant.test.ts`, the seeded differential fuzz (`just tugmark-fuzz`), and `at0732-tugcast-hostile-render`, which streams hostile markdown through tugcast into the real WKWebView with an observer on every element that lands and asserts that no CSP violation fires.

## The population {#population}

**The page mounts the rows near the viewport, not the rows it holds.** [L36]

There are two windowed surfaces, the transcript (`TugListView`, `tugdeck/src/components/tugways/tug-list-view.tsx`) and the Overview column (`useOverviewWindow`, `tugdeck/src/components/overview/use-overview-window.ts`). They share one implementation of the window, the pure helpers in `tugdeck/src/components/tugways/internal/list-view-window.ts` (`computeWindow`, `resolveEvictSegments`, `coldWindow`). Each has two margins, and those are the two windows. A row mounts within one viewport of the scrollport (`EVICT_MOUNT_MARGIN_VIEWPORTS`) and stays mounted until it is two away (`EVICT_RETAIN_MARGIN_VIEWPORTS`), so a row at the edge does not mount and unmount on every scroll tick. Besides the window, each commit mounts at most one measure segment of `MEASURE_SEGMENT_MAX_ROWS` (8) rows. That segment is how unmeasured or stale heights drain, nearest the window first. Spacers stand in for every unmounted run and keep `scrollHeight` and `scrollTop` exact. So the scroller's extent, the follow-bottom pin and the restore anchor read the same numbers they read fully mounted.

Heights persist with the card's state bag, per session and per post. A reopened or relaunched surface therefore windows against real heights from its first commit. A row with no recorded height is estimated from the ledger's median and corrected on measurement. No state mounts the whole loaded window.

Under a closed motion gate the mounted set is held. The surfaces' observers are `heldResizeObserver`s. A commit under the gate renders exactly the window, segment and row count the last unheld commit rendered, so rows appended under the gate mount after it. That is the animation doctrine's [D9](animation-doctrine.md#d9-compositor-only-settle), in the shell's page; a card in its own page is never held, and the pop at release is no longer an accepted one ([the set-up solves the end state](animation-doctrine.md#fully-solved)). `at0727-population-ceiling-reading` holds the ceiling: the Overview's mounted count, no full transcript mount through a reflowing settle, and every moving settle sealed.

---

## Where each rule is checked {#checks}

| Rule | Held by |
|---|---|
| The protocol's lists match its unions | the compile-time check in `tugproto/src/ingest.ts`; `ingest-kinds.test.ts` |
| The render feed's two halves agree | `rendered-parity.test.ts` and `render_bridge.rs`'s tests, over one fixture |
| The host's hold, cap and unheld kinds | `tugdeck/src/lib/ingest/__tests__/ingest-host.hold.test.ts` |
| The render bridge's hold and its floor | `render_bridge.rs`'s tests |
| No batch inside a motion | `at0725-streaming-settle-reading` |
| The display rule and the finishers | `render-tracker.test.ts`; `ingest-host.rendered.test.ts` |
| One barrier, under a script-free policy | `tugmark_invariant.rs`, `sanitize-invariant.test.ts`, `just tugmark-fuzz`, `at0732-tugcast-hostile-render` |
| The population ceiling | `at0727-population-ceiling-reading` |
| A page's identity and the registry | the tests in `tugcast-core/src/pages.rs` and `tugcast/src/pages.rs`; `many-pages.test.ts` "identity" |
| Addressed delivery and the newest page | `pages.rs`'s `resolve_*` and `delivery_admits_only_whom_it_names`; `many-pages.test.ts` "addressed control" and "eval" |
| Inputs per page, replies to the asker | `router.rs`'s ownership tests, `file_watch.rs`'s tests; `many-pages.test.ts` "replies" |
| Session-scoped frames by subscription | `router.rs`'s `session_of_*` tests; `many-pages.test.ts` "session subscription" |
| The render bridge's per-page pacing and hold | `render_bridge.rs`'s tests; `many-pages.test.ts` "render input" |
| Seating ownership and the sweep | `router.rs`'s `code_input_follows_the_cards_seating`; the sweep tests in `agent_supervisor/mod.rs`; `agent_supervisor/tests/arc.rs`; `many-pages.test.ts` "seating" |
| The bus's routing and its two halves | `bus.rs`'s and `router.rs`'s bus tests; `bus-parity.test.ts`; `many-pages.test.ts` "bus" |
