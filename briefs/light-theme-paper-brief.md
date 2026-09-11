# Light themes: paper fields, Key in marks

**Purpose:** The three light themes (`harmony`, `aria`, `vivace`) tint too many surfaces — the sidebar rails worst of all — and read as a candy factory next to the dark themes. The Light Tint spike settled a treatment, called *paper*: every field is a tinted neutral, the Key hue lives only in marks, selection is a pale wash, and an inactive card recedes by ink rather than by chroma. This brief records what was found and what was decided so the treatment can land in the theme files.

---

## Purpose {#purpose}

The user's words: "The tints in the sidebar cards are too much. They're not distracting in the dark themes, but they are really horrid in the light themes. We still haven't come up with a good way to add color to the light themes." The ask was to dig into the code, look at how well-regarded light UIs handle color, and propose how the light themes should be colored and tinted "so that they look good, but don't look like an explosion in a candy factory."

The spike at `tugdeck/src/spikes/spike-light-tint.tsx` drew four treatments against real pane markup; two were dropped, one was tuned by the user across three rounds, and this brief is that tuned treatment.

---

## Evidence {#evidence}

**[F01] The light rail body carries double the dark themes' chroma, at the darkest light lightness on screen.** Every light theme paints the sidebar rail on `--tug7-surface-global-primary-normal-sunken-rest` at `l: 910, c: 40` (OKLCH C 0.02 at L 0.91; `#d3e6e6` in vivace, `#dae2ef` in harmony). The dark themes give the same surface `c: 20`. Content sits at `l: 960, c: 0`, so the rail is both the most colored and the darkest light field in view, and it is a panel, not a control. Read out of `styles/themes/{harmony,aria,vivace}.css` and resolved through `resolveTugColorToOklch`. **(verified)**

