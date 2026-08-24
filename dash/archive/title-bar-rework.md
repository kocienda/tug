<!-- devise-skeleton v4 -->

## Title Bar Rework — Three Chrome Tiers, Adopted {#phase-slug}

**Purpose:** Take the three-tier card chrome ratified in the *Card Chrome Tiers* gallery spike — 72px document masthead / 36px utility title bar / 32px rail — out of the fixture and onto the shipping cards: the Text, File viewer, and Diff cards wear document mastheads, the Lens, Jots, and Gazette rails wear the flush racing-stripes rail chrome, and every utility card keeps the 36px bar it has today.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft (vetted 2026-08-10; five fixups folded in) |
| Target branch | main |
| Last updated | 2026-08-10 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The deck's chrome today has two heights (`tuglaws/pane-model.md` § "Chrome has two heights, and the taller one is a masthead"), and exactly one card wears the taller one: the Session card. The *Card Chrome Tiers* spike (`tugdeck/src/components/tugways/cards/gallery-card-chrome.tsx`, Maker ▸ Layout & Structure) proposed and ratified a third distinction: a **document** card (Text, File viewer, Diff) says its own name and where it lives in a 72px masthead; a **utility** card (Settings, Keyboard, gallery cards) keeps the 36px tinted bar; a **rail** (Lens, Jots, Gazette) — which the layout imposer already treats as a different kind of thing — wears a 32px flush bar with an uppercase tracked label, a tinted glyph, and racing stripes.

The chrome side of this is **already real, shipping code**, not spike code: `CardMastheadPayload` is a union (`session-masthead` | `card-masthead`) in `tugdeck/src/lib/card-title-store.ts`; `CardMasthead` (`tugdeck/src/components/tugways/card-masthead.tsx`) composes `TugSessionRow` on the shared `masthead-frame.css` tier exactly as the session masthead does; `CardTitleBar` (`tugdeck/src/components/chrome/tug-pane.tsx`) renders either masthead kind and takes a `sidebar` prop; and the full rail treatment lives in `tugdeck/src/components/tugways/tug-pane.css` under `.tug-pane-title-bar[data-role="sidebar"]`. What does not exist is any **publisher or role pass**: no shipping card publishes a `card-masthead` payload, and `TugPane` never passes `sidebar` to `CardTitleBar`, so outside the gallery fixture the document tier and the rail tier are dead code. This plan is the adoption: publishers, the role pass, the tokens, the icons, the Text card's chrome consolidation, the tests, and the doctrine updates.

Adoption also has to fix one thing the spike shipped broken. The document masthead never reserves the pane's control cluster, so its title and path currently run underneath the width button and the close box — see [P09]. That is a defect in code already on `main`, and it lands here because this is the plan that puts real filenames into that tier.

#### Strategy {#strategy}

- **Adoption is publication.** The chrome is generic and finished; each step teaches one card (or the pane) to use what already ships. No new tier component is authored anywhere in this plan.
- Fix the document masthead's control-cluster reserve **before** any card publishes into that tier, so no step ships a masthead that collides with the close box.
- Land the **rail** early — it is pure plumbing (a prop pass, a CSS rule relocation, three icons, one theme token) with no content decisions left.
- Land the **Text card** in two steps: first move its actions into the pane `…` menu (so the top bar has no remaining job), then publish the masthead, delete `TextCardTopBar`, move the save-state cell to the masthead's third line, and repair the three app-tests that deletion breaks.
- **File viewer** and **Diff** follow as small, independent publisher steps.
- Doctrine (`tuglaws/pane-model.md`, `tuglaws/design-decisions.md`) and the gallery fixture's "nothing is wired" docstring update once the code is true.
- New app-test coverage lands as its own step with `@covers` declarations, then one integration checkpoint sweeps the derived selection.

#### Success Criteria (Measurable) {#success-criteria}

