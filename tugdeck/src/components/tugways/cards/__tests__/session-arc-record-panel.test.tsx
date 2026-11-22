/**
 * The Sketch panel shows an arc's record as written, and says that
 * nothing is recorded for an arc that has none.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isArcDocuments } from "@/lib/changeset-types";

import { NOT_RECORDED, recordPanel } from "../session-arc-shade-content";

describe("recordPanel", () => {
  test("an arc with no record keeps the empty seat", () => {
    expect(recordPanel(undefined)).toBe(NOT_RECORDED);
    expect(recordPanel("  \n ")).toBe(NOT_RECORDED);
    expect(NOT_RECORDED.state).toBe("pending");
    expect(NOT_RECORDED.title).toBeUndefined();
    expect(renderToStaticMarkup(<>{NOT_RECORDED.body}</>)).toContain(">None<");
  });

  test("a record is a settled panel showing its want, its approach and its list", () => {
    const text = "Start an arc from one place.\n\nMake New Arc a button.\n\n- In the shade\n- In the Session menu";
    const panel = recordPanel(text);
    expect(panel.state).toBe("done");
    expect(panel.title).toBeUndefined();
    expect(renderToStaticMarkup(<>{panel.body}</>)).toBe(
      '<div class="session-arc-panel-text" data-slot="session-arc-panel-text">' +
        "<p>Start an arc from one place.</p><p>Make New Arc a button.</p>" +
        "<ul><li>In the shade</li><li>In the Session menu</li></ul></div>",
    );
  });
});

describe("isArcDocuments", () => {
  test("carries the record text and refuses a record that is not text", () => {
    expect(isArcDocuments({ brief: "/p/brief.md", sketch_text: "a sketch" })).toBe(true);
    expect(isArcDocuments({ sketch_text: null })).toBe(false);
  });
});
