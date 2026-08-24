# App-test suite audit — grading the inventory

353 test files, 99,767 lines. Graded into three bands: **must-keep** (59), **should-keep** (109), **can-delete** (185). Every file lands in exactly one band; the lists were derived as a partition and checked programmatically, so there are no gaps and no double-counting.

## What the numbers say before any judgment is applied

The suite's cost is not evenly distributed, and it is not mostly in the tests that matter.

| Band | Files | Lines |
|---|---:|---:|
| must-keep | 59 | 21,250 |
| should-keep | 109 | 34,759 |
| can-delete | 185 | 43,758 |

**More than half the suite's mass is in the deletable band.** 185 files carrying 43,758 lines — 44% of the corpus — exist to assert things that would be obvious on sight, or to assert something a kept test already drives end-to-end.

The second number that explains the 5-minutes-to-change / 20-minutes-to-test ratio is the selection fan-out. `scripts/select-tests.ts` carries an `ACCEPTED_FANOUT` table recording how many tests a single source file pulls in:

| Source file | Tests selected |
|---|---:|
| `focus-manager.ts` | 68 |
| `focus-transfer.ts` | 30 |
| `tug-text-editor/` (+ 7 modules named individually) | 29–30 |
| `tug-pane.tsx` | 29 |
| `tug-list-view.tsx` | 27 |
| `tug-prompt-entry.tsx` | 25 |
| `deck-manager.ts` | 25 |
| `AppDelegate.swift` | 23 |
| `tug-text-editor.tsx` | 22 |
| `card-state-orchestrator.ts` | 21 |

Touch `focus-manager.ts` — the single most-edited file in the tugdeck focus work — and the selector wants **68 app-test files**, each launching its own `Tug.app` subprocess behind a machine-wide serialization gate. That is the 20 minutes. The table's own comments read as a slow surrender: entry after entry documents a budget being raised by one because a new test "has nowhere smaller to point." The budget was `MAX_SELECTED = 20`; `focus-manager.ts` is at 68.

Cutting the delete band removes **31 of the 68** `focus-manager.ts` selections and **11 of the 27** `tug-list-view.tsx` selections. The fan-out problem is not separate from the duplication problem — it *is* the duplication problem, measured at the selector.

The third signal is churn. Over six months, the most-edited test files are not the ones guarding the hardest behavior:

| Test | Commits touching it |
|---|---:|
| `at0168-menu-structure` | 26 |
| `at0121-list-view-container-focus` | 16 |
| `at0146-question-dialog-keyboard` | 15 |
| `at0117-radio-group-focus` | 12 |
| `at0118-choice-group-focus` | 12 |
| `at0120-accordion-focus` | 12 |

Four of the top six are per-widget focus clones. These are being *repaired*, not *consulted* — a maintenance tax paid in every session that touches the focus engine.

## The grading rule

- **must-keep** — failure is **silent or destructive**. State that persists to disk, a ledger, or a process; or a shared engine whose breakage is diffuse rather than local (focus routing, scroll attribution, the imposer, transport recovery). These are the tests that catch what a user would *not* catch by looking.
- **should-keep** — exactly **one test per user-facing feature**, chosen as the most end-to-end member of its cluster. A real feature that could plausibly regress, held by one file rather than six.
- **can-delete** — everything else: clones, fossils, cosmetics, creation checks, and primitive-level tests whose behavior is already driven end-to-end by a kept test.

The load-bearing phrase in your framing is *non-falsifiable in practice*. A test that asserts a card appears when you dispatch the action that creates the card cannot fail in any way that would not also make the app visibly unusable within seconds. It costs a process launch on every run to tell you something the first click of manual use would have screamed.

## can-delete — the clusters, and why

### Self-declared scratch (5 files, 3,588 lines)

`at9995-textcard-ring-probe`, `at9996-anim-island-lab` (2,659 lines — the single largest file in the suite), `at9997-scratch-jot-heavy-deck`, `zzscratch-keymap-scoped`, `zzscratch-keymap-trace`.

Their own docblocks say "SCRATCH diagnostic, not a kept suite" and "SCRATCH lab." They were investigation instruments. The investigations concluded. `at9996` alone has been touched by 12 commits since — it is being maintained as a test while documented as not being one.

### Fossilized investigation probes (3 files)

The rapid-cadence trio: `at0001-rapid-cadence`, `at0003-rapid-cadence`, `at0016-rapid-cadence`. Each is its slow-cadence parent replayed with no inter-gesture waits. `at0001-rapid-cadence`'s own header:

