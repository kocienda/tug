# Site clip tooling: manifest, scene timeline, app support

**Purpose:** Recording the Tug app in motion for the site works, but every clip is cut by hand through a dozen steps and the same geometry and timing defects recur. The user wants to make many more clips, so the workflow becomes tooling, in three layers landed as one arc.

---

## Purpose {#purpose}

The user: "I really like the way we can generate videos of the app while it's working. I want to do more of this, so I wonder if there is an opportunity to tool-ify the workflow you have been using. What APIs or support in the app codebase might help to make the tooling easier to implement? How can we improve the way this works?"

Today a clip is: a driver file under `tests/app-test/site-clips/` in the Tug repo, run twice through `just app-test` with three environment variables, once per mode; two `tools/make-clip` invocations in the site repo with a loop trim picked by paging through PNG frames; a README row typed by hand; a screenshot check through a throwaway CDP script in `/tmp`. Eighteen drivers exist. The sketch settled on three layers: a manifest and one-command runner in the site repo, a scene timeline with loop marks and declarative crop in the harness, and a short list of app-side supports. The user asked for all three in one arc.

---

## Evidence {#evidence}

**[F01] The capture host caps a burst at ten seconds.** `tugapp/Sources/HostFrameMeter.swift` declares `CaptureBurst.maxDurationMs = 10_000` and clamps `durationMs` to it in `init`. `_site-clips.ts` mirrors it as `BURST_CAP_MS` and throws past it. The theme clip spends 9.4 s stepping four themes at 1.5 s each; a longer walk or a slower typing scene cannot be one take. **(verified)**

**[F02] A cropped burst already excludes the title bar.** `CaptureBurst.init` converts the crop from content points to device pixels and offsets `y` by `titleBarPx`, so only a whole-window burst, or a crop the driver computed wrongly, shows the title bar. The title-bar defect seen while cutting the button and choice-group clips came from driver arithmetic, not from the host. **(verified)**

**[F03] Frames are copied out by the driver, and the reading is the driver's.** The host writes PNGs to its own temporary location and the harness reclaims them with the test's screenshots at teardown, so `writeFrames` in `_site-clips.ts` copies every frame to `$TUG_SITE_CLIPS_OUT/<clip>/<mode>/frame-NNNN.png` and writes `reading.json` itself. The host answers `read` with `t`, `wall` and `path` per frame, plus scale, content size, crop and background colour, but carries no named marks. **(verified)**

**[F04] Every driver composes its crop by hand from three readings.** `standIns(app)` gives card pane rects in content points, `app.bodies()` gives body frames, and `rectIn(body, selector)` gives an element rect in body coordinates, so a crop ending at the status bar is `view.y + bar.y + bar.height - card.y`. `sc-theme.test.ts` and `sc-busy-done.test.ts` carry this arithmetic verbatim, and the deleted button, choice-group and confirm drivers each got it wrong at least once: title bar in frame, an empty right half, a popover clipped at the left edge. **(verified)**

**[F05] Scene timing is `Bun.sleep` against guessed durations.** The theme driver holds 1.5 s per theme and sleeps 1 s before and after; the markdown-entry driver types word by word on fixed pauses. The burst duration is a constant chosen to cover the sleeps. The loop trim (`--first`, `--last`) is then found by reading frames, and the two modes of one clip are trimmed separately. **(verified)**

**[F06] The app already has a global duration scale.** `--tug-timing` scales every animation duration (`tug-tooltip.css`, `zoom-rects.css`, `zoom-readout.css` multiply by it, under laws L13 and L14). The text editor's caret is CodeMirror's, drawn by `tug-text-editor/selection-layer.ts`, whose blink rate is an editor option. Neither is exposed to a clip. **(verified)**

**[F07] A stub-bound session card reads "No turns. Ready."** `session-activity-line.ts` prints the engine's turn count from the session ledger store, and the streaming stub publishes transcript frames but no ledger frame, so the masthead of every stub-bound card says the conversation is empty while the transcript shows a finished turn. The masthead clip worked around it with an in-page push. **(verified)**

