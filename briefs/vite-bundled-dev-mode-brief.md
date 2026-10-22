<!-- brief-skeleton v1 -->

# Vite bundled dev mode for the debug app

**Purpose:** A card page under the debug app costs ~1,680 module requests through one Vite, and a ten-card deck pays that eleven times at once. The cost of a single page has to fall by an order of magnitude without changing what the page contains. Vite 8.1's bundled dev mode claims exactly that, and this brief is the spike that finds out whether it holds for Tug's config.

---

## Purpose {#purpose}

The user's report, 2026-10-21: "Long launch times and deck-clearing in the debug app has basically broken HMR … This super-looooonngggg delay to populate the deck must go away." The sketch found that the per-page cost is the root of the launch delay, and the user narrowed the remedy on the same day: "For A, I really only want your first idea: Vite 8's full bundle mode. I don't want to start hacking on page content unless that idea fails."

So this brief is one idea, tried properly. The sibling brief (`briefs/staged-bodies-and-scoped-hmr-brief.md`) takes the launch order and the HMR fan-out, and does not depend on this one landing.

---

## Evidence {#evidence}

**[F01] A page is ~1,680 requests and ~60 MB, and every page pays it.** The shell's `frontend-ready` lap on every launch recorded on 2026-10-21 and 2026-10-22 reports 1,683–1,688 resources and 60–64 MB. `tugdeck/src` holds 1,345 TS/TSX and 310 CSS files outside tests, and `body/body-main.ts` imports `css-imports` and the card registry, so a body page carries the deck's graph. With ten cards and the spare, that is ~18,000 requests at one single-threaded Vite, and the bodies are dark for 7 s after the shell reveals (the sibling brief's [F01]). **(verified)**

**[F02] The feature exists, under a different name than the sketch used.** Vite 8.1 (released 2026-06-23) ships "bundled dev mode", formerly "full bundle mode", as an experiment: `experimental.bundledDev: true` in the config, or `--experimental-bundle` on the command line. It bundles lazily, "only what's needed to render the page the browser actually requests", and keeps HMR on ESM output with per-chunk patches. The Vite team's own figures on a 10,000-component app: ~15× faster startup and ~10× faster full reloads. The latest published Vite is 8.3.5; tugdeck is on 7.3.1. Read from the Vite 8.1 announcement and the bundled-dev design discussion (vitejs/vite discussion 22746); not yet measured here. **(verified as published, unmeasured here)**

**[F03] Bundled dev mode does not support the HMR hook Tug's config uses.** The design discussion lists `hotUpdate` and `handleHotUpdate` as unsupported ("Transforming a single module is not possible"; support is a phase-2 investigation), `ViteDevServer.waitForRequestsIdle` as not working, the dependency optimizer as not running, and `import.meta.glob` as unsupported. A change that needs a full reload is announced to the client as a `vite:bundled-dev:reload-needed` event rather than Vite's own `full-reload`. `vite.config.ts` uses `handleHotUpdate` twice (`controlTokenHotReload`, `capabilitiesVirtualModulePlugin`), `server.moduleGraph` and `server.reloadModule` to repaint the active theme, and `server.watcher.add` for files outside the root. Nothing in `tugdeck/src` uses `import.meta.glob` (`spike-registry.tsx` deliberately lists instead). **(verified: the Vite side from the design doc, the Tug side from the code)**

**[F04] The rest of Tug's config is in the partially-supported or unaddressed set.** Virtual modules (`virtual:tug-active-theme.css`, the capabilities module) are supported if `resolveId`/`load` respect `options.isEntry`; `transform` plugins must declare watched files with `this.addWatchFile`; CSS HMR "reuses Vite's existing CSS HMR approach" with a proper CSS HMR as a phase-3 target; web workers, `?url`, `?raw` and `transformIndexHtml` are listed as not yet addressed. Tug has five `new Worker(new URL(…, import.meta.url))` sites (ingest, sparkline, image downsample, pdf.js, the test surface), two `?url` wasm imports (shell and body entries), two `?raw` theme imports (`gallery-theme-editor.tsx`), a PostCSS plugin (`postcss-tug-color`), and the CSP inline-script-hash plugin on `transformIndexHtml`. **(verified from the code; the support status from the design doc)**

**[F05] Vite 8 itself is a migration separate from the mode.** The Vite 8 migration guide: Oxc replaces esbuild for transforms, `esbuild.keepNames` becomes `rolldownOptions.output.keepNames`, `build.rollupOptions` is renamed `build.rolldownOptions`, the function form of `manualChunks` is deprecated in favour of `codeSplitting`, `optimizeDeps.esbuildOptions` is deprecated, and `define` no longer shares object references. Both React plugins in `package.json` declare `vite ^8` in their peer range (`@vitejs/plugin-react-swc` 4.3.3, `@vitejs/plugin-react` 5.2.0, from `bun.lock`); plugin-react v6 moves React Refresh to Oxc. Node 25.7 and Bun 1.3.9 are installed, above Vite 8's floor. The release build (`just app-release`, `bun run build`) and `scripts/release-chunk-graph.ts` (imports `build` and `Rollup` types from vite) run through the same package. **(verified)**

**[F06] Nothing on record says what a page costs under bundled dev.** The shell's lap gives the before number ([F01]); the deck-populated and make-to-ready laps the sibling brief adds ([B06] there) give the after number for the whole deck. The spike reads both. **(verified by absence)**

---

## Decisions {#decisions}

**[B01] The remedy is Vite 8's bundled dev mode, tried as a spike before anything else about page cost is touched.** The user's call, 2026-10-21. A page's module count is the cost; bundling in dev is the one approach that removes the per-page tax rather than dividing it, and it changes nothing about what a page contains. Shrinking the body graph, loading card kinds by dynamic import, and cross-process caching are not started unless this spike fails ([Non-goals]).

**[B02] The spike is a yes-or-no on one branch, with a defined pass.** On a branch: upgrade `vite` to the current 8.x, migrate the config per [F05], run the debug app once unbundled to confirm nothing regressed, then turn on `experimental.bundledDev` and launch the user's ten-card deck. Pass means: the shell's `frontend-ready` resource count drops by an order of magnitude; the deck-populated lap lands under 3 s after the reveal warm; a CSS edit, a component edit and a shared-module edit each reach every page with the cards on screen; the theme switch, the control-token hot reload, the capabilities snapshot roll, the five workers, the wasm, and the `?raw` theme sources all still work. Fail is any one of those that cannot be made to work inside the spike's budget, and the record says which.

**[B03] The Vite 8 migration lands whether or not the mode passes.** It is a separate change ([F05]) with its own value (the release build, plugin-react v6 on Oxc), and separating it from the mode is what makes the spike's verdict about the mode and not about the upgrade. The upgrade is checked by the release build (`just app-release`) and the app-test core tier, which read the built bundle.

**[B04] Where the mode does not support a hook Tug uses, the hook moves to a supported shape; it is not a fail by itself.** The two `handleHotUpdate` uses ([F03]) become watcher callbacks that invalidate through what bundled dev exposes, and the active-theme repaint stops reading `server.moduleGraph` if that graph is not the one the bundle serves. A per-page full reload, the sibling brief's [B04], is written against `vite:bundled-dev:reload-needed` when this mode is on and against `hotUpdate` when it is off; the sibling brief says so. What counts as a fail is a feature with no supported shape at all, not a rewrite of a plugin.

**[B05] The mode is on for the debug app only, through the config, and the app-test build does not change.** `ProcessManager.spawnViteServer` passes the arguments; the flag is set in `vite.config.ts` under the dev-serving condition, never on the command line, so the release build and `vite preview` are untouched. The reach-instrumented app-test build (`TUG_APPTEST_REACH=1`, Babel plugin) stays on the unbundled path until it is shown to work bundled, since it is a different plugin stack and not what the user is waiting on.

**[B06] The number that decides is the deck-populated lap, read on the user's deck.** Not a harness reading, not a fresh deck: the sibling brief's laps on the ten-card `debug-main` deck, the same way the before number was read. A spike that reports only Vite's own startup time has not read the thing the user complained about.

---

## Open Questions {#open-questions}

- Whether lazy bundling treats `/?body=<cardId>` as the same entry as `/`. The design discussion says the mode bundles "the page the browser actually requests"; every Tug page is `index.html` and `entry.ts` picks the branch at runtime by query string, with each branch a dynamic import. If each body page triggers its own lazy compile the gain shrinks on the first launch and the spike should read the second body's load separately from the first.
- Whether the SWC React plugin or plugin-react v6 on Oxc is the right partner for the mode. Both declare Vite 8 support; the spike takes whichever works first and notes the other.

---

## Non-goals {#non-goals}

- **Shrinking the body module graph, or loading a card kind by dynamic import.** Ruled out by the user on 2026-10-21 unless this spike fails. The sketch estimated it would halve a page and still leave hundreds of requests per page.
- **Making Vite's `/src/*` responses cacheable across WebContent processes.** Vite stamps import versions only after invalidation, so a cache-friendly header cannot be made safe without forking the import rewriter. Rejected in the sketch. Note that `noConditionalRequestsPlugin` in `vite.config.ts` already strips conditional headers, so there is no 304 path today either.
- **Lightning CSS, chunk import maps, WASM ESM integration.** Vite 8.1 ships them beside the mode; none is needed for the verdict and each is its own change.
- **Fixing the launch order or the HMR fan-out.** That is the sibling brief, and it lands regardless.
- **Any dev-only bundling of our own** (an esbuild watch build served by Vite, a prebuilt body bundle). That would be page-content hacking by another name and would lose per-module HMR.

---

## Exit {#exit}

An arc whose first step is the spike itself. The shape: the Vite 8 upgrade and config migration first ([B03]), verified by the release build and the core tier; then the mode turned on under the dev-serving condition ([B05]) with the `handleHotUpdate` uses and the theme repaint moved to supported shapes ([B04]); then the launch of the user's deck read against [B02] with the sibling brief's laps, and the three edits made with the deck watched. If the mode passes, the arc leaves it on and records the before and after numbers beside the sibling brief's. If it fails, the arc leaves the Vite 8 upgrade in, turns the mode off, records which feature had no supported shape, and the question of page content comes back to the user as a new sketch.
