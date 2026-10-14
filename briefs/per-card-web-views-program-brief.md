<!-- brief-skeleton v1 -->

# One WKWebView per card: the shell, the bodies, and the host that moves them

**Purpose:** The deck is one document on one WebContent main thread, and six stages of taking script off that thread ended with the engine's own frames still over budget: the first frame after an arrangement commit is 77–83 ms, the height crossing's frames are style and compositing that every shape pays, and the document doubles in a working day. The user's goal, full frame rate no matter what the app is doing, needs more main threads, and on macOS that is more WKWebViews. This program splits the deck into a shell page and one body page per card, each in its own WebContent process, with the host positioning and animating the bodies. This brief is the index: the architecture, the invariants every stage holds, the ordered stages, and the record.

---

## Purpose {#purpose}

The user, 2026-10-13: "We're still *in jail* here with too much work depending on the performance of one thread… ***eventually*** we'll need to deal with the *one-thread/elephant in the room* problem… We *must* find a way to take advantage of more of the compute that is on tap." And, on the costs of the split: "I never wanted cross-card text selection (actually... I explicitly *don't want it*), and the loss of the ability to reason about the whole deck as one DOM can be mitigated by issuing multiple requests. I see no reason at all to hold off doing this work." And: "I want one WKWebView per card, not per column."

The asks are `briefs/graphics-animations-asks.md`: new cards, folds, column moves, flow slides and the rest, with no gap over one display period and a one-frame land, with three or four sessions streaming.

---

## Evidence {#evidence}

**[F01] Six stages took script off the thread and the engine's frames remain.** The headroom program (`briefs/main-thread-headroom-program-brief.md`, stages 1–6, all joined by 2026-10-13) moved the socket, decode and reducer to a Worker, rendering to tugcast, bounded the mounted population, made the set-up read geometry once and took parked content out of layout. Stage 6's write-back (`briefs/engine-time-in-the-motion-brief.md`, resolved-as-built notes): the first frame after a fold's commit fell from 107–116 ms to 77–83 ms on the harness; the height crossing's two new shapes both failed because "the motion's frames are style and compositing, which every shape pays"; the standing taxes at rest were ruled with no build because no supported lever exists. **(verified, read from the record)**

**[F02] WebKit prices a document on its main thread, and gives one per web view.** Style resolution, layout, the compositing-requirements walk and the layer commit run on the WebContent main thread of the document they belong to; nothing in WebKit's public API moves them. Each WKWebView has its own WebContent process by default on macOS; the API that groups views into one process is private, and Tug ships no private API in the host beyond the feature-override and `drawsBackground` KVC it already uses (`tugapp/Sources/MainWindow.swift:15-58`, `:632`). **(the thread fact is verified by six stages of readings; the process-per-view fact is WebKit's documented default and is confirmed by the first stage's spike before anything is built on it)**

**[F03] The host holds one web view and no per-card state.** `MainWindow` (`MainWindow.swift:342`) owns a single `ClickThroughWebView` (`:269-339`), one `WKUserContentController` with 22 message handlers (`:550-572`), a splash below it and two overlays above it (`:664-720`, `:1192-1299`). Host-to-page traffic is `sendControl` over the tugcast control socket (`ProcessManager.swift:699-710`), broadcast to the page as a CONTROL frame, and `evaluateJavaScript` into `window.__tugBridge.*` (`MainWindow.swift:857-1621`). The host learns focus only from the page's `menuState` payload (`MenuState.swift:22, 205`). There is no `performKeyEquivalent` or `keyDown` override (`AppDelegate.swift:1586-1591`); every chord the host owns is an `NSMenuItem` key equivalent that the page gates. The harness attaches to that one view (`TestHarnessBridge.swift:46-64`) and maps every coordinate through it (`CoordMapping.swift:108-130`). **(verified, read)**

**[F04] tugcast admits many pages and treats them as one.** Multiple WebSocket clients are allowed (`router.rs:202, 378, 1086`), but: the auth token is single-use (`auth.rs:95-110`), so a second page must share the first's cookie; every input feed but `CODE_INPUT` is single-writer per `(feed, None)` (`router.rs:899-921`, `boot/supervisor.rs:689-701`), so a second page cannot send `RENDER_INPUT`, `SHELL_INPUT`, file or git queries; session feeds broadcast every session to every client with no per-session subscription (`feeds/session_scoped.rs:1-15`); `CODE_INPUT` is admitted only for sessions the same `client_id` spawned (`router.rs:1066-1072`), and a resume from a second client is `session_live_elsewhere` (`spawn.rs:520-531`); the orphan sweep reaps bridges no client holds 60 s after any connect (`agent_supervisor/mod.rs:4534-4600`); `eval`, `ask` and every menu `tell` are CONTROL broadcasts that every page receives and answers (`actions.rs:262-280`, `:507-525`). Deck layout and per-card state bags are already per key in tugbank through `/api/defaults` (`settings-api.ts:1-30`), and DEFAULTS is already broadcast to every connection (`feeds/defaults.rs:1-35`). **(verified, read)**

