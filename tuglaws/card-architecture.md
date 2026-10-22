# Card Architecture

*The narrative summary of the per-card web view design: why the deck was split, what the pieces are, why the split delivers better frames, what it costs, and what the record shows. This is the overview; the rules are in [shell-and-bodies.md](shell-and-bodies.md), the decisions are [D213]–[D217] and [D219] in [design-decisions.md](design-decisions.md), and the programs' briefs are `briefs/per-card-web-views-program-brief.md`, `briefs/body-lifecycle-program-brief.md` and the stage briefs each indexes.*

---

## The problem it solves {#problem}

Before this program the whole deck was **one HTML document in one WKWebView**: one WebContent process, one main thread, and that thread did everything for every card. React commits, style resolution, layout, the compositing-requirements walk and the layer commit all ran there, so one frame cost as much as the whole deck, and the deck grew through a working day. The user's aged deck reached 25–29k elements and 2.9 GB resident.

The main-thread headroom program (`briefs/main-thread-headroom-program-brief.md`) spent six stages taking script off that thread: the socket, decode and reducer moved into a Worker; rendering moved into tugcast; the mounted population was bounded; parked content left layout. WebKit's own work for a frame was still over budget afterwards. The first frame after an arrangement commit took 77–83 ms, about five display periods, and the height crossing's frames were style and compositing that every shape paid.

WebKit runs style, layout and compositing on the main thread of the document they belong to, and no public API moves them. An app gets more main threads by having more web views. So the deck was split ([D214]).

## The shape {#shape}

Three layers of web view and one host, bottom to top.