**[F08] The site records provenance by hand and cannot tell what is stale.** `src/assets/tug/motion/README.md` is a table with the driver, Tug commit, frames kept and encode date per clip and mode, written by hand per row. Nothing compares the recorded Tug commit or the driver's content against the current tree, so after an app change the clips that need re-cutting are found by memory. **(verified)**

**[F09] Verification lives in `/tmp`.** The screenshot checks of the page (`/tmp/shot-live.mjs`, `/tmp/shot-components.mjs`, `/tmp/heading-gaps.mjs`) drive a headless Chrome over CDP against `pnpm astro preview`. They are rewritten each session and nothing checks that every clip the page references exists in both modes with even dimensions and a matching poster. `./tools/deploy` already runs `pnpm themes:check` before the build and could run a clip check the same way. **(verified)**

**[F10] The drivers are tests in name only.** Each is a `bun:test` file gated on `RUNS` with one assertion that frames were written, run by path through `just app-test` with `TUG_APPTEST_FILE_BUDGET_SECS` raised past the 20 s default. The runner's own selection never sweeps `site-clips/`. **(verified)**

---

## Decisions {#decisions}

**[B01] The three layers land as one arc.** The user's call. Each layer has value alone, but the timeline (layer two) is what gives the manifest (layer one) its trim, and the host marks (layer three) are what make the timeline's trim exact, so landing them apart would mean building each layer's stopgap and then removing it.

**[B02] A clip manifest in the site repo is the single source of provenance.** One entry per clip: name, driver path, modes, trim, crf, max width, the Tug commit and the driver file's content hash at the cut, and the encode date. The motion README's table is generated from it, never edited by hand. The manifest is what a staleness check reads, which the README's prose table cannot be.

**[B03] One command cuts a clip end to end.** `tools/clip cut <name>` in the site repo runs the driver once per mode through `just app-test` in the Tug checkout, encodes both modes through `make-clip` with the manifest's settings, writes the posters, updates the manifest entry and regenerates the README. `tools/clip status` lists entries whose recorded Tug commit is not an ancestor of the current Tug `HEAD` touching relevant paths, or whose driver hash has changed. `tools/clip check` is the asset check of [B08]. The Tug checkout's location is a setting with a default of the sibling directory, not a hardcoded path.

**[B04] A scene is a timeline, and the burst's length derives from it.** The harness gains a `scene` builder: `at(ms, act)` entries, a `mark(name)` entry, and `record()` which arms the burst for the timeline's span plus settle, runs the entries on schedule, and returns the reading. `Bun.sleep` chains in drivers are replaced by entries. A scene's trim is the frames between its `loop-start` and `loop-end` marks, resolved against frame timestamps, so the trim is chosen by the scene's author in code and the two modes share it.

**[B05] A crop is declared, not computed.** The harness gains one helper that takes the cards a scene is about, an optional ending slot selector, and padding, and returns the crop in content points, doing once the arithmetic in [F04]. Drivers call it and never compose `view.y + bar.y` again. This replaces the title-bar exclusion item from the sketch, since [F02] shows the host already excludes it for a cropped burst; a whole-window capture that must exclude the title bar is out of scope here.

**[B06] The app gains the supports the harness cannot fake, each small.**
- A `mark` op on `captureBurst` that stamps the next frame index under a name, answered in `read` as `marks: {name: index}`, so the timeline's trim is the host's reading rather than a timestamp search.
- An `outDir` on `arm`, so the host writes frames and a `reading.json` straight into the clip directory and the copy loop in `writeFrames` goes away. Marks ride the reading.
- A longer burst: `maxDurationMs` raised to 30 s, with the frames-outgrow-their-use concern met by the clip's crop and interval rather than a cap. Chaining segments was considered and rejected as more machinery for the same result.
- A clip mode the harness can switch on: `--tug-timing` pinned to 1, the editor caret blink disabled, and any stub pacing fixed, so the dark and light cuts of a scene have the same frame count. Exposed as a `tugdeck.diag` call or a launch environment variable, whichever the existing test-mode plumbing already carries.
- A ledger frame from the streaming stub, or a `seedSessionState` on the stub, so a stub-bound card's masthead reads its turn count and status ([F07]) without an in-page push.
- A `diag` call answering an element's rect in window content points, given a card id and selector, so the crop helper of [B05] has one source instead of three.