**[F05] The deck's seams are where the split goes.** A pane owns geometry and chrome; a card is content; `CardHost` portals a card's content into its pane's `.tug-pane-content` through `CardPortal` (`components/chrome/card-portal.tsx:110-134`, registry `pane-content-registry.ts`, registration `tug-pane.tsx:2892`). The masthead is pane chrome fed by the body through `cardTitleStore` (`session-card.tsx:4714-4724`). The body reaches the deck through a short list: `cardFoldedOf`, `cardArrivingOf`, `getFirstResponderCardId`, `observeCardDidActivate`, `useCardDelegate`, `useSpaceLayerShownSource`, the pane frame and portal contexts, and writes back `cardTitleStore`, sheet reservations and opening bids, fold guards, close advice and `menuState` (`session-card.tsx:651-667, 1233-1395, 1353-1375, 1719-1727, 1961, 2202`). The imposer writes pane rects as CSS `calc()` over custom properties, so no script knows a pane's pixel rect without measuring (`lib/layout-imposer.ts:1577, 1670, 3439`; measured at `layout-imposition.ts:98-108`). Motion is the settle engine's beats on pane frames (`settle-engine.ts:3810-4065`) with the still-crossing hold, `resize-episode` and `smart-scroll` reaching into the body by attributes and CustomEvents (`lib/fold-crossing.ts:345-575`, `lib/resize-episode.ts`). **(verified, read)**

**[F06] What depends on one document.** The focus manager and responder chain query the document for responder ids (`focus-manager.ts:1143-3647`, `responder-chain.ts:616-1864`); Tab already never crosses cards (`focusNext/Previous` wrap inside the key card, `focus-manager.ts:2043-2051`). `selection-guard.ts` holds one native selection and paints the other cards' selections into a CSS Highlight. Popovers, tooltips, menus and dialogs portal into one `CanvasOverlayRoot`. Find is per card (`TugFindBar` inside the session body, `session-card.tsx:5066`). Theme is one `<link>` set flipped per document (`theme-links.ts:54-115`); zoom is a `transform: scale()` on `#deck-container` (`lib/page-zoom-store.ts:103-117`). `TugConnection` parks ingest batches while the shell's motion gate is closed (`connection.ts:478-525`). The app-test corpus is 481 files; about 207 reach from chrome selectors into Session-card DOM in one document, 37 on a single line, and the harness's `evalJS`, `getElementScreenBounds`, screenshots and native events all assume the one view. **(verified, read and counted)**

**[F07] The deck already ships a transparent web view.** `webView.setValue(false, forKey: "drawsBackground")` (`MainWindow.swift:632`); the window's background follows the theme (`:1185`). Nothing in the deck persists to `localStorage` but a theme mirror (`theme-mirror.ts:94`); card and layout state are tugbank's. **(verified, read)**

---

## Decisions {#decisions}

**[B01] The deck becomes a shell page and one body page per card, each in its own WKWebView.** The shell is today's deck minus card content: chrome, panes, tab bars, mastheads, columns, rails, the imposer, the settle engine's chrome beats, pickers, deck-scope overlays, focus arbitration, chords and the deck's state. A body is one card's content, `registration.contentFactory(cardId)`, mounted alone in its own document with the deck contexts it reads bridged in. One body per card of every kind, Session cards first; no body is shared by a column or a workspace. This is the user's call, and it is the only shape that bounds a frame's cost by a card rather than by the deck.

**[B02] The shell sits over the bodies, transparent where a body shows through.** Body views are children of the window's container view beneath the shell view; the shell draws its background and chrome, and each pane's `.tug-pane-content` is transparent so the body beneath it shows. Every deck-scope overlay (popover, tooltip, dialog, sheet, drag ghost, focus ring, scrim) keeps drawing in the shell, over the bodies, with no host overlay. The host hit-tests the shell view and passes a pointer event through to the body under it unless the shell has told the host it is claiming the pointer (a scrim, a sheet, a drag, a popover open over that rect). The alternative, bodies over the shell, needs a third surface for every overlay and is the recorded fallback if the first stage's spike shows the composite or the pass-through failing.

