# Theme System (CSS-First)

*The theme runtime is CSS-first and file-based.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Source Of Truth

Theme data lives in checked-in CSS files:

| File | Role |
|---|---|
| `tugdeck/styles/themes/<name>.css` | Theme source (complete token declarations) |
| `tugdeck/styles/tug-active-theme.css` | Active theme copy (complete theme, never empty) |

Shipped themes (registered in `SHIPPED_THEME_NAMES`, `tugdeck/src/action-dispatch.ts`):

Each theme carries a **Key + Accent duet**:
**Key** is the selection / primary-action hue (list & menu selection, toggle/radio/checkbox/choice
"on", tabs, links, the primary CTA, text selection); **Accent** is the affordance hue (keyboard caret
bar, focus ring, drag-drop stroke, flash). The chroma column notes each axis's relative saturation —
low-chroma Keys read as pale tints, high-chroma Keys as vivid.

| Theme | Mode | Tint | Key (chroma) | Accent (chroma) |
|---|---|---|---|---|
| `brio` | dark | indigo-violet | cobalt (vivid) | orange (vivid) |
| `nocturne` | dark | teal | seafoam (vivid) | orange (vivid) |
| `bravura` | dark | grape | purple (vivid) | orange (vivid) |
| `harmony` | light | indigo | blue (vivid) | orange (vivid) |
| `aria` | light | orchid | iris (vivid) | orange (vivid) |
| `vivace` | light | cyan | seafoam (vivid) | orange (vivid) |

Two repetitions in that table are the files' own and not transcription slips: every theme currently
declares the same `--tugx-accent`, so the Accent column is one hue six times, and every Key is vivid
(`c: 400` dark, `c: 320` light on the filled action), so the chroma note distinguishes nothing today.
The duet above is the *authoring* rule; the Accent column is where the six files have not yet taken
it up. Read the table against `styles/themes/*.css` before copying a row — it has drifted twice.

Every theme is a peer — none depends on another at runtime. `brio` is special only as
`BASE_THEME_NAME` (the bundled base; see `tugdeck/src/theme-constants.ts`). Each theme is a
complete, hand-authored CSS file defining the full token vocabulary.

---

## Tinted-Neutral Authoring Doctrine

Every theme is **one tint hue over a shared lightness skeleton** — the "predominant tint colors the
details without a redesign" model. The engine (`--tug-color(hue, l:, c:)`, OKLCH) makes a new theme
largely a hue swap: keep the *lightness* ladder, change the *hue*.

1. **One tint hue per theme** for all `--tug7-surface-global-primary-*` neutrals (and the neutral
   text/icon/border/divider families). Surfaces differ by **lightness only**; chroma stays in a tight
   low band (a faint tint — a small fraction of the gamut, low `c`). Lightness carries elevation, not hue.
2. **Monotonic elevation ladder.** Dark: deeper base, lighter raised/overlay. Light: lighter base
   (content/raised/overlay near white), darker recessed wells (sunken). No hue jumps, no
   dark-surface-in-a-light-theme surprises. `screen` (tooltips, dev panel) is the lone exception in
   light themes — it stays light because tooltips render *default* text, not inverse.
3. **In a light theme, color is a MARK and never a field.** Every surface larger than a control — the
   canvas, the card, the rail, the lid, the status band, the tool block, the tooltip — is a tinted
   *neutral* on the theme's one tint hue at authored `c ≤ 14` (OKLCH C ≤ 0.007, about where Tailwind's
   `slate-100` sits). The **Key hue appears only in marks**: badges, atoms, glyphs, the focus ring,
   the caret, the selection wash, and any rule drawn to carry focus or selection once the fields have
   gone quiet. Elevation is lightness in a *short* ladder — two or three points of L between adjacent
   rungs, near the top of the range — not saturation, and not a fourth hue.

   The shipped ladder, which a fourth light theme should copy rather than re-derive: content, card,
   raised, overlay and the tool-block well at `l: 985`; the rail, the focused lid band, the status
   rung and the tool block at `l: 965`; the Z0 control band at `l: 955`; chroma `c: 4`–`c: 6`
   throughout. The inactive lid is *lighter* than the focused band, not darker (`gray, l: 970`) —
   on paper the focused thing is the one with more ink, so an unfocused card recedes by bleaching.
   Borders and dividers run `l: 800`–`l: 880` at `c: 8`–`c: 10`, and inactive ink `l: 640, c: 20`.

   The reason is that chroma reads louder as lightness rises. A shared `l`/`c` skeleton therefore does
   NOT transfer between modes: the same authored `c` that is a whisper at L 0.3 is a colored panel at
   L 0.96, so a light theme built by re-hueing a dark one arrives with a dozen fields each wearing a
   little of the Key hue and reads as two hues at once rather than one. Authoring a field on the Key
   hue is the specific mistake — it puts the action color under everything instead of on the things
   that act. `tugdeck/src/__tests__/light-theme-paper.test.ts` holds the ceiling, the ladder and the
   one-hue rule for the three shipped light themes; a fourth joins that list.
