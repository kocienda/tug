<!-- brief-skeleton v1 -->

# Keep spikes, gallery, fixtures, and the test surface out of the production chunk

**Purpose:** `tugdeck/src/main.tsx` registers spike cards, gallery cards, and fixture cards unconditionally and statically imports the 3.4k-line test surface, so roughly 40k lines of prototype, showcase, and harness code ship in every release bundle. The gate that should exclude them already exists eight lines below the registrations.

---

## Purpose {#purpose}

Item 7 of `briefs/audit-punch-list.md`:

> 7. Load spikes, gallery, fixtures, and `test-surface.ts` behind the existing DEV and test-mode gate with dynamic imports. That is about 37k lines out of the production chunk.

Nothing user-visible changes in a release build; a maker build and the app-test harness must still see every one of these cards.

---

## Evidence {#evidence}

**[F01] Registration is unconditional** — `tugdeck/src/main.tsx` calls `registerGalleryCards()`, `registerSpikeCards()`, and `registerFixtureCards()` in the card-registration block, before the `if (import.meta.env.DEV || window.__tugTestMode === true)` gate that guards the dev log, the perf monitor, and the waker census. `attachTugTestSurface` is a static import at the top of the file, gated only at call time. **(verified)**

**[F02] Size** — `src/spikes/` is 36 files, 12,945 lines including CSS; the `gallery-*` modules are 27,029 lines; `src/fixtures/` 667; `test-surface.ts` 3,379. `spike-registry.tsx` statically imports all sixteen spike modules. None of these is behind a dynamic `import()`; the bundle has 54 lazy imports and none for this set. **(verified)**

**[F03] Who legitimately needs them** — the host's Maker menu sends `show-component-gallery` (`AppDelegate.swift`); maker mode is "on in debug bundles, absent from release ones" and the deck learns it through `lib/maker-mode-bridge.ts`. The app-test harness opens gallery and spike cards as fixtures: 111 of 465 app-tests mention gallery or spike. The harness runs the built `dist/` with `window.__tugTestMode` set. **(verified)**

**[F04] A maker build does not always run under Vite** — `AppDelegate.swift` around line 531 waits for Vite and, when it is not ready, falls back to tugcast's `ServeDir` over the prebuilt `dist/`. In that case `import.meta.env.DEV` is false and `__tugTestMode` is false, yet the Maker menu still offers the gallery. A gate that reads only those two flags would make the gallery item a dead click in that fallback. **(verified by reading)**

**[F05] Registration order is load-bearing** — the comment above the registration block says the layout loader "drops panes whose only card's componentId is unregistered at load", and "registration order is the order the Layout card lists its rows in". A dynamic import that resolves after the deck deserializes its layout would drop every restored spike or gallery pane in a maker build. **(verified)**

**[F06] `manualChunks` carries a stale rule** — `vite.config.ts` splits `react` and `shiki` into named chunks; `shiki` is not in `package.json`. Not a defect, but the chunking config is the natural home for the new split and the stale rule should go with it. **(verified)**

---

## Decisions {#decisions}

**[B01] One predicate, `makerTooling`, decides whether dev-only code loads: `import.meta.env.DEV`, or `window.__tugTestMode`, or the host's `makerMode` from the settings bridge.** The third term is what [F04] requires. Outside the host the bridge resolves `null` and the predicate falls through to the first two, so browser dev is unchanged.

**[B02] The four modules load through `await import()` inside that gate, and boot awaits them before the layout is deserialized.** [F05] rules out fire-and-forget. The cost is one awaited round trip to the host for `getSettings` plus the chunk fetch, both only in maker and test builds; a release build pays the bridge call alone, which the menu-state layer already makes at boot.

**[B03] `test-surface.ts` joins the same gate rather than keeping its own.** Its attach call is already gated on `__tugTestMode`; the static import is the only reason its 3.4k lines ship. It moves to the dynamic import and keeps its attach-time check.

**[B04] The split is verified by what the release chunk contains, not by behaviour.** A unit test over the built manifest asserts that no chunk reachable from the entry contains `src/spikes/`, `gallery-`, `src/fixtures/`, or `test-surface`. Behaviour is verified by the app-tests that open gallery and spike cards ([F03]) staying green under `__tugTestMode`.

**[B05] The stale `shiki` rule in `manualChunks` is removed in the same change.** Same file, same concern, and leaving a rule that names a dependency the project does not have misleads the next reader.

---

## Open Questions {#open-questions}

- Whether any gallery module is imported by a shipped component for a type or helper rather than for a card. `grep` shows `gallery-registrations.tsx` imported only from `main.tsx` and from other gallery files; the arc confirms with the manifest test in [B04] before calling it done.

---

## Non-goals {#non-goals}

- **Deleting spikes.** They are the design-spike record and the Spikes home card is a maker feature. They leave the release bundle, not the tree.
- **Gating by build profile at compile time** (a Vite define). It would need a second build of `dist/` for maker builds, and [F04] shows a maker build serving the same `dist/` the release does.
- **Lazy-loading the gallery per card** rather than as one chunk. Possible later; the gain here is release-bundle size, and one chunk delivers it.

---

## Exit {#exit}

An arc. One step: the `makerTooling` predicate in `main.tsx`, the four dynamic imports awaited before deserialization, the manifest test, the `manualChunks` cleanup, and a run of the `@covers`-derived app-test selection for `main.tsx` plus two of the gallery-opening tests to confirm the harness still sees the cards.
