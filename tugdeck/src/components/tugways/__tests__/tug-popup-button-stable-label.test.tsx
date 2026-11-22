/**
 * A width-stabilized popup button's face holds every item's label in one
 * cell beside the visible one, and hides the reserves from assistive
 * technology, so only the chosen label is read.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TugPopupButtonStableLabel } from "../tug-popup-button";

describe("TugPopupButtonStableLabel", () => {
  test("stacks the visible label over a hidden reserve for every item", () => {
    const html = renderToStaticMarkup(
      <TugPopupButtonStableLabel
        label="Activity"
        items={[{ label: "Workspaces" }, { label: "Activity" }]}
      />,
    );
    expect(html).toBe(
      '<span class="tug-popup-button-stable" data-slot="tug-popup-button-stable">' +
        '<span class="tug-popup-button-stable-visible">Activity</span>' +
        '<span class="tug-popup-button-stable-reserve" aria-hidden="true">Workspaces</span>' +
        '<span class="tug-popup-button-stable-reserve" aria-hidden="true">Activity</span>' +
        "</span>",
    );
  });

  test("only the visible label is exposed", () => {
    const html = renderToStaticMarkup(
      <TugPopupButtonStableLabel label="Short" items={[{ label: "A much longer label" }]} />,
    );
    const exposed = html.match(/<span class="tug-popup-button-stable-visible">([^<]*)</);
    expect(exposed?.[1]).toBe("Short");
    expect(html.match(/aria-hidden="true"/g)?.length).toBe(1);
  });
});