**[F02] Chroma reads louder at high lightness, so the same `c` is a different strength in light and dark.** The displayable gamut and the eye both narrow toward white; a hue that reads as itself at L 0.6 must drop to C ≈ 0.01 at L 0.98 or it clips and goes garish (Evil Martians' OKLCH scale: C 0.011 at L 0.978, 0.032 at 0.936, peaking mid-scale). This is why the user's observation — same tints, fine in dark, horrid in light — is the expected result of a shared `l`/`c` skeleton, not a mistake in one theme. **(inference from published scales; consistent with F01)**

**[F03] Every light theme paints two hues on one screen.** The neutral tint hue and the Key hue are 30–35° apart in each theme: vivace cyan 200° / seafoam 165°, harmony indigo 260° / blue 230°, aria orchid 310° / iris 278°. The rail, blocks, and wells wear the tint hue; the focused lid (`--tugx-chrome-key-surface`, `l: 925, c: 65` — C 0.0325, Tailwind blue-100 territory), Z0, Z2, atoms, and tinted badges each wear a pale wash of the Key hue. Two greens in vivace, a lavender and a sky in harmony. **(verified, from the theme files)**

**[F04] The light UIs we admire keep panels at C ≈ 0.003–0.007 and spend the accent on marks.** Web research, primary sources:
- Canvas white, sidebar the same neutral one step down: GitHub Primer `#ffffff` → `bgColor-muted #f6f8fa`; Notion `#ffffff` → `#f7f6f3`; One Light `#fafafa` → `#eaeaeb`; Solarized Light `#fdf6e3` → `#eee8d5`. ΔL 2–5 points, no accent in the panel.
- A tinted neutral: Tailwind slate-50 `oklch(98.4% 0.003 248)`, slate-100 `oklch(96.8% 0.007 248)`; Radix slate-2 `#f9f9fb`. A colored surface begins at C ≈ 0.014 (Tailwind blue-50).
- Accent tint on a surface is a flag, not chrome: Primer `accent-muted #ddf4ff` marks flagged content only; Radix step 3 is a component's hover, never a panel; Radix advises white for the light-mode app background.
- Accent in marks: Apple HIG "touches of color" — selection, sidebar glyphs, buttons — over a gray sidebar material; Linear's light refresh pulled chrome toward neutral; Things keeps its blue for the button, the checkbox, and the selection.
**(verified against the cited sources during the spike)**

**[F05] The paper treatment renders as intended on Harmony and Vivace.** Screenshots from a scratch app-test (deleted afterwards) showed: neutral rail and lids, a 2px Key rule on the focused lid, the pale selection wash with a leading-edge rule, and dimmed ink on the unfocused Session masthead and Diff title bar under the deck's real recede layers. The picker, sliders, and readout were exercised in the same run. **(verified)**

**[F06] Two shipping mechanisms already carry what paper needs.** The deck's recede (`.tug-pane:not([data-focused="true"]) .tug-pane-chrome::before/::after`, saturation kill + lightness wash) applies to every unfocused card regardless of theme. The Session masthead's name line paints from `--tugx-pane-title-fg-active` (`session-masthead.css`), which the pane aliases to the inactive ink on an unfocused card — so dimming the inactive title token dims the masthead name with no rule change. **(verified in `tug-pane.css`, `chrome.css`, `session-masthead.css`)**

**[F07] The pane's `--tugx-*` aliases are declared on `body`.** A `var()` is substituted where the property is declared, so a theme file change to a `--tug7-*` token reaches the aliases (they are declared against the tokens at `body`), but a scoped override does not. This is why the spike restates aliases on its preview root and why the rollout is a theme-file change rather than a component change. **(verified; `tug-pane.css` lines 50–110)**

---

## Decisions {#decisions}

**[B01] In a light theme, color is a mark, not a field.** Every surface larger than a control — canvas, content, rail body, lids, Z0, Z2, tool blocks, wells — is a tinted neutral in the theme's *tint* hue at authored `c ≤ 14` (C ≤ 0.007). The Key hue appears only in marks: the card-type glyph, the selection, the filled and tinted badges, the pulsing dot, the focus ring, and two rules named below. This is F04's rule applied, and it collapses F03's two-hue problem because no field wears the Key hue any more.

**[B02] Elevation is lightness, in a short ladder.** Content near white (`l: 985`), the rail and the lids one step down (`l: 965`), Z0 a step below that (`l: 955`), wells back at content (`l: 985`). Steps of two to three points, the GitHub shape. The rail is still a panel on the sunken surface as the rail-panel arc settled it; what changes is the sunken surface's value, not the rail's frame.

**[B03] Focus is carried by a Key rule and by ink, not by lid chroma.** The focused lid is the same neutral as the unfocused one, with a 2px rule in the Key hue at the glyph's own color (`--tug7-element-card-icon-normal-title-active`) drawn along its top edge, and the title at full ink. This replaces the light-chrome arc's "chroma leads" rule for the lid (that arc's inactive-lighter-than-active ordering is kept: inactive `gray, l: 970` against active `l: 965`). The rule is drawn as an inset box-shadow so it adds no height and moves nothing.

**[B04] Selection is a pale Key wash under dark ink, with a 3px Key rule on the row's leading edge.** `--tug7-surface-selection-primary-normal-selected-rest` goes from `l: 710, c: 360` (solid vivid) to `l: 930, c: 50`, and `--tug7-element-selection-text-normal-selected-rest` from near-white to `gray, l: 150`. The user judged the solid fill "too much … must be far less strong," and at `c: 50` with the rule the row still reads as selected. The rule is the GitHub sidebar pattern and does the work if the chroma is turned further down.

**[B05] An inactive card recedes by ink.** The inactive title, glyph, and muted control tokens move from `l: 480–560` to `l: 640, c: 20` in the tint hue, one lightness for all three. The masthead's 85% / 65% ladder steps down from that ink (F06), and the deck's recede layers land on top. The user asked to see exactly this ("dim the text in the titlebar/mastheads in the light styles") and accepted it with a note that the Diff pair is quieter than the Session pair; the two knobs to push if it proves too faint are the inactive ink upward toward `l: 750` and the inactive lid one step darker than the focused one.

**[B06] Borders and dividers follow the fields down in chroma.** Frame `l: 850, c: 8`, default border `l: 860, c: 8`, strong border `l: 800, c: 10`, divider `l: 880, c: 8`. Today's dividers are `c: 80` — a colored line around every neutral field would undo B01.

**[B07] The numbers land in all three light themes at each theme's own hues.** Every value above is hue-relative: tint hue for fields and inactive ink, Key hue for the lid rule, the selection wash, and the row rule. `harmony` = indigo / blue, `aria` = orchid / iris, `vivace` = cyan / seafoam. The spike's readout prints the declarations in this form for the active theme; the same `l`/`c` pairs copy across because chroma is absolute (`tuglaws/color-palette.md`).

**[B08] Marks keep their strength.** Filled and tinted badges, atoms, the focus ring, the caret, drag-drop, flash, and signal colors are not touched. B01 is about what a field may wear; a mark at full chroma on a neutral field is the point.

**[B09] The theme files are the whole of the change.** No component CSS changes are required (F06, F07). The one rule the spike added — the masthead name painting from the title-bar ink — already ships in `session-masthead.css`.

The paste-ready set, per theme (hue names shown for `vivace`; substitute per B07):

```css
--tug7-surface-global-primary-normal-content-rest: --tug-color(cyan, l: 985, c: 4);
--tug7-surface-global-primary-normal-default-rest: --tug-color(cyan, l: 985, c: 4);
--tug7-surface-global-primary-normal-raised-rest: --tug-color(cyan, l: 985, c: 4);
--tug7-surface-global-primary-normal-overlay-rest: --tug-color(cyan, l: 985, c: 4);
--tug7-surface-global-primary-normal-sunken-rest: --tug-color(cyan, l: 965, c: 6);
--tugx-chrome-key-surface: --tug-color(cyan, l: 965, c: 6);
--tug7-surface-card-primary-normal-titlebar-inactive: --tug-color(gray, l: 970);
--tug7-surface-card-primary-normal-status-rest: --tug-color(cyan, l: 965, c: 6);
--tug7-surface-card-primary-normal-controlbar-rest: --tug-color(cyan, l: 955, c: 6);
--tug7-surface-card-primary-normal-block-rest: --tug-color(cyan, l: 965, c: 4);
--tug7-surface-card-primary-normal-well-rest: --tug-color(cyan, l: 985, c: 4);
--tug7-element-card-border-normal-frame-rest: --tug-color(cyan, l: 850, c: 8);
--tug7-element-global-border-normal-default-rest: --tug-color(cyan, l: 860, c: 8);
--tug7-element-global-border-normal-strong-rest: --tug-color(cyan, l: 800, c: 10);
--tug7-element-global-divider-normal-default-rest: --tug-color(cyan, l: 880, c: 8);
--tug7-surface-selection-primary-normal-selected-rest: --tug-color(seafoam, l: 930, c: 50);
--tug7-element-selection-text-normal-selected-rest: --tug-color(gray, l: 150);
--tug7-element-card-text-normal-title-inactive: --tug-color(cyan, l: 640, c: 20);
--tug7-element-card-icon-normal-title-inactive: --tug-color(cyan, l: 640, c: 20);
--tug7-element-card-control-normal-muted-rest: --tug-color(cyan, l: 640, c: 20);
/* focused lid: 2px Key rule along the top edge, at the glyph's own color */
/* selected row: 3px Key rule along the leading edge, at the glyph's own color */
```

---

## Open Questions {#open-questions}

- **Where do the two rules live?** The lid rule (B03) and the row rule (B04) are not tokens; the spike draws them as inset box-shadows keyed on `--sp-lt-lid-rule` / `--sp-lt-sel-rule`. They want a home — most likely a knob on `.tug-pane-title-bar` and on the selected list row, declared in the theme file so a dark theme sets it to `0`. Whether the dark themes want the rules at all is a separate call the arc should make by looking, not here.
- **Does the selection change ride into the dark themes?** B04 is a light-theme call. A pale wash is meaningless on a dark ground, so the dark themes keep their solid selection unless someone decides otherwise. The tokens are per-theme, so nothing forces it either way.
- **Other selection consumers.** `--tug7-surface-selection-primary-normal-selected-rest` is read by more than the rail rows (menus, list views, the `quiet` and `demoted` variants beside it). Whether every consumer wants the pale wash, or only the rail, is for the arc to survey; the spike judged only the rail row.
- **The contrast audit.** `bun run audit:theme-contrast` gates on no more WCAG failures than `brio`. Dimmed inactive ink at `l: 640` on a `l: 965` lid is roughly 3.4:1 and may trip a `content`-role pairing. Whether to relax the pairing's role for inactive chrome or lift the ink is decided when the audit is run, not guessed.

---

## Non-goals {#non-goals}

- **Whisper — today's ladder with chroma capped.** Drawn, looked at, dropped: it keeps the two-hue problem (F03) at lower volume and keeps the rail as the darkest light field.
- **One tint — paper plus a Key-tinted focused Session masthead.** Drawn and dropped: the moment one field wears the Key hue the question of which fields may returns, and B01 is cleaner with the answer "none."
- **Re-hueing the light themes.** The tint and Key hues stay as they are; this is about how much chroma a field may carry, not which hue.
- **Touching the dark themes.** Nothing here was judged on a dark ground. The spike applies no overrides under a dark appearance for that reason.
- **Component CSS changes.** B09. If the arc finds it needs one, that is a finding to record, not a door to walk through quietly.

---

## Exit {#exit}

**An arc.** The shape of the first steps, as the spike's readout already lays them out: land the B07 token set in `harmony.css`, run the contrast audit, look at the deck; then `aria.css` and `vivace.css` by the same mechanical hue swap; then give the two rules (B03, B04) a declared home and set them to zero in the dark themes; then survey the other selection consumers (open question three) and decide per surface. The spike graduates when the numbers ship: its durable content is this brief and the light-theme doctrine in `tuglaws/theme-engine.md`, which should gain a paragraph stating B01 and B02 as the light-theme authoring rule, and the spike file is deleted.
