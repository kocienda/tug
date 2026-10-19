# Shell and Bodies

*The long form of [L37] and [L38]. The deck is one shell page and one body page per card, each in its own web view and its own process ([D214]). This document is how those pages talk: the three channels, the three things that may cross between shell and body, who owns each piece of state, and what a test may assume about which document it is in. The library that carries all of it is `tugdeck/src/bus/`.*

## The three channels {#channels}

Each channel has one job, and a message belongs to the channel whose job it is.

- **Host ↔ page.** `WKScriptMessage` handlers on each view's content controller, with the view named by `message.webView`, and `evaluateJavaScript` into a named view (`window.__tugBridge`). This carries what the host owns: geometry, focus, a body's lifecycle (`bodyPlace`, `bodyDestroy`, `onBodyState`), the clipboard, lookup, dictation and zoom.
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

The owner writes with `set`, `setFor` or `update`. A replica reads through `useSyncExternalStore(store.subscribe, store.getSnapshot)` ([L02]) and never writes. A `set` that `equals` calls unchanged sends nothing. A changed one raises the store's version, and a replica accepts a snapshot only if its version is newer or its epoch (the owner's `pageId`) is new.

**A store the owner keeps but a replica edits gets a write-back, never a second copy.** It is declared with `proposals`. The replica's `propose(patch)` shows the patch at once, using `applyProposal` if the store declares one, and sends it to the owner. The owner's `onProposal` applies or refuses it and always republishes with an `ack`. The replica keeps its optimistic view until that ack arrives, then takes the owner's value whatever it is. The replica never holds an authoritative copy, so there is nothing to mirror and nothing to reconcile. Paired stores that mirror each other in both directions are exactly what this replaces.

A card-owned replica in the shell keeps its last value when the card's body detaches, unless the store is declared `clearOnDetach`. The shell drops all of a card's entries when the card is destroyed (`forgetCard`).

## The shell is the hub {#star}

Bodies speak to the shell and the shell speaks to bodies. A body never addresses another body, and the library drops a body-to-body action or request at its owner. A body that needs another card's facts reads a store the shell projects for it, as the deck-wide bindings and activities are. So the shell stays the one authority on what a card knows about the deck, and a body that fails cannot reach a sibling.

## Which page this is, and which page runs a command {#page}

**A module that behaves differently in a body reads the page, never a setter someone remembered to call.** `tugdeck/src/bus/page.ts` says which page this is (`page.isShell`, `page.isBody`, `page.cardId`), set once at boot before the first render. A body's keyboard yield (it holds the keyboard exactly while its card is the deck's first responder, as its deck store publishes it), its press placement, its Tab walk off either end (`focus.exit`), its session filter and its surface host each read it.

**A command's owner is a field of its row.** `ownerOf` (`tugdeck/src/bus/command-route.ts`) answers the row's `owner`, or else what its routing implies: a chain routing is the key card's, `registry` the shell's. In the shell, a key-card command while the key card is a body card goes to that card's body as the one `command` action, through the shell's key-card route, and the body runs it as its own dispatch. A `registry` row whose handler every page that holds a card registers for its own card says `owner: "key-card"`; a shell-owned row would run in the shell, where a body card has no stops, no cycle and no surface map.

**Host plumbing is not a crossing.** The shell's half of the keyboard yield (`setKeyboardYield`, installed once by `installBodyShell`) is how the shell learns from its own focus engine that a park was declined, so it can tell the host which web view takes the keyboard (`bodyFocus`). Nothing in it reaches another page, so it stays the shell's one installation rather than a store or an action.

## Snapshot on attach, and the hold {#attach}

**The library owns liveness, so no feature queues by hand.** Every page announces itself with a `hello` when its bus is bound and again after a reconnect. Every hello that is not itself an answer gets one answer. A spare body with no card yet stays silent until it is bound. A page marks a peer attached when it hears that peer's hello. The shell detaches a card when the host reports its body `terminated` or `failed`, and when the card is destroyed.

Anything addressed to a target that is not attached is held for that target, in order: a store's snapshot (only the latest per key), an action, a request. **On attach the owner sends every store the new peer is scoped to before it drains the hold**, so a body never reads a store that has not arrived. Detach drops held snapshots, because the next attach sends fresh ones, and keeps held actions. A `bus_undeliverable` from tugcast is logged against its target, as a warning when the library believed the target was attached.

## Requests and their horizons {#requests}

A request is a wait on another process, so [L33] governs it ([no-wait-without-a-horizon.md](no-wait-without-a-horizon.md)). `request.ask(payload, {card?, horizon})` names one of two horizons:

- **`{ms}`** is a deadline armed at the `ask`, not when the envelope leaves the hold, so a request held for a body that never attaches still ends.
- **`{person}`** names the surface where a person ends the wait, for example the close sheet in the card. It arms no timer.

Every request ends in a named state: `ok`, or `timeout`, `detached`, `refused` (the handler threw) or `withdrawn`. A declaration says what a detach means for a request still pending. `fail` settles it `detached`. `redeliver` sends it again when the card's body next attaches, which is how an ask survives a body reload. `withdraw(requestId)` takes a request down at the owner, and the handler's `AbortSignal` aborts on a withdrawal or when the asker's card goes away, so a dialog a request raised comes down with it.

## What a test may assume about documents {#tests}

**A card's DOM is in that card's own page.** An app-test reaches it through `App.body(cardId)`, never through the shell's document, where an expression finds nothing of the card ([tests/app-test/README.md](../tests/app-test/README.md#reaching-a-card)). A call that reads the shell's page on purpose, for example to show the shell's document did not take what a body did, carries a `// card-dom: shell` comment on its line or the line above. `just app-test-body-scope-check` holds that rule.

**A unit test of a crossing stands on `createTestBus()`** (`tugdeck/src/bus/test-bus.ts`). It runs the real library on a shell page and any number of body pages, over a fake router that serializes every frame and resolves targets the way tugcast does. Attach, detach, disconnect, the hold, snapshot-on-attach and request horizons are all exercised as exchanges between pages. A test that asserts against a `send` callback, or against a mock of the bus, tests nothing that crosses.

## Adding a store or a verb {#adding}

1. Declare it in a file under `tugdeck/src/bus/declarations/`, beside its payload type and codec. A declaration anywhere else fails `bus/__tests__/registry.test.ts`, and so does a key used twice across stores, actions and requests.
2. Register it in `tugdeck/src/bus/registry.ts`, in `SHARED_STORES`, `ROUTED_ACTIONS` or `REQUESTS`. The same test checks that every codec decodes its own `sample` and that every store's `initial` passes its codec.
3. Test it on `createTestBus()`, as an exchange between the pages that own and read it.

Nothing in `components/` learns whether it runs in a body. The primitives feed the same contexts a component already reads.
