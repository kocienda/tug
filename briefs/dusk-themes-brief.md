# Dusk: a third theme family

**Purpose:** Tug ships dark themes and light themes and nothing between them. The user wants a third family of mid-tone grounds, light enough that the text is still dark, shipped as five real themes.

---

## Purpose {#purpose}

The request, in the user's words: "I want *a third family of themes* to go alongside the light and dark families we have now. This one should use *mid tones* for the basic color, but be light enough so that *dark/black* text will work."

A spike drew the family, and the user settled its name, its themes' names, its five grounds and the ground's lightness and chroma from it. This brief records those calls and what the codebase needs so the five themes can ship as peers of the ten that exist.

---

## Evidence {#evidence}

**[F01] The spike is the drawn reference.** `tugdeck/src/spikes/spike-mid-themes.tsx` and `tugdeck/src/spikes/spike-mid-themes.css` draw five miniature decks, each a scoped theme root that derives a ladder from one tint hue and one Key hue and restates the `--tug7-*` tokens `TugButton` and `TugBadge` read. The ladder's offsets from the card ground are in the `.sp-mt-deck` rule: raised `+0.07` L, sunken `−0.035`, focused lid `−0.07` at 1.5× chroma, inactive lid `−0.03` at 0.3× chroma, canvas field `−0.30` at 1.2× chroma, card edge `−0.17`, divider `−0.10`. Ink is `gray, l: 130`; muted ink is the tint hue at L 0.34, C 0.03. **(verified, read from the file)** The user judged the spike on a deck and chose from it; the model never saw it rendered.

**[F02] Dark ink holds on the locked ground and white ink does not.** At `l: 775, c: 30` the WCAG contrast of the near-black ink on the card ground is 9.8–9.9 on all five themes, the muted ink 5.7–5.8, and the ink on the focused lid 7.6–7.7. White ink on the same ground is 2.0. **(verified, computed with `oklchToLinearSRGB` from `tugdeck/src/components/tugways/tugcolor.ts`; channels clamped to sRGB)**