> This was originally expected to fail against the [A3] `useLayoutEffect` in `CardHost`… **In practice it passes deterministically** … This file locks in current behavior so refactors cannot regress at this cadence.

A test written to catch a race that never reproduced, kept to lock in the behavior of the code that made the race not reproduce. Three copies of it. They are 451 lines and three process launches asserting the same thing their parents assert, faster.

### Per-widget focus clones (9 of 11 files, ~1,700 lines)

`at0113`-checkbox, `at0114`-switch, `at0115`-slider, `at0116`-tab-bar, `at0117`-radio-group, `at0118`-choice-group, `at0119`-option-group, `at0120`-accordion, `at0122`-list-view-subordinate.

`at0113` and `at0114` are the same file with `s/checkbox/switch/`: 92 differing lines out of 161, and every one of them is a noun. Both assert the identical three-part contract — click paints no ring, keyboard focus paints the ring on the wrapper, Space toggles. That contract belongs to the focus engine and the shared ring stylesheet, not to eleven widgets independently. It is already asserted by `at0109-focus-ring` (the one app-owned ring), and the archetype is held by `at0112-button-focus`.

Keeping: `at0112` (the base button — the archetype every other control derives from) and `at0121` (list-view container — the app's most complex focusable, genuinely different machinery). Deleting the other nine, which cost 12–16 repair commits each.

### FC/EM duplicate halves (7 files)

`at0002-tab-switch-em`, `at0006-em-cross-pane`, `at0007-em-card-detach`, `at0009-em-inactive-mount`, `at0033-em-fresh-card-activation`, `at0034-em-focus-after-move`, `at0035-em-app-switch-selection`.

Every one is the EM-flavored half of a test whose FC half is kept. The orchestrator contract under test is identical; only which component reacquires focus differs. Keeping one EM representative — `at0032-em-cold-boot-selection`, the restore path, which is the hardest and the one where a break would be silent.

### Popup / completion cancel-and-restore variants (6 files)

`at0052`, `at0053`, `at0054`, `at0055`, `at0056`, `at0058`. Six files each asserting "the completion popup cancels (or restores focus) when *X*" for six values of X. One predicate, six process launches. Keeping `at0051` (the overlay-tier registry, 572 lines, 4 tests — the real machinery) and `at0057` (popup-in-sheet z-tier elevation, a genuinely different stacking path).

### Motion and animation micro-envelopes (6 files, ~2,500 lines)

`at0274-progress-dot-envelope` (27 assertions on a dot's breath curve), `at0276-progress-dot-crossing` (716 lines, 38 assertions that the dot "never pops on a state change"), `at0288-motion-residency`, `at0289-transcript-motion-hygiene`, `at0291-perf-instruments` (tests the instrument, not the app), `at0230-perf-idle-quiet`.

A pulsing dot with a wrong easing curve is the definition of something that screams on sight. 1,082 lines on one dot's animation. Keeping the perf guardrails that measure things the eye cannot: `at0292-idle-silence` (a settled deck writes nothing), `at0293-typing-latency` (the active typing-lag campaign).

### Typography, geometry, and pixel cosmetics (~24 files)

`at0087`-badge-two-line, `at0110`-selection-accent, `at0161`-question-dialog-geometry, `at0208`-attribution-gap, `at0264`-commit-receipt-geometry, `at0273`-list-row-press, `at0283`-list-row-striping, `at0283`-pulse-typography (27 assertions on the PULSE's typographic contract), `at0297`-lens-empty-label-row-height, `at0353`-selection-wash, `at0363`-action-tooltip-shortcut, `at0367`-button-activity, `at0374`-session-identity-tiers, `at0375`-session-masthead (**1,184 lines, 64 assertions** — the largest kept test in the suite, asserting a chrome tier's measurements), `at0377`-session-row-stack, `at0383`-session-row-title-measure, `at0384`-session-tape-vertical, `at0386`-session-description-hover, `at0390`-compose-strip-overflow, `at0392`-card-chrome-tiers, `at0392`-sheet-over-tall-entry, `at0394`-sheet-width-nesting, `at0397`-kbf-paint-route, `at0398`-chord-ring.

This is the largest deletable cluster by line count. Every one measures something that is *visible*. A masthead at the wrong height, a row at the wrong tint, a tooltip with the wrong chord — these are caught by opening the app, and they are the class of change most likely to be *deliberate*, which means these tests fail on purpose constantly and get repaired rather than consulted.

`at0375-session-masthead` is the one worth pausing on: 1,184 lines is a lot to delete. But it is 64 assertions about a chrome tier's geometry, and it is in the top-13 churn list at 13 repair commits. It is a design spec transcribed as a test.

### Card-creation and singleton checks (5 files)

`at0041`-gallery-close-reopen, `at0082`-gallery-shipped-renderers, `at0153`-about-singleton, `at0154`-settings-singleton, `at0355`-keyboard-card.

Your exact example. `at0153` boots an empty deck, dispatches the About action, verifies the About card appears, dispatches it again, verifies a second one did not appear. Two of a card is a bug you find the first time you press the menu item twice. `at0154` has been repaired 11 times.

### Lens over-coverage (16 of 26 files)

The Lens rail carries 26 test files. Deleting: `at0230`-pinned-lens-geometry, `at0233`-lens-reorder-escape, `at0245`-jots-click-scroll, `at0248`-lens-list-cursor-keys, `at0254`-jots-editor-growth, `at0255`-jots-followons, `at0256`-lens-focus-carrier, `at0269`-lens-card-dirty-dot, `at0276`-lens-side-persists, `at0282`-lens-row-arrow-escape, `at0287`-lens-row-action-not-a-pick, `at0290`-jot-delete-confirm-anchor, `at0296`-lens-row-is-the-handle, `at0297`-lens-empty-label-row-height, `at0299`-lens-edge-drag, `at0313`-lens-cards-group-reorder, `at0351`-lens-band-keyboard.

Keeping 9, spanning the toggle, relaunch survival, ⌘L focus, cross-section arrows, the two-level Cards section, reorder, filter, row accessories, and the Jots editor. One sidebar does not need 26 process launches.

### Session identity presentation (10 of 15 files)

`at0374`, `at0375`, `at0377`, `at0378`, `at0379`, `at0381`, `at0383`, `at0384`-atom-live-face, `at0384`-tape-vertical, `at0385`, `at0386`-description-hover.

Fifteen files on how a session is *named and displayed*. Keeping `at0373` (one resolver, and it is reactive — the actual logic), `at0376` (the atom on the real pasteboard — a real data path), `at0380` (resume-by-tag — addressability), `at0387` (the identity menu's copies).

### Primitive-level tests already driven end-to-end by a kept test (~40 files)

`at0059` (anchor save — `at0061` proves save *and* apply), `at0060`, `at0098` (`at0097` drives `/rewind` end-to-end), `at0101`, `at0102`, `at0103`, `at0139` (`at0140` drives cycle mode through the session card), `at0142`, `at0176`, `at0179`, `at0180`×2, `at0193`-compact-native-reload, `at0195`, `at0202`, `at0203`, `at0206`, `at0215` (`at0340` covers composer routes), `at0217`, `at0237` (`at0188` covers the copy path), `at0249`, `at0251`, `at0270`, `at0271` (`at0339` covers find), `at0283`-page-not-a-scroller, `at0308` (`at0307` covers the annotator), `at0337`, `at0338`, `at0342`, `at0348`, `at0350`, `at0354`, `at0396` (`at0213`/`at0306` cover Open Quickly), `at0399`, and the remainder listed in the appendix.

### Bug-report fossils (4 files)

`at0045`-cmd-a-after-typing, `at0046`-first-responder-after-button-click, `at0048`-caret-rendering, `at0049`-no-doubled-caret. All four cite "Step 9.5B / 9.6 manual checkpoint" — they are transcriptions of individual bug reports from a 2026 editor push, guarding hacks that were subsequently deleted.

## What survives, and why

**must-keep (59)** clusters as: cold-boot and relaunch restore (9), the focus engine's routing core (12), session and turn correctness including transport recovery (8), the scroll/eviction spine (6), changes and commit ledger integrity (6), files written to disk (2), the layout imposer (3), host menu and keymap contracts (3), permission writes to real settings files (4), Lens core (2), process hygiene and perf floors (3), plus the harness smoke floor.

These share one property: **you cannot see them fail.** A serialization axis silently dropped, a turn replayed twice, a scroll write that steals the viewport from the user, a hunk attributed to the wrong session, an unflushed save on quit, a SIGKILL on teardown. Every one is a bug that ships.

**should-keep (109)** is one file per feature. If you want to go further later, this is the band to cut from — but cutting it trades coverage for time honestly, whereas cutting the delete band costs nothing at all.

## Expected effect

Deleting the 185 files removes 43,758 lines and, more importantly, 185 `Tug.app` launches from the corpus. On the selection path that actually governs your day:

- `focus-manager.ts`: 68 → **37** selected tests
- `tug-list-view.tsx`: 27 → **16**
- `tug-text-editor/`: 29 → **18**
- `tug-prompt-entry.tsx`: 25 → **16**

`MAX_SELECTED = 20` becomes a budget the suite can actually live inside again, rather than one the `ACCEPTED_FANOUT` table exists to apologize for.

## Appendix — the complete partition

Generated from the working tree; every `*.test.ts` in `tests/app-test/` appears exactly once.

### must-keep (      59 files)

at0000-smoke — 43 lines
at0001-tab-switch-fc — 272 lines
at0003-pane-activation — 305 lines
at0016-tab-close-handoff — 268 lines
at0010-cold-boot-selection — 395 lines
at0014-cold-boot-scroll — 281 lines
at0017-savestate-rpc-parity — 139 lines
at0024-prompt-state-roundtrip — 757 lines
at0027-layout-state-persistence — 444 lines
at0037-deck-wide-restore-consistency — 694 lines
at0126-keyboard-ring-cold-boot — 212 lines
at0246-focus-boot-invariant — 208 lines
at0279-quit-draft-survival — 183 lines
at0109-focus-ring — 157 lines
at0165-activation-first-responder — 385 lines
at0224-card-active-keyboard — 664 lines
at0250-focus-steal-trap — 190 lines
at0267-drag-activation-focus — 451 lines
at0268-focus-projection — 296 lines
at0269-gesture-classification — 175 lines
at0295-background-activation-click — 188 lines
at0344-activation-click-drill-down — 203 lines
at0084-session-lifecycle-coordination — 509 lines
at0191-turns-end-to-end — 263 lines
at0192-z2-cold-replay — 361 lines
at0197-scheduled-survives-respawn — 169 lines
at0216-shell-exchange — 376 lines
at0285-restore-dead-branch — 187 lines
at0286-multi-compaction-seating — 221 lines
at0335-transport-reconnect-recovery — 313 lines
at0083-list-view-submit-pin — 514 lines
at0190-transcript-anchor-restore — 198 lines
at0330-transcript-eviction — 877 lines
at0333-follow-bottom-unattributed — 579 lines
at0335-scroll-displacement — 682 lines
at0336-conservation-probe — 536 lines
at0253-commit-dialog — 150 lines
at0332-changes-claim-disclaim — 189 lines
at0333-changes-hunk-ids — 338 lines
at0334-changes-hunk-election — 462 lines
at0335-changes-hunk-contention — 445 lines
at0353-shell-route-session-trailer — 276 lines
at0209-text-card-live-autosave — 382 lines
at0212-text-card-manual-save — 727 lines
at0294-imposer-flip-settle — 654 lines
at0303-imposer-space-allocator — 525 lines
at0401-sidebar-split — 709 lines
at0168-menu-structure — 299 lines
at0174-edit-menu-validation — 362 lines
at0182-keymap-override — 400 lines
at0093-permission-buckets — 240 lines
at0094-permission-scope-routing — 205 lines
at0145-permission-dialog-keyboard — 337 lines
at0146-question-dialog-keyboard — 750 lines
at0231-lens-toggle-focus — 261 lines
at0247-relaunch-lens-keyboard — 298 lines
at0282-quiesce-no-sigkill — 64 lines
at0292-idle-silence — 234 lines
at0293-typing-latency — 248 lines

### should-keep (     109 files)

at0004-app-resign-return — 172 lines
at0006-cross-pane-drag — 194 lines
at0007-card-detach — 174 lines
at0021-drag-aborted — 170 lines
at0040-multi-tab-close-confirm — 510 lines
at0193-deselect-renav — 122 lines
at0284-title-bar-floor — 168 lines
at0332-pane-occlusion — 334 lines
at0347-stack-badge-picker — 527 lines
at0357-content-width-default — 261 lines
at0359-sidebar-stack — 236 lines
at0361-lateral-card-ring — 255 lines
at0362-height-pinned-imposed — 211 lines
at0371-card-width-chords — 202 lines
at0372-bullseye — 797 lines
at0014-scroll-persistence — 220 lines
at0018-async-content-race — 173 lines
at0019-pane-teardown-flush — 152 lines
at0025-prompt-deactivated-roundtrip — 563 lines
at0026-overlay-persistence — 259 lines
at0032-em-cold-boot-selection — 182 lines
at0061-region-scroll-anchor-apply — 425 lines
at0331-region-scroll-anchor-one-shot — 370 lines
at0010-markdown-selection — 304 lines
at0023-cross-card-selection — 185 lines
at0038-deactivation-inactive-paint — 792 lines
at0298-transcript-shift-extend — 411 lines
at0388-press-collapses-selection — 211 lines
at0042-tug-text-editor-state-roundtrip — 675 lines
at0043-tug-text-editor-copy-diag — 399 lines
at0137-textarea-cut-paste — 161 lines
at0229-prompt-markdown-styling — 315 lines
at0269-markdown-text-style-constructs — 343 lines
at0343-prompt-arrow-history — 248 lines
at0345-editor-ring-mode-division — 332 lines
at0400-tab-release — 209 lines
at0112-button-focus — 177 lines
at0121-list-view-container-focus — 225 lines
at0127-list-view-cursor — 138 lines
at0140-cycle-session-card — 683 lines
at0141-picker-keys — 326 lines
at0143-descend-escape-ascend — 184 lines
at0148-dialog-survives-reactivation — 211 lines
at0157-cycle-escape-two-pane — 261 lines
at0175-session-mount-focus — 427 lines
at0252-accessibility-focus-follows — 229 lines
at0272-focus-reveal — 312 lines
at0278-lens-cmdl-focus-stability — 343 lines
at0312-focus-attr-stability — 146 lines
at0341-lens-cross-section-arrows — 383 lines
at0051-completion-popup-escapes-card — 572 lines
at0057-popup-in-sheet-stacking — 244 lines
at0100-sheet-pane-modal-focus — 148 lines
at0178-sheet-focus-trap — 111 lines
at0218-alert-chooser-rows — 215 lines
at0320-app-test-ask-dialog — 448 lines
at0167-file-menu-close-validation — 221 lines
at0169-menu-deck-validation — 269 lines
at0172-session-menu-live-state — 228 lines
at0181-keymap-chord-sweep — 202 lines
at0088-permission-mode-chip — 219 lines
at0090-permissions-rules-editor — 299 lines
at0096-effort-chip — 306 lines
at0097-rewind-sheet — 168 lines
at0099-resume-command — 152 lines
at0105-api-retry-banner — 236 lines
at0106-compact-boundary-divider — 143 lines
at0188-transcript-copy-wiring — 403 lines
at0189-transcript-atbottom-no-slam — 211 lines
at0200-assistant-defaults — 515 lines
at0201-session-card-activation-click-focus — 233 lines
at0205-atom-chip-first-paint — 386 lines
at0211-btw-side-question-overlay — 296 lines
at0222-one-shot-commands — 326 lines
at0225-clickable-slash-commands — 391 lines
at0226-usage-sheet — 244 lines
at0239-session-history-view — 319 lines
at0268-session-history-paging-filter — 506 lines
at0280-shared-agent-absent — 242 lines
at0307-transcript-file-path-links — 1068 lines
at0339-session-find-bar — 846 lines
at0340-composer-routes — 304 lines
at0346-annotation-atom-and-entity — 377 lines
at0352-shell-row-copy — 228 lines
at0372-ai-config-mixer — 392 lines
at0373-session-identity-rename — 256 lines
at0376-session-atom-clipboard — 413 lines
at0380-resume-by-tag — 160 lines
at0387-error-block-follow-bottom — 527 lines
at0387-session-identity-menu — 494 lines
at0210-text-card-options — 319 lines
at0213-open-quickly — 219 lines
at0223-text-card-find-bar — 355 lines
at0241-jots-editor — 328 lines
at0257-lens-session-reorder — 350 lines
at0265-picker-filter — 412 lines
at0266-lens-filter — 327 lines
at0277-lens-row-accessories-keyboard — 391 lines
at0281-configure-tug-on-demand — 187 lines
at0304-settings-default-project-dir — 126 lines
at0306-open-quickly-default-dir — 901 lines
at0310-file-view-open — 515 lines
at0311-pdf-viewer-controls — 328 lines
at0312-lens-cards-two-level — 415 lines
at0356-settings-sections-persist — 157 lines
at0360-project-diff-card — 184 lines
at0365-gazette-card — 304 lines
at0369-open-file-neighbor-slot — 190 lines
at0136-stale-reapply-clobber — 126 lines

### can-delete (     185 files)

at0001-rapid-cadence — 145 lines
at0002-tab-switch-em — 170 lines
at0003-rapid-cadence — 154 lines
at0005-app-hide-unhide — 149 lines
at0006-em-cross-pane — 165 lines
at0007-em-card-detach — 142 lines
at0009-em-inactive-mount — 177 lines
at0016-rapid-cadence — 152 lines
at0020-overlay-focus-return — 169 lines
at0022-caret-visibility — 168 lines
at0030-virtual-focus — 372 lines
at0033-em-fresh-card-activation — 150 lines
at0034-em-focus-after-move — 203 lines
at0035-dev-app-switch-selection — 221 lines
at0035-em-app-switch-selection — 200 lines
at0039-title-bar-return-focus-restore — 372 lines
at0041-gallery-close-reopen — 211 lines
at0044-tug-text-editor-clipboard-stress — 298 lines
at0045-tug-text-editor-cmd-a-after-typing — 130 lines
at0046-tug-text-editor-first-responder-after-button-click — 212 lines
at0048-tug-text-editor-caret-rendering — 275 lines
at0049-tug-text-editor-no-doubled-caret — 344 lines
at0052-completion-cancels-on-sibling-popup — 224 lines
at0053-completion-cancels-on-peer-card-click — 186 lines
at0054-completion-escape-still-cancels — 154 lines
at0055-popup-close-restores-editor-focus — 219 lines
at0056-popup-outside-click-skips-restore — 186 lines
at0058-popup-in-sheet-close-focus — 236 lines
at0059-region-scroll-anchor-save — 264 lines
at0060-list-view-content-settled — 237 lines
at0078-dev-engine-focus-survives — 153 lines
at0080-dev-focus-card-switch — 136 lines
at0081-dev-focus-reload — 171 lines
at0082-gallery-shipped-renderers — 244 lines
at0087-tug-badge-two-line — 230 lines
at0091-recently-denied — 185 lines
at0092-workspace-directories — 246 lines
at0098-rewind-mount-identity — 246 lines
at0101-slash-command-pane-scope — 218 lines
at0102-default-button-pane-scope — 156 lines
at0103-submit-accepts-completion — 135 lines
at0108-unknown-event-banner — 166 lines
at0110-selection-accent — 121 lines
at0113-checkbox-focus — 161 lines
at0114-switch-focus — 159 lines
at0115-slider-focus — 155 lines
at0116-tab-bar-focus — 182 lines
at0117-radio-group-focus — 224 lines
at0118-choice-group-focus — 220 lines
at0119-option-group-focus — 186 lines
at0120-accordion-focus — 250 lines
at0122-list-view-subordinate-focus — 118 lines
at0125-background-tab-focus-isolation — 106 lines
at0128-ctx-menu-input-selection — 114 lines
at0131-textarea-paste-menu — 130 lines
at0139-cycle-mode-scope — 123 lines
at0142-single-select-keyboard — 214 lines
at0147-question-nav-focus — 239 lines
at0149-dialog-enter-after-tab — 195 lines
at0150-sheet-spatial-order — 191 lines
at0151-confirm-popover-editor-restore — 145 lines
at0153-about-singleton — 129 lines
at0154-settings-singleton — 131 lines
at0155-settings-propagation — 127 lines
at0156-title-bar-controls — 82 lines
at0158-menu-escape-close-focus — 173 lines
at0159-alert-escape — 189 lines
at0160-context-menu-escape — 102 lines
at0161-question-dialog-geometry — 261 lines
at0162-button-ctrl-click-no-activate — 110 lines
at0163-sheet-focus-language — 144 lines
at0164-alert-focus-language — 132 lines
at0166-close-confirm-multitab-and-close-all — 231 lines
at0171-session-menu-card-type — 172 lines
at0173-settings-shortcut — 134 lines
at0176-tab-accepts-completion — 178 lines
at0177-permission-cycle-keys — 161 lines
at0179-dynamic-keybinding — 131 lines
at0180-command-registry-gates — 166 lines
at0180-list-accessory-keyboard — 274 lines
at0193-compact-native-reload — 228 lines
at0195-atom-selected-appearance — 179 lines
at0196-z4b-chip-buttons — 193 lines
at0197-deactivation-caret-no-wash — 153 lines
at0198-wake-trigger-chip — 149 lines
at0199-confirm-popover-stale-within-ring — 112 lines
at0202-question-review-reveal — 389 lines
at0203-dialog-focus-on-card-click-back — 338 lines
at0204-prompt-entry-text-surface — 233 lines
at0206-z2-popup-list — 399 lines
at0208-transcript-attribution-gap — 345 lines
at0209-picker-field-click-single-focus — 128 lines
at0215-composer-route-chrome — 294 lines
at0217-sheet-default-ring-click-back — 222 lines
at0219-work-revamp — 205 lines
at0220-settings-chips-turn-lock — 200 lines
at0230-perf-idle-quiet — 142 lines
at0230-pinned-lens-geometry — 227 lines
at0233-lens-reorder-escape — 254 lines
at0237-transcript-command-copy — 243 lines
at0239-compact-summary-inline — 200 lines
at0245-jots-click-scroll — 169 lines
at0248-lens-list-cursor-keys — 200 lines
at0249-engine-scroll-keys — 173 lines
at0251-dialog-steal-budget — 142 lines
at0254-jots-editor-growth — 326 lines
at0255-jots-followons — 337 lines
at0256-lens-focus-carrier — 161 lines
at0264-commit-receipt-geometry — 111 lines
at0265-commit-sha-right-click — 174 lines
at0269-lens-card-dirty-dot — 203 lines
at0270-addcard-default-focus — 128 lines
at0271-find-tool-headers — 314 lines
at0273-list-row-press — 141 lines
at0274-progress-dot-envelope — 366 lines
at0276-lens-side-persists — 187 lines
at0276-progress-dot-crossing — 716 lines
at0278-update-bulletin — 89 lines
at0282-lens-row-arrow-escape — 216 lines
at0282-session-row-levels — 400 lines
at0283-list-row-striping — 267 lines
at0283-page-not-a-scroller — 230 lines
at0283-pulse-typography — 399 lines
at0287-lens-row-action-not-a-pick — 249 lines
at0288-motion-residency — 315 lines
at0289-transcript-motion-hygiene — 235 lines
at0290-jot-delete-confirm-anchor — 234 lines
at0291-perf-instruments — 297 lines
at0296-lens-row-is-the-handle — 176 lines
at0297-lens-empty-label-row-height — 125 lines
at0299-lens-edge-drag — 236 lines
at0300-layouts-five-six-up — 166 lines
at0302-imposed-resize-click — 232 lines
at0305-picker-seeds-default-dir — 93 lines
at0308-transcript-commit-shas — 230 lines
at0310-commit-receipt-annotations — 262 lines
at0313-lens-cards-group-reorder — 366 lines
at0334-text-card-markdown-return — 176 lines
at0337-extent-floor-phantom — 201 lines
at0338-slot-chords — 318 lines
at0339-focus-marks-background-window — 179 lines
at0342-picker-arrow-traversal — 166 lines
at0348-reveal-stack-chord — 209 lines
at0349-stack-picker-foreground — 192 lines
at0350-cycle-stack-ring — 264 lines
at0351-lens-band-keyboard — 267 lines
at0353-selection-wash-focus-independent — 193 lines
at0354-insert-file-composer — 226 lines
at0355-keyboard-card — 95 lines
at0358-slim-width-regression — 332 lines
at0363-action-tooltip-shortcut — 239 lines
at0364-commit-receipt-path-gestures — 230 lines
at0366-mention-trailing-punctuation — 199 lines
at0367-button-activity — 262 lines
at0368-transcript-stamp-date-context — 300 lines
at0370-sparkline-registration — 417 lines
at0374-session-identity-tiers — 271 lines
at0375-session-masthead — 1184 lines
at0377-session-row-stack — 386 lines
at0378-history-session-citation — 298 lines
at0379-session-synopsis — 259 lines
at0381-session-citation-surfaces — 226 lines
at0382-text-card-list-hanging-indent — 173 lines
at0383-session-row-title-measure — 193 lines
at0384-session-atom-live-face — 222 lines
at0384-session-tape-vertical — 174 lines
at0385-masthead-rest-facts — 186 lines
at0386-gutter-line-selection — 170 lines
at0386-session-description-hover — 217 lines
at0389-resume-session-neighbor-slot — 195 lines
at0390-compose-strip-overflow — 367 lines
at0391-open-diff-neighbor-slot — 169 lines
at0392-card-chrome-tiers — 588 lines
at0392-sheet-over-tall-entry — 300 lines
at0393-composer-atom-open-file — 190 lines
at0394-sheet-width-nesting — 216 lines
at0396-open-quickly-arrows — 556 lines
at0397-kbf-paint-route — 209 lines
at0398-chord-ring — 317 lines
at0399-shade-focus — 310 lines
at9995-textcard-ring-probe — 225 lines
at9996-anim-island-lab — 2659 lines
at9997-scratch-jot-heavy-deck — 537 lines
zzscratch-keymap-scoped — 92 lines
zzscratch-keymap-trace — 75 lines

## Follow-on: the AT-tag registry, retired

`tuglaws/app-test-inventory.md` was deleted on 2026-08-11.

It was the "canonical AT-tag catalog," and both `tests/app-test/README.md` and `tuglaws/app-test-harness.md` carried a hard invariant pointing at it: every `at{NNNN}-*.test.ts` prefix MUST match an entry there, and the entry MUST be added before the test was written. **Nothing enforced either half.** Measured at deletion time:

- 208 catalog entries against 157 live test numbers.
- **78 of the live numbers had no entry at all** — the index stopped tracking new tags around AT0181, so roughly half the suite it claimed to catalog was invisible to it. This predates the suite reduction; it was already true on 2026-08-10.
- 10 live numbers gate two or three unrelated tests apiece (`at0335-` prefixes three), directly against the file's own "one tag = one regression" rule.

The reduction made the drift visible rather than causing it. The choice was to reconcile 185 retired entries and author 78 missing ones, or to stop keeping a second copy of the truth that no tool reads. The second copy went.

What replaced it: the directory listing is the registry, the header docblock says what a test is for, and `@covers` says what it gates — and `@covers` is the one that never drifted, because `just app-test-covers-check` reads it on every selection. The naming rule now lives in `app-test-harness.md`, including the honest admission that numbers may collide and that a collision is untidy rather than broken.

References repaired, not left dangling: `tuglaws/INDEX.md`, `tuglaws/app-test-harness.md`, `tuglaws/state-preservation.md` (a 12-row table of deep anchor links became a table of links to the actual test files), `tuglaws/lifecycle-delegates.md`, `tests/app-test/README.md`, and one stale comment in `at0038`. Archived roadmap docs keep their mentions — they are historical records of what was true when written.

## Correction: three suites restored, and the grading rule that missed them {#correction-kbf}

*2026-08-11, from the KBF audit.* Three files are back: **at0397**-kbf-paint-route, **at0398**-chord-ring, **at0399**-shade-focus. All three pass unmodified against current `main`, and `ACCEPTED_FANOUT` for `focus-manager.ts` went 26 → 29 to carry them, deliberately and with the reason recorded in place.

**What went wrong, and it is a flaw in the rubric rather than in any one call.** at0397 and at0398 were graded under *typography, geometry, and pixel cosmetics* — the band whose justification is "every one measures something that is *visible*", so opening the app catches it. That reasoning is sound for a masthead's height and wrong for these two, and the difference is worth stating because it will recur: **they read computed style, but what they assert is an engine rule.** at0397 pins the paint keying on the keyboard ROUTE — a granted caret stands the marks down while the mode stays engaged — which was four commits old at deletion and is the least-settled rule in the focus model. at0398 pins the dashed default ring resolving to solid only under an *exclusive* modifier: a promise about which key fires a button, where being wrong means the interface lies rather than looks off. at0399 was graded under *primitive-level, already driven end-to-end*, and nothing else drives its rules (a covered stop leaves the walk; a shade signal carries its name, not a boolean).

The rubric's bands sort by **how a failure reaches you**, which is right, and the misgrade came from reading the assertion's *instrument* instead of its *subject*. A `getComputedStyle` call is not a cosmetic test when the thing it is measuring is whether the engine and the paint agree. That distinction has teeth here specifically because this phase's recorded failure mode is the opposite one — at0345 shipped a ring that painted nothing for a whole phase by asserting the attribute and never the pixel — so in the focus engine, reading pixels is how you check an engine claim, not a sign that you are checking a cosmetic one.

Two more consequences worth carrying:

- **The doctrine was left citing them.** `tuglaws/focus-language.md` said "Pinned by at0397 / at0398 / at0399" for four days after the files were gone; across `tuglaws/` twenty cited suites did not exist. A claim of proof is worse than an admitted gap, because nobody re-derives what a document says is already covered. The four whose deletion still stands (at0202, at0203, at0204, at0251) now read as **unpinned**, by name, in the doctrine.
- **at0398 was not deleted by this audit at all.** It went in `975ce03f3`, a sidebar-split commit, which nothing in this document proposed. A test file leaving the tree in an unrelated commit is its own class of problem and is the reason the existence sweep is worth re-running after a cull, not just before one.
