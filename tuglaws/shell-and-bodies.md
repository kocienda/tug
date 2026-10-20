# Shell and Bodies

*The long form of [L37], [L38] and [L39]. The deck is one shell page and one body page per card, each in its own web view and its own process ([D214]), with the cards' views standing over the shell's page ([D216]). This document is how those pages are layered and how they talk: the layer order, the three channels, the three things that may cross between shell and body, who owns each piece of state, and what a test may assume about which document it is in. The library that carries the talk is `tugdeck/src/bus/`.*

## The layer order {#layers}

Three layers of web view, bottom to top, and each paints only what is its own.

- **The shell's page is beneath every card.** It paints the canvas and its grid, the rails' panels, the place seams and the drop bands, and lays the deck out. Each Pane in it is a paintless stand-in: the `.tug-pane` frame with its data attributes and inline geometry, nothing drawn, no clip and no painted child. A shell-document census (`at0747`, `// card-dom: shell`) holds that.
- **Each card is one view over the shell.** The host places it from its stand-in's rect, outset by the card apron and grown to whole points (`placeCards`, `lib/card-placement.ts`), and stacks the views in the deck's order. The card's own page draws its chrome and its content (`body-chrome.ts`), so a card is opaque over its pane and nothing the shell paints shows through it; nothing is cut in the shell for a card, and a card covered by another stands beneath it in the host's stacking rather than being hidden. A card the shell has not yet placed, or that is not the pane's active card, is hidden or transparent in the host, never in the shell. A settle moves a card as a whole: the shell plans each carried card's beats from the stand-in's First and Last rects and posts one `cardPlan` ([B11]), which the host runs as Core Animation on the card's container on the clock both sides share, and a dropped card lands by the same plan from where the hand let go.
- **The overlay is above every card.** One page for the surfaces that stand over the whole deck — the app-modal restore gate, the sheets, the relayed menus and tooltips — transparent and passing every point outside its claim through (`overlayClaim`). While it claims the whole window, as the restore gate does, every click and the keyboard are its; a test of a gesture meant for a card is made once the gate has gone (`restoreGateGone`).

**The pointer follows the layers.** A point in the overlay's claim is the overlay's. Otherwise the host asks which card it is (`CardHitRegion`, `CardGeometry.swift`): a point inside a card's pane rect is that card's, a point in its apron is the card's only along an edge it grips, a point on a shell seam over a card is the shell's, and a point on no card falls to the shell's page. A drag or a resize begun in a card's chrome is tracked by the host (`cardGesture`), with the deck's own clamp and snap ported exactly, and committed to the shell at the release.

**The keyboard follows the shell's word.** The shell names the card that has it (`bodyFocus`) and the host makes that card's view first responder; a modal standing in the overlay keeps it until the modal goes. A click in a card's view takes the keyboard the way a click in any view does, and the shell is told, so its focus engine and the host agree on who has it.

## The three channels {#channels}

Each channel has one job, and a message belongs to the channel whose job it is.

- **Host ↔ page.** The host vocabulary ([L39]): every message declared once in `tugdeck/src/host/declarations/`, listed in `host/registry.ts`, and named again in `tugapp/Sources/HostMessages.swift`. A page posts the JSON string `postToHost` makes (`host/channel.ts`) to the declaration's `WKScriptMessage` handler, and `HostChannel.swift` decodes it once with `JSONDecoder`, naming the view by `message.webView` and refusing a payload that does not decode. The host answers by calling a `window.__tugBridge` member, which `installHostChannel` defines at boot for each host→page declaration; the member decodes its one payload and hands it to the one handler `onHostMessage` registered. A call the host awaits (`window.tugdeck`'s `saveState`, `prepareForTermination`, `reauthenticate`) is answered through `answerPageCall`. This carries what the host owns: geometry (`placeCards`, `cardGesture`), focus, a body's lifecycle (`bodyCreate`, `bodyDestroy`, `onBodyState`), the clipboard, lookup, dictation and zoom.
- **Shell ↔ body.** `DECK_BUS` (0xD0) over tugcast, which every page already connects to. This carries everything one page of the deck tells another. It runs in bun with no host, so every crossing is testable without the app.
- **Host → shell commands.** The control socket, delivered to the shell. A command a body owns goes on from the shell to the key card's body over the bus, so the host never needs to know which page a command ends in.