**[B07] Drivers stay app-test files run by path.** The gate on `RUNS`, the `TUGAPP_APP_TEST` export and the per-file budget are kept; `tools/clip cut` is what sets them. A separate runner was considered and rejected: the harness's launch, stub and tugbank helpers are what a driver is made of, and they live under the app-test runner.

**[B08] Verification is tooling and the deploy runs it.** The CDP screenshot script becomes `tools/shot-page` with the page, width, theme and region as arguments. `tools/clip check` confirms that every clip the Tug pages reference exists in both modes, has even dimensions, has a poster whose dimensions match, and has a manifest entry; `./tools/deploy` runs it beside `pnpm themes:check`.

**[B09] Existing clips are not re-cut by this arc.** The eighteen drivers are moved onto the timeline and crop helpers so they keep running, and the manifest is seeded from the README's current rows, but the shipped mp4 and png assets stay as they are. Re-cutting is what the tooling is for and happens after it lands, clip by clip, as `tools/clip status` directs.

**[B10] This arc is the site layer only; the Tug layers are a second arc.** Settled at the door: an arc has one worktree, this one is cut in the site repo, and doctrine forbids a stage writing outside it. So this arc lands [B02], [B03] and [B08] against the harness as it stands today, with the manifest's trim held per mode as frame numbers and the runner invoking the eighteen existing drivers unchanged. The Tug-repo arc, opened from a Tug session on this same brief, lands [B04], [B05] and [B06]; when it has, the manifest's trim gains a marks-based source and the runner reads `reading.json` marks. The first open question below is thereby answered.

---

## Open Questions {#open-questions}

- **Which repository hosts the arc.** Layer one is site-repo work; layers two and three are Tug-repo work, and an arc has one worktree. The sketch assumed the Tug repo, since that is where the app-tests run and most of the change lands, with the site-side tooling committed in the site checkout. Whether the door accepts an arc whose steps write outside its worktree, or whether this becomes two arcs that land together, is the user's call before the arc opens.
- **Where the clip mode is switched on.** Whether `--tug-timing` and the caret blink are set through a launch environment variable the app's test mode already reads, or through a `tugdeck.diag` call the harness makes after boot, depends on which the existing plumbing carries with less new code. Reading the test-mode launch path settles it.

---

## Non-goals {#non-goals}

- **Changing the clip format or the page.** H.264 yuv420p, the 1600 px cap, the poster convention and the Clip component stay. This arc changes how clips are made, not what they are.
- **Chained burst segments.** Rejected in [B06]: raising the cap is the same result with less machinery.
- **A whole-window capture that hides the title bar.** The hero is a still and every motion clip is cropped, so there is no consumer.
- **Driving a real engine.** Scenes stay on the streaming stub; a clip that needs a live model run is a different kind of tool.
- **Re-cutting the shipped clips.** [B09].
- **A GUI or an in-app clip recorder.** The harness is the recorder; the user's gesture is a command.

---

## Exit {#exit}

**An arc.** The shape, in the order it must land: the app supports of [B06] first, since the harness layer consumes them (marks, `outDir`, the longer cap, the rect diag, clip mode, the stub ledger frame); then the harness layer, the scene builder and crop helper of [B04] and [B05], with the eighteen drivers moved onto them and each re-run once per mode to prove it still records; then the site layer, the manifest seeded from the README, `tools/clip` with `cut`, `status` and `check`, `tools/shot-page`, the README generated, and the deploy script running the check. The first open question decides where that arc's worktree is, and is answered before it opens.

---

*Status note, 2026-10-26: the site layer ([B02], [B03], [B08]) landed on the site repo's `main` as commit `d24ed593fd`. The Tug-repo arc lands [B04], [B05] and [B06] per [B10].*