4. **Signals are fixed across themes** by hue: `danger`=red, `success`=green, `caution`=yellow/gold,
   `data`=teal, `agent`=violet. The **selection / primary-action axis is no longer a fixed blue** —
   each theme picks its own **Key** hue (the `selection`/`active`/`toggle-on`/`link`/filled-action
   tokens) and a partnered **Accent** hue (the affordance axis: caret, focus ring, drag-drop, flash).
   Both ride the TugColor model (`--tug-color(hue, l:, c:)`, lightness kept per-mode so light themes keep
   their darker legible links); each rung carries its own chroma. Re-hue a theme with
   `tugdeck/scripts/apply-theme-editor.ts` (additive l/c deltas) from a clean theme file, then run the contrast audit.
   Keep Key and Accent ≥~30° from every signal hue and from each other; on-fill contrast text stays a
   near-white (dark) / near-black (light) neutral — never the Key hue, or it vanishes on its own fill.
5. **Signal tuning is per-mode.** Dark: bright, mid-tone, saturated. Light: darker and more saturated
   so a mark holds contrast on near-white. Saturated light hues (orange/yellow/teal) can't reach 3:1
   on white without turning muddy — that is an accepted light-theme tension, the mirror of dark
   themes' dark-on-dark limits.
6. **Consistent authoring style** (uniform `l:`/`c:` usage) so themes diff cleanly and the next tint
   swap stays mechanical.

A new theme: copy the same-mode reference (brio for dark, harmony for light), remap the neutral-tint
family and the accent hue, set a literal-hex `--tugx-host-canvas-color` matching the app surface, and
validate with the contrast audit below.

---

## Contrast Audit (per theme)

`bun run audit:theme-contrast` (`tugdeck/scripts/audit-theme-contrast.ts`) resolves every token in
the authoritative pairing map for each `styles/themes/*.css` and runs the same WCAG / perceptual /
CVD checks as the in-app Theme Accessibility card — headlessly, reusing `resolveTugColorToOklch`
(the single source of truth shared with `postcss-tug-color`, so build and audit never drift).

WCAG is normative per role; perceptual is informational. The gate is **comparative**: the base theme
(`brio`) sets the accessibility budget, and no other theme may ship with *more* WCAG failures than
it. Run `audit:theme-contrast <name>` for one theme (with the full failure list), or `--list` for all.

---

## Activation Model

### Development

- `POST /__themes/activate` is the activation API.
- `brio` copies `styles/themes/brio.css` into `tug-active-theme.css`.
- `harmony` copies `styles/themes/harmony.css` into `tug-active-theme.css`.
- The endpoint returns `{ theme, hostCanvasColor }`.
- `tug-active-theme.css` is always a complete theme; it is never empty.

### Production

- Base theme is included by app CSS import.
- Non-base theme is activated via `<link id="tug-theme-override" href="/assets/themes/<name>.css">`.
- `activateProductionTheme()` inserts/updates/removes that link.
- On startup, if saved theme is non-`brio`, the link is applied before first visible paint.

---

## Host Canvas Color Contract

Each theme CSS file must define:

```css
body {
  --tugx-host-canvas-color: #rrggbb;
}
```

Rules:

- Must be literal 6-digit hex.
- Dev activation returns this value from source CSS metadata.
- Production activation reads the applied CSS value and normalizes to `#rrggbb`.
- Swift bridge receives only the normalized hex string.

---

## Accessibility Card Data Path

Theme Accessibility uses live CSS, not derivation:

1. Build-time token inventory: `TUG_TOKEN_NAMES`.
2. Runtime raw values: `getComputedStyle(...).getPropertyValue(name)`.
3. Runtime color resolution: hidden probe element for tokens needing computed color.
4. Contrast/CVD analysis from resolved runtime colors.

This card reports live findings only (failures, marginals, unresolved values, CVD warnings).

---

## Build Processing

PostCSS is used for CSS processing:

- Authoring syntax `--tug-color(...)` remains in source CSS.
- `postcss-tug-color` expands to regular CSS during Vite dev/build.

The system intentionally duplicates one value per theme (`--tugx-host-canvas-color`) to keep runtime simple and explicit.
