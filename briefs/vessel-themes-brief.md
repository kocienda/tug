# Vessel Themes: Ten Themes, Named for Ships and Boats

**Purpose:** Grow the theme set from six to ten — two more color variants in each of dark and light — and replace the musical theme names, which nothing else in Tug echoes, with nautical ones.

---

## Purpose {#purpose}

The user asked for two things at once. First: "add *two more color variants* to each of the dark and light themes." Second: "a better naming system that isn't based on musical names, since nothing else in Tug uses such names," in a nautical register.

A first round of sea-inspired names (water states, materials, light at sea) was rejected as "mostly *terrible*", with the direction "ship names or more nautical than sea-inspired." The color plan from that round was accepted as "good enough to try." The vessel-type names in this brief were then accepted: "Let's go with these."

---

## Evidence {#evidence}

**[F01] The six shipped themes and their hues** — read from `tugdeck/styles/themes/*.css` (the neutral surface tokens and `--tug7-surface-control-primary-filled-action-rest`). **(verified)**

| Theme | Mode | Tint | Key |
|---|---|---|---|
| `brio` | dark | indigo-violet | cobalt |
| `nocturne` | dark | teal | seafoam |
| `bravura` | dark | grape | purple |
| `harmony` | light | indigo | blue |
| `aria` | light | orchid | iris |
| `vivace` | light | cyan | seafoam |

**[F02] Every theme's Key sits in the cool half of the wheel** — the six Keys run from seafoam (165°) to purple (285°) in the hue table in `tugdeck/src/components/tugways/tugcolor.ts`. There is no warm-tinted theme and no theme whose Key is outside the teal-to-purple arc. **(verified)**

**[F03] All six themes declare the same Accent** — `--tugx-accent: --tug-color(orange, l: 755, c: 1000)` in every file. `tuglaws/theme-engine.md` already notes this. The `FAMILY` table in `tugdeck/src/components/tugways/cards/gallery-theme-editor.tsx` disagrees with the files: it lists `amber` for `aria` and `gold` for `vivace`. **(verified)**

**[F04] Rose clears every fixed signal hue** — the signals are red (25°), yellow (90°), green (140°), teal (175°) and violet (270°). Rose is 335°, which is 50° from red, its nearest signal. That is a wider gap than two Keys already shipped: seafoam sits 10° from teal and purple 15° from violet. **(verified by arithmetic on the hue table; not yet checked in the contrast or CVD audit)**

**[F05] Amber-family Keys do not fit** — amber (65°) and honey (70°) sit within 25° of the caution signal and within 15° of the orange Accent. A warm theme therefore cannot take a warm Key without crowding both. **(verified by arithmetic)**

**[F06] A sibling theme is mostly mechanical to produce** — the Theme Deriver (`deriveTheme` in `tugdeck/theme-editor-core.ts`, driven by `POST /__theme-editor/derive` in `tugdeck/vite.config.ts`) generates a family member from a same-mode base by rotating hues while holding chroma and lightness. `tuglaws/theme-engine.md` gives the remaining hand steps: remap the neutral tint family, set a literal-hex `--tugx-host-canvas-color`, run `bun run audit:theme-contrast`. **(verified by reading; the deriver was not run)**

**[F07] The rename surface is short** — the places that carry theme names as identifiers: **(verified by grep; a plan should re-run it)**

- the six files in `tugdeck/styles/themes/`
- `SHIPPED_THEME_NAMES` in `tugdeck/src/action-dispatch.ts`
- `BASE_THEME_NAME` in `tugdeck/src/theme-constants.ts` and `baseThemeName` in `tugapp/Sources/AppDelegate.swift`
- the base path and comments in `tugdeck/vite.config.ts`
- the `FAMILY` table and base-picker labels in `gallery-theme-editor.tsx`
- `tugdeck/scripts/clamp-theme-gamut.ts`
- tests: `light-theme-paper.test.ts`, `chrome-rule-knobs.test.ts`, `action-dispatch.test.ts`
- `tuglaws/theme-engine.md` and the theme section of `CLAUDE.md`
- the saved theme preference, which stores the name

Many more files mention `brio` in comments. Rust test fixtures in `tugrust/crates/tugcast/src/feeds/operator.rs` use `brio` as sample prompt text and a sample path, not as a theme identifier.

**[F08] No collision search was run on the vessel names** — the earlier research covered the rejected sea-word set only. From memory, not from a search: `frigate`, `clipper` and `cutter` carry well-known product namesakes, which is why they are alternates; `sloop`, `ketch` and `skiff` have small or defunct ones. **(not verified)**

