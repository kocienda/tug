/**
 * at0212-text-card-manual-save-draft.test.ts — what a Text card in manual
 * save mode keeps that is not yet on disk ([AT0212],
 * arc/file-editing-enhancements.md).
 *
 * One piece of the at0212 split; the deck shape and gestures are
 * `text-card-manual-save-fixture.ts`.
 *
 * 1. **Aside crash-safety.** A dirty edit is set aside under Autosave
 *    Information without touching the real file.
 * 2. **New Text Card.** `new-text-card` opens a second Untitled editor, and
 *    that buffer's masthead is checked for the two things a not-yet-a-file
 *    document must not do: leave the second line empty (a hole in a fixed
 *    three-line tier) or claim on the third that it was saved — and the
 *    italic stand-in is checked to paint ink.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/text-card-save-text.ts
 * @covers tugdeck/src/components/tugways/card-masthead.tsx
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-status-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @family at0212-text-card-manual-save
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { mkTextFixture } from "./_harness/fixtures";
import { enforcedTimeout } from "./_harness/rpc";
import { decodePngFile } from "./_harness/png";
import {
  ORIGINAL,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  dispatchControl,
  seedTextCard,
  settle,
  typeIntoEditor,
  waitForEditor,
  waitForSaveCell,
} from "./text-card-manual-save-fixture";

describe.skipIf(!SHOULD_RUN)("at0212: Text card manual save", () => {
  test(
    "a dirty edit is set aside without touching the real file",
    async () => {
      const asideDir = path.join(
        os.homedir(),
        "Library/Application Support/Tug/Autosave Information",
      );
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      const app = await launchTugApp({ testName: "at0212-aside" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(await waitForBodyReady(app, "A"), "alpha");
        await typeIntoEditor(app.body("A"), "ASIDE-SENTINEL ");
        await waitForSaveCell(app.body("A"), "Edited");
        await settle();

        const deadline = Date.now() + 15000;
        let found = false;
        while (Date.now() < deadline && !found) {
          if (fs.existsSync(asideDir)) {
            for (const name of fs.readdirSync(asideDir)) {
              try {
                if (fs.readFileSync(path.join(asideDir, name), "utf8").includes("ASIDE-SENTINEL")) {
                  found = true;
                  break;
                }
              } catch {
                /* racing writer — retry */
              }
            }
          }
          if (!found) await new Promise((r) => setTimeout(r, 150));
        }
        expect(found).toBe(true);
        expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "New Text Card opens a second Untitled editor",
    async () => {
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      const app = await launchTugApp({ testName: "at0212-new-text-card" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(await waitForBodyReady(app, "A"), "alpha");
        await settle();
        await dispatchControl(app, "new-text-card");
        await settle();
        // Each Text card is its own body: count the editors page by page and
        // sum them.
        {
          const budget = enforcedTimeout(15000);
          const deadline = Date.now() + budget;
          for (;;) {
            let editors = 0;
            for (const b of await app.bodies()) {
              if (b.componentId !== "text" || b.state !== "ready" || b.cardId === null) continue;
              editors += await app
                .body(b.cardId)
                .evalJS<number>(`document.querySelectorAll('[data-slot="tug-text-card-editor"]').length`);
            }
            if (editors >= 2) break;
            if (Date.now() >= deadline) {
              throw new Error(`fewer than two Text card editors within ${budget} ms (saw ${editors})`);
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        // The masthead of a buffer that is NOT A FILE YET. Both lines were
        // wrong when the tier shipped: the second was empty, which on a fixed
        // three-line tier is a hole between two filled lines rather than a
        // shorter masthead, and the third said "Saved" about a buffer nothing
        // had ever written. A stand-in fills the second ([D132]) and the third
        // names what the buffer IS.
        // The new card draws its masthead in its own page: it is read there,
        // and its ink is read off that page's own paint, in its own points.
        const draftId = (await app.bodies()).find((b) => b.componentId === "text" && b.cardId !== null && b.cardId !== "A")?.cardId;
        expect(draftId, "the new Text card has a body").toBeDefined();
        const draft = app.body(draftId!);
        const untitled = await draft.evalJS<{
          description: string;
          stamp: string | null;
          fontStyle: string;
          rect: { left: number; top: number; width: number; height: number };
          innerWidth: number;
          detail: string;
        } | null>(`(function () {
          var heads = document.querySelectorAll('[data-slot="card-masthead"]');
          for (var i = 0; i < heads.length; i++) {
            var head = heads[i];
            var title = head.querySelector('[data-testid="card-masthead-title"]');
            if (title === null || title.innerText.indexOf("Untitled") !== 0) continue;
            var desc = head.querySelector('[data-testid="card-masthead-description"]');
            var detail = head.querySelector('[data-testid="card-masthead-detail"]');
            // The quieter ink and the italic both land on the ROW's
            // description element — this span's parent — because that is where
            // the row stamps a stand-in.
            var line = desc === null ? null : desc.parentElement;
            var r = line === null ? null : line.getBoundingClientRect();
            return {
              description: desc === null ? "" : desc.innerText,
              stamp: line === null ? null : line.getAttribute("data-stamp"),
              fontStyle: line === null ? "" : getComputedStyle(line).fontStyle,
              rect:
                r === null
                  ? { left: 0, top: 0, width: 0, height: 0 }
                  : { left: r.left, top: r.top, width: r.width, height: r.height },
              innerWidth: window.innerWidth,
              detail: detail === null ? "" : detail.innerText,
            };
          }
          return null;
        })()`);
        note("at0212 untitled masthead", JSON.stringify(untitled));
        expect(untitled).not.toBeNull();
        expect(untitled!.description).toBe("No file");
        expect(untitled!.stamp, "a stand-in reads a step quieter").toBe("true");
        expect(untitled!.fontStyle, "and in the other type").toBe("italic");
        expect(untitled!.detail).toBe("Draft");

        // …and it actually PAINTS. `font-style: italic` on a weight with no
        // bundled italic face renders nothing at all in this WKWebView — no
        // synthesized oblique — while the element keeps a normal rect, a
        // normal computed color, and its text content. Every assertion above
        // passes on a blank line, so the only honest guard is ink.
        const shot = await draft.screenshot();
        try {
          const png = decodePngFile(shot.path);
          const scale = png.width / untitled!.innerWidth;
          const r = untitled!.rect;
          // The run only, not the line box: the description stretches to the
          // pane's width, and counting its empty tail would drown the glyphs.
          const x0 = Math.round(r.left * scale);
          const x1 = Math.round((r.left + Math.min(r.width, 90)) * scale);
          const y0 = Math.round(r.top * scale);
          const y1 = Math.round((r.top + r.height) * scale);
          let ink = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * png.width + x) * 4;
              // The band is a flat tint; type ink is far off it in luminance.
              const lum =
                0.299 * png.rgba[i]! + 0.587 * png.rgba[i + 1]! + 0.114 * png.rgba[i + 2]!;
              if (lum > 110) ink += 1;
            }
          }
          note("at0212 stand-in ink", `${ink}px in ${x1 - x0}×${y1 - y0}`);
          expect(ink, "the italic stand-in paints glyphs").toBeGreaterThan(40);
        } finally {
          fs.rmSync(shot.path, { force: true });
        }
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
