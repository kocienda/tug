<!-- brief-skeleton v1 -->

# Carve `deck-manager.ts` along its own section markers, and give the chrome layer a fast test

**Purpose:** `tugdeck/src/deck-manager.ts` is 8.8k lines and 168 methods implementing a 158-member store interface that mixes three distinct stores, card lifecycle, layout imposition, focus transfer, engine hooks, test seeding, fold, cascade, and persistence. Beside it, the chrome layer (`deck-canvas.tsx`, `settle-engine.ts`, `tug-sheet.tsx`, `card-host.tsx`) has no unit test at all: every regression there is found by app-tests that cost minutes each.

---

## Purpose {#purpose}

Item 30 of `briefs/audit-punch-list.md`:

> 30. Carve `deck-manager.ts` along its own section markers and add a fast unit layer under `deck-canvas`, `settle-engine`, `tug-sheet`, and `card-host`, which today have only minutes-long app-test coverage.

Behaviour is held fixed. The laws apply throughout: one `createRoot` ever [L01], external state enters React through `useSyncExternalStore` [L02], registrations in `useLayoutEffect` [L03], appearance through CSS and DOM [L06].

---

## Evidence {#evidence}

**[F01] The file names its own seams** — 25 `// ----` section banners, among them: per-card state cache (1055), save callbacks (1077), spaces (1166) and "Spaces store (a second useSyncExternalStore contract)" (1489), "Subscribable store state (useSyncExternalStore contract)" (1226), "CardLifecycleStore contract" (2242), card and stack management (3000 to 6212), layout imposition (6240), per-card state cache API (6817), focus-transfer channels (6984), engine hooks (7073), test-mode state seeding (7627), stack and card mutators (7749), fold (8435), cascade (8532), layout persistence (8568). **(verified)**

**[F02] Three store contracts in one class** — the deck store, the spaces store, and the card-lifecycle store each have their own subscribe and snapshot surface inside `DeckManager`, which `implements IDeckManagerStore` (`deck-manager-store.ts`, 158 members). The constructor takes a container, the connection, and optional initial layout, theme, card states, focused card, and options. The one `createRoot` call in the deck is at line 2609. **(verified)**

**[F03] Coupling** — 72 imports; 8 non-test files import `deck-manager`; 9 unit-test files already construct a `DeckManager`, so it is buildable under `bun test` with `jsdom` (a devDependency; 17 tests touch `document`; `bunfig.toml` preloads a setup file). **(verified)**

**[F04] The chrome layer has no fast layer** — unit-test importers: `deck-canvas.tsx` 0, `settle-engine.ts` 0, `tug-sheet.tsx` 0, `card-host.tsx` 0, `tug-pane.tsx` 1. App-test `@covers` counts: 22, 20, 13, 6, 21. `settle-engine.ts` (4.5k lines) exports exactly one hook, `useSettleEngine`, a `SettleEngineDeps` interface, and a test teardown; `deck-canvas.tsx` exports one component; `tug-sheet.tsx` 21 symbols of which 5 are components; `card-host.tsx` 9 of which 2 are components. **(verified)**

**[F05] What the app-tests for these files assert** — from the memory and the corpus: focus order and Tab counts (`focus-manager`, `deck-canvas`), settle timing and frame gaps (`settle-engine`, the per-gesture settle files), sheet open and dismiss and the responder chain under a sheet (`tug-sheet`), content-ready and teardown-save (`card-host`). Those are the behaviours a fast layer must be able to break. **(verified by reading `@covers` headers and the memory index)**

---

## Decisions {#decisions}

**[B01] Three stores become three classes the `DeckManager` composes: `SpacesStore`, `CardStateCache` (the per-card cache, the save callbacks, and the cache API), and `LayoutPersistence`.** Each owns its own subscribe, snapshot, and notify. `DeckManager` keeps `IDeckManagerStore` by delegating one-liners, so the 158-member interface and the 8 importers do not change in this arc. Moving consumers to the sub-stores directly is a later arc, once the sub-stores exist to move to.

**[B02] Four non-store regions become modules the manager calls: `layout-imposition.ts`, `engine-hooks.ts`, `fold.ts`, `cascade.ts`.** Each takes what it needs as arguments or a small `deps` object rather than `this`; test-mode seeding moves to `deck-manager-test-seed.ts` so the production class stops carrying it. Card and stack management (3,200 lines) stays in the manager for this arc: it is the deck's core and splitting it is a design question, not a move.

**[B03] The chrome layer gets a fast test per file, aimed at the behaviour its app-tests assert ([F05]), not at a coverage number.** For `settle-engine.ts`, the decision logic (what settles, in what order, under what budget) is lifted out of the hook into pure functions in `settle-plan.ts` and tested as data in, plan out; the hook becomes the thin React half. For `deck-canvas.tsx`, `tug-sheet.tsx`, and `card-host.tsx`, render-under-jsdom tests with the existing `DeckManager` construction from [F03]: a focus-order census, a sheet open-dismiss-restore sequence, a content-ready and teardown-save sequence. One test file each, and each must fail when the covered behaviour is broken by hand before it is trusted.

**[B04] Each extraction is verified by the unit tests that already construct a `DeckManager` plus the new chrome tests, and the app-test selection runs once at the end.** The nine existing unit-test importers are the regression net for the carve; the chrome tests are the net the carve leaves behind for the next change.

**[B05] Order: `LayoutPersistence` first (the smallest, at the end of the file), then `CardStateCache`, then `SpacesStore`, then the four modules, then the chrome tests.** The chrome tests come last because `settle-plan.ts` is the only one that changes production structure, and it is easier to lift out of a settle engine whose deps the earlier steps have already narrowed.

---

## Open Questions {#open-questions}

- Whether jsdom is enough for the `settle-engine` hook's React half, which reads `requestAnimationFrame` and frame timing. The pure `settle-plan.ts` is testable regardless; if the hook's own test needs a fake frame clock, the deck already has a `perf-monitor` that patches timers in test mode and can be the model. Decide at that step.

---

## Non-goals {#non-goals}

- **Changing `IDeckManagerStore` or its consumers.** [B01].
- **Splitting card and stack management.** [B02].
- **A shared store base for the deck's 98 hand-rolled stores.** Item 23; the three classes here are written so that base can absorb them later.
- **Testing `tug-pane.tsx`.** It has one unit importer and item 22's cycle work touches it; it is not in this arc's four.

---

## Exit {#exit}

An arc. Steps in the order of [B05]: three store extractions, four module extractions, then four chrome test files with `settle-plan.ts` lifted beside the fourth. `bun test` in `tugdeck/` is each step's verdict; the `@covers`-derived selection for `deck-manager.ts` and the four chrome files (about 50 app-tests after dedup, so budget for two batches) runs once after the last step, with the `@covers` lines in the chrome tests retargeted where files moved.
