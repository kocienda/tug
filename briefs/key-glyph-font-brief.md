# Key glyph font: Plex-matched Mac key symbols for the deck

**Purpose:** The Mac modifier and key symbols in the transcript and the composer are drawn from a system fallback face at symbol scale, small and squat against IBM Plex. We have drawn our own set to Plex's measure; this brief decides how they become a font the deck uses everywhere a chord is read.

---

## Purpose {#purpose}

The user's report, with a screenshot of the Session card: "The macOS-specific modifier keys have *awful glyphs* in the font we use both in the prompt entry and in the transcript. Is there anything we can do here to make these glyphs be sized more like the surrounding text, have better baselines, be more legible?"

The sketch settled on a font-level fallback for the fourteen symbols, and the drawings exist and are approved: `resources/glyphs/` holds the generator, the outlines and a specimen, landed as `3ed3b45227` (the set) and `37ee5adcb6` (the solid wide-headed arrows). What remains is turning the outlines into a font and wiring it into the deck.

---

## Evidence {#evidence}

**[F01] Plex has none of the modifier glyphs.** Read from the bundled fonts' cmaps with fontTools: IBM Plex Sans, Plex Mono and every Plex script face in the fallback chain (Arabic, Hebrew, Thai, JP) lack U+2318 ⌘, U+2325 ⌥, U+2303 ⌃, U+21E7 ⇧, U+238B ⎋, U+232B ⌫, U+2326 ⌦, U+21E5 ⇥, U+21EA ⇪ and U+23CE ⏎. They do carry U+2190–2193 ← ↑ → ↓. **(verified)**

**[F02] The fallback is the system face.** `--tug-font-family-sans` in `tugdeck/styles/themes/ironclad.css` ends in `system-ui, -apple-system`, and SF Pro carries all the missing symbols, so WebKit draws them from SF at SF's symbol proportions: a low cap, heavy stroke, and a letter after them still in Plex. The chain is repeated verbatim in all ten theme files. **(verified by reading; the face WebKit actually picks was not read off the live deck)**

**[F03] The keymap pane already solved this locally.** `settings-keymap-body.css` sets `.settings-keymap-chord-label` in `system-ui` with a comment naming exactly this problem, so the pane draws a chord in one face while the transcript draws it in two. **(verified)**

**[F04] Plex's measures.** Cap height 698, x-height 516, ascent 1025, descent 275, UPM 1000, identical across Sans and Mono. Vertical stems 84/113/152 and horizontal bars 74/100/135 at Regular, Medium, Bold; Sans and Mono agree within two units. Plex's own ← is 710 wide in Sans and compressed to 552 in Mono's 600 cell. **(verified)**

**[F05] The drawings exist and are approved.** `resources/glyphs/build.py` draws all fourteen glyphs as filled outlines from stroked centerlines via skia, at strokes 82/104/130, and writes 84 SVGs under `resources/glyphs/svg/<family>-<weight>/` plus `resources/glyphs/specimen.html`. The user approved the set and then the solid wide-headed arrows in their place. The outlines are already overlap-free and even-odd clean, which is what a font cutter needs. **(verified)**

**[F06] The font stylesheet is static and provenance-bearing.** `tugdeck/public/fonts.css` holds every `@font-face` as a static sheet outside HMR, is loaded by `tugdeck/index.html`, and records each face's license. `scripts/fetch-fonts.ts` vendors Plex into `public/fonts` and only removes its own temp dir, so a hand-placed face in `public/fonts` survives a refetch. **(verified by reading)**

**[F07] Text measurers in the deck.** `src/lib/font-metrics.ts`, `src/lib/atom-font.ts` and `src/lib/tug-atom-img.ts` measure or paint text, and app-test `at0205` checks an atom chip's first paint. A chord inside an atom will resolve a second face. **(verified that they exist; not verified that any of them breaks)**

---

## Decisions {#decisions}

**[B01] The symbols ship as a font of our own, reached through `unicode-range`.** A font-level fallback reaches every surface at once, transcript, composer, chips, badges and the keymap pane, with no markup pass and no runtime work, and it is the only mechanism that can seat a glyph on Plex's baseline at Plex's cap height. Custom SF Symbols were ruled out: a symbol is an asset rendered by AppKit, not a glyph in any cmap, so WebKit text can never fall back to it.

