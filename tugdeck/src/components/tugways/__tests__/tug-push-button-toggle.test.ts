/**
 * The toggle contract of `TugPushButton`'s `pressed` prop.
 *
 * `pressed` is what turns a push button into a toggle, and the lit look in
 * `tug-push-button.css` keys on the two attributes it resolves to. The cases
 * that matter are the edges: an off toggle still announces itself, and a
 * button that never asked to be a toggle gets nothing, so the `aria-pressed`
 * an action button stamps for itself is neither overwritten nor lit.
 */

import { describe, expect, test } from "bun:test";

import { tugPushButtonToggleAttributes } from "../tug-push-button";

describe("tugPushButtonToggleAttributes", () => {
  test("an omitted pressed adds no attribute", () => {
    expect(tugPushButtonToggleAttributes(undefined)).toEqual({});
  });

  test("an omitted pressed leaves a caller's own aria-pressed standing", () => {
    const merged = {
      "aria-pressed": true,
      ...tugPushButtonToggleAttributes(undefined),
    };
    expect(merged).toEqual({ "aria-pressed": true });
  });

  test("on is aria-pressed true, with the toggle marker", () => {
    expect(tugPushButtonToggleAttributes(true)).toEqual({
      "aria-pressed": true,
      "data-tug-toggle": "",
    });
  });

  test("off still renders aria-pressed, so the button reads as a toggle", () => {
    expect(tugPushButtonToggleAttributes(false)).toEqual({
      "aria-pressed": false,
      "data-tug-toggle": "",
    });
  });

  test("pressed outranks a caller's own aria-pressed", () => {
    const merged = {
      "aria-pressed": true,
      ...tugPushButtonToggleAttributes(false),
    };
    expect(merged["aria-pressed"]).toBe(false);
  });
});
