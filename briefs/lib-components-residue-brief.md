<!-- brief-skeleton v1 -->

# Shrink the lib-to-components lint residue by moving each dependency to the layer it belongs in

**Purpose:** The import-cycles arc left a 17-file override list for `lib` files that import from `components`, each with a reason. The reasons are honest and the list will not shrink on its own. Read one by one, every entry is either a store or pure module living in `components` that belongs in `lib`, or a `lib` file doing component-layer work that belongs in `components`.

---

## Purpose {#purpose}

From the audit of 2026-10-11:

> The lib-to-components override list has 17 entries, each with a reason, which is the right shape but will only shrink if someone makes it.

No module changes what it exports or does. What changes is its directory, and the override list goes to zero.

---

## Evidence {#evidence}

**[F01] The list and what each file imports** — `tugdeck/.oxlintrc.json`, the `no-restricted-imports` override: `arc-session-index.ts` and `document-arc-entry.ts` import the model builder from `tug-arc-track.tsx`; `code-session-store.ts` imports `PropertyStore` from `property-store.ts`; `flash-pane-border.ts` imports `paneCanvasOf` from `chrome/space-layer.ts`; `folded-body.ts` and `gesture-scope.ts` import `isTugMotionEnabled` from `scale-timing.ts`; `imposer-motion.ts` imports `SpringSolver` from `physics.ts`; `session-activity-store.ts` imports curve geometry from `tug-sparkline.tsx`; `layout-selection.ts` and `host-menu-state.ts` import `cards-selection-store.ts`; `help-content.ts`, `shell-interactive-staging.ts`, `markdown/enhance-img.ts`, and `host-menu-state.ts` import `keymap-registry.ts`, `command-registry.ts`, and `chord-capture-state.ts`; `session-transcript-data-source.ts` imports two receipt parsers from the receipt block components; `transcript-search-index.ts` imports four renderers' search-part functions; `prompt-insert-target.ts` imports `dictationHandleFor` from the editor's dictation span; `use-unavailable-model-bulletin.ts` imports `presentAlertSheet`. **(verified)**

**[F02] Six of the imported modules are lib-shaped already** — they import nothing from `components` and render nothing: `property-store.ts` (387 lines), `physics.ts` (292), `scale-timing.ts` (98), `chord-capture-state.ts` (52), `chrome/space-layer.ts` (254). `cards-selection-store.ts` (357) has one component import. `tug-arc-track.tsx` (688) and `tug-sparkline.tsx` (516) are components whose model builders (`arcTrackModel`, `arcTrackSteps`, `arcReading` at `tug-arc-track.tsx:215-461`) and curve geometry are pure functions at the top of the file. **(verified)**

**[F03] The registries are not lib-shaped** — `command-registry.ts` (3,422 lines) and `keymap-registry.ts` (599) import from `components` and reference React; moving them down would carry the component layer with them. **(verified)**

**[F04] The two receipt blocks and the four renderers are components** — `session-join-receipt-block.tsx` has 15 component imports and 20 JSX uses; `session-arc-receipt-block.tsx` 11 and 15. Their parsers (`parseJoinReceipt` and the arc receipt parser) are pure functions inside component files. **(verified)**

---

## Decisions {#decisions}

**[B01] Move down: `property-store.ts`, `physics.ts`, `scale-timing.ts`, `chord-capture-state.ts`, `space-layer.ts`'s `paneCanvasOf`, and `cards-selection-store.ts` go to `lib/`, with a re-export left at the old path for one arc.** [F02]: they are stores and pure modules, and `lib` is where the laws put stores ([L02]). This clears `code-session-store.ts`, `imposer-motion.ts`, `folded-body.ts`, `gesture-scope.ts`, `flash-pane-border.ts`, `layout-selection.ts`, and the `chord-capture-state` and `cards-selection-store` lines of `host-menu-state.ts`: eight entries.

**[B02] Split out: the arc-track model builders, the sparkline curve geometry, and the two receipt parsers move to `lib/` as their own modules, and the components import them from there.** [F02], [F04]: pure functions at the top of a component file are the component's model, and a model is lib. This clears `arc-session-index.ts`, `document-arc-entry.ts`, `session-activity-store.ts`, and `session-transcript-data-source.ts`: four entries.

**[B03] Move up: `transcript-search-index.ts`, `prompt-insert-target.ts`, `use-unavailable-model-bulletin.ts`, `help-content.ts`, and `shell-interactive-staging.ts` go to `components/`, and `markdown/enhance-img.ts`'s chord check takes the predicate as a parameter from its component caller.** The search index indexes what renderers show; the insert target reaches into the editor; the bulletin is a hook that presents a sheet; help content and the staging prompt render shortcuts from the registry, which is component-layer by [F03]. These are not lib files with a stray import; they are component files in the wrong directory. Six entries.

**[B04] `host-menu-state.ts` is the one file that stays, and the override list becomes one entry.** It mirrors the command registry, the keymap, and the selection into the host's menus, which is component-layer work by [F03], but it is also the store the Swift side reads through a `useSyncExternalStore` contract and it has eight registry imports. Moving it up is right and is its own small arc once [B01] has moved the selection store; this arc leaves it with its reason. One entry with a reason is a list that can be read; seventeen is a list that is skimmed.

**[B05] Order: [B01], then [B02], then [B03], then the re-exports from [B01] are deleted.** Moves first because they clear the most entries and change no code; splits second because they touch component files; the ups last because they change what the directory means for five files; the re-exports go when nothing imports the old path, which `import/no-cycle` and `bun run check` confirm.

---

## Open Questions {#open-questions}

- None. Whether each file moves down, splits, or moves up was decided by reading its imports ([F02] through [F04]).

---

## Non-goals {#non-goals}

- **Moving `command-registry.ts` or `keymap-registry.ts`.** [F03].
- **Moving `host-menu-state.ts`.** [B04].
- **Changing any export, signature, or behaviour.**

---

## Exit {#exit}

An arc. Steps as ordered in [B05]; `bun run check`, `bun run lint`, and `bun test` in `tugdeck/` are each step's verdict, with the override count in `.oxlintrc.json` written in each step's log. The `@covers`-derived app-test selection for the moved files runs once after the last step; the `@covers` lines pointing at old paths are retargeted in the step that moves each file, and `just app-test-covers-check` is part of each step's verdict for that reason.
