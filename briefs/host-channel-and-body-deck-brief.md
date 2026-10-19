# A declared host channel and a body-sized deck

**Purpose:** The card-is-one-view arc is seven steps into nineteen and is adding host↔page messages and body-side deck members by hand, in the shape the bus library replaced. The remaining steps are geometry, which rides the one channel with no discipline. This brief gives the host channel the bus's discipline, gives a card page a deck interface sized to what it needs, and lands both before the arc resumes.

---

## Purpose {#purpose}

The user's question, after the arc's plan grew from ten steps to nineteen:

> Much like it happened recently, it feels like the long set of steps on this arc that are being implemented … is struggling with incomplete and/or inadequate APIs. Do we need to do another pass just on API to make this work go more smoothly?

The answer is yes, narrowly. The shell↔body bus held: every crossing the arc needed became a declared store or verb with a codec, a registry entry and a `createTestBus()` test. What is struggling is the other two surfaces a card page stands on, the host channel and the deck interface, and the arc's remaining steps lean on both.

---

## Evidence {#evidence}

**[F01] The bus held.** The arc declared `pane.chrome`, eleven `pane.*` actions, `card.railHold`, `card.geometryChanged` and a `reveal` flag on `card.activate`, each in `bus/declarations/`, registered, codec-checked and tested on the test bus. No relay, no singleton and no Rust change was needed. **(verified, by reading the arc's diff at `a7ccec4c1` and its uncommitted step 7)**

**[F02] The host channel is pre-bus.** Page→host is 37 message names in one `switch` in `tugapp/Sources/MainWindow.swift`, each parsed by hand from `[String: Any]`: 72 `as?` casts there, 25 in `BodyViewController.swift`, 12 in `BodyGeometry.swift`. Host→page is five `__tugBridge` callbacks. Nothing types a message on either side, no fixture checks that the two sides agree, and a missing field defaults silently (`entry["visible"] as? Bool ?? false`). The TypeScript side posts 15 names through `postToHost` with no declaration of their payloads. **(verified, by census)**

**[F03] The arc is growing that channel by hand, and the rest of it is geometry.** Steps 2 to 6 added `placeCards`, `cardGesture`, `cardLand` and `onCardGesture` with hand parsing and a hand-written tracker. Steps 10 and 13 to 16 add `cardPlan`, `landed`, `beatsCancelled` and the layer swap, all host messages. **(verified, from the plan's Spec S03 and S04 and the ledger)**

**[F04] The body pretends to be the deck.** `BodyDeckBridge` implements `IDeckManagerStore`, a 105-member interface, with forty members marked inert. Each new thing a card page needs is a new interface member and a new verb: step 7 added `observeCardDidMove`, `observeCardDidResize`, `noteGeometryChanged` and the `card.geometryChanged` action because a card's delegates reclaim focus on move and resize events the page never heard. **(verified, uncommitted in the arc worktree)**

**[F05] Deck-wide card facts cross by several routes.** `body/card-facts-mirror.ts` feeds four maps of siblings' bindings, titles, identities and activities into the page's own stores from `deck.cardBindings`, `deck.cardActivities` and `arrangement.cardFacts`, while `pane.chrome.tabs[]` carries the same titles composed by the shell. **(verified)**

**[F06] Close-confirm is decided in three places.** `pane-chrome-projection.ts` computes `confirmClose` into the store; `body-root.tsx` recomputes it from registrations for `CLOSE` and `CLOSE_ALL`; the shell's `paneClosePane` handler runs `closeGuardWalk`. Two of those can disagree for one gesture. **(verified)**

**[F07] A new register-and-remember singleton appeared.** `lib/rail-edge-registry.ts` is a map from pane id to a driver the stand-in registers so the host-gesture path can find it. It never crosses pages, so the legacy guard admits it, but it is the shape the bus retired. **(verified)**

**[F08] The split was corpus tax, not API.** The ten-to-nineteen split was per-kind migration of about a hundred app-tests from shell selectors to `App.body`. No API would have removed that. **(verified, from the split's own report)**

---

## Decisions {#decisions}

**[B01] The host channel becomes a declared vocabulary with the bus's discipline.** Every host↔page message is declared once: its name, direction, a TypeScript codec from `bus/codec.ts`, and a Swift `Codable` type. One registry on the TypeScript side (`tugdeck/src/host/`) and one dispatcher on the Swift side decode by name; a message that fails to decode is logged and refused, never defaulted field by field. A parity fixture of sample payloads is decoded by both sides in `bun test` and `just test-swift`, as `bus-parity.json` does for the envelope. `postToHost` and `__tugBridge` become the two ends of this one vocabulary. This is what made the bus cheap to extend, applied to the channel the arc's remaining steps live on.

**[B02] The geometry family converts first.** `placeCards`, `cardGesture` and `onCardGesture`, `cardLand`, `beatPlan` becoming `cardPlan`, `landed`, `beatsCancelled`, `crossingReady`, `pointerClaim`, `bodyCreate`, `bodyDestroy`, `bodyFocus`, `bodyHello`, `onBodyState`, `painted` and `floorGrid`. These are every message the card-is-one-view arc reads or writes. The remaining names (clipboard, dictation, paths, settings, menu state, update) go through the same dispatcher but may keep their payload types loose until each is touched; the dispatcher refuses a name it does not know.

**[B03] `BodyDeckBridge` is retired and deleted; a card page never implements the deck.** The user's call, in their words: an inert interface carried along is insane and must be fixed by complete retirement and deletion. So `IDeckManagerStore` splits: a `CardDeck` naming what a card's components may read and call (lifecycle observation, the card's own state bag, activate, focus, close, add sibling, reservations, the card's own pane facts), and the arrangement surface that only the shell holds. Components under `components/` take `CardDeck`. The shell's store implements both. In a body page the `CardDeck` is a small real object built from the page's replicas and verbs, not a bridge standing in as the deck, and `body-deck-bridge.ts` is deleted with its forty inert members and its "Real, local" and "Inert" halves. No type anywhere implements a member by ignoring it; a test over the body's `CardDeck` refuses a member that returns without acting.

**[B04] Deck-wide card facts cross once.** One shell-owned projection, `deck.cards`, carries per card what any page may need of its siblings: component, title, identity, activity, session binding. It replaces the mirror's four maps, and `pane.chrome.tabs[]` names card ids and reads their titles from it. Whether `deck.cardBindings`, `deck.cardActivities` and `arrangement.cardFacts` fold into it is the arc's reading of their consumers, with the rule that no fact crosses twice.

**[B05] The move and resize events a page hears are the deck's, not a verb's.** `card.geometryChanged` and the bridge's `noteGeometryChanged` were step 7's answer to delegates that never heard their events. Under [B03] the `CardDeck` fires them from the card's own placement, which the page already learns, and the verb goes. The arc re-reads step 7's addition against that and keeps the one that survives.

**[B06] Close-confirm has one rule.** The projection's rule is the rule. `pane.chrome` carries what the chrome needs to ask (`confirmClose`, the message, the label), `body-root.tsx` reads it and computes nothing from registrations, and the shell's guard walk consults the same function. A test shows the body and the shell answer one close the same way.

**[B07] The rail edge drag has no registry.** The rail width draft is reached from the host-gesture path by pane id through the deck, as a function over the deck and the draft owner, not through a map the stand-in remembers to register in. The mechanism is the arc's; the shape ruled out is register-and-remember.

**[B08] The host-channel rule becomes law.** `shell-and-bodies.md#channels` gains: a host↔page message is declared in the vocabulary or it does not exist, and a guard test refuses an `as? [String: Any]` on a message body anywhere but the dispatcher, as `no-legacy-bus.test.ts` refuses the old kinds. Whether this is a clause on [L37] or its own law is the arc's call when it writes it.

**[B09] This lands on `main`, between the two halves of card-is-one-view.** Card-is-one-view's steps 1 to 7 are a verified half (three groups of kinds carry their chrome, host gestures are live) and join to `main` first; this arc forks from that `main`. The remaining twelve steps of that plan are not resumed: they are restated in a successor brief, `briefs/shell-beneath-the-cards-brief.md`, on the vocabulary, `CardDeck` and `deck.cards` this arc lands, and that arc runs after this one joins. Nesting this arc onto the old branch was considered and rejected: it would leave a planned arc stopped mid-implement with a stale nineteen-step ledger and a stale review.

---

## Open Questions {#open-questions}

- **How the Swift side decodes.** `Codable` over `JSONDecoder` is the obvious shape; the bridge today hands `message.body` as a dictionary. Whether the dispatcher re-serializes to JSON or decodes the dictionary directly is a reading of cost on the placement path, which fires per commit.
- **Whether `__tugBridge` collapses to one entry.** Five callbacks could become one `hostMessage(name, payload)` dispatched through the same registry. It is simpler and symmetric; it also changes every evaluateJavaScript site. The arc decides after counting them.
- **The reach of [B04].** Folding the three existing deck-wide stores into `deck.cards` is a consolidation whose consumers the arc has to read; the brief rules only that no fact crosses twice.

---

## Non-goals {#non-goals}

- **Moving geometry onto the bus.** Geometry belongs to the host↔page channel (`shell-and-bodies.md#channels`); the fix is discipline on that channel, not a third kind.
- **Changing the bus primitives.** Three primitives, one envelope, tugcast reading nothing.
- **Converting every non-geometry host message now.** They pass through the dispatcher; their payload types tighten as each is touched.
- **Retiring the stand-in or finishing card-is-one-view.** That arc resumes after this joins.
- **A pass on the bus itself.** It held; nothing in [F01] asks for one.

---

## Exit {#exit}

An arc from `main`, once card-is-one-view's first seven steps have joined. The order the pieces must land in:

1. **The vocabulary and its two dispatchers**, with the parity fixture and the guard test, carrying the existing messages unchanged in meaning: a behaviour-neutral step verified by the existing body and placement tests.
2. **The geometry family typed**, both sides, with `BodyViewController.swift`'s hand parsing replaced by decoded types.
3. **`CardDeck`**, the components re-pointed, `body-deck-bridge.ts` deleted, the body's own `CardDeck` built from replicas and verbs, the no-inert-member test; step 7's `card.geometryChanged` re-read under it.
4. **`deck.cards`** and the mirror's retirement; `pane.chrome` tabs by id.
5. **The close rule and the rail edge**, with their tests.
6. **The law and the doc**, then the join. The successor arc (`briefs/shell-beneath-the-cards-brief.md`) opens on the result.

The verdict at each stage is the unit suite, `just test-swift`, lint, and the app-tests derived from the files touched. No core tier: nothing here runs before a test's first assertion.
