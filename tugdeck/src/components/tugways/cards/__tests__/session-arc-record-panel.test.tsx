/**
 * The Idea and Sketch panels show an arc's record as written, and say that
 * nothing is recorded for an arc that has none.
 */

import { describe, expect, test } from "bun:test";
import React from "react";

import { isArcDocuments } from "@/lib/changeset-types";

import { NOT_RECORDED, recordPanel } from "../session-arc-shade-content";

describe("recordPanel", () => {
  test("an arc with no record keeps the empty seat", () => {
    expect(recordPanel(undefined)).toBe(NOT_RECORDED);
    expect(recordPanel("  \n ")).toBe(NOT_RECORDED);
    expect(NOT_RECORDED.state).toBe("pending");
    expect(NOT_RECORDED.title).toBe("Nothing recorded for this arc yet");
  });

  test("a record is a settled panel showing its text as written", () => {
    const text = "Make New Arc a button.\n\nAnd a menu item.";
    const panel = recordPanel(text);
    expect(panel.state).toBe("done");
    expect(panel.title).toBeUndefined();
    const body = panel.body as React.ReactElement<{ className: string; children: string }>;
    expect(React.isValidElement(body)).toBe(true);
    expect(body.props.className).toBe("session-arc-panel-text");
    expect(body.props.children).toBe(text);
  });
});

describe("isArcDocuments", () => {
  test("carries the record texts and refuses a record that is not text", () => {
    expect(isArcDocuments({ brief: "/p/brief.md", idea_text: "an idea", sketch_text: "a sketch" })).toBe(true);
    expect(isArcDocuments({ idea_text: 3 })).toBe(false);
    expect(isArcDocuments({ sketch_text: null })).toBe(false);
  });
});