**The shell page, beneath everything.** It paints only its own: the canvas and its grid, the rails' panels, the seams and the drop bands. It is still the one authority on arrangement — the layout imposer, the settle engine's planning, focus arbitration, chords and the deck's state — and it draws a card only while that card's page has not painted. Each Pane in it is a **stand-in**: the `.tug-pane` frame with its geometry and data attributes, paintless while the card's view stands over it ([D216]). For a card whose page is not there yet, or has not painted, the stand-in draws the card's own chrome from the facts the shell already sends the page; that is the one paint the shell makes for a card ([L09], [D219], [a card's life](#lifecycle)).

**One WKWebView per card, standing over the shell.** Each card is its own page (`?body=<cardId>`) in its own WebContent process. The card's page draws **its own chrome and its own content** — title bar, masthead, border, body — so a card is one opaque view and one layer tree, and nothing is cut in the shell for it. A pane with tabs is one live view for the active card at the pane's rect, plus a sibling view for each inactive tab that has a page, placed at the same rect and painting at opacity 0. An inactive tab that has never been shown has no page at all until it is chosen. A Session card's page owns its session: its own tugcast connection, its own `CODE_INPUT`, its own feed subscription. tugcast was taught to serve many pages for this ([D213]): per-page identity, per-page input ownership, per-session subscription, and reaping by a card's seating rather than by socket. One spare page is kept warm so a new card binds a page already loaded, and the host loads at most two pages at once, shown cards first (the lane).

**The overlay page, above every card.** It holds what must cover the whole deck: the restore gate, sheets, relayed menus and tooltips. It is transparent and passes every point outside its claim through to the views beneath.

**The host is the stagehand.** After each commit the shell measures its stand-ins and posts one `placeCards`; the host sets each card view's frame and stacking order. The host hit-tests the pointer — the overlay's claim first, then the card whose shape holds the point, otherwise the shell — and tracks a drag or resize begun in a card's chrome itself, with the deck's clamp and snap ported exactly, committing to the shell at release. For a settle (⌘N, a slot move, a flow slide) the shell posts one `cardPlan` per carried card and the host runs it as **Core Animation on the card's container**, on the clock both sides share.

**Three channels, each with one job** ([shell-and-bodies.md](shell-and-bodies.md#channels)):

- **Host ↔ page**: typed messages ([L39], [D217]). Each is declared once in TypeScript with a Swift twin, and one parity fixture holds both sides. This carries what the host owns: geometry, focus, a body's lifecycle, the clipboard, lookup, dictation and zoom.
- **Shell ↔ card**: `DECK_BUS` over tugcast, which every page already connects to. Everything crossing it is one of three primitives: a **shared store** (one owner page writes, other pages hold replicas, a replica's edit comes back as `propose`), a **routed action** (a verb with no answer), or a **request** (a verb with an answer and a horizon). tugcast routes the envelope and reads none of it. The shell is the hub; a card page never addresses another card.
- **Host → shell**: commands over the control socket, delivered to the shell, which forwards a card-owned command to the key card's page over the bus.

**The keyboard follows the shell's word.** The shell names the card that has it (`bodyFocus`) and the host makes that card's view the window's first responder. A click in a card's view takes the keyboard as a click in any view does, and the shell is told.

## A card's life {#lifecycle}

A card is always a body, but its page is not always there. What the user can see, and for how long they have not, decides which of five tiers its page is in ([D219], `briefs/body-lifecycle-program-brief.md`):

- **Shown**: a pane's active card, its view on screen.
- **Sibling**: an inactive tab of a shown pane whose page exists, placed at the pane and painting at opacity 0, so choosing the tab is instant.
- **Hidden**: a page the host has hidden (a parked workspace's card, a folded card), within its dormant delay.
- **Dormant**: hidden for 60 s. The page empties its session subscription, so its worker hears nothing and idles; its loops still, it keeps its DOM and stores, and on reveal it asks the session for every turn after the last one it holds.
- **Evicted**: hidden for fifteen minutes, or taken by memory pressure (a warning takes hidden pages oldest-hidden first, one at a time; critical takes every page not shown, the spare with them). The page writes its card's state and the host destroys it; the card's record, seating and session stand, and the reveal is an arrival.

**No page is made for a card nobody can see.** A parked workspace's card is not handed off until its workspace is shown, and an inactive tab restored at launch is handed off `unmade`: no page is asked for until the deck first wants it shown. A kind that can veto its own close is the exception, since only its page can answer. A shell reload keeps every page, and the reloaded shell re-adopts them.

**What stands in while a page is not painted.** The host keeps an evicted card's last frame as a **cover**, and the card's next page stands under it until it paints. Where there is no cover, the shell's **stand-in** draws the card's chrome beneath where its view will stand. A departing view would hide that stand-in, so wherever a placement takes a view down over a card that waits on its page, the host hides the view in the same transaction that stands a **face** of its own, drawn from the stand-in's display list (`lib/face-draw.ts`), and retires the face once the shell's frame is on screen.

**The lane paces loading, never counts cards.** The host loads at most two pages at once, shown cards before hidden ones, and a page leaves the lane at `ready` or its deadline. That is a pacing width: it orders when pages load, and it sleeps, evicts and refuses nothing.

**While a page is not listening**, dormant, evicted or never made, the shell follows the card's session itself, so its dot still says what the session is doing. Nothing names a card's tier to the user.

## Why it is faster {#why}

**A frame costs one card, not the deck.** Each card has its own main thread. A streaming transcript restyles and re-lays-out only its own document; a React commit that forces layout in one card pays that card's layout alone; the shell's arrangement commit touches no card DOM; three cards streaming are three threads on three cores rather than one thread taking turns. Cost grows with the size of a card, not the size of the deck. This is the central gain.

**Motion leaves the web threads entirely.** A settle is Core Animation on the render server's path. A card whose main thread is busy cannot stall its own movement across the screen. The spike that gated the program read exactly this ([B09] of the program brief): with the deck's main thread jammed by a 3-second synchronous loop, a child view's Core Animation translate advanced on 180 of 180 display ticks and the child's own `requestAnimationFrame` loop ran with a worst gap of 21 ms.

**Set-up-and-go is structural.** A card takes its final size at the commit, in its own process, before the motion starts; the motion moves a finished layer, and nothing re-lays-out mid-flight because the box never changes mid-flight. In one document that was a discipline every change had to keep. Now the structure enforces it.

**The reconciliation work is gone.** The first per-card layout stood the shell *over* the cards: the shell drew each card's chrome and cut an even-odd hole for its content, so every drag frame was a shell transform, a `placeBodies` to the host and a re-cut, and two renderers with no shared commit had to agree about one card. That is where a card's content detaching from its title bar, and the holes left on neighbours, came from. Putting the cards over the shell ([D216]) deleted the cuts, the lids, the floor, the per-frame follow, the beat offset, the shell-side landing and the host's `near()` check — about 3,500 lines — and with them a cross-process crossing on every pointer frame. Chrome and content of one card can no longer tear, because one renderer draws both.

## What the record shows {#record}

The stage 3 reading (2026-10-14, M4 Max, 60 Hz, the harness window in front, three cards streaming stub turns through tugcast's real feed; the table is in the program brief's record):

- the window's display link missed **no tick** in any gesture, worst tick gap 16.7 ms;
- leads 15–17 ms, one frame;
- worst in-motion gaps 17–24 ms;
- lands 17–22 ms.

The before figure, 77–83 ms to the first frame after a commit, was read by a different instrument on the one-document deck, so the two are not exactly like for like; the size of the change is not in doubt.

**What the record still lacks is a reading on the user's aged, busy deck.** Every reading so far was taken in the harness or on a fresh deck. That reading is the one that decides the question, and it is owed.

## What it costs {#costs}

- **Memory and processes.** A card page runs about 200 MB resident, the warm spare about 150 MB, the shell about 260 MB; six WebContent processes came to about 1.1 GB. There is no cap. A hidden card's page goes dormant and then is evicted, by time and by memory pressure, never by a count ([a card's life](#lifecycle)); an evicted card's reveal is a cold arrival of about half a second, under its cover or stand-in.
- **Latency between pages.** Anything crossing shell and card is a message over tugcast or the host, not a function call. The host→shell pipeline at a landing was read at one frame.
- **Losses the user ruled acceptable.** No text selection across cards, which was never wanted ([L12]). No single DOM to query across cards: a test reaches a card through `App.body(cardId)`, and the shell's document holds none of a card's DOM ([shell-and-bodies.md](shell-and-bodies.md#tests)).
- **Complexity moved rather than vanished.** It now lives in declared contracts — bus stores and verbs, typed host messages, attach and snapshot ordering — that are testable without the app (`createTestBus()`) and fail where someone can see them. The one-document deck's shared mutable state failed silently.

## Where the seams are {#seams}

Two areas carry the open work.

**Where a card's identity crosses layers.** Focus hand-off, a ring or highlight the shell once painted on a card, an overlay anchored to a card's content. Each is a thing one layer knows and another layer draws, and each crossing is a message the shell and the card must agree on. The flash ring is the pattern: the shell cannot paint over a card, so the ring moved into the card's own page as a routed action, and the shell draws its own only for a card whose page failed.

**The per-card memory budget.** One process per card is the premise, and nothing caps open cards: a hidden page is given up by the clock and by the machine's pressure level, and no count of cards or bodies is a setting, a default or a threshold ([D219]). What the deck costs on the user's aged deck, with its pages dormant and evicted, is still a reading to take there.
