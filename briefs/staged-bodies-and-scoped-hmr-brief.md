<!-- brief-skeleton v1 -->

# Staged body loads and page-scoped HMR

**Purpose:** A debug launch shows an empty deck for seven seconds after the window reveals, and any HMR update that Vite cannot apply incrementally clears the whole deck and replays that launch. The deck must populate progressively from the first second, and an edit must reload only the pages that import what changed, with the cards left on screen.

---

## Purpose {#purpose}

The user's report, 2026-10-21: "Long launch times and deck-clearing in the debug app has basically broken HMR. This is bad. This super-looooonngggg delay to populate the deck must go away. Can't have this. Make a sketch for how we can get back *lively* debug-app launches and snappy HMR."

The sketch found two mechanisms. One is the cost of a single card page under Vite, which is the sibling brief's subject (`briefs/vite-full-bundle-mode-brief.md`). The other two are this brief's: the host loads every card's page at once the moment the shell reveals, and Vite's full reload is a broadcast that the host answers by destroying every body. These two are fixable without touching how Vite serves a page, and together they end the deck-clearing on their own.

---

## Evidence {#evidence}

**[F01] The shell is up in 1–3 s; the cards are dark for 7 s after it.** The latest warm launch (`debug-main`, `tugapp.log.2026-10-22`, 01:40): tugcast ready at 1.0 s, shell HTML loaded at 1.4 s, `frontend-ready` and reveal at 4.9 s, all ten body pages `page loaded` by 5.4 s, first body `ready` at 12.4 s, last body `painted` at 12.8 s. Every launch recorded on 2026-10-21 has the same shape: bodies start within 0.3 s of the reveal, then a gap of 7 s with ten cards and 4–5 s with six. **(verified)**

**[F02] The gap scales with the number of pages because each page fetches the whole module graph from one Vite.** The shell's `frontend-ready` lap reports 1,683–1,688 resources and 60–64 MB per page. `tugdeck/src` holds 1,345 TS/TSX and 310 CSS files outside tests; `body/body-main.ts` imports `css-imports` and the card registry, so a body page carries the deck's graph. Ten bodies and a spare are ~18,000 module requests fired at once at a single-threaded Vite. The per-page count is measured; the linearity is inferred from the 6-card versus 10-card gaps and would be confirmed by the lap in [B06]. **(partly verified)**

**[F03] The host's own `ready` line hides the gap.** `BodyViewController.swift` clocks `ready ms=` from `boundAt`, set in `bind`, which runs after the page has loaded and said hello; the recorded values are 43–305 ms while the wall time from `make` to `ready` is 7 s. Nothing on record measures make-to-ready or the moment the last restored card paints. **(verified)**

**[F04] Every restored card's body is made at once, and the spare competes with them.** `create(cardId:…)` in `BodyViewController.swift` makes a body immediately for every `bodyCreate` the shell's restore pass posts; there is no queue and no cap. The spare is scheduled a second after the shell's launch and after each bound body's ready, so it is loading during the worst second and is remade several times per launch (two to three `page loaded card=spare` lines per launch on 2026-10-21). Hidden tab siblings and parked-workspace cards are asked for like any other card (`lib/body-handoff.ts`: "a visited workspace's card keeps its body while parked, and is asked for again there"), and then go dormant under `body/body-dormancy.ts`. **(verified)**

**[F05] Vite's full reload is a broadcast, and the host answers it by destroying every body.** The reloads recorded on 2026-10-21 came from non-component modules whose propagation reached an entry with no accept boundary: `src/lib/session-control-actions.ts`, `src/action-dispatch.ts`, `src/lib/layout-imposer.ts`, `src/lib/card-placement.ts`, `src/host/declarations/geometry.ts`, `src/spikes/spike-home.tsx` (Fast Refresh refused its `spikeComponentId` export). Vite sends `full-reload` to every connected client of the environment, so all twelve pages (shell, overlay, ten bodies, spare) reload. The shell's reload is intercepted in `MainWindow.swift` (`decidePolicyFor`, `navigationType == .reload`, `webView === self.webView`), which freezes a snapshot, calls `bodies.saveAndDestroyAll`, saves the shell and reloads it; the reloaded shell's restore pass then makes every body again. Body reloads are not intercepted, so each body also reloads itself on Vite's word before being destroyed. One edit to a shell-only module is a full relaunch, [F01] included. **(verified)**

**[F06] The bus already expects bodies to outlive a shell reload.** `main.tsx` installs the body shell and then calls `pageBus().announce()` with the comment "a body that outlived a shell reload hears it and answers, and is sent every store it reads." `BodyViewController.create` ignores a `bodyCreate` for a card that already has a body unless it failed. So the pieces for a shell reload that keeps its bodies exist; what destroys them is the one call in the reload intercept. **(verified)**

**[F07] Vite 7.3.1 exposes the hook a per-page reload needs.** The installed Vite declares the `hotUpdate` plugin hook (`node_modules/vite/dist/node/index.d.ts`), which receives the changed module and its environment, can walk `importers` to the entries that reach it, can send a custom event over `environment.hot.send`, and suppresses Vite's own handling by returning an empty array. Client pages already subscribe to custom events through `import.meta.hot.on` (`hmr-bridge.ts` handles `tug:theme-changed`). **(verified)**

**[F08] CSS and component edits are already incremental.** `css-imports.ts` self-accepts, so a stylesheet edit is a CSS hot update on every page; the SWC plugin's Fast Refresh handles component modules. The breakage is confined to full reloads. **(verified)**

---

## Decisions {#decisions}

