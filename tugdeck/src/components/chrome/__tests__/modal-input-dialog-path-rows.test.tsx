/**
 * modal-input-dialog-path-rows.test.tsx — a path row's match emphasis
 * survives the middle-truncation split.
 *
 * Open Quickly draws each row as a `TugPath`, a head that elides and a tail
 * that stays, and the provider's match ranges are offsets into the whole
 * label. A range that straddles the split must be emphasized in both runs,
 * and no character may be lost or doubled across them. The flexing itself is
 * CSS and belongs to the app.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { renderLabel } from "../modal-input-dialog";
import { TugPath } from "@/components/tugways/tug-path";

function pathRow(label: string, matches: [number, number][]): string {
  return renderToStaticMarkup(
    <TugPath
      path={label}
      renderRun={(text, start) =>
        renderLabel(label, matches, start, start + text.length)
      }
    />,
  );
}

describe("a path row's match emphasis", () => {
  const label = "a/deep/dir/bg-default.css";

  test("a match in the filename lands in the tail", () => {
    const start = label.indexOf("bg-default");
    const html = pathRow(label, [[start, start + 10]]);
    expect(html).toContain('<span class="tug-path-head">a/deep/dir</span>');
    expect(html).toContain(">bg-default</strong>.css</span>");
  });

  test("a match straddling the split is emphasized in both runs", () => {
    // "dir/bg" — "dir" in the head, "/bg" in the tail.
    const start = label.indexOf("dir/bg");
    const html = pathRow(label, [[start, start + 6]]);
    expect(html).toContain(">dir</strong></span>");
    expect(html).toContain(">/bg</strong>-default.css</span>");
  });

  test("the runs reconstruct the label, matches or not", () => {
    const text = (html: string) => html.replace(/<[^>]+>/g, "");
    expect(text(pathRow(label, []))).toBe(label);
    expect(text(pathRow(label, [[0, 3], [8, 14], [20, 25]]))).toBe(label);
  });
});