- A Text card bound to a file shows a 72px masthead: filename (dirty dot in manual mode), start-truncated full path, and the save-state line — verified by app-test assertions on `[data-testid="card-masthead-title"]` / `-description` / `-detail` and a measured 72px `.tug-pane-title-bar` height.
- **No document masthead line overlaps the control cluster:** with a title long enough to fill the tier, the measured right edge of `.tug-list-row-title`'s text box is left of `.tug-pane-title-bar-controls`'s left edge ([P09]).
- The Text card renders **no** `text-card-top-bar` element, and Save / Move To… / Editor Options are reachable from the pane `…` menu (`[data-testid="tug-pane-title-bar-menu-button"]`), each dispatching its registry command ([P10]).
- Menu-item enablement matches the command registry, not a card-local opinion: with a clean titled buffer, the `…` menu's Save row and File ▸ Save are both disabled ([P10], [L30]).
- A File viewer card and a Project Diff card each show a masthead with the content in **Table T01**, and neither pane changes chrome height after mount ([P11]).
- A pinned Lens/Jots/Gazette pane's bar is 32px, flush (`background-color` = `--tugx-pane-bg`), with an uppercase tracked label and both stripe bands — and `--tugx-pane-chrome-height` reads 32px **on the pane element**, not just the bar.
- Utility cards (Settings, Keyboard, About, gallery) are pixel-unchanged at 36px.
- `cd tugdeck && bunx tsc --noEmit` and `bunx vite build` clean; `bun run audit:theme-contrast` passes; `just app-test-covers-check` passes; the derived app-test selection passes, including the three repaired tests in (#breaking-tests).

#### Scope {#scope}

1. The document masthead's control-cluster reserve in `card-masthead.css`.
2. `TugPane` → `CardTitleBar` sidebar role pass, pane-level role stamp from `layoutRole`, rail chrome-height publication at pane scope, `--tug-rail-chrome-height` in the six themes.
3. Rail icons for Lens, Jots, Gazette.
4. Text card: `…` menu migration as command references (Save / Move To… / Reveal in Finder / Editor Options sheet), masthead publication, `TextCardTopBar` deletion, save-state relocation out of the status bar.
5. File viewer card masthead publication.
6. Diff card masthead publication.
7. Repair of the three app-tests the deletion breaks (#breaking-tests).
8. Doctrine updates: `tuglaws/pane-model.md`, `tuglaws/design-decisions.md` (including the stale width-control paragraph), gallery fixture docstring.
9. New app-test coverage for the document masthead and the rail tier.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No change to the Session card's masthead, `SessionMasthead`, `TugSessionRow`, or `masthead-frame.css` — they are the finished substrate this plan mounts things on. (`card-masthead.css` **is** touched, for the reserve alone — [P09].)
- No re-litigation of the rail treatment. Racing stripes are settled: flush ground, three 1px stripes on a 3px pitch, neutral ink only, focus signaled by brightening — never the accent color, never a hue change.
- No masthead for utility cards, the Pulse card, or the About card; no rail chrome for anything but the three `layoutRole: "sidebar"` cards.
- No redesign of the Text card's find bar, conflict sheets, or the status bar's settable/number clusters — only the save cell moves.
- No changes to the tab-bar metrics: the masthead and the tab bar stack (72 + 36); tab rows stay on `--tug-chrome-height`.
- No general rework of `paneTitleBarMenuStore`'s consumers — it has none; [P10] settles its item shape before it acquires any.

#### Dependencies / Prerequisites {#dependencies}

- The shipped chrome substrate, all already on `main`: `CardMasthead` + `masthead-frame.css` (commit `683c08269` and the follow-up that made both mastheads mount `TugSessionRow`), the `CardMastheadPayload` union, `CardTitleBar`'s `masthead` and `sidebar` props, and the rail CSS in `tug-pane.css`.
- `paneTitleBarMenuStore` (`tugdeck/src/lib/pane-title-bar-menu-store.ts`) — generic infrastructure with **zero publishers today**; this plan is its first user.
- `command-registry.ts`'s existing `TUG_ACTIONS.SAVE` (`file.save`, ⌘S) and `TUG_ACTIONS.SAVE_AS` (`file.saveAs`, ⇧⌘S) entries, which the `…` menu references rather than re-implements.

#### Constraints {#constraints}

- Tugdeck verification: `bunx vite build` before declaring any change done (the debug app loads the prod rollup bundle); bun, never npm.
- App-tests are selective (`just app-test-changed` / explicit files); never a sweep, never piped output; new tests must carry `@covers`.
- Theme token work must pass `bun run audit:theme-contrast` (no theme may exceed the brio budget).
- [L30]'s lint in `command-registry.ts` fails the build on any action that is neither a command wire nor in `ACTIONS_OUTSIDE_THE_TABLE` — so [Q04] cannot be skipped silently.
- Only the user commits on `main`; `/tugplug:implement` commits per-step on its dash worktree only.

#### Assumptions {#assumptions}

- The 32px rail height from the spike is the ratified height (the spike's open question defaulted to what shipped in `tug-pane.css`'s fallback; nothing in review moved it).
- The three `layoutRole: "sidebar"` registrations are the complete rail set; a fourth would inherit the chrome automatically ([P04]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `**References:**` and `**Depends on:**` lines on every step, no line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where do the Text card's actions go? (DECIDED) {#q01-text-actions}

**Question:** When the masthead takes the path line, where do the top bar's Save / Move To… button and the editor-options gear go?

**Resolution:** DECIDED (see [P02]) — user chose the pane `…` menu, 2026-08-10. `TextCardTopBar` is deleted; the gear's popover becomes an Editor Options sheet because a menu item cannot anchor a popover.

#### [Q02] Does a document masthead carry a third line, and what does the Text card's say? (DECIDED) {#q02-third-line}

**Question:** Two or three lines for document mastheads; the Text card's candidate facts already live in its bottom status bar.

**Resolution:** DECIDED (see [P03]) — user directive, 2026-08-10: "move this save data to the third line in the title bar. Leave all the other metadata and controls that are on the bottom now right where they are." The Text card's third line is the save state, moved out of the status bar; the status bar keeps its settable pair (line ending, language) and number pair (caret, counts). File viewer and Diff publish the third-line content in **Table T01**.

#### [Q03] Image dimensions on the File viewer's third line (DEFERRED) {#q03-image-dimensions}

**Question:** The spike's File viewer example showed `PNG · 2560 × 812 · 341 KB`. `ImageBlock` does not currently expose `naturalWidth/Height` upward, and the card streams bytes via `<img src=blobUrl(path)>` so it never holds a byte count.

**Resolution:** DEFERRED — initial adoption publishes the kind label (and PDF page count, which `PdfView` already knows via `doc.numPages`). Wiring an intrinsic-size callback out of `ImageBlock` is a follow-on (#roadmap); the masthead's `detail` accepts it without structural change when it arrives.

#### [Q04] Do `Editor Options…` and `Reveal in Finder` get command-registry entries? (OPEN) {#q04-new-commands}

**Question:** [P10] routes every `…` item through `dispatchCommand`. Two of the four have no entry today: `Editor Options…` is new, and `TUG_ACTIONS.REVEAL_IN_FINDER` is currently declared in `ACTIONS_OUTSIDE_THE_TABLE` as a context-menu verb over a sampled target.

**Why it matters:** [L30]'s lint fails on an action that is neither a command wire nor declared outside the table, so this cannot be left implicit. The classification is also a real judgment rather than paperwork: a context-menu verb acting on whatever the pointer sampled is a genuinely different thing from a named row in a pane menu that always means "this card's file."

**Options:**
- `Editor Options…` — a full entry with a `menuItemId` (a native menu door too), or an entry with `internal: true` plus a comment naming what blocks a door.
- `Reveal in Finder` — promote to a table entry with a card-scoped meaning; or leave `REVEAL_IN_FINDER` outside the table and give the menu row its own card-scoped command id; or drop the row entirely and wait for the actionable-description follow-on (#roadmap).

**Plan to resolve:** Decide while writing the entries in #step-3. The registry lint is the forcing function — it fails the build if this is skipped.

**Resolution:** DECIDED in #step-3 — both become **new** key-card entries with a `paneMenu: true` door declaration. (Key-card, not first-responder: pressing the pane's `…` button promotes the PANE, so a first-responder walk starts above the card and never enters it. And `paneMenu` rather than `internal`: the pane menu IS their door — `internal` would have claimed they have none, which is the opposite of true, and would have hidden them from the keymap pane. The door-coverage lint counts native menu items and key equivalents, so it needed teaching, which is the field.) `Editor Options…` is `TUG_ACTIONS.SHOW_EDITOR_OPTIONS`. `Reveal in Finder` is `TUG_ACTIONS.REVEAL_CARD_FILE`, deliberately *not* `REVEAL_IN_FINDER`: that action means "the path the pointer sampled" and carries the path as its payload, while a pane-menu row has no pointer target and always means the card's own document, which only the chain can resolve. `REVEAL_IN_FINDER` therefore stays in `ACTIONS_OUTSIDE_THE_TABLE` unchanged.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Payload churn re-notifying the store per keystroke | med | low | R01 | profiler shows title-store notifies during typing |
| Rail height at pane scope regresses scrim/sheet/banner seats | med | low | R02 | any surface floats 4px high on a rail |
| Losing the save affordance's visibility | low | med | R03 | user feedback after landing |
| Test repairs mis-scoped (masthead is pane chrome, not card body) | med | med | R04 | a repaired assertion returns null |

**Risk R01: Save-state on the third line makes `cardTitleStore.set` chatty** {#r01-title-store-churn}

- **Risk:** The Text card's masthead payload now changes on every save-state transition and dirty flip; a naive publisher could call `set` per keystroke.
- **Mitigation:** The publisher effect depends only on `snapshot.fileName`, `snapshot.readOnly`, `snapshot.saveMode`, `snapshot.saveState`, `snapshot.conflict`, `snapshot.lastSavedAt`, `isDirty`, and the path — the same facts the status bar already re-renders on. `CardTitleStore.set` is equality-guarded (`sameMasthead` compares every `DocumentMastheadPayload` field), so an unchanged payload never notifies.
- **Residual risk:** `saveState === "editing"` still flips once per edit burst; that is one store notify, same cost as today's dirty-dot title update.

**Risk R02: Moving the rail chrome-height to pane scope changes four consumers' geometry** {#r02-pane-scope-height}

- **Risk:** `--tugx-pane-chrome-height` at 32px on the pane now positions the pane scrim's top, the sheet clip's top, and the pane banner's top on rails — surfaces the spike never exercised.
- **Mitigation:** This is the *correct* seating (the bar really is 32px tall; a scrim seated at 36px would leave a 4px lit strip). The app-test step asserts the pane-level property value and the bar height together.
- **Residual risk:** None identified; rails rarely host sheets, and the Lens's own surfaces live below the bar regardless.

**Risk R03: Save loses its always-visible button** {#r03-save-visibility}

- **Risk:** Save moves from a persistent icon to a `…` menu row; the save *state* stays visible (masthead third line) but the *gesture* takes one more click.
- **Mitigation:** ⌘S and the native File ▸ Save are untouched and remain the primary gestures — and under [P10] the menu row is literally the same registry entry, so it can never disagree with them. The masthead's third line makes the state more visible than the old status-bar cell.
- **Residual risk:** Pointer-first users lose a one-click Save; accepted by [Q01]'s resolution.

**Risk R04: The repaired assertions look in the wrong place** {#r04-test-scope}

- **Risk:** `at0212`'s save-cell assertions are scoped `${CARD} [data-testid="text-card-status-save"]` — inside the card body. The masthead lives in the **pane's title bar**, which is not a descendant of the card element, so a mechanical testid swap under the same prefix silently matches nothing.
- **Mitigation:** (#breaking-tests) names this explicitly; the repaired selectors are pane-scoped, and the step's checkpoint runs the three files rather than trusting the edit.
- **Residual risk:** None once the tests run green; a null-matching selector fails loudly in this harness.

---

### Design Decisions {#design-decisions}

#### [P01] Adoption is publication; the chrome is finished (DECIDED) {#p01-adoption-is-publication}

**Decision:** No step in this plan authors a new chrome tier, masthead component, or rail treatment. Every step either publishes into an existing channel (`cardTitleStore`, `paneTitleBarMenuStore`), passes an existing prop (`sidebar`), or fixes a defect in the existing tier ([P09]).

**Rationale:**
- `CardMasthead` already composes `TugSessionRow` on `masthead-frame.css`; a second ladder anywhere is the exact defect two review rounds just removed.
- `CardTitleBar` already branches on `masthead.kind` and `sidebar`; the gallery fixture proves both paths against real tokens.

**Implications:**
- Implementation diffs are almost entirely in card files and `tug-pane.tsx`'s mount site. `card-masthead.tsx`, `masthead-frame.css`, and `session-masthead.*` see **no** edits; `card-masthead.css` gains exactly the two reserve rules in [P09] and nothing else; `tug-pane.css` gains the one height relocation in [P04].

#### [P02] Text card actions migrate to the pane `…` menu; `TextCardTopBar` is deleted; the gear becomes an Editor Options sheet (DECIDED) {#p02-text-actions-menu}

**Decision:** The Text card publishes its actions via `paneTitleBarMenuStore` as **command references** ([P10]): **Save** (`TUG_ACTIONS.SAVE`), **Move To…** (`TUG_ACTIONS.SAVE_AS`), **Reveal in Finder** (bound non-draft buffers; classification per [Q04]), and **Editor Options…**, which opens a card sheet hosting the shared `TextCardControls`. `TextCardTopBar` (`text-card-top-bar.tsx`) is deleted along with its CSS block in `text-card.css`.

**Rationale:**
- Resolves [Q01] per the user's choice: one chrome tier, no strip under the masthead.
- A flat menu row cannot host or anchor the gear's `TugPopover`, so the options surface moves to the card's existing sheet idiom (the card already runs `renderSheet()` for save/conflict sheets; the options sheet joins that family, composing `TugSheet` + `TextCardControls`, both real Tug components).
- Nothing is being migrated in the store: `paneTitleBarMenuStore` has **no publishers today**, so the Text card is its first user and there is no existing item shape to preserve — which is what makes [P10]'s shape free to adopt.

**Implications:**
- The card publishes *which commands belong on this pane's menu*, not their labels or their gates ([P10]). The `disabled?: boolean` field an earlier draft of this plan proposed is **not** added — it is the second enablement opinion [L30] forbids.
- Publication is a `useLayoutEffect` keyed on facts that change *membership* (`saveMode`, `draftId`, `isPathPickerAvailable()`, whether the buffer is bound), cleared on unmount. Enablement is not a membership fact and never triggers a re-publish.
- The gear button and its popover disappear entirely; the sheet replaces both.

#### [P03] The Text card's third line is its save state, moved — not copied — from the status bar (DECIDED) {#p03-save-state-third-line}

**Decision:** The masthead `detail` is exactly what the status bar's left cell says today — the `saveText(saveMode, saveState, conflict, lastSavedAt)` function in `text-card-status-bar.tsx` ("Saving…" / "Edited" / "Unsaved" / "Saved" / "Saved: 12:04:11 PM" / "File changed" / "File deleted"). The `saveText` helper and the save cell move out of the status bar; the settable pair and number pair stay exactly where they are.

**Rationale:**
- Resolves [Q02] per the user's directive verbatim.
- A moved fact, not a duplicated one: two surfaces saying "Edited" would drift the moment one gains a timestamp.

**Implications:**
- `saveText` relocates to `text-card.tsx` (or a small shared module) since the status bar no longer calls it; `TextCardStatusBar` loses the `saveState` / `conflict` / `lastSavedAt` props that fed only that cell. `saveMode` is retained only if the settable cluster still needs it — verify at implementation rather than assuming.
- The manual-mode conflict wording rides the third line now; the automatic-mode conflict `TugPaneBanner` is untouched.
- `[data-testid="text-card-status-save"]` ceases to exist. Three app-tests depend on it or on the deleted top bar — see (#breaking-tests), which #step-4 owns.

#### [P04] The rail role comes from the card's declared `layoutRole`, and is stamped on the pane (DECIDED) {#p04-role-on-pane}

**Decision:** `TugPane` derives rail-ness from the **active card's registration** — `activeCardRegistration?.layoutRole === "sidebar"` — passes it to `CardTitleBar` as `sidebar`, and stamps `data-role="sidebar"` on the `.tug-pane` root. The rail's `--tugx-pane-chrome-height: var(--tug-rail-chrome-height, 32px)` declaration moves from `.tug-pane-title-bar[data-role="sidebar"]` up to `.tug-pane[data-role="sidebar"]`, beside `.tug-pane[data-masthead="true"]`'s.

**Rationale:**
- **`layoutRole: "sidebar"` already exists** as a card-registry field on all three rails (`lens-register-card.tsx`, `jots-card-registration.tsx`, `gazette-card-registration.tsx`), read today only by the Lens's Layouts section. It says what the card *is*. `sidebarSide` says where it currently *stands* — and an earlier draft of this plan keyed on that, which would flip a released Lens from racing stripes to a tinted title bar mid-gesture. A tool does not stop being a tool when you unpin it; the livery should not blink.
- `TugPane` already resolves `activeCardRegistration` via `getRegistration(activeCard.componentId)` for `effectiveMeta`, so this costs one property read and no new plumbing. Deriving from the **active** card also matches how the masthead already works — chrome follows the frontmost tab.
- The height must be pane-scoped so the scrim, sheet clip, and banner seat below a 32px bar — the same publication the masthead already has. The `tug-pane.css` § "The rail tier" comment names exactly this move.
- The role cannot be derived in CSS from the bar's attribute: `:has()` does not invalidate on a descendant attribute change in WebKit.

**Implications:**
- **`data-lens` stays and is not redundant.** `TugPane` already stamps `data-lens={sidebarSide}` on the pane; it encodes *which edge a rail is pinned to* and is load-bearing for `at0230-pinned-lens-geometry`, `at0276-lens-side-persists`, and `at0299-lens-edge-drag`. Under this decision the two attributes genuinely differ: a released rail has rail chrome (`data-role`) and no side (`data-lens` absent). Do not collapse them.
- All rail ink/stripe/label rules stay keyed on the **bar's** `[data-role="sidebar"]` — they style the bar. Only the height declaration moves to the pane.
- A released rail keeps its stripes *and* gains a width control (width suppression still keys on `sidebarSide`). That combination is intended: the chrome says what the card is, the controls say what the pane can do.

#### [P05] Rail icons: Telescope, NotebookPen, Newspaper (DECIDED) {#p05-rail-icons}

**Decision:** `defaultMeta.icon` gains `"Telescope"` on Lens (`tugdeck/src/components/lens/lens-register-card.tsx`), `"NotebookPen"` on Jots (`tugdeck/src/components/jots/jots-card-registration.tsx`), `"Newspaper"` on Gazette (`tugdeck/src/components/gazette/gazette-card-registration.tsx`).

**Rationale:**
- Lens and Jots are the spike's own picks (rendered in the fixture's Tier 3 rows); Gazette follows the same literal-noun register.
- The rail glyph draws in `--tugx-rail-icon-ink` (the theme's indigo icon role) — the mark is the tinted element the treatment calls for.

**Implications:**
- `defaultMeta.icon` also feeds the stack-picker rows and any surface reading `CardMeta.icon`; those surfaces gain the same glyphs, which is wanted.

#### [P06] `--tug-rail-chrome-height: 32px` is promoted into the six themes (DECIDED) {#p06-rail-height-token}

**Decision:** Each of `tugdeck/styles/themes/{brio,nocturne,bravura,harmony,aria,vivace}.css` declares `--tug-rail-chrome-height: 32px` beside the existing `--tug-masthead-height: 72px`. The `var(--tug-rail-chrome-height, 32px)` fallback at the point of use stays.

**Rationale:**
- The masthead height is a theme token; the rail height is the same kind of fact and a theme retuning one should find both in the same place.
- The fallback stays per the CSS-knob doctrine — defaults live in `var()` at the point of use.

**Implications:**
- Hand-edit all six files (they are hand-authored; there is no generation script).

#### [P07] Document masthead content per card is fixed by Table T01 (DECIDED) {#p07-masthead-content}

**Decision:** Each adopting card publishes exactly the content in **Table T01** (#t01-masthead-content). Titles keep their existing string-channel conventions (the Text card's trailing dirty dot ` •`, the read-only suffix); the string channel and the masthead publish in **one** `cardTitleStore.set(cardId, title, payload)` call so tab bar, Window menu, and masthead can never disagree.

**Rationale:**
- The string channel remains the reader surface for tabs and menus; splitting the two publishes would race the equality guard and double-notify.
- Every description/detail fact in T01 is one the card already holds in the snapshot it renders from — no new stores, no new fetches ([P01]).

**Implications:**
- The Text card's current title effect grows the payload argument rather than gaining a sibling effect.
- The Diff card's "publish only when there is a better name" rule now applies to the *string* only; the masthead publishes for both guises, per [P11] from mount.

#### [P08] The File viewer's icon and detail come from `classifyFileKind` (DECIDED) {#p08-file-viewer-kind}

**Decision:** The File viewer's masthead icon and third line derive from `classifyFileKind(path)` (`tugdeck/src/lib/file-kinds.ts`): images get icon `"Image"`, PDFs get icon `"FileText"` and `"PDF"` — extended to `"PDF · N pages"` once `PdfView` reports `doc.numPages` upward.

**Rationale:**
- The kind classification already exists and already branches the card body; the masthead reads the same fact.
- Dimensions and byte size are deferred ([Q03]).

**Implications:**
- `classifyFileKind` returns a **coarse `FileKind`** off a `VIEWABLE_EXTENSIONS` map — it does not hand back "PNG image". The human label is composed from the extension beside the kind; do not expect the function to supply it.
- `PdfView` gains an optional `onDocumentInfo?: (info: { pages: number }) => void`, or the page count is read from the `PdfViewState` it already reports — smallest honest wiring, decided at implementation. Either way the payload republishes through the same equality-guarded `set`.

#### [P09] The document masthead reserves the control cluster on its first two lines (DECIDED) {#p09-document-reserve}

**Decision:** `card-masthead.css` gains `padding-inline-end` reserves on the document row's **name line** and **description**, mirroring the session masthead's but without its tape and telemetry-widget terms. The third line stays unreserved and runs the full width.

**Rationale:**
- `masthead-frame.css` deliberately pulls the frame out under the control cluster (`margin-inline-end: calc(-1 * (var(--tugx-pane-controls-width, 0px) + var(--tug-space-xs)))`) because the cluster occupies only the first chrome band, and its comment ends: *"Each line above reserves the cluster back for itself."* The session masthead does that on `.session-masthead-row .tug-session-row-name-line` and its description. **`card-masthead.css` has no such rules** — it is the glyph box and the path line, nothing else.
- So a document masthead's title and path currently run underneath the width button, the `…` menu, the stack badge, and the close X. **This is a live defect in code already on `main`**, not a new requirement. The gallery fixture hides it: its titles are short, and its long paths clip at the head under `dir="rtl"`, so the tail simply vanishes beneath the cluster and reads as ordinary truncation.
- This is not a re-typing of the row's ladder and does not violate [P01]: *where a mount's lines stop* is the mount's own arithmetic, which is precisely why the session's reserve lives in `session-masthead.css` rather than in the shared frame.

**Implications:**
- The reserve is `calc(var(--tugx-pane-controls-width, 0px) + var(--tug-space-xs))` — no `--tugx-session-row-trailing-inset` compensation (a document masthead sets no trailing inset; it has no tape to seat) and no 28px widget term (it has no telemetry widget).
- This must land **before** any card publishes into the tier, so no step ships a colliding masthead. It is #step-2 and #step-4/#step-5/#step-6 depend on it.
- Falsifiable at the pixel: title text-box right edge < controls-cluster left edge, with a title long enough to fill the tier.

#### [P10] `…` menu items name commands; the bar resolves label, enablement, and shortcut from the registry (DECIDED) {#p10-menu-items-are-commands}

**Decision:** `PaneTitleBarMenuItem` becomes a **command reference** — it carries a `commandId` (plus an optional `checked` for toggles) and drops the free-form `label` / `onSelect` pair. `CardTitleBar` renders each row with the registry's title, its `validate(chain)` enablement, and its `commandShortcut(id)` glyph, and invokes it with `dispatchCommand(commandId)`.

**Rationale:**
- [L30] names menu items first in its definition of a command: *"a menu item, a chord, a button, a context-menu verb."* Every row this plan adds is a menu item, so every one is a command and must go through funnel #1.
- The law's enablement clause is explicit — *"not a host-side tier that decides an item's enablement next to the entry that already answers for it."* `TUG_ACTIONS.SAVE` already answers via `validate: (chain) => chain.menu.fileGates?.save ?? false`. A card-supplied `disabled` computed from its own `canSave` is exactly that second opinion, and it would drift from ⌘S and File ▸ Save the first time the gate changed.
- The store has **no publishers**, so nothing is being migrated and this shape costs nothing today. It is also the shape that scales: every future card's `…` menu gets shortcut glyphs and single-source gating for free.
- `TugPopupMenuItem` already carries `disabled` and honors it, so the render path exists and needs no component work.

**Implications:**
- `pane-title-bar-menu-store.ts`'s item type changes shape before it acquires a user — cheap now, a migration later.
- `CardTitleBar` imports `dispatchCommand` and the registry lookup; it must still import **no** card-specific module ([L10]/[L25]).
- **Save** → `TUG_ACTIONS.SAVE`. **Move To…** → `TUG_ACTIONS.SAVE_AS` (the top bar's Move To… already calls the card's `saveAs`, and `file.saveAs` / ⇧⌘S is its registry door).
- **Editor Options…** and **Reveal in Finder** need registry decisions — [Q04], closed in #step-3.
- A row whose command is invalid renders disabled rather than vanishing, which is the menu the hand can learn — and it is the registry, not the card, that decides.

#### [P11] A document card publishes its masthead at mount, never on data arrival (DECIDED) {#p11-publish-at-mount}

**Decision:** Every adopting card publishes a `card-masthead` payload from its first title-sync effect, filling `description` / `detail` with `null` until the facts exist. No card gates the *payload's existence* on a loaded state; only its content fills in.

**Rationale:**
- `pane-model.md` fixes the tier's height *because* "chrome that changed height as its text changed would move every card in the Pane while the user was reading." A 36↔72 swap on **tab switch** is explicitly sanctioned. A swap on **data arrival** — an earlier draft gated the Diff masthead on `phase === "ready"` — is a new case and reads as precisely the failure the law names: the user is looking at the card when the chrome grows 36px and the body jumps.
- The Text card already does the right thing for its untitled state (publishing `"Untitled"` rather than clearing); this makes the behavior uniform across the three cards.

**Implications:**
- **Diff:** publishes `"Project Diff"` with `description: null` at mount, then fills the stat line when `phase === "ready"`. The `no_repo` case keeps a null description rather than dropping the tier.
- **File viewer:** publishes as soon as the card has a path, including before the blob loads. The pre-bind placeholder state (`path === null`) still clears — that card has no document yet and is not a document card until it does.
- **Text:** unchanged from [P03]/T01 — untitled buffers publish `"Untitled"`.
- One height for a card's whole life is the invariant; an app-test asserts the Diff pane's bar height is 72 both before and after the payload lands.

---

### Deep Dives {#deep-dives}

#### The wiring that already exists (read this before touching anything) {#existing-wiring}

- **`TugPane` → masthead:** `tug-pane.tsx` subscribes `activeCardMasthead` from `cardTitleStore.getMasthead(activeCardId)` via `useSyncExternalStore` and passes it to `CardTitleBar masthead={…}`; the pane root already stamps `data-masthead="true"` when non-null. Chrome follows the **active** card; the masthead and tab bar stack (72 + 36).
- **`CardTitleBar` → renderer:** `masthead.kind === "card-masthead"` mounts `<CardMasthead payload={masthead} />` (unkeyed — reconciling a new path onto the same element is correct); `"session-masthead"` mounts `SessionMasthead` keyed by session id. The masthead **replaces** the registry icon + title string in the bar; the controls cluster is untouched and publishes `--tugx-pane-controls-width` via a `ResizeObserver`, which is what [P09]'s reserve consumes.
- **`CardMasthead` contracts:** never pass `indicatorSize` (its arithmetic reads the phase-dot glyph's geometry; a solid glyph would pull left); the payload's `description: null` and absent `detail` are rendered as `""`, never `undefined` (presence of the description node is what selects the three-level stack via `:has(> .tug-session-row-description)`, and `TugPulse` prints "None" for an absent activity). These are already handled **inside** `CardMasthead` — publishers just fill `DocumentMastheadPayload` honestly.
- **Rail CSS:** everything under `tug-pane.css` § "The rail tier" is finished — flush ground on `--tugx-pane-bg`, three published ink knobs (`--tugx-rail-stripe-ink` / `-label-ink` / `-icon-ink`) with the focused pair as base and the recede keyed off `.tug-pane:not([data-focused="true"])` (deliberate inverted polarity — descendant-selector correctness), `order: 1` + `margin-inline-start: auto` on the controls so the `::after` stripe band lays out before them, stripe bands as `::before`/`::after` at `flex: 1 1 0`.
- **Width control on rails:** already suppressed — `TugPane` omits `widthPreset`/`onSetWidth` when `sidebarSide !== undefined`. Unchanged by [P04], which is about chrome, not controls.
- **`…` menu:** `CardTitleBar` already subscribes `paneTitleBarMenuStore.get(activeCardId)` and renders the `MoreHorizontal` button + `TugPopupMenu` when items exist. **No card publishes into it yet.**

#### Text card facts inventory (what feeds the payload) {#text-card-facts}

From `text-card.tsx`'s existing `snapshot` (`TextCardStore`): `fileName`, `path`, `readOnly`, `saveMode`, `saveState`, `conflict`, `lastSavedAt`, `draftId`, `untitled`; plus the derived `isDirty` and `isManual` the title effect already uses. The masthead effect is the current title-sync `useLayoutEffect` with the payload added — same deps plus the save-state facts. Untitled buffers: today the card *clears* the title override when `fileName === null`; under the masthead it publishes `title: "Untitled"`, `description: null`, so an untitled draft wears the tier too ([P11] — a document card that dropped to 36px while untitled would reflow the editor on first save).

**Table T01: Document masthead content per card** {#t01-masthead-content}

| Card | icon | title | description (`descriptionKind`) | detail |
|------|------|-------|--------------------------------|--------|
| Text | `"FileText"` | `fileName` (+ ` (read-only)` / manual-dirty ` •`, as today); `"Untitled"` when unbound | full `path` (`"path"`); `null` when untitled | `saveText(…)` — the relocated save state ([P03]) |
| File viewer | by kind ([P08]): `"Image"` / `"FileText"` | `basename(path)` (as today) | full `path` (`"path"`) | kind label; `"PDF · N pages"` when known ([P08], [Q03]) |
| Diff (project guise) | `"GitCompareArrows"` | `"Project Diff"` (as today) | `"{file_count} files · +{total_added} −{total_removed}"` from `GitDiffPayload` (`"text"`); `null` until ready ([P11]) | `base` ref line, e.g. `"vs HEAD"` from `payload.base` |
| Diff (scoped pop-out) | `"GitCompareArrows"` | registry `"Diff"` string channel unchanged; masthead title = the scoped file's basename | scoped file's path (`"path"`) | per-file `+added −removed` |

Diff notes: the store is `createGitDiffStore()` (`tugdeck/src/lib/git-diff-store.ts`); `GitDiffSnapshot.payload` carries `file_count`, `total_added`, `total_removed`, `base`, `no_repo`. Per [P11] the payload is published from mount with a null description and filled when `phase === "ready"`; `no_repo` keeps the null description rather than dropping the tier. Implementation note: the card's existing title effect is declared **above** `const snapshot = useSyncExternalStore(…)` in `DiffCardContent` — move the effect below the subscription rather than reaching forward into it.

Description-line **clicks are inert in this phase.** `CardTitleBar` mounts `CardMasthead` without `onActivateDescription` (there is no pane↔card channel for it yet), so Reveal in Finder travels as a `…` menu row on the Text and File viewer cards instead. Wiring an actionable description is a follow-on (#roadmap).

#### The three app-tests this breaks {#breaking-tests}

Deleting `TextCardTopBar` and the status bar's save cell invalidates three existing app-tests. All three are selected automatically by `just app-test-changed` through their `@covers` lines, so they fail at the step that lands the change unless that step repairs them. #step-4 owns all three.

- **`tests/app-test/at0363-action-tooltip-shortcut.test.ts`** — declares `@covers …/text-card-top-bar.tsx` and uses `[data-slot="text-card-top-bar"] button[aria-label="Save"]` as its subject. **This test is not about Text cards**: it verifies that a `TugActionTooltip` renders its action's keyboard shortcut. It needs a **new specimen** — another `TugActionTooltip`-wrapped button with a bound action, found by grepping `TugActionTooltip` usages — plus a rewritten `@covers`. A selector swap will not do; the surface is gone.
- **`tests/app-test/at0210-text-card-options.test.ts`** — `@covers` the top bar, drives `TOP_BAR` and the gear popover, and reads the save cell. Rewritten against the new path: open the pane `…` menu, choose Editor Options…, assert the sheet appears and a card-local setting change takes effect.
- **`tests/app-test/at0212-text-card-manual-save.test.ts`** — reads `[data-testid="text-card-status-save"]` in two places, including a two-card case keyed `[data-card-id="B"]`. Both move to `[data-testid="card-masthead-detail"]`. **Scope trap (Risk R04):** those assertions are prefixed with the card element, and the masthead lives in the **pane's title bar**, which is not a descendant of the card. The repaired selectors must be pane-scoped, or they will match nothing.

#### What the gallery fixture becomes {#gallery-after}

`gallery-card-chrome.tsx` stays as the tiers' design reference, but its docstring's "Nothing in this file is wired into a shipping card" paragraph becomes false and must be rewritten to say the tiers ship and the fixture is the comparative reference. Its "As shipped, for comparison" rows (a content card's bar on a rail; `TextCardTopBar` on a text card) become historical: relabel them "before". The fixture **imports `TextCardTopBar` today** — after [P02] that component is gone, so the fixture's "today" text-card row is rebuilt from static markup or removed. The fixture must not resurrect the deleted component.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Document masthead payloads (Text/File/Diff) | structure (pane↔card channel) | existing `cardTitleStore` + `useSyncExternalStore`, published from card `useLayoutEffect` | [L02], [L24], [L09]/[L10] |
| Rail role on the pane | structure → appearance | `activeCardRegistration.layoutRole` → `data-role="sidebar"` attribute; all styling in CSS | [L06], [L09] |
| Rail tier height | appearance | theme token `--tug-rail-chrome-height` + pane-scoped `--tugx-pane-chrome-height` | [L20], [L17] |
| Document masthead line reserves | appearance | CSS `padding-inline-end` off the pane-published `--tugx-pane-controls-width` | [L06], [L20] |
| Text card `…` items (which commands) | structure (pane↔card channel) | existing `paneTitleBarMenuStore` carrying command ids, published from card `useLayoutEffect` | [L02], [L24], [L10]/[L25] |
| `…` item enablement + labels + shortcuts | *not state* — derived | `command-registry.ts` `validate(chain)` / title / `commandShortcut(id)`; never stored | [L30] |
| Editor Options sheet open/closed | local-data | the Text card's existing sheet state (`renderSheet()` family), `useState` in the card | [L24] |
| Save state on the third line | structure (travels in payload) | fact from `TextCardStore` snapshot, rides `DocumentMastheadPayload.detail` | [L02] |
| PDF page count | local-data → payload | `PdfView` callback → card state → payload republish | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at####-card-chrome-tiers.test.ts` | App-test for the document masthead (Text card), the [P09] reserve, and the rail tier (numbered at implementation from the corpus tail) |
| `tugdeck/src/components/tugways/cards/text-card-options-sheet.tsx` (or folded into `text-card-save-sheets.tsx`'s family) | The Editor Options sheet hosting `TextCardControls` ([P02]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `.card-masthead-row` line reserves | CSS rules | `tugdeck/src/components/tugways/card-masthead.css` | the two `padding-inline-end` rules from [P09] — the only edit this file takes |
| `TugPane` render | fn | `tugdeck/src/components/chrome/tug-pane.tsx` | `sidebar` from `activeCardRegistration?.layoutRole === "sidebar"`; stamp `data-role="sidebar"` on `.tug-pane` root ([P04]) |
| `.tug-pane[data-role="sidebar"]` | CSS rule | `tugdeck/src/components/tugways/tug-pane.css` | receives the `--tugx-pane-chrome-height` declaration moved off the bar selector; update the § comment that promised this move |
| `--tug-rail-chrome-height` | token | `tugdeck/styles/themes/*.css` (six files) | `32px`, beside `--tug-masthead-height` |
| `defaultMeta.icon` | field | lens/jots/gazette registration files | `"Telescope"` / `"NotebookPen"` / `"Newspaper"` ([P05]) |
| `PaneTitleBarMenuItem` | interface | `tugdeck/src/lib/pane-title-bar-menu-store.ts` | reshaped to `{ commandId, checked? }`; `label`/`onSelect` removed ([P10]) |
| `CardTitleBar` menu mapping | fn | `tugdeck/src/components/chrome/tug-pane.tsx` | resolve title / `disabled` / shortcut from the registry; `dispatchCommand` on select ([P10]) |
| Editor Options command (+ Reveal decision) | registry entry | `tugdeck/src/components/tugways/command-registry.ts` | per [Q04]; the table lint enforces one of the two outcomes |
| Text card masthead+menu effects | fn | `tugdeck/src/components/tugways/cards/text-card.tsx` | title effect grows the payload; new `paneTitleBarMenuStore` publish effect; `saveText` relocated here |
| `TextCardTopBar` | component | `text-card-top-bar.tsx` | **deleted** (file + CSS block + import + fixture import) |
| `TextCardStatusBar` | component | `text-card-status-bar.tsx` | save cell + `saveText` removed; prop list trimmed |
| File viewer masthead effect | fn | `file-view-card.tsx` | title effect grows the payload per T01, published from mount ([P11]) |
| Diff masthead effect | fn | `diff-card.tsx` | published from mount, description filled at `ready` ([P11]); move the effect below the `useSyncExternalStore` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/pane-model.md` § "Chrome has two heights" → three tiers; document the rail height's pane-scoped publication, that rail-ness comes from `layoutRole`, and which cards wear what.
- [ ] `tuglaws/design-decisions.md`: fix the stale "The width control does not render on a masthead-bearing pane" paragraph (reverted by `1693707dc`; the control renders on every pane that has a width, rails excepted because rails have no width preset); extend the [D132]-adjacent masthead prose to name the document tier and the rail tier.
- [ ] `gallery-card-chrome.tsx` docstring + "as shipped" rows updated per (#gallery-after).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test** | Drive the real Tug.app: seed a deck, measure real chrome geometry and computed style | the tiers' visible truth — heights, reserves, inks, line content |
| **Unit (bun test)** | Pure helpers | `saveText` relocation; payload construction if extracted as pure fns |
| **Drift prevention** | Existing at0375 masthead diagnostics | must stay byte-identical — the session masthead is untouched substrate |
| **Repair** | The three tests in (#breaking-tests) | land in the same commit as the deletion, never after |

#### What stays out of tests {#test-non-goals}

- No jsdom render tests of `CardMasthead` or `CardTitleBar` — banned pattern; the app-test measures the real thing.
- No mock-store assertion tests on `cardTitleStore` or `paneTitleBarMenuStore` publishes — the app-test asserts the rendered masthead and the rendered menu, which are the facts that matter.
- Rail *stripe pixel* assertions beyond presence/ink — 1px gradients under transitions are flaky to read; assert the un-animated custom-property values instead (transitions poison mid-flight style reads).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every tugdeck step's checkpoint includes `cd tugdeck && bunx tsc --noEmit && bunx vite build` (from the worktree's absolute path — Bash cwd reverts between calls).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Rail role plumbing + tokens + icons | done | `c03b7d1a4` |
| #step-2 | Document masthead control-cluster reserve | done | `103119661` |
| #step-3 | `…` menu items become commands; Text card publishes them | done | `71a987806` |
| #step-4 | Text card masthead; delete `TextCardTopBar`; relocate save state; repair three tests | done | `b2d8bade4` |
| #step-5 | File viewer masthead | done | `871f6ba43` |
| #step-6 | Diff card masthead | done | `853df018c` |
| #step-7 | Doctrine + gallery fixture updates | done | `154fe94de` |
| #step-8 | New app-test coverage | done | `517db39b4` |
| #step-9 | Integration checkpoint | done | `4ecbd5e42` |

#### Step 1: Rail role plumbing + tokens + icons {#step-1}

**Commit:** `tugdeck(chrome): give rails their own chrome tier — role from layoutRole, height pane-wide, rail icons`

**References:** [P01] Adoption is publication, [P04] Role from `layoutRole`, [P05] Rail icons, [P06] Rail height token, (#existing-wiring, #symbols)

**Artifacts:**
- `sidebar` prop pass + `data-role="sidebar"` pane stamp in `tug-pane.tsx`; height rule relocation in `tug-pane.css`; `--tug-rail-chrome-height: 32px` in six theme files; three registration icons.

**Tasks:**
- [ ] In `TugPane`'s render: derive rail-ness from the already-resolved `activeCardRegistration` (`?.layoutRole === "sidebar"`), pass it as `sidebar` to `CardTitleBar`, and spread `data-role="sidebar"` onto the `.tug-pane` root beside the existing `data-masthead` / `data-lens` spreads. **Do not** remove or fold `data-lens` — it carries the pinned side and three app-tests read it ([P04]).
- [ ] Move `--tugx-pane-chrome-height: var(--tug-rail-chrome-height, 32px)` from `.tug-pane-title-bar[data-role="sidebar"]` to a new `.tug-pane[data-role="sidebar"]` rule beside `.tug-pane[data-masthead="true"]`; rewrite the § comment that documented the bar-scoped workaround.
- [ ] Add `--tug-rail-chrome-height: 32px;` beside `--tug-masthead-height` in `brio/nocturne/bravura/harmony/aria/vivace.css`.
- [ ] Add `icon: "Telescope"` / `"NotebookPen"` / `"Newspaper"` to the three registrations ([P05] paths).

**Tests:**
- [ ] Deferred to #step-8 (geometry needs the live app).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `bun run audit:theme-contrast` (from `tugdeck/`) — no theme exceeds the brio budget.
- [ ] In the running app: pin the Lens; its bar is 32px, flush, striped, labeled LENS with the Telescope glyph; `getComputedStyle(document.querySelector('.tug-pane[data-role="sidebar"]')).getPropertyValue('--tugx-pane-chrome-height')` → `32px`. Release it: the stripes stay ([P04]).
- [ ] `just app-test tests/app-test/at0230-pinned-lens-geometry.test.ts tests/app-test/at0276-lens-side-persists.test.ts` — the `data-lens` readers still pass.

---

#### Step 2: Document masthead control-cluster reserve {#step-2}

<!-- Independent of #step-1; must precede every publisher step. -->

**Commit:** `tugdeck(card-masthead): stop the document tier's first two lines under the pane controls`

**References:** [P09] Document reserve, [P01] (amended implication), (#existing-wiring, #success-criteria)

**Artifacts:**
- Two `padding-inline-end` rules in `card-masthead.css`.

**Tasks:**
- [ ] Add a reserve on the document row's name line and description of `calc(var(--tugx-pane-controls-width, 0px) + var(--tug-space-xs))` — no trailing-inset compensation and no widget term ([P09]).
- [ ] Leave the third line unreserved; the frame's negative margin exists so the last line runs full width.
- [ ] Comment the rules against `masthead-frame.css`'s "each line above reserves the cluster back for itself", so the pair reads as one mechanism.

**Tests:**
- [ ] Covered by #step-8's reserve assertion (needs a live pane and a real cluster width).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] In the running app, in the `gallery-card-chrome` fixture (which needs no publisher): a Tier 1 row's title and path both stop short of the control cluster; measure `.tug-list-row-title` text-box right edge < `.tug-pane-title-bar-controls` left edge.

---

#### Step 3: `…` menu items become commands; Text card publishes them {#step-3}

**Commit:** `tugdeck(pane-chrome): make … menu items command references, and give the Text card its menu`

**References:** [P02] Actions to the `…` menu, [P10] Items name commands, [Q01], [Q04], Risk R03, (#text-card-facts, #symbols)

**Artifacts:**
- Reshaped `PaneTitleBarMenuItem`; `CardTitleBar` registry-driven rendering + `dispatchCommand`; new registry entries per [Q04]; Text card menu publish effect; Editor Options sheet. `TextCardTopBar` still mounted (removed in #step-4).

**Tasks:**
- [ ] Reshape `PaneTitleBarMenuItem` to `{ commandId, checked? }` ([P10]); the store has no publishers, so this is a type change with no migration.
- [ ] In `CardTitleBar`, map each item through the command registry: title, `disabled` from `validate(chain)`, shortcut from `commandShortcut(id)`, `onSelect` → `dispatchCommand(commandId)`. No card-specific import may enter this file ([L10]/[L25]).
- [ ] Close [Q04]: write the `Editor Options…` entry, and decide Reveal in Finder's classification. The registry's "neither a command nor declared outside the table" lint must pass.
- [ ] In `text-card.tsx`, a `useLayoutEffect` publishing the item list — membership only (`saveMode`, `draftId`, `isPathPickerAvailable()`, bound-ness); cleared on unmount. Enablement is never a card decision.
- [ ] Build the Editor Options sheet (`TugSheet` hosting `TextCardControls`, title "Text Card Settings"), opened by the command, joining the card's existing `renderSheet()` family; the controls write through the same `setSetting`.

**Tests:**
- [ ] Deferred to #step-8 (menu reachability and gating asserted there).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build` (the registry lint runs in the type/test pass)
- [ ] In the running app: a Text card's pane shows the `…` button; Save carries its ⌘S glyph and is **disabled on a clean titled buffer, matching File ▸ Save**; Editor Options opens the sheet and a setting change takes effect in that card only.

---

#### Step 4: Text card masthead; delete `TextCardTopBar`; relocate save state; repair three tests {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(text-card): publish the document masthead, retire the top bar, seat the save state on the third line`

**References:** [P03] Save state third line, [P07] Content per card, [P11] Publish at mount, Table T01, [Q02], Risk R01, Risk R04, (#text-card-facts, #breaking-tests)

**Artifacts:**
- Masthead payload in the Text card's title effect; `text-card-top-bar.tsx` deleted (+ its `text-card.css` block + import + mount); `saveText` relocated; status bar's save cell removed and props trimmed; three app-tests repaired.

**Tasks:**
- [ ] Grow the existing title-sync `useLayoutEffect` to publish `{kind: "card-masthead", icon: "FileText", title, description, descriptionKind: "path", detail}` per Table T01 in the **same** `cardTitleStore.set` call as the string; untitled buffers publish `title: "Untitled"`, `description: null` instead of clearing ([P11]).
- [ ] Move `saveText` out of `text-card-status-bar.tsx`; delete the save cell and the now-unused props; keep the settable and number clusters byte-identical.
- [ ] Delete `text-card-top-bar.tsx`, its import/mount in `text-card.tsx`, and the `.text-card-top-bar*` rules in `text-card.css`. Reveal-in-Finder is already a `…` row from #step-3.
- [ ] Verify the editor fills the reclaimed row (`.text-card--editor` layout accounts for the missing bar).
- [ ] Repair the three tests in (#breaking-tests): re-specimen `at0363` onto a surviving `TugActionTooltip` button and rewrite its `@covers`; rewrite `at0210` against the `…` → Editor Options sheet path; move `at0212`'s two save-cell reads to `[data-testid="card-masthead-detail"]` with **pane-scoped** selectors (Risk R04).

**Tests:**
- [ ] Unit: relocated `saveText` keeps its six wordings (port any existing unit coverage).
- [ ] The three repaired app-tests are the step's own tests.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `grep -rn "text-card-top-bar\|TextCardTopBar" tugdeck/src tests` → only the gallery fixture (handled in #step-7) or nothing.
- [ ] `just app-test tests/app-test/at0363-action-tooltip-shortcut.test.ts tests/app-test/at0210-text-card-options.test.ts tests/app-test/at0212-text-card-manual-save.test.ts` — VERDICT pass.
- [ ] In the running app: a bound Text card shows the 72px masthead with name/path/save-state; typing flips the third line to "Edited"; ⌘S saves and it reads "Saved: <time>"; the bottom status bar shows no save cell.

---

#### Step 5: File viewer masthead {#step-5}

**Depends on:** #step-2

**Commit:** `tugdeck(file-view-card): publish the document masthead`

**References:** [P07] Content per card, [P08] Kind-derived icon/detail, [P11] Publish at mount, Table T01, [Q03], (#existing-wiring)

**Artifacts:**
- Masthead payload in `file-view-card.tsx`'s title effect; optional PDF page-count wiring from `PdfView`; a Reveal in Finder menu row.

**Tasks:**
- [ ] Grow the title-sync effect: `{kind: "card-masthead", icon, title: basename(path), description: path, descriptionKind: "path", detail}` per T01/[P08], published as soon as the card has a path ([P11]); `path === null` keeps the current `clear`.
- [ ] Compose the kind label from `classifyFileKind` **plus the extension** — the function returns a coarse `FileKind`, not a human label ([P08]). PDF page count if `PdfView` exposes it without contortion, else `"PDF"` and leave [Q03].
- [ ] Publish a Reveal in Finder row via `paneTitleBarMenuStore` using the command id settled in [Q04].

**Tests:**
- [ ] Deferred to #step-8.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] In the running app: open an image and a PDF in viewer cards; each wears the masthead per T01, at 72px from the moment the card appears.

---

#### Step 6: Diff card masthead {#step-6}

**Depends on:** #step-2

**Commit:** `tugdeck(diff-card): publish the document masthead`

**References:** [P07] Content per card, [P11] Publish at mount, Table T01 (Diff rows and notes), (#existing-wiring)

**Artifacts:**
- Masthead publish in `diff-card.tsx`, from mount, description filled at `ready`.

**Tasks:**
- [ ] Move the title effect below `const snapshot = useSyncExternalStore(…)` in `DiffCardContent` (it is currently declared above it).
- [ ] Publish from mount per [P11]: project guise `"Project Diff"` with `description: null`, filled with the stat line when `phase === "ready"`; `no_repo` keeps the null description rather than dropping the tier. Scoped guise publishes the file-scoped masthead while leaving the string channel's override-only-when-better rule intact ([P07]).

**Tests:**
- [ ] Deferred to #step-8.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] In the running app: the Project Diff card's bar is **72px before and after** the payload lands — the body must not jump — and the description fills in with `N files · +A −R`.

---

#### Step 7: Doctrine + gallery fixture updates {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `tuglaws+tugdeck(gallery): record the three chrome tiers; retire the fixture's "nothing is wired" framing`

**References:** [P01]–[P11], (#documentation-plan, #gallery-after)

**Tasks:**
- [ ] `tuglaws/pane-model.md`: rewrite § "Chrome has two heights" as three tiers (36 / 72 / 32), naming the wearing cards, the pane-scoped height publication for all three, that rail-ness comes from `layoutRole` ([P04]), and that the rail's flush surface is a token-family change (`--tug7-element-global-*`).
- [ ] `tuglaws/design-decisions.md`: correct the stale width-control paragraph (it renders on every width-bearing pane; reverted by `1693707dc`); extend the masthead decision prose with the document tier and rail tier.
- [ ] `gallery-card-chrome.tsx`: docstring rewritten per (#gallery-after); the `TextCardTopBar` import and "today" row replaced (the component no longer exists); "as shipped" rows relabeled "before".

**Tests:**
- [ ] N/A (docs + fixture prose).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build` (the fixture edit compiles with no reference to the deleted component)
- [ ] `grep -n "does not render on a masthead-bearing" tuglaws/design-decisions.md` → nothing.

---

#### Step 8: New app-test coverage {#step-8}

**Depends on:** #step-1, #step-2, #step-4, #step-5, #step-6

**Commit:** `tests(app-test): cover the document masthead, its control reserve, and the rail chrome tier`

**References:** [P03], [P04], [P07], [P09], [P10], [P11], Table T01, (#test-plan-concepts, #success-criteria)

**Artifacts:**
- New `at####-card-chrome-tiers.test.ts` with `@covers` lines for `card-masthead.tsx`, `card-masthead.css`, `masthead-frame.css`, `text-card.tsx`, `file-view-card.tsx`, `diff-card.tsx`, `pane-title-bar-menu-store.ts`, and `tug-pane.css`.

**Tasks:**
- [ ] Text tier: seed a Text card bound to a real temp file; assert bar height 72, `card-masthead-title` = basename, `-description` ends with the basename (start-truncation), `-detail` in the "Saved" family; type via the editor and assert `-detail` flips to "Edited"; assert `text-card-top-bar` and `text-card-status-save` are both absent.
- [ ] Reserve ([P09]): bind a file whose name is long enough to fill the tier; assert the title's text-box right edge is left of `.tug-pane-title-bar-controls`'s left edge, and the same for the description.
- [ ] Menu ([P10]): assert the `…` button exists, that Save's row is disabled on a clean titled buffer, and that it carries a shortcut glyph.
- [ ] Height stability ([P11]): assert a Diff pane's bar is 72px both before and after its payload resolves.
- [ ] Rail tier: seed a deck with the Lens pinned; assert `.tug-pane[data-role="sidebar"]` exists, `--tugx-pane-chrome-height` computes to 32px, the bar's `background-color` equals the pane's `--tugx-pane-bg` (compare computed values — WebKit reports `oklch()`), the label is the tracked uppercase form, and both stripe bands render (assert the un-animated custom-property inks, not mid-transition colors).
- [ ] Regression: run `at0375-session-masthead` in the same selection and require its geometry diagnostics unchanged.

**Tests:** (this step *is* the tests)

**Checkpoint:**
- [ ] `just app-test tests/app-test/at####-card-chrome-tiers.test.ts tests/app-test/at0375-session-masthead.test.ts` — VERDICT pass, at0375 diagnostics unchanged.
- [ ] `just app-test-covers-check`

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify all artifacts land together: rails, three document mastheads with reserves, no top bar, command-driven `…` menu, doctrine current.

**Tests:**
- [ ] The derived selection: `just app-test-changed` (answer a CORE TIER ADVISED advisory with `just app-test`, not the corpus).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun run audit:theme-contrast`
- [ ] `just app-test-changed` — VERDICT pass.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every shipping card wears its ratified chrome tier — document mastheads on Text/File viewer/Diff, racing-stripe rails on Lens/Jots/Gazette, the 36px bar everywhere else — with the document tier's control-cluster collision fixed, the Text card's chrome consolidated into the masthead plus a command-driven `…` menu, and the doctrine telling the truth about all of it.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria bullets verified (each names its own measurement).
- [x] `at0375` — the session masthead itself is untouched substrate, but the test is not byte-identical, and correctly so: its Text tab is a document card now, so the tier stays 72 across the tab switch instead of dropping to 36. The assertion moved to *whose* masthead is in the slot, which is the claim that survived.
- [ ] No references to `TextCardTopBar` outside git history.
- [ ] Every `…` menu row is a registry command; no card computes an item's enablement ([L30]).

**Acceptance tests:**
- [ ] `at####-card-chrome-tiers.test.ts` green.
- [ ] The three repaired tests in (#breaking-tests) green.
- [ ] `just app-test-covers-check` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q03] image dimensions + byte size on the File viewer's third line (an `ImageBlock` intrinsic-size callback).
- [ ] Actionable masthead descriptions: a per-card masthead-action channel (mirroring `paneTitleBarMenuStore`) wiring `CardMasthead`'s existing `onActivateDescription` prop, so a path click reveals in the Finder; this phase ships the description inert with Reveal in Finder in the `…` menu.
- [ ] The Lens's `toggleMenu` affordance published through the now-command-shaped `paneTitleBarMenuStore` — its original intended use, unblocked by [P10].
- [ ] Retiring the unused session-tone tokens noted in design-decisions (separate question).
- [ ] Any further document card (a future viewer kind) adopts by publishing a T01-shaped payload — no chrome work.

| Checkpoint | Verification |
|------------|--------------|
| Chrome substrate untouched | `git diff` shows no edits to `card-masthead.tsx`, `masthead-frame.css`, or `session-masthead.*`; `card-masthead.css` shows only [P09]'s two rules |
| Themes complete | `grep -l "tug-rail-chrome-height" tugdeck/styles/themes/*.css` lists all six |
| No second enablement opinion | `grep -n "disabled" tugdeck/src/lib/pane-title-bar-menu-store.ts` → nothing |