## Three primitives, and nothing else {#primitives}

Everything that crosses `DECK_BUS` is one of three things.

- **A shared store** (`defineSharedStore`): state one page owns and other pages read. Deck facts, card context, the arrangement, the selection, a card's title and its holds are all stores.
- **A routed action** (`defineAction`): a verb one page asks another to run, with no answer. It runs on its owner's page.
- **A request** (`defineRequest`): a verb that answers. The asker gets a promise that settles with a value or a named failure.

There is no fourth primitive. A need that fits none of the three is a design question, and these answers to it are rejected:

- **a new bus kind**, because tugcast routes five kinds and reads nothing else;
- **an advice variant** that carries a verb inside a fact;
- **a `dispatch` id with its own sub-grammar** that a handler parses at the far end;
- **a module singleton** that one page sets so another page's code behaves differently.

Each of these is how a wire got written before this library existed, and each produced its own queue, its own dedupe and its own failure surface.

**tugcast routes an envelope and reads none of it.** `tugrust/crates/tugcast-core/src/bus.rs` parses the target (`"shell"`, `"body"`, `{card}`, `{page}`) and the kind (`hello`, `state`, `action`, `request`, `reply`). It passes every other field through untouched and stamps `from` with the identity the sender's hello registered. A payload's type lives once, in TypeScript, beside its declaration in `tugdeck/src/bus/declarations/`. The receiving page's codec validates it there and refuses it with `INVALID`, so a malformed payload is refused where someone can see it rather than stripped in transit. A new store or verb is a TypeScript change with no Rust rebuild.

## Owner by lifetime, and write-back by `propose` {#owner}

A store has exactly one owner page, which is `"shell"` or `"card"` (the card's body), and any number of replicas. **Choose the owner by the state's lifetime.** State that must outlive a body belongs to the shell: a hidden rail's draft, the selection, the arrangement. State that dies with the card's content belongs to the card: its masthead, its holds, its surface.

The owner writes with `set`, `setFor` or `update`. A replica never writes. A React reader reads it through `useSyncExternalStore(store.subscribe, store.getSnapshot)` ([L02]); an imperative reader subscribes and applies what it reads ([L22]). A `set` that `equals` calls unchanged sends nothing. A changed one raises the store's version, and a replica accepts a snapshot only if its version is newer or its epoch (the owner's `pageId`) is new.

**A store the owner keeps but a replica edits gets a write-back, never a second copy.** It is declared with `proposals`. The replica's `propose(patch)` shows the patch at once, using `applyProposal` if the store declares one, and sends it to the owner. The owner's `onProposal` applies or refuses it and always republishes with an `ack`. The replica keeps its optimistic view until that ack arrives, then takes the owner's value whatever it is. The replica never holds an authoritative copy, so there is nothing to reconcile. Paired stores that mirror each other in both directions are exactly what this replaces.

**A page's pre-existing store is fed from a replica, never written back from.** Some stores a body's components already read predate the bus: the deck facts a card's components read, the selection, the session binding. In a body each is *fed*: an imperative reader subscribes to the replica and applies its value to the old store (`createCardFactsMirror` in `body-main.ts` for the facts and the body's own `cardSessionBindingStore`, the selection's `take` in `shareLayoutSelection`). The old store is never the authority and nothing copies it back. A body's own edit to one, where it has any, goes to the owner as a `propose`, like any other replica's.

A card-owned replica in the shell keeps its last value when the card's body detaches, unless the store is declared `clearOnDetach`. The shell drops all of a card's entries when the card is destroyed (`forgetCard`).

