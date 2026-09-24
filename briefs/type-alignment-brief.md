# Type Alignment: One Baseline, No Nudges

**Purpose:** Monospace text sits a pixel off the sans text beside it across the app — tool block headers, status cells, sheet rows. The cause is not the fonts; it is ~66 hand-tuned optical nudges across 29 files, several of which stack on each other, with no doctrine and no guard to make any one of them falsifiable.

---

## Purpose {#purpose}

> "Misaligned monospace text. I want a full 360° audit of the code to find and fix all these issues. No more one-off patches and hacks to make this text line up properly. I want this fixed *comprehensively* and *consistently* everywhere in the app, in all tool block headers, components, etc. Everywhere."

The report arrived with a screenshot of a Session card showing three separate instances in one frame: a `Skill` tool block header whose mono detail `/tugplug:brief` sits below the sans `Skill` beside it and below the trailing copy/chevron cluster; the `STATE` / `TIME` / `CONTEXT` / `TASKS` / `JOBS` telemetry row sitting off its endcap rules; and an `OK` / `COPY` control row.

The complaint is not that a particular row is wrong. It is that rows keep being wrong, each gets patched locally, and nothing prevents the next one. That is the problem this brief is about.

---

## Evidence {#evidence}

**[F01] The two bundled faces are metrically identical, so the fonts cannot be the cause.** Vertical metrics were extracted directly from the `woff2` files in `tugdeck/public/fonts/` by decompressing the brotli stream and reading `head` / `hhea` / `OS/2`:

| face | upem | hhea asc/desc/gap | typo asc/desc/gap | cap | x-height |
|---|---|---|---|---|---|
| `IBMPlexSans-Regular` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |
| `IBMPlexSans-SemiBold` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 522 |
| `IBMPlexMono-Regular` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |
| `IBMPlexMono-SemiBold` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |
| `IBMPlexSansCondensed-Regular` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |

Same em square, same ascent, same descent, zero line-gap, same cap-height, and `USE_TYPO_METRICS` clear on every face so the browser uses the `hhea` numbers uniformly. Sans and mono at one `font-size` and one `line-height` land on the same baseline with no assistance. Every optical nudge in the tree is therefore correcting something other than the face. **(verified)**

**[F02] The screenshot's defect is two nudges stacking in `tugdeck/src/components/tugways/blocks/block-header.css`.** The file applies `position: relative; top: 1px` at four places, two of which nest:

- `block-header.css:154` — `.tool-call-header-dot, .tool-call-header-name` → `+1px`
- `block-header.css:196` — `.tool-call-header-detail` → `+1px`
- `block-header.css:270` — `.tool-call-header-detail code` → `+1px`, compounding with the rule above
- `block-header.css:307` — `.tool-call-header-summary, .tool-call-header-timing` → `+1px`
- `.tool-call-header-leading` and `.tool-call-header-actions` → no nudge

`tugdeck/src/components/tugways/cards/blocks/skill-tool-block.tsx:202` renders its header detail as a `<code>`, so it collects both the detail rule and the code rule. In the reported row: `Skill` at `+1`, `/tugplug:brief` at `+2`, the timing badge at `+1`, the copy/chevron cluster at `0` — three y positions in one row. The same stacking affects every block whose detail is a `<code>`: Bash, Grep, Glob, Monitor, Cron, WebSearch, RemoteTrigger, TaskMgmt, ShareOnboardingGuide. **(verified)**

**[F03] The nudge comments in that file contradict each other.** `block-header.css:152` reads "the lifecycle dot and the bold sans name center a hair high against the mono detail"; `block-header.css:196` reads "the mono detail / file ref centers a hair high against the bold sans name." Both cannot be true, and both were given `top: 1px`. Meanwhile the file's own docstring states the correct mechanism: "One font size across the text (`sm`) means 'centered in the same line box' is also 'same baseline' — that is the whole alignment trick." The nudges were added on top of a mechanism the file already documents as sufficient. **(verified — read out of the file)**

**[F04] The box arithmetic says all four nudges in `block-header.css` are unnecessary.** With `--tugx-toolheader-line` = `13px × 1.6` = `20.8px`: the name's line box is `normal` (1.3 × 13 = 16.9px) centred in the 20.8px `min-height` box, giving a baseline at `(20.8 − 16.9)/2 + 13.3 = 15.25px`; the detail declares `line-height: 20.8px` directly, giving `0 + 15.25 = 15.25px`. The baselines coincide before any nudge is applied. **(not verified — this is arithmetic from the declared metrics, not a rendered measurement. `[F09]` is the instrument that would confirm it.)**

**[F05] A second, independent family: centred letterspaced labels are off-centre with no compensation anywhere.** `letter-spacing` adds its track *after* the final glyph, so a centred label is displaced left by half the track. `tugdeck/src/components/tugways/tug-status-cell.css:578` sets `letter-spacing: 0.18em` at `font-size: 0.5625rem` — roughly 1.6px of phantom trailing width, ~0.8px of left displacement — on the endcap labels visible in the screenshot. A sweep of all ~50 `letter-spacing` declarations under `tugdeck/src/` found **zero** sites compensating with a trailing negative margin, a `text-indent`, or any other means. **(verified)**

