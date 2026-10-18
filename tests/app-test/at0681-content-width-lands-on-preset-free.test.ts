/**
 * at0681-content-width-lands-on-preset-free.test.ts — choosing the deck's
 * content width puts every content pane exactly on the preset, starting from
 * free panes.
 *
 * `set-content-width` is the Layout card's Card Width row: it re-widths every
 * content pane to the named preset and re-solves the rails in the same commit
 * (`DeckManager.setContentWidth`). The preset is the ask and the band is the
 * ceiling, so a pane lands on `min(preset, band)` — and on exactly that, to
 * the pixel, both in the record and on screen. A pane one pixel short reads as
 * a card that did not quite take the width it was given, and the seams beside
 * it stand a pixel off the ones `setCardWidths` produces for the same preset.
 *
 * The fixture is two free content panes beside a pinned Layout rail, because
 * the rail re-solve is the half of the gesture only this door runs. Every
 * preset is read in turn, and the band is read from the live
 * `--tug-imposer-inset-*` values rather than typed here, so a deck whose band
 * is narrower than `wide` still asks the honest question.
 *
 * One piece of the at0681-content-width-lands-on-preset split ([B07] of the
 * bodies migration brief); `-three-up` starts from slotted panes under an imposition and `-bullseye` from a pane standing in bullseye. The deck, the readers and the case body
 * are `content-width-preset-fixture.ts`.
 *
 * @family at0681-content-width-lands-on-preset
 * @covers tugdeck/src/layout-imposition.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, test } from "bun:test";

import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  caseTitle,
  landsOnPreset,
  type PresetCase,
} from "./content-width-preset-fixture";

const CASE: PresetCase = { name: "free", imposed: false, bullseye: false };

describe.skipIf(!SHOULD_RUN)("at0681 — the deck's content width lands on its preset", () => {
  test(caseTitle(CASE), () => landsOnPreset(CASE), TEST_TIMEOUT_MS);
});