---

## Decisions {#decisions}

**[B01] Themes are named for vessel types: ships for dark, boats for light.** The product is itself named for a vessel, so the family is native to Tug in a way the musical names were not. The ship/boat split makes the mode legible from the word alone. Sea-state and material words (`abyss`, `spume`, `oakum` and the rest) were tried first and rejected by the user.

**[B02] The ten themes are these.** Colors for the six existing themes do not change; only their names do.

| Name | Mode | Was | Tint | Key |
|---|---|---|---|---|
| `ironclad` | dark, base | `brio` | indigo-violet | cobalt |
| `trawler` | dark | `nocturne` | teal | seafoam |
| `barque` | dark | `bravura` | grape | purple |
| `galleon` | dark | new | honey | cerulean |
| `collier` | dark | new | azure | rose |
| `sloop` | light | `harmony` | indigo | blue |
| `ketch` | light | `aria` | orchid | iris |
| `skiff` | light | `vivace` | cyan | seafoam |
| `dory` | light | new | honey | sapphire |
| `yawl` | light | new | pink | rose |

**[B03] The four new themes fill the two gaps [F02] names, as cross-mode pairs.** `galleon` and `dory` are the warm pair, sharing the honey tint so they read as siblings across modes. `collier` and `yawl` are the rose pair: a quiet tint with one hot Key. The user accepted this color plan as "good enough to try", so it is a starting point for the audit, not a final tuning.

**[B04] Warm themes take a cool Key.** Per [F05], `galleon` takes cerulean and `dory` takes sapphire. The warmth lives in the tint; the Key stays clear of caution and of the Accent.

**[B05] The Accent stays orange on all ten.** Per [F03] no theme has taken up a per-theme Accent yet, and doing so is a separate decision from adding themes. Revisit only if the audit shows orange sitting badly on the honey tints.

**[B06] New themes copy the shipped skeletons and do not re-derive them.** Dark themes follow `brio`'s ladder (canvas `l: 210`, tint `c: 20`). Light themes follow the paper ladder in `tuglaws/theme-engine.md` (`l: 985` content, `c: 4`–`c: 6`, Key in marks only), and the two new light themes join the list `light-theme-paper.test.ts` holds.

**[B07] The rename is a clean break.** The install base is zero, so there is no alias table and no migration of a saved preference holding an old name; an unknown saved name falls back to the base theme as it does today.

**[B08] `ironclad` is the base theme.** It is `brio` renamed, so `BASE_THEME_NAME` and the Swift `baseThemeName` change value together and nothing else about the base-theme contract moves.

---

## Open Questions {#open-questions}

- **Does rose hold apart from danger red under color-vision deficiency?** [F04] is arithmetic only. The contrast audit's CVD checks on `collier` and `yawl` settle it. If it fails, azure is the agreed fallback Key for `collier`; `yawl` has no agreed fallback yet.
- **Is `yawl` the right word for the rose light theme?** It is the least literal fit of the ten. `lugger`, whose traditional sails were red-tan, is the recorded alternate. The user accepted the set as given, so this only reopens if they raise it.

---

## Non-goals {#non-goals}

- **Sea-state and material names.** `abyss`, `grotto`, `gloaming`, `oakum`, `squall`, `spume`, `nacre`, `shallows`, `sailcloth`, `conch` were proposed and rejected by the user.
- **Famous-ship proper names.** `endurance`, `beagle`, `calypso` and similar were offered as a second register and not taken; they carry no dark or light signal.
- **Per-theme Accent hues.** See [B05].
- **Retuning the six existing themes.** Their colors are untouched; this work renames them.
- **A compatibility bridge for old names.** See [B07].
- **Alternates held in reserve, not shipped.** Dark: `frigate`, `schooner`, `whaler`, `dreadnought`. Light: `cutter`, `clipper`, `dhow`, `lugger`, `wherry`, `coracle`.

---

## Exit {#exit}

**An arc.** Its natural order:

- Rename the six existing themes across the surface in [F07], with `ironclad` as the base, and get the existing tests and the contrast audit green under the new names before any new theme exists.
- Derive `galleon` and `collier` from `ironclad`, and `dory` and `yawl` from `sloop`, per [F06]; remap each tint, set each host canvas hex, register all four in `SHIPPED_THEME_NAMES`, and extend the deriver's `FAMILY` table, fixing its Accent drift from [F03] on the way.
- Run the contrast audit on all ten and resolve the rose question above.
- Rewrite the theme table in `tuglaws/theme-engine.md` and the theme section of `CLAUDE.md`.