**[F06] The nudge corpus is 29 files.** Counted under `tugdeck/src/` with `grep`: 21 micro `top` / `bottom` offsets at 3px or less, 13 micro `translateY` calls (px or sub-`em`), 21 `vertical-align` declarations, 11 micro or negative `margin-top` / `margin-block-start`, 2 `line-height: 0`. Named instances include `tug-status-cell.css:581` (`translateY(0.5px)`), `usage-sheet.css:168` and `:299` (`translateY(-0.28em)`), `tug-separator.css:125` (`translateY(-0.05em)`), `session-card-z1b.css:140` (a `--tugx-session-z1b-copy-baseline-nudge` token of `0.5px`), `tug-atom-ref.css:55` and `tug-markdown-view.css:892` (`vertical-align: -0.15em`), `task-tool-block.css:69` (`top: 0.5px`). **(verified)**

**[F07] There is no doctrine for the vertical rhythm of type.** `tuglaws/` holds 44 documents covering colour (`color-palette.md`, `theme-engine.md`), tokens (`token-naming.md`), motion (`animation-doctrine.md`), lists (`list-surface-grammar.md`), focus, panes, and more. None addresses baseline alignment, line boxes, or optical nudges. **(verified)**

**[F08] There is no guard.** `tugdeck/package.json` ships five audit scripts — `audit:tokens`, `audit:visibility`, `audit:settle-motion`, `audit:theme-contrast`, `audit:gamut` — plus `scripts/verify-pairings.ts`. None inspects alignment. A nudge added today fails nothing, which is why each one was locally plausible and collectively incoherent. **(verified)**

**[F09] Nothing in the codebase can currently measure a baseline.** The app-test harness under `tests/app-test/` drives the real `Tug.app`, but no test reads text-run geometry. Confirming `[F04]` — or any of the 29 files' deletions — presently means looking at a screenshot, which is the method that produced `[F03]`. **(verified — absence established by search)**

**[F10] `--tugx-block-args-size` is a live size-step-down that the header no longer uses.** `tugdeck/src/components/tugways/blocks/block-chrome.css:63` declares the args row one size step below the name (`xs` under `sm`), on the stated reasoning that "a mono glyph reads optically larger than the sans tool name at the same px." `block-header.css` has since moved to one size for all header text and argues the opposite resolution — bold weight, not size, carries the hierarchy. The token remains declared and is consumed by `read-`, `edit-`, `glob-` and `grep-tool-block.css`. Two font sizes on one row is the condition under which `align-items: center` and baseline alignment diverge. **(verified)**

---

## Decisions {#decisions}

**[B01] The fix is systemic, not per-site: a law, a primitive, a measured sweep, and a guard.** `[F01]` removes the explanation everybody reached for, and `[F03]` shows what fills the vacuum — locally reasoned, mutually contradictory, individually unfalsifiable corrections. Patching the reported rows would leave that generator running. What is being bought is that a nudge has somewhere to be wrong. Revisit only if the measurement in `[B03]` shows the nudges are load-bearing after all, which would mean `[F01]` is incomplete and some other metric source is in play.

**[B02] A nudge is not an alignment mechanism.** Text-to-text alignment is achieved by shared `font-size` and `line-height`, by baseline alignment, or by one declared line box every item rides — never by `position: relative; top`, sub-pixel `translateY`, or a length `vertical-align`. This is the rule the user asked for in their own words ("no more one-off patches and hacks"), and it is the one the guard in `[B05]` enforces. It rules out the fastest fix for any future single misaligned row, which is the point.

**[B03] The measuring instrument is built before any CSS is edited.** An app-test mounts each mixed-face row, reads its text runs' baselines via `Range.getClientRects()`, and asserts equality. Every nudge deletion across the 29 files of `[F06]` is then confirmed by the probe rather than by eye. The user chose this ordering explicitly over fixing `block-header.css` first. The argument: 29 files is far past what anyone can eyeball, and eyeballing is the documented cause of `[F03]`. Without the probe, "comprehensively" is a claim rather than a fact, and `[F04]` in particular stays an inference.

**[B04] The doctrine is written down as `tuglaws/type-alignment.md`.** Five rules: (i) text sharing a row shares one `font-size` and one `line-height`; (ii) a row mixing faces aligns by baseline or by one declared line box, never by `align-items: center` over boxes of differing height; (iii) `[B02]`; (iv) an SVG glyph aligns to the cap-height band rather than the em box, through one shared primitive; (v) a centred letterspaced label compensates its trailing track, per `[F05]`. `[F07]` establishes the gap. Rules (i), (ii) and (iv) exist so that (iii) is obeyable rather than merely stated.