**Only the owner's page may set a store.** A replica refuses a snapshot from any page but the store's owner, and the shell refuses a card-owned snapshot from a body that names a card other than its own. Both are logged as refused, so a body cannot write the shell's state, nor another card's.

## The shell is the hub {#star}

Bodies speak to the shell and the shell speaks to bodies. A body never addresses another body, and the library drops a body-to-body action or request at its owner. A body that needs another card's facts reads a store the shell projects for it, as the deck-wide bindings and activities are. So the shell stays the one authority on what a card knows about the deck, and a body that fails cannot reach a sibling.

## Which page this is, and which page runs a command {#page}

**A module that behaves differently in a body reads the page, never a setter someone remembered to call.** `tugdeck/src/bus/page.ts` says which page this is (`page.isShell`, `page.isBody`, `page.cardId`), set once at boot before the first render. A body's keyboard yield (it holds the keyboard exactly while its card is the deck's first responder, as its deck store publishes it), its press placement, its Tab walk off either end (`focus.exit`), its session filter and its surface host each read it.

**A command's owner is a field of its row.** `ownerOf` (`tugdeck/src/bus/command-route.ts`) answers the row's `owner`, or else what its routing implies: a chain routing is the key card's, `registry` the shell's. In the shell, a key-card command while the key card is a body card goes to that card's body as the one `command` action, through the shell's key-card route, and the body runs it as its own dispatch. A `registry` row whose handler every page that holds a card registers for its own card says `owner: "key-card"`; a shell-owned row would run in the shell, where a body card has no stops, no cycle and no surface map.