**[B02] Two faces, Sans and Mono, three static weights each.** The outlines already differ by family: Mono compresses the centerline into a 600 cell and keeps the stroke, as Plex Mono's own arrows do. One cutter run per family and weight gives six woff2 files, each a few kilobytes. A variable font buys nothing at three instances.

**[B03] The faces carry Plex's vertical metrics and need no CSS overrides.** With ascent 1025, descent 275 and cap 698 written into the font, a glyph seats itself; `size-adjust` and the ascent and descent overrides stay unused, and a mismatch is a bug in the cutter rather than a knob in the CSS.

**[B04] The range covers all fourteen codepoints, arrows included, in both families.** The user chose the heavy arrows over Plex's, so a prose arrow and a chord arrow are now the same glyph everywhere. The range is U+2318, U+2325, U+2303, U+21E7, U+238B, U+232B, U+2326, U+21E5, U+21EA, U+23CE, U+2190–2193.

**[B05] The new face is prepended to both family chains in every theme.** Ten theme files each spell `--tug-font-family-sans` and `--tug-font-family-mono`; the arc edits all ten the same way, or lifts the chain into one shared token if that is a smaller change. The composer and transcript inherit it.

**[B06] The keymap chip's `system-ui` override is removed.** With the face in the chain, the pane, the transcript and the composer draw the same chord. The comment in `settings-keymap-body.css` that explains the override is replaced by one pointing at the font.

**[B07] The cutter lives beside the generator and is rebuildable from the outlines.** A fontTools script in `resources/glyphs/` reads the skia outlines (or the SVGs) and writes the woff2 files into `tugdeck/public/fonts/`, so the font is never hand-edited and the drawings stay the source. It records the font's name, version and license in the font's name table and in `fonts.css` beside the Plex entries.

**[B08] The face is ours and OFL-licensed.** Every outline is an original drawing to Plex's measure; nothing is traced from SF. OFL 1.1 is what Plex and Datatype already carry in `fonts.css`, and it keeps the bundle free of anything Tug cannot ship.

**[B09] Verification is one app-test plus a look at the real deck.** A test that reads the computed font of a modifier glyph in the transcript and in the composer, and the existing measurers and `at0205` run as the step's own files. The three weights, dark and light, are checked on the live app at the user's sizes.

---

## Open Questions {#open-questions}

- **The face's name.** It appears in the name table, the CSS chain and the license block; the user may want to pick it. Absent a preference the arc uses "Tug Keys".

---

## Non-goals {#non-goals}

- **Wrapping chord runs in markup.** A text-run annotator in the markdown renderer plus a CodeMirror decorator in the composer would make a chord an object, but it is two annotators to keep in step, it misses text outside those pipelines, and it still needs a face. Rejected in the sketch.
- **Naming the system face through `local()` with `unicode-range`.** It corrects the metrics but keeps SF's drawings, which is the thing the user objects to. It was the proposed probe, and it is moot now that our drawings exist.
- **Custom SF Symbols.** Not reachable by WebKit text layout. See [B01].
- **Matching the menu bar.** A Tug chord will differ from the same chord in the AppKit menu bar. The chord is read inline in prose far more often than beside a menu item, so matching Plex wins.
- **Retuning the drawings.** The set and the heavy arrows are approved and committed; this work cuts and wires them. A drawing change is a separate change to `build.py`.

---

## Exit {#exit}

**An arc.** The shape, in the order it must land:

1. The cutter: a fontTools script beside `build.py` that emits six woff2 files into `tugdeck/public/fonts/`, with Plex's vertical metrics, a cmap of the fourteen codepoints, and the name and license tables. Proven by loading one face in the specimen through `@font-face` and `unicode-range` and seeing it match the inline SVGs.
2. The wiring: `fonts.css` entries with provenance, the chain prepended in all ten themes, the keymap chip override removed.
3. The verdict: the app-test from [B09], the measurers and `at0205`, and a look at the live deck.