**[F03] The shared Accent disappears on a Dusk ground.** Every theme declares `--tugx-accent: --tug-color(orange, l: 755, c: 1000)`. Against the Dusk ground at L 0.775 that is about 1.1 : 1, so the focus ring, the caret and the drop stroke would be invisible. A cut at `l: 560` reaches only about 2.4 : 1, still under the 3 : 1 a mark wants. **(computed with an approximated chroma for the gamut-clamped orange; the ratio is dominated by lightness, so the conclusion holds, but the exact figures are not the build's)**

**[F04] The appearance mode is two-valued in exactly one place and read in five.** `reflectThemeAppearance` in `tugdeck/src/theme-tokens.ts` maps `--tugx-theme-appearance` to `<html data-theme-mode>` as `light` or else `dark`. The attribute is branched on in `tugdeck/src/components/tugways/tug-code.css` (the syntax palette), `tugdeck/styles/focus-ring.css`, `tugdeck/src/components/tugways/tug-list-view.css`, `tugdeck/src/components/tugways/body-kinds/diff-block.css`, and `tugdeck/src/components/tugways/cards/pdf-view.css` with `pdf-view.tsx`. Every one of those branches is `[data-theme-mode="light"]`. **(verified by grep)**

**[F05] The catalog and the theme menu know two modes.** `ThemeMode` in `tugdeck/src/theme-catalog.ts` is `"dark" | "light"`, and `THEME_CATALOG` lists the dark themes and then the light ones. `tugdeck/src/components/cards/cards-space-header.tsx` builds the theme menu from two filters, `mode === "dark"` and `mode === "light"`, so a theme of any other mode would not appear in it. `tugdeck/src/__tests__/theme-catalog.test.ts` loops over `["dark", "light"]` and asserts the dark themes come ahead of the light ones. **(verified)**

**[F06] The registration surface for a theme.** A shipped theme is a complete `tugdeck/styles/themes/<name>.css` (1,132 lines for a dark theme, 1,222 for a light one), an entry in `SHIPPED_THEME_NAMES` in `tugdeck/src/action-dispatch.ts`, and an entry in `THEME_CATALOG` carrying its canvas hex and resolved Key colour. Each file must declare a literal-hex `--tugx-host-canvas-color`. The contrast audit, `bun run audit:theme-contrast`, reads every file under `styles/themes/` and allows no theme more WCAG failures than `ironclad`. **(verified, from the files and `tuglaws/theme-engine.md`)**

**[F07] The light themes carry rules a Dusk theme breaks on purpose.** `tuglaws/theme-engine.md` rule 3 says that in a light theme colour is a mark and never a field, with every field at authored `c ≤ 14`, and `tugdeck/src/__tests__/light-theme-paper.test.ts` enforces that ceiling, the paper ladder and the one-hue rule for the five light themes by name. A Dusk ground at `c: 30` is over the ceiling, and its ladder steps both ways where paper only steps down. **(verified)**

**[F08] The host picks its window appearance from the canvas colour, not from the mode.** `tugapp/Sources/MainWindow.swift` sets `NSAppearance` to `.darkAqua` when the canvas brightness is under 0.5, in two places. The light themes' canvases are dark fields (`sloop` is `#3d4446`), so they already run under `.darkAqua`. The spike's Dusk field is the ground less 0.30, L 0.475, which is on the dark side of that threshold. **(the Swift lines are verified; where a real Dusk canvas hex lands against 0.5 is inferred from the spike's offset and wants reading once a file exists)**

**[F09] Per-mode palettes exist beyond the theme files.** The syntax palette in `tug-code.css` has a dark rung in `body` and a darker rung under `[data-theme-mode="light"]`, tuned for near-white. Each theme file carries its own chart series, signal tones and selection washes, tuned per mode: the light files' series are "darker so each holds 3:1 on the content surface" at L 0.985. None of these has been judged on a ground at L 0.775. **(the files are verified; that the light rungs need retuning for Dusk is inference, and the contrast audit is what settles it)**

**[F10] Three of the five names are already callsign words.** `packet`, `tender` and `cutter` are in the session tag lexicon (`tugdeck/src/lib/session-tag-lexicon.ts`, `tugrust/crates/tugcast/src/session_tag_lexicon.rs`). So is `sloop`, which is a shipped theme, so a theme name and a callsign word sharing a spelling is an existing condition and not a collision. **(verified by grep)**

---

## Decisions {#decisions}

**[B01] The family is named Dusk.** It is the hour between day and night, and it sits in the row with the two words it joins: light, dusk, dark. `ThemeMode` gains `"dusk"`, and a Dusk theme declares `--tugx-theme-appearance: dusk`. The user chose it over Halftone, Midships, Tidewater and Overcast.

**[B02] The five themes are named for working craft: `lugger`, `packet`, `tender`, `cutter`, `trawler`.** Dark themes are ships and light themes are boats, so the mode reads from the word; a working craft is the size class between them. The user chose this set over two others.

**[B03] Each theme's ground and Key, as drawn in the spike:**

| Theme | Ground | Tint hue | Key hue |
|---|---|---|---|
| `lugger` | Gravel | `gray` (no chroma) | `sapphire` |
| `packet` | Sand | `honey` | `plum` |
| `tender` | Sage | `jade` | `azure` |
| `cutter` | Slate | `cerulean` | `cobalt` |
| `trawler` | Mauve | `orchid` | `cerise` |

Gravel is the user's own call: a true neutral gray in place of the spike's first warm ground. The four tinted pairings were the spike's first proposals and the user kept them. A Key may move at rollout if the contrast audit or the 30° rule against the signal hues demands it; a tint hue may not, because the ground is what the user chose.

**[B04] The card ground is `l: 775, c: 30` on the theme's tint hue, and `lugger`'s is `gray, l: 775`.** The user locked both numbers on the spike's sliders. This is the content, default and card surface. `lugger` carries no chroma on any neutral surface or neutral ink.

**[B05] Elevation steps both ways from the ground.** Raised surfaces, overlays and the code well are lighter than the ground; the lid, the sunken band and the canvas field are darker. A mid-tone has headroom in both directions, and using it is what distinguishes the family from paper, which can only step down. The offsets in [F01] are the starting ladder, to be tuned by eye and by the audit as the first theme file is written; the ground in [B04] is the one fixed rung.

**[B06] In a Dusk theme colour may be a field.** The ground, the lid and the canvas carry the tint at a chroma the light themes are forbidden. The one-hue rule still holds: every neutral surface and neutral ink of a theme is on its one tint hue, and the Key hue stays in marks, fills and washes.

**[B07] Ink is the dark-ink family.** Default text is near-black gray, muted text is the tint hue darkened, and on-fill text over a dark Key fill is near-white. A Dusk theme file is therefore authored from the light themes' token families, not the dark themes', since a surface change is a token family change and the ink polarity here is the light themes'.

**[B08] `data-theme-mode` gains the value `dusk`, and every existing `light` branch is answered for it.** `reflectThemeAppearance` reflects the token's own three values. Each of the five consumers in [F04] then states what Dusk gets. The default answer is the light branch, because all five exist to serve dark ink, with the syntax palette the one certain to need its own rung since its light values are tuned against L 0.985. A consumer silently falling through to the dark branch is the failure this decision exists to prevent.

**[B09] Dusk needs its own Accent cut.** The shared `l: 755` orange cannot ship on these grounds ([F03]). Each Dusk file declares a `--tugx-accent` that holds at least 3 : 1 against its ground. The hue stays orange unless the open question below changes it.

**[B10] The catalog and the menu order the families dark, dusk, light.** Dusk sits between the two it sits between. The theme menu gains a Dusk group, `next-theme` cycles through it in that order, and the catalog test's ordering assertion is restated for three modes with the same guarantee: each family's themes are contiguous.

**[B11] Dusk gets its own invariant test, and the paper test stays as it is.** `light-theme-paper.test.ts` keeps guarding the five light themes by name and gains no Dusk theme. A sibling test holds the Dusk settlement: the ground at `l: 775, c: 30`, `lugger` at zero chroma, one tint hue across every neutral surface, and the raised rung above the ground with the lid and field below it.

**[B12] The doctrine is written down in the same work.** `tuglaws/theme-engine.md` gains the five rows of its theme table, the Dusk authoring rules beside rule 3, and the reference theme a new Dusk theme is derived from. The naming sentence becomes ships, working craft and boats.

**[B13] The spike stays.** The user said to keep it for now. Its seeds were moved to the locked ground in this session and that edit is uncommitted. It is deleted or graduated in a later gesture, not by this rollout.

---

## Open Questions {#open-questions}

- **What is the Dusk Accent?** [F03] and [B09] say it must change; they do not say to what. A deeper orange near `l: 500` holds contrast but may read as brown on Sand and against the caution signal. A near-white ring is the other direction a mid-tone allows. This is a judgment by eye on a rendered deck, and it decides the focus ring, the caret, the drop stroke and the flash at once. The spike already draws two rings side by side and could draw the candidates.
- **Does a Dusk lid carry the two Key rules?** The light themes draw a Key rule on the focused lid and down a selected row because their fields went neutral and had nothing left to say focus with. A Dusk lid has colour and a lightness step of its own, so the lid rule may be redundant. The selected-row rule is drawn in the spike. Settled by eye on the first theme file.

---

## Non-goals {#non-goals}

- **No change to the ten shipped themes.** Their files, their tests and their doctrine stay as they are, `ironclad` above all.
- **No automatic switching between families** by time of day or by the system appearance. Dusk is a set of themes a workspace wears, chosen the way the others are.
- **No Theme Deriver or theme editor work** beyond what authoring five files requires. If the deriver cannot produce a Dusk theme from a reference, the files are written by hand.
- **Clay is not a theme.** The spike's first warm ground was dropped by the user in favour of Gravel.
- **The other name candidates are closed.** Halftone, Midships, Tidewater and Overcast for the family; the world-traders set (`dhow`, `felucca`, `sampan`, `proa`, `junk`) and the inland set (`barge`, `scow`, `wherry`, `ferry`, `punt`) for the themes.
- **Deleting the spike** is not part of this work ([B13]).

---

## Exit {#exit}

**An arc.** The work has a natural order, because four of the five files are a hue swap of the first:

- Make the mode three-valued before any theme uses it: `ThemeMode`, `reflectThemeAppearance`, the menu's grouping and the catalog test ([B01], [B08], [B10]).
- Write one Dusk theme in full as the family's reference, from `sloop`'s token families, on the locked ground and the spike's ladder. `cutter` is the closest to `sloop`'s own hues; `lugger` is the simplest ground. Register it, give it a canvas hex, and run the contrast audit against it. This is where the ladder, the signals, the chart series and the selection washes get their Dusk rungs, and where the two open questions are answered on a real deck.
- Answer each `[data-theme-mode="light"]` consumer for Dusk, the syntax palette first ([B08], [F09]).
- Derive the other four from the reference, `lugger` with its chroma zeroed, and register each in `SHIPPED_THEME_NAMES` and `THEME_CATALOG`.
- Land the Dusk invariant test and the doctrine ([B11], [B12]).
- Read the host's window appearance against a real Dusk canvas hex ([F08]), and update whatever enumerates the shipped themes: `tugdeck/src/__tests__/action-dispatch.test.ts`, `theme-mirror.test.ts`, `theme-cvd-series.test.ts`, and the app-tests on the workspace theme menu (`at0663`–`at0665`, `row-44-switch-theme`).
