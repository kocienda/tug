/**
 * TugJumpToBottomButton — a caller's `aria-label` names the button, and the
 * component's own label is only the default.
 *
 * No render and no DOM: the component's render function is called directly
 * and the element it returns is read as data, which is where the accessible
 * name is decided — the props handed to `TugPushButton`.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";

import { TugJumpToBottomButton, type TugJumpToBottomButtonProps } from "../tug-jump-to-bottom-button";

type RenderFn = (props: TugJumpToBottomButtonProps, ref: React.Ref<HTMLButtonElement>) => React.ReactElement;

/** The `aria-label` the button hands its push button for these props. */
function labelFor(props: TugJumpToBottomButtonProps): unknown {
  const render = (TugJumpToBottomButton as unknown as { render: RenderFn }).render;
  const element = render(props, null) as React.ReactElement<Record<string, unknown>>;
  return element.props["aria-label"];
}

describe("TugJumpToBottomButton aria-label", () => {
  test("a caller's label replaces the default", () => {
    expect(labelFor({ "aria-label": "Jump to latest" })).toBe("Jump to latest");
  });

  test("with none passed, the default names it", () => {
    expect(labelFor({})).toBe("Scroll to latest");
  });
});
