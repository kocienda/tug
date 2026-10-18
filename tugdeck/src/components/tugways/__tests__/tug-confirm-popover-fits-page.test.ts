/**
 * A confirm never grows past the page it opens in.
 *
 * Every card is a body — a web view of its own — so a confirm raised in a
 * narrow rail (the Arcs card's Discard and Delete) is drawn inside the rail's
 * page and nowhere else. Radix's popper wrapper sizes the box to its
 * content's max-content, so an unwrapped question set the width: 592 px of
 * popover in a 419 px rail, its Delete button past the page's edge, neither
 * drawn nor pressable (`at0575`). The box is clamped to the space Radix says
 * the page has, so a long question wraps instead.
 *
 * Read from the CSS text, as `chrome-rule-knobs.test.ts` reads its rules:
 * jsdom lays nothing out, and what is guarded is the authoring contract — the
 * clamp is declared on the confirm's own box, through Radix's variable.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(path.join(import.meta.dir, "../tug-confirm-popover.css"), "utf-8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
    if (m[1].trim() === selector) return m[2];
  }
  return null;
}

describe("tug-confirm-popover fits its page", () => {
  it("clamps the confirm's box to Radix's available width", () => {
    const body = ruleBody(CSS, ".tug-confirm-popover");
    expect(body).not.toBeNull();
    expect(body ?? "").toMatch(/max-width:\s*var\(--radix-popover-content-available-width\b/);
  });
});