**Host plumbing is not a crossing.** The shell's half of the keyboard yield (`setKeyboardYield`, installed once by `installBodyShell`) is how the shell learns from its own focus engine that a park was declined, so it can tell the host which web view takes the keyboard (`bodyFocus`). Nothing in it reaches another page, so it stays the shell's one installation rather than a store or an action. That is the rule for every module singleton a boot installs: it is allowed only when it never crosses pages. `bus/__tests__/no-legacy-bus.test.ts` names the five that meet it (the keyboard yield, the key-card route `installKeyCardRoute`, the body reloader, the Settings reveal consumer and the layout cursor's write), and refuses any of the setters the bus replaced, in any directory and in any spelling of an export, re-exports included.

## Snapshot on attach, and the hold {#attach}

**The library owns liveness, so no feature queues by hand.** Every page announces itself with a `hello` when its bus is bound and again after a reconnect. Every hello that is not itself an answer gets one answer. A spare body with no card yet stays silent until it is bound. A page marks a peer attached when it hears that peer's hello. The shell detaches a card when the host reports its body `terminated` or `failed`, and when the card is destroyed.

Anything addressed to a target that is not attached is held for that target, in order: a store's snapshot (only the latest per key), an action, a request. **On attach the owner sends every store the new peer is scoped to before it drains the hold**, so a body never reads a store that has not arrived.

**The order snapshots go out in is declared.** On a hello, a page sends its stores in registration order unless a store declares `after`, naming the stores it must follow: `card.painted` declares `after: [cardFacts]` and `card.context` `after: [cardCrossing]`. So the order a reader relies on is written down rather than left to the order the declaration modules happen to be imported in, and the registry test refuses an `after` that names no registered store. A reader that needs two stores still waits for both to have arrived: the shell's paint gate (`createBodyPaintGate`) reveals a body only once the host has placed it, it has painted, and its facts have come.

**One handler cannot stop the bus.** A route, a store subscriber, or a hello, attach, gone or detach listener that throws is logged against its name and the bus goes on to the next, so one feature's defect fails that feature alone. Every registration returns its release ([L27]), and binding a page's bus does too. Detach drops held snapshots, because the next attach sends fresh ones, and keeps held actions. A `bus_undeliverable` from tugcast is logged against its target, as a warning when the library believed the target was attached.

## Requests and their horizons {#requests}

A request is a wait on another process, so [L33] governs it ([no-wait-without-a-horizon.md](no-wait-without-a-horizon.md)). `request.ask(payload, {card?, horizon})` names one of two horizons:

- **`{ms}`** is a deadline armed at the `ask`, not when the envelope leaves the hold, so a request held for a body that never attaches still ends.
- **`{person}`** names the surface where a person ends the wait, for example the close sheet in the card. It arms no timer. A wait on a person is not a wait on a process, and [L33]'s person-exit clause is what allows it: the surface is the named way out, and the request's named end states still hold.

Every request ends in a named state: `ok`, or `timeout`, `detached`, `refused` (the handler threw) or `withdrawn`. A declaration says what a detach means for a request still pending. `fail` settles it `detached`. `redeliver` sends it again when the card's body next attaches, which is how an ask survives a body reload. `withdraw(requestId)` takes a request down at the owner, and the handler's `AbortSignal` aborts on a withdrawal or when the asker's page goes away, card or shell — a card that detaches, or a shell that says hello from a new page after a reload — so a dialog a request raised comes down with it rather than waiting to send a reply that has nothing to go to.

## What a test may assume about documents {#tests}

**A card's DOM is in that card's own page.** An app-test reaches it through `App.body(cardId)`, never through the shell's document, where an expression finds nothing of the card ([tests/app-test/README.md](../tests/app-test/README.md#reaching-a-card)). A call that reads the shell's page on purpose, for example to show the shell's document did not take what a body did, carries a `// card-dom: shell` comment on its line or the line above. `just app-test-body-scope-check` holds that rule.

**A unit test of a crossing stands on `createTestBus()`** (`tugdeck/src/bus/test-bus.ts`). It runs the real library on a shell page and any number of body pages, over a fake router that serializes every frame and resolves targets the way tugcast does. Attach, detach, disconnect, the hold, snapshot-on-attach and request horizons are all exercised as exchanges between pages. A test that asserts against a `send` callback, or against a mock of the bus, tests nothing that crosses.

## Adding a store or a verb {#adding}

1. Declare it in a file under `tugdeck/src/bus/declarations/`, beside its payload type and codec. A declaration anywhere else fails `bus/__tests__/registry.test.ts`, and so does a key used twice across stores, actions and requests.
2. Register it in `tugdeck/src/bus/registry.ts`, in `SHARED_STORES`, `ROUTED_ACTIONS` or `REQUESTS`. The same test checks that every codec decodes its own `sample` and that every store's `initial` passes its codec.
3. Test it on `createTestBus()`, as an exchange between the pages that own and read it.

Nothing in `components/` learns whether it runs in a body. The primitives feed the same contexts a component already reads, and a card reads its deck through `CardDeck` (an arrangement card through `DeckView`, `tugdeck/src/card-deck.ts`), which the shell's deck and a body's deck built from its replicas and verbs both implement.

## Adding a host message {#adding-a-host-message}

1. Declare it in a file under `tugdeck/src/host/declarations/` with `defineToHost`, `defineToPage` or `definePageCall`, beside its payload's codec, at least one of its `samples`, and the `refused` payloads a typed codec must refuse.
2. Register it in `tugdeck/src/host/registry.ts`, in `TO_HOST`, `TO_PAGE` or `PAGE_CALLS`. `host/__tests__/registry.test.ts` checks that the file and the list agree and that every codec decodes its samples and refuses its refusals.
3. Write its Swift twin in `tugapp/Sources/HostMessages.swift`: the name in `ToHostName`, `ToPageMember` or `PageCall`, and a `Decodable` payload a typed message decodes into. Handle it in `HostChannel.swift`'s dispatch, or send it with `HostChannel.send`.
4. Regenerate the parity fixture with `HOST_PARITY_UPDATE=1 bun test src/host/__tests__/host-parity.test.ts` and review its diff; `TugTests/HostChannelTests.swift` holds the Swift side to the same fixture.
5. Post it with `postToHost(decl, payload)` or handle it with `onHostMessage(decl, handler)`. Nothing else reaches `webkit.messageHandlers` or defines a `__tugBridge` member (`host/__tests__/no-hand-channel.test.ts`).