**[B03] The host positions and animates the bodies; the shell decides where they go.** The shell stays the authority on arrangement (it is already a pure function of store state), measures its pane content rects once per commit, and posts them to the host. For a settle it posts a beat plan per body (rect and opacity keyframes, duration, easing, an absolute start time), and the host runs them as Core Animation on a container layer around each body view, which keeps display rate on the render server whatever any WebContent thread is doing. Set-up-and-go holds: a body takes its final size at the commit, in its own process, and the motion translates and clips its container; a body's content never relayouts mid-motion because its box does not change mid-motion.

**[B04] Three channels, each with one job.** Host ↔ page keeps today's shapes, routed by view: `WKScriptMessage` handlers registered per view's content controller with the view identified by `message.webView`, and `evaluateJavaScript` into the named view; this channel carries geometry, focus, lifecycle and the things the host owns (clipboard, lookup, dictation, zoom). Shell ↔ body application messages ride tugcast, which every page already connects to, over a new addressed bus (title and masthead facts, sheet reservations, fold and close advice, find commands, chords the body does not own, theme and zoom, crossings); it is testable in bun with no host. Host → page commands keep the control socket, delivered to the shell, which forwards body-owned actions to the key card's body over the bus.

**[B05] A body owns its session.** A Session body spawns or resumes its session on its own connection, so `CODE_INPUT` and the single-writer feeds are its own; the shell holds no session. tugcast gains per-client identity and roles, addressed control, per-client input ownership, per-session subscription, and a sweep that reaps by card seating rather than by client. These are the first stage because they are prerequisites for every body and need no host.

**[B06] What is kept, what is rebuilt, what is lost.** Kept as is: every card's component code and its Rust; within-card selection, copy, find, scroll, history, composer; every chord and menu; theme and zoom; VoiceOver. Rebuilt as a bridge message or host code: card motion, card drag, focus hand-off between cards, Tab at a card's edge, the masthead's facts, menu state aggregation, undo routing, overlays that anchor to body content, the harness's addressing. Lost, by the user's ruling: cross-card text selection (never wanted) and one DOM to query across cards (replaced by one query per body). The selection guard's "inactive selection" paint becomes WebKit's own inactive-selection paint in an unfocused view.

**[B07] Every stage reads the asks' bar on the user's deck, aged, with sessions streaming.** The honesty rules (`briefs/motion-record-honesty-brief.md`) stand. The instruments extend across pages: the gap sampler runs in every page, the eval door and the settle verb take a `--card`, and the host gains a display-link frame reading of its own, because the frames that matter are now the window's, not one document's. The before is the stage 6 after on the user's deck; each stage writes its after into the record below.

**[B08] Stop points, in order, and no stage lands on by default.** The program may stop after any stage: (1) tugcast for many pages, invisible to the user; (2) one Session card in a body, placed by the host; (2a) grounding, `briefs/body-view-grounding-brief.md`: bodies behind a switch that is off on the shipping build, a written bar of basic behaviours, and a harness that delivers keys and menu commands on the app's own path; (3) motion to the host for the four gestures; (4) focus, keys and the edges; (5) every card a body, the shell's diet, the harness sweep, the laws. *Corrected 2026-10-14:* the first draft said each stage leaves the product whole, and stage 2 did not; it joined with bodies snapping at the land and focus minimal, and the user's deck was rough. From the grounding stage on, every stage lands behind the switch, keeps the bar green on every row it touches, and flips nothing on; the switch's default changes only by a decision written here after the user has run the body deck as their daily deck and said so.

**[B09] The first act is a spike, inside stage 2, and its reading gates the rest.** Before any seam is cut: a child WKWebView over the deck, in its own process, its container animated by Core Animation while the shell is deliberately stalled with a synchronous loop and while the child's own page is streaming, read with the host's display-link instrument; a transparent shell over it, hit-tested through; a count of processes and resident memory per view. If a body view cannot hold display rate under a stalled shell, this program's premise is wrong and the record says so before anything else is built.

**[B10] No private API, no process sharing.** Bodies are one process each; the ceiling on open bodies is the parked-and-unloaded rule of stage 5, not a shared process. The feature-override and `drawsBackground` KVC the host already ships are the only exceptions, as today.

---

## Open Questions {#open-questions}