**[B01] Bodies load through a lane of two or three at a time, visible cards first.** The host keeps a queue of pending `bodyCreate`s and holds at most two or three pages in flight; a body leaves the lane at `ready` or at its deadline. Order is the order the user sees: the active card of each pane in reading order, then the rest. The first card is live about a second after the reveal instead of seven ([F01]), and the deck fills progressively rather than all at once at the end. The lane's width is a constant to read, not a setting; two or three is a starting value and the lap in [B06] decides it. This rules out "load everything at once" even once a page is cheap: a cheap page still costs a WebContent process and its first paint, and the order is what the user feels.

**[B02] A card that will not be shown gets no page at launch.** Hidden tab siblings and cards in parked workspaces are not asked for by the restore pass; they are asked for when they are first shown, by the same funnel that asks for a card brought back from eviction. They go dormant within seconds of being made today ([F04]), so a page made for them at launch is a page made to sleep. The card's stand-in and its cover (the last frame, where one exists) are what the user sees until then, as they are after an eviction. This is revisited only if a shown-on-demand card's first paint is slow enough to be felt; the eviction reading (`at0749`) is the number to compare against.

**[B03] The spare is made after the restore pass has drained, not during it.** The spare's purpose is a warm page for a *new* card; during the restore it competes with cards the user is waiting for ([F04]). `scheduleSpare` waits for the lane to be empty.

**[B04] A full reload is scoped to the pages that import the changed module.** A Vite plugin in `vite.config.ts` implements `hotUpdate`: when propagation would reach an entry, it walks the module graph from the changed file to the entries that import it (`src/main.tsx`, `src/body/body-main.ts`, `src/overlay/overlay-main.ts`, `src/body/spike-page.ts`), sends a `tug:reload` event naming them, and returns an empty array so Vite sends no `full-reload`. Each page's client (`hmr-bridge.ts` for the shell; a sibling installed by `body-main.ts` and `overlay-main.ts`) reloads itself only when its own entry is named, through the same `captureAllForTeardown` path the shell runs today. A layout edit reloads the shell alone; a transcript edit reloads the bodies alone. The plugin lives in dev only, as every `import.meta.hot` path does ([F08]). What would revisit this: Vite gaining per-client module graphs, which it does not have in 7.3.

**[B05] A shell reload keeps its bodies.** The reload intercept in `MainWindow.swift` stops calling `saveAndDestroyAll`. The shell saves its own state and reloads; the bodies stay bound to their cards and their views, the reloaded shell's `announce()` re-adopts them ([F06]), and the shell's restore pass's `bodyCreate` for an existing body is ignored as it is today. The snapshot freeze is kept for the shell's own canvas. A shell-only edit then costs the shell's own load (1–3 s, [F01]) with every card still on screen. `destroyAll` on bridge teardown is untouched; it is for the window going away, not for a reload. What has to be confirmed in the work: that a kept body's `card.facts`, focus and geometry are re-sent by the reloaded shell and not only by a fresh bind, and that a body which was mid-save when the shell reloaded does not lose its bag.

**[B06] The launch records when the deck is populated, and each body's whole load.** The shell posts a `deck-populated` lap when the last body of the restore pass reports `painted`, logged beside `reveal` on the launch clock. `BodyViewController` logs a body's time from `make` to `ready` beside the existing bind-to-ready figure ([F03]). The arc's verdict reads from these: a populated ten-card deck within 3 s of the reveal on a warm Vite, and a shell-only edit under 2 s with no body reloaded. These are the numbers the sibling brief's spike is then measured against too.

**[B07] Registries get accept handlers; pure modules are left to reload.** `action-dispatch.ts` and like registries accept their own update by re-registering, which removes the commonest offender in [F05]. Pure modules (`card-placement.ts`, `geometry.ts`) are left to the scoped reload: once a reload is per-page and keeps the cards, it is cheap enough not to chase. A self-accept on a module whose exports are held by importers would leave those importers stale, so it is not the general remedy.

---

## Open Questions {#open-questions}

- Whether a Session card's body that is kept across a shell reload needs anything re-sent that `announce()` does not already carry. The code says the stores are re-sent ([F06]); whether `bodyFocus`, `placeCards` and the shown/hidden word are, is to be read in `lib/body-shell*.ts` and `BodyViewController` during the work, and it may add a message rather than change the decision.

---

## Non-goals {#non-goals}

- **Making a page cheaper to load.** That is `briefs/vite-full-bundle-mode-brief.md`. This brief assumes a page costs what it costs today, and its numbers in [B06] hold even so.
- **Shrinking the body module graph or loading card kinds by dynamic import.** Ruled out by the user on 2026-10-21: no hacking on page content unless the full bundle mode spike fails.
- **Making Vite's `/src/*` responses cacheable across WebContent processes.** Vite stamps import versions only after invalidation, so a cache-friendly header cannot be made safe without forking the import rewriter. Rejected in the sketch.
- **Changing what the shipped build does.** Every change here is under `import.meta.hot`, in the dev-serving branch of the host, or in the body loading order, which the Release app also benefits from but which carries no dev-only switch.
- **Self-accepting pure modules.** See [B07].

---

## Exit {#exit}

An arc. The order the sketch settled: the lap first ([B06]), so every later step reads its own number; then the lane, the deferred spare and the no-page-for-hidden rule ([B01]–[B03]) in the host; then the per-page reload plugin and the body and overlay clients ([B04]); then the shell reload that keeps its bodies ([B05]), which is the step with the open question and so goes last; and the registry accept handlers ([B07]) wherever they fall. The verdict is a launch of the user's ten-card deck against the numbers in [B06], read from the laps, and one edit to `layout-imposer.ts` with the deck watched.
