/**
 * A card frame that fills the pane never overflows it.
 *
 * `.tug-pane-content` is itself a scroller (`overflow: auto`). A card frame
 * that claims `height: 100%` and also pads itself, under the default
 * `content-box`, is taller than the pane by exactly its padding — so the pane
 * scrolls that sliver, and a frame that scrolls its own content paints a
 * second scrollbar beside its own (the Diff card did, 2026-10-26). The repair
 * is `box-sizing: border-box` on the frame, as `about-card.css` says.
 *
 * A pure read of the CSS text: no DOM, no cascade. Every rule under `cards/`
 * that sets `height: 100%` and a non-zero padding must also be border-box.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

const CARDS = join(dirname(fileURLToPath(import.meta.url)), "../cards");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? cssFiles(join(dir, e.name))
      : e.name.endsWith(".css")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("card frames that fill the pane", () => {
  test("pad inside their height, never past it", () => {
    const offenders: string[] = [];
    for (const file of cssFiles(CARDS)) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2];
        if (!/(^|;)\s*height:\s*100%/.test(body)) continue;
        const pad = body.match(/(^|;)\s*padding(-block(-start|-end)?|-top|-bottom)?:\s*([^;]+)/);
        if (pad === null || /^0(px|rem)?(\s+0(px|rem)?)*$/.test(pad[4].trim())) continue;
        if (/box-sizing:\s*border-box/.test(body)) continue;
        offenders.push(`${file.slice(CARDS.length + 1)}: ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