- **Does a transparent shell over body views composite and hit-test cleanly on this WebKit?** [B09]'s spike settles it; [B02] names the fallback.
- **How large is the skew between the shell's WAAPI chrome beats and the host's Core Animation body beats when both are anchored to one absolute start time?** Read in stage 3; if it is a frame, the chrome moves to the host too (the pane's title bar as a host-drawn strip is the recorded escalation, not a plan).
- **What does a WebContent process cost at rest on this machine, and how many bodies can be live before the cap?** Read in the spike and ruled in stage 5.

---

## Non-goals {#non-goals}

- **One web view per column.** The user ruled it out; it halves the seams and keeps the jail.
- **A native Session card.** Throws away CodeMirror, the markdown stack and every card's code.
- **OffscreenCanvas or a Worker-rendered transcript.** Loses selection, accessibility and find.
- **Containment and `content-visibility` as the answer.** Stage 6 took what they give; they bound a document's cost, not the thread.
- **Sharing one WebContent process across bodies.** Private API, and it is the jail with more doors.
- **Compatibility bridges for tests.** The 207 mixed files are migrated, not shimmed; a shim that made one `querySelector` reach across documents would be the one-document assumption kept alive.

---

## Exit {#exit}

**Five arcs, one per stage, each with its own brief:**

| Stage | Brief | Lands |
|---|---|---|
| 1 | `briefs/tugcast-for-many-pages-brief.md` | Client identity and roles, addressed control and eval, per-client input ownership, per-session subscription, seating-based sweep, the bus |
| 2 | `briefs/body-view-brief.md` | The spike, the host's body view, the body page, one Session card in a body placed by the host |
| 2a | `briefs/body-view-grounding-brief.md` | The switch (off by default), the grounding bar's twelve rows, `nativeKey` and `performMenuItem` on the app's own path, real-app readings, the tree's fixups landed under the bar |
| 3 | `briefs/motion-to-the-host-brief.md` | Beat plans, Core Animation on body containers, the four gestures' bars on the user's deck |
| 4 | `briefs/focus-keys-and-edges-brief.md` | First responder arbitration, chords, Tab at the edge, menu state, undo, clipboard, overlays, theme and zoom per body |
| 5 | `briefs/every-card-a-body-brief.md` | Every card kind, the shell's diet, lifecycle and the cap, the harness sweep, the laws page |

**Record.** One row per stage at its join: the four gestures' lead, worst in-motion gap and land on the user's deck, aged, with sessions streaming; process count and resident memory; the harness's own frame reading. The before row is stage 6's after.

| Stage | Joined | Lead | In-motion | Land | Processes / RSS | Notes |
|---|---|---|---|---|---|---|
| before (stage 6) | 2026-10-13 | — | — | — | 1 / 2.9 GB | first frame after commit 77–83 ms (harness); user's aged deck owed |
| 2 | 2026-10-13 (harness; join owed) | — | — | — | 4 WebContent / 709–717 MB (shell + two bodies + the spare; each 215–219, 180–187, 178–185, 130–133 MB) | no host motion yet, so no gesture reading; a body's bind → ready: warm 109–148 ms, cold 112–127 ms (`ready` at the body's first paint); the arrival fade a 216.7 ms ramp at 16.67 ms with no display-link gap and the seen container still; user's aged deck owed at join |

**Spike reading (stage 2).** 2026-10-13, Apple M4 Max (`Mac16,5`), macOS 27.0.1, 60 Hz display, the harness window in the foreground (`at0737-body-view-spike.test.ts`). One child page (`/?body=spike`, a compositor animation plus one painted log line per frame) in a WKWebView of its own beneath the deck, shown through a hole in the deck's paint, while the deck's main thread ran a 3000 ms synchronous loop. **The premise holds.**

- (a) The child's own rAF over the stall: 180 ticks against 176 expected at its own 17 ms period, worst gap 21 ms (1.24 periods; bar ≤ 1.5).
- (b) The host display link sampling the child container's presentation layer under a Core Animation translate, over the stall's first half: the position advanced on every tick (ratio 1.00; bar ≥ 0.95). The link itself, over the whole stall: 180/180 ticks at 16.67 ms, none missed.
- (c) Composited window captures cropped to the child, over the stall's second half: 89 of 89 consecutive pairs differed (bar ≥ 0.90). The translate and the captures take different halves because a moving container makes every crop differ.
- (d) The child shows through the deck's transparent region in a composited capture; (e) a native click at the child's centre reached the child (one `pointerdown`), the deck's view passing it through.
- Processes: the child added one WebContent process, 53 MB resident at creation. The spike page's cold time, `load` to painted: 116–132 ms over four launches.
