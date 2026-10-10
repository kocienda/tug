<!-- brief-skeleton v1 -->

# Break tugdeck's two import cycles and forbid `lib` from importing `components`

**Purpose:** Two strongly connected import components in `tugdeck/src` tie the session reducer and the block renderers to the whole component tree through single stray edges, and 42 files under `lib/` import from `components/`. Nothing checks for cycles, so the next stray edge lands silently.

---

## Purpose {#purpose}

Item 22 of `briefs/audit-punch-list.md`:

> 22. Break the two import cycles in tugdeck by moving two constants out of component files and splitting the pure formatters out of `session-card-telemetry-renderers.tsx`. Then a lint rule forbidding `lib` to import from `components`.

Behaviour is held fixed. No component changes what it renders; no store changes what it holds. What changes is which file a symbol lives in, and that a gate exists afterwards.

---

## Evidence {#evidence}

**[F01] The first cycle enters the component tree through a lib file, not the reducer** — the punch list said the reducer imports from a component. It does not: `tugdeck/src/lib/code-session-store/reducer.ts:170` imports `TUG_ATOM_CHAR` from `../tug-atom-img`, which is `lib/tug-atom-img.ts`. The lib-to-component edge is `lib/tug-atom-img.ts:42`, importing `progressRoleFillToken` from `@/components/tugways/tug-progress-indicator` (defined at `tug-progress-indicator.tsx:258`, used once at `tug-atom-img.ts:614`). From there: `tug-progress-indicator.tsx:105` imports `TugLabel`; `tug-label.tsx:17` imports `useCopyableText`; `use-copyable-text.tsx:37` imports `useResponderChain`; `responder-chain-provider.tsx:43` imports `registerResponderChainManager` from `action-dispatch.ts`, which imports about 40 lib stores and the command registry at lines 34 to 146. `lib/tug-atom-char.ts` is already a leaf module whose header says `slash-commands.ts` imports it directly to dodge this cycle. **(verified)**

**[F02] The second cycle runs through the telemetry renderers** — `components/tugways/blocks/block-header.tsx:61-64` imports `useLiveTick` and `formatTimeMinutesSeconds` from `cards/session-card-telemetry-renderers.tsx` (2,120 lines), which imports `TugPaneFrameContext` from `chrome/tug-pane` at :50 and `paneCanvasOf` from `chrome/space-layer` at :51. The renderers file holds, under a heading that already says "Pure-logic formatters (exported for tests)", `formatTokens` :165, `formatTokensCaps` :182, `formatTokenCap` :202, `formatDurationMs` :213, `formatTimeAlwaysHours` :238, `formatTimeMinutesSeconds` :257, `formatUsd` :268, and `foldArrivalTitle` :637; `useLiveTick` :330 is a hook over a module-level listener set at :287 with no JSX; two focus-group constants at :765-766 are pure; and eight components and eight types make up the rest. **(verified)**

**[F03] 42 non-test lib files import from components** — 68 import lines, 16 of them `import type`. The value imports fall into three kinds: constants (`TUG_ACTIONS` in six files, `SHOWN_PANE_FRAMES` in three, `RETAINED_LINE_CAP`), pure functions (`formatByteSize`, `parseGitCommit`, `classifyApiRetry`, `deriveRestoreGateHold`, `withClipboardOrigins`, `isCancelChordEvent`, `turnEntryToMarkdown`, `replayDisabledReason`), and genuine component-layer dependencies, of which `lib/transcript-search-index.ts` is the outlier with 12 lines importing block renderers' search-part functions, and `lib/host-menu-state.ts` has 8 lines from the command registry and keymap. **(verified; the full list is in the arc's first step, not here)**

**[F04] No cycle detector exists and the linter can host one** — no madge, dpdm, or dependency-cruiser in `tugdeck/package.json`, and none on PATH. oxlint 1.87.0 ships `import/no-cycle` (options `ignoreTypes`, `maxDepth`, in `node_modules/oxlint/configuration_schema.json:2850`) behind the `import` plugin, which `.oxlintrc.json` does not enable (plugins are `typescript`, `unicorn`, `oxc`, `react`); and `no-restricted-imports` with `patterns` and `group`. `import/no-restricted-paths` is not in the schema. `just lint` runs `bun run check` and `bun run lint` with `--deny-warnings`. **(verified)**

---

## Decisions {#decisions}

**[B01] `progressRoleFillToken` moves to `lib/progress-role-token.ts`, and the component re-exports it.** It is one pure function and the only edge from `lib/tug-atom-img.ts` into the component tree ([F01]). The re-export keeps every component importer untouched; `tug-atom-img.ts` is the one importer that changes. The chain in [F01] beyond that edge is a component-to-component chain and is not a cycle once the lib edge is gone.

**[B02] The pure formatters, `useLiveTick` with its listener set, and the two focus-group constants move out of `session-card-telemetry-renderers.tsx` into `lib/session-telemetry-format.ts` and `lib/live-tick.ts`; the renderers file re-exports them.** [F02]: the file already labels them pure and exports them for tests, and `block-header.tsx` wants only those. The renderers file keeps the eight components and their types and its chrome imports, which are correct for a component. `useLiveTick` goes with the formatters rather than staying because its listener set is a store, and stores live in `lib` ([L02]).

**[B03] The `import` plugin is enabled with `import/no-cycle` at error, `ignoreTypes: true`.** Type-only cycles are erased by `tsc` and cost nothing at runtime, so they are not what this gate is for. The rule is the arc's gauge: zero reports after [B01] and [B02], and any cycle the rule reports that neither step predicted is fixed in this arc, since a brief that leaves the gate red has not broken the cycles.

**[B04] `no-restricted-imports` forbids `@/components/*` and `../components/*` under `src/lib/`, at error, with a per-file override list for the residue.** The 42 files in [F03] are worked down first: constants and pure functions move to `lib` (the `TUG_ACTIONS` table, `SHOWN_PANE_FRAMES`, `RETAINED_LINE_CAP`, and the eight pure functions named there), and type-only imports move the type to `lib` or sit under `allowTypeImports`. What remains is listed by file in the override, each with a one-line reason. The override is a list that only shrinks; adding a file to it is a review question, not an edit.

**[B05] Order: [B01], then [B02], then [B03] with the plugin, then the lib moves and [B04].** The two cycles are mechanical and small; the gate goes in while the tree is clean; the lib sweep is the largest step and lands last against a rule that is already on.

---

## Open Questions {#open-questions}

- Whether `lib/transcript-search-index.ts` belongs in `lib` at all. Its 12 component imports are the block renderers' search-part functions, which means it indexes what the renderers show, not what the store holds. The default is to leave it in the [B04] override with that reason, and let a later arc decide whether the renderers should publish a search-parts table the index can read from `lib`.

---

## Non-goals {#non-goals}

- **Installing a standalone cycle tool.** oxlint already has the rule ([F04]); a second tool is a second config.
- **Restructuring `action-dispatch.ts`.** Its 40 imports are the hub by design; the cycles are the stray edges into it, not the hub.
- **Changing any component's render or any store's contents.**

---

## Exit {#exit}

An arc. Steps as ordered in [B05]: the token move, the formatter and tick split, the plugin and `no-cycle` rule, then the lib sweep with `no-restricted-imports` and its override list. `bun run check` and `bun run lint` in `tugdeck/` are each step's verdict; `bun test` runs at the formatter split because the formatter tests move with the functions. The `@covers`-derived app-test selection for the files touched runs once after the last step.
