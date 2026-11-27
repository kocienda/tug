/**
 * An open sketch shows its record as written, and says that nothing is
 * recorded for a record that holds no text.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isArcDocuments } from "@/lib/changeset-types";

import { recordBody } from "../session-arc-record";

describe("recordBody", () => {
  test("a record with no text says None", () => {
    expect(renderToStaticMarkup(recordBody(undefined))).toContain(">None<");
    expect(renderToStaticMarkup(recordBody("  \n "))).toContain(">None<");
  });

  test("a record shows its want, its approach and its list", () => {
    const text = "Start an arc from one place.\n\nMake New Arc a button.\n\n- In the shade\n- In the Session menu";
    expect(renderToStaticMarkup(recordBody(text))).toBe(
      '<div class="session-arc-record-text" data-slot="session-arc-record-text">' +
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
