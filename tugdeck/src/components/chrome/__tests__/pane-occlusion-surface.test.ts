/**
 * pane-occlusion-surface.test.ts — what `readPaintFacts` reads as a pane's
 * surface.
 *
 * A body card's chrome and content paint nothing (`tug-pane.css`,
 * `.tug-pane[data-body-card]`): the pane's rect is its title bar over the
 * placeholder's lid or the body's page. The controller once read the chrome's
 * background for every frame, so under bodies no coverer was ever opaque and
 * no buried pane ever hid (`at0347-stack-badge-picker`, the occluded leg).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installJsdom, type JsdomSubstrate } from "../../../__tests__/jsdom-deck";
import { readPaintFacts } from "../pane-occlusion-controller";

let dom: JsdomSubstrate;

beforeEach(() => {
  dom = installJsdom();
});
afterEach(() => {
  dom.restore();
});

function frame(opts: { bodyCard: boolean; chromeBg: string; barBg: string; lid: boolean }): HTMLElement {
  const el = document.createElement("div");
  el.className = "tug-pane";
  // jsdom computes "" for a property nobody set, and the controller parses
  // the frame's opacity; a real frame always has one.
  el.style.opacity = "1";
  if (opts.bodyCard) el.setAttribute("data-body-card", "");
  el.innerHTML =
    `<div class="tug-pane-chrome" style="background-color: ${opts.chromeBg}; opacity: 1">` +
    `<div class="tug-pane-title-bar" style="background-color: ${opts.barBg}"></div>` +
    `<div class="tug-pane-content">${opts.lid ? '<div data-body-placeholder data-card-id="A"></div>' : ""}</div>` +
    `</div>`;
  dom.container.appendChild(el);
  return el;
}

describe("a pane's surface, as the occlusion test reads it", () => {
  test("an in-document card's surface is its chrome background", () => {
    expect(readPaintFacts(frame({ bodyCard: false, chromeBg: "rgb(10, 10, 10)", barBg: "rgb(1, 1, 1)", lid: true })).opaque).toBe(true);
    expect(readPaintFacts(frame({ bodyCard: false, chromeBg: "transparent", barBg: "rgb(1, 1, 1)", lid: true })).opaque).toBe(false);
  });

  test("a body card's surface is its title bar over the lid, not its transparent chrome", () => {
    expect(readPaintFacts(frame({ bodyCard: true, chromeBg: "transparent", barBg: "rgb(1, 1, 1)", lid: true })).opaque).toBe(true);
  });

  test("a body card with a see-through title bar, or no placeholder to lid its content, is no coverer", () => {
    expect(readPaintFacts(frame({ bodyCard: true, chromeBg: "transparent", barBg: "rgba(1, 1, 1, 0.5)", lid: true })).opaque).toBe(false);
    expect(readPaintFacts(frame({ bodyCard: true, chromeBg: "transparent", barBg: "rgb(1, 1, 1)", lid: false })).opaque).toBe(false);
  });
});
