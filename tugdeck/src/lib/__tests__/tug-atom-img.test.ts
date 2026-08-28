/**
 * Pure-logic tests for the `tug-atom-img` exports that don't depend on
 * the DOM. The full chip-builder (`bakeAtomChipDataUri`) is
 * DOM-dependent (it reads theme tokens via `getComputedStyle(document.body)`)
 * and is exercised through the real-app manual smoke; this file pins
 * the pure pieces consumers rely on:
 *
 *   - {@link formatAtomLabel} — basename extraction. Tool-block path
 *     chips call this with mode `"filename"` to derive the chip's
 *     label from the full path.
 * The register table and the editor leading derived from it are pinned in
 * `atom-register.test`, beside the table they are about.
 */

import { describe, expect, test } from "bun:test";

import { formatAtomLabel } from "../tug-atom-img";

describe("formatAtomLabel — `filename` mode (basename extraction)", () => {
  test("absolute path: returns the last component", () => {
    expect(formatAtomLabel("/repo/src/main.ts", "filename")).toBe("main.ts");
  });

  test("relative path: returns the last component", () => {
    expect(formatAtomLabel("src/components/foo.tsx", "filename")).toBe(
      "foo.tsx",
    );
  });

  test("bare filename (no slash): returns the input as-is", () => {
    expect(formatAtomLabel("main.ts", "filename")).toBe("main.ts");
  });

  test("path ending in slash returns empty (last component after trailing slash)", () => {
    // The transcript / tool-block side never passes a directory path
    // — the tool inputs are always file paths — but pin the deterministic
    // behaviour of `lastIndexOf('/')` so a future regression to a
    // non-empty fallback would be observable.
    expect(formatAtomLabel("src/", "filename")).toBe("");
  });

  test("nested basename keeps its extension", () => {
    expect(
      formatAtomLabel("/Users/kocienda/notebooks/exploration.ipynb", "filename"),
    ).toBe("exploration.ipynb");
  });

  test("http URL: returns the trailing component (after query strip)", () => {
    expect(
      formatAtomLabel("https://example.com/api/v2/users?id=42", "filename"),
    ).toBe("users");
  });

  test("https URL ending in slash (homepage): returns the full URL fallback", () => {
    // The `filename` branch falls back to the full value when the
    // post-strip basename is empty (a homepage URL).
    expect(formatAtomLabel("https://example.com/", "filename")).toBe(
      "https://example.com/",
    );
  });
});