**[B05] The guard is `audit:type-alignment`, wired into `just lint`.** It fails on micro `top` / `bottom` / `translateY` / length `vertical-align` in any rule whose selector carries text, and on a centred `letter-spacing` with no trailing compensation — unless the rule carries an explicit `/* @tug-optical-nudge: <reason> */` escape naming what it corrects. `[F08]` establishes the gap; `scripts/verify-pairings.ts` and `scripts/audit-tokens.ts` establish the shape, so the cost is low. The escape hatch is deliberate: a genuine optical correction (an ornamental glyph sitting low in its own bounding box, as at `tug-separator.css:125`) remains possible but must name itself and becomes greppable. Without this, `[F06]` regrows.

**[B06] The line-box mechanism is extracted into one primitive.** `block-header.css` currently hand-rolls `display: inline-flex; align-items: center; min-height: var(--tugx-toolheader-line)` and other sites re-derive the same stanza independently. Each re-derivation is a chance to drift a pixel, which is `[F02]`'s proximate mechanism. One implementation becomes the only sanctioned way a row mixes faces.

**[B07] Where rule (i) and optical size parity conflict, same-size-plus-weight-contrast wins.** `[F10]` names the live conflict. Dropping mono a size step for optical parity is a real typographic instinct, and it is also precisely what breaks baseline alignment under centre-alignment. `block-header.css`'s own docstring already argues the winning side. Revisit if the probe shows a same-size mono/sans pair reads badly enough to be worth a different mechanism — but that mechanism would be a face or tracking adjustment, not a size step.

---

## Open Questions {#open-questions}

- **How far past 29 files does the corpus actually run?** The sweep in `[F06]` catches *declared* nudges. It cannot catch a row misaligned because two items disagree on `font-size` or `line-height` with no nudge papering over it — `[F10]` is exactly that shape. The probe from `[B03]` is what settles the true count, and it should be pointed at the corpus before the sweep's size is estimated.

- **Can the probe read baselines reliably under the app-test harness?** `Range.getClientRects()` returns the inline box, not the baseline directly; the baseline must be derived from the box plus the font's ascent, or obtained some other way. There is also a known hazard recorded for this harness: a covered harness window suspends `requestAnimationFrame`, so any measurement that waits on paint needs care. This is a build-it-and-see question, not a design question — but if it proves unworkable the ordering in `[B03]` has to be reconsidered.

- **Does `[F05]`'s trailing-track compensation belong at the ~50 call sites or in a shared label primitive?** A primitive is obviously better if the letterspaced-uppercase label is one recurring object; it is not yet established that the ~50 sites are one object rather than several. Reading them is what settles it, and that reading has not been done.

---

## Non-goals {#non-goals}

- **Changing the bundled faces, or adding a `size-adjust` / `ascent-override` descriptor to any `@font-face`.** `[F01]` rules this out: the metrics already agree exactly. A descriptor added here would be a second unfalsifiable correction on top of the ones being removed.

- **Patching the reported rows and stopping.** Explicitly rejected by the user, and `[B01]` gives the reason. The screenshot's three defects are symptoms of `[F03]`'s generator, and fixing them alone leaves it running.

- **Sweeping the corpus by eye without the probe.** Offered and declined. It is the fastest route and it reproduces the exact failure mode that wrote the contradictory comments in `[F03]`.

- **Touching `tugdeck/src/spikes/`.** Spike files (`spike-focus-language.css`, `spike-session-identity.css`, `spike-place-coordinate.css`) appear in the `[F06]` counts but are exploratory surfaces, not shipped product. They are out of scope for the sweep and should be excluded from the guard in `[B05]`.

- **The `.tug-petals` rotation transforms in `tug-button.css:2198-2205`.** They match the `translateY` grep but are a radial petal layout, not a text nudge. Named here so the sweep does not rediscover them.

---

## Exit {#exit}

**An arc.** The work has a forced order, since `[B03]` puts the instrument before the edits.

The shape of the first steps:

1. **Build the baseline probe.** An app-test that mounts a mixed-face row, reads its text runs' baselines, and asserts equality. Point it at a `Skill` or `Bash` tool block header — it should run **red** against `block-header.css` as it stands today, and that red is the probe's own proof of function. Carries `@covers` for `block-header.css` and the block wrappers it exercises.

2. **Point the probe at the corpus and get the true count.** Settles the first open question and sizes everything after it.

3. **Write `tuglaws/type-alignment.md`** per `[B04]`, and register it in `tuglaws/INDEX.md`.

4. **Extract the line-box primitive** per `[B06]`.

5. **Sweep, measured.** `block-header.css`'s four nudges first — the reported defect, and the case where `[F04]` predicts a specific outcome the probe can confirm or refute. Then the remaining files, each deletion confirmed rather than asserted. `[F10]`'s size-step-down resolves here under `[B07]`.

6. **Land the guard** per `[B05]`, in `just lint`, once the corpus is clean enough to pass it.

Steps 3 and 4 are independent of each other and of step 2; steps 1, 5 and 6 are strictly ordered. Step 5 is the bulk of the work and is the one that will want checkpointing per file group.
