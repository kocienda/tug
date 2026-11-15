/**
 * Where a link or an image in a previewed Markdown file points.
 *
 * The cases are the ones a wrong answer would show: a relative link that
 * navigates the card's page instead of opening a file, an absolute URL that
 * gets swallowed, an image fetched from the page's origin, and a destination
 * that climbs out of the document's directory.
 */

import { describe, expect, test } from "bun:test";

import { blobUrl, bytesUrl } from "../file-kinds";
import { previewImageUrl, readPreviewHref } from "../markdown-preview-links";

const BASE = "/Users/me/notes";

describe("readPreviewHref", () => {
  test("a relative link resolves against the document's directory", () => {
    expect(readPreviewHref(BASE, "other.md")).toEqual({
      kind: "path",
      path: "/Users/me/notes/other.md",
    });
    expect(readPreviewHref(BASE, "sub/deep/file.txt")).toEqual({
      kind: "path",
      path: "/Users/me/notes/sub/deep/file.txt",
    });
  });

  test("a percent-encoded destination names the file it spells", () => {
    expect(readPreviewHref(BASE, "assets/My%20Shot.png")).toEqual({
      kind: "path",
      path: "/Users/me/notes/assets/My Shot.png",
    });
  });

  test("a fragment or a query on a relative link is dropped from the path", () => {
    expect(readPreviewHref(BASE, "other.md#section")).toEqual({
      kind: "path",
      path: "/Users/me/notes/other.md",
    });
    expect(readPreviewHref(BASE, "other.md?raw=1")).toEqual({
      kind: "path",
      path: "/Users/me/notes/other.md",
    });
  });

  test("a URL with a scheme is external, whatever the scheme", () => {
    expect(readPreviewHref(BASE, "https://example.com/a.md")).toEqual({ kind: "external" });
    expect(readPreviewHref(BASE, "mailto:someone@example.com")).toEqual({ kind: "external" });
    expect(readPreviewHref(BASE, "//example.com/a.png")).toEqual({ kind: "external" });
  });

  test("a bare fragment is a place in this document", () => {
    expect(readPreviewHref(BASE, "#getting-started")).toEqual({
      kind: "anchor",
      anchor: "getting-started",
    });
    expect(readPreviewHref(BASE, "#caf%C3%A9")).toEqual({ kind: "anchor", anchor: "café" });
  });

  test("a destination outside the document's directory is a path that opens nothing", () => {
    expect(readPreviewHref(BASE, "../secrets.md")).toEqual({ kind: "path", path: null });
    expect(readPreviewHref(BASE, "/etc/hosts")).toEqual({ kind: "path", path: null });
    expect(readPreviewHref(BASE, "./other.md")).toEqual({ kind: "path", path: null });
    expect(readPreviewHref(BASE, "")).toEqual({ kind: "path", path: null });
  });

  test("a document with no directory yet resolves no path", () => {
    expect(readPreviewHref(null, "other.md")).toEqual({ kind: "path", path: null });
  });
});

describe("previewImageUrl", () => {
  test("a relative image loads from the file beside the document", () => {
    expect(previewImageUrl(BASE, "assets/shot.png")).toBe(
      blobUrl("/Users/me/notes/assets/shot.png"),
    );
    expect(previewImageUrl(BASE, "diagrams/My%20Flow.png")).toBe(
      blobUrl("/Users/me/notes/diagrams/My Flow.png"),
    );
  });

  test("a relative image with no image extension still loads its bytes", () => {
    expect(previewImageUrl(BASE, "assets/render")).toBe(bytesUrl("/Users/me/notes/assets/render"));
  });

  test("an absolute image URL is left as written", () => {
    expect(previewImageUrl(BASE, "https://example.com/a.png")).toBeNull();
    expect(previewImageUrl(BASE, "data:image/png;base64,AAAA")).toBeNull();
  });

  test("an image that does not resolve is left as written", () => {
    expect(previewImageUrl(BASE, "../outside.png")).toBeNull();
    expect(previewImageUrl(null, "assets/shot.png")).toBeNull();
  });
});
