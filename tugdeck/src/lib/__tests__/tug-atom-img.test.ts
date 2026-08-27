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
 *   - {@link editorLineHeightFor} — the editor leading derived from the atom
 *     register, and the register table it is derived from.
 */

import { describe, expect, test } from "bun:test";

import { editorLineHeightFor, formatAtomLabel } from "../tug-atom-img";
import {
  ATOM_REGISTERS,
  atomEditorLineBoxFloorPx,
  atomRegisterMetrics,
  type AtomRegister,
} from "../atom-register";

const REGISTERS = Object.keys(ATOM_REGISTERS) as AtomRegister[];

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

describe("the atom register table", () => {
  // Registers are densities of one mark, not two marks. Everything except the
  // box is shared, and a register that drifted on type size or dot would put
  // two different-looking atoms on two surfaces — the defect the table exists
  // to make impossible.
  test("every register agrees on type size, dot and border", () => {
    const first = atomRegisterMetrics(REGISTERS[0]!);
    for (const register of REGISTERS) {
      const m = atomRegisterMetrics(register);
      expect(m.fontSize).toBe(first.fontSize);
      expect(m.dotSize).toBe(first.dotSize);
      expect(m.borderWidth).toBe(first.borderWidth);
    }
  });

  // The complaint that produced this table was a box so tight the label had
  // nowhere to sit. Three pixels of air above and below the type, inside the
  // border, is the floor — below it the atom reads as clamped.
  test("every register leaves at least 3px of air around its type", () => {
    for (const register of REGISTERS) {
      const m = atomRegisterMetrics(register);
      const air = (m.height - 2 * m.borderWidth - m.fontSize) / 2;
      expect(air).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("editorLineHeightFor", () => {
  // The whole no-hop scheme rests on one contract: an atom must fit inside the
  // line box of every surface it stands on. The editor's leading is derived
  // from the register rather than pinned, so this holds at every font size the
  // editor offers — including the small end, where a pinned 1.5 could not seat
  // the atom and the bake compensated by shrinking the chip, which is how an
  // atom came to change size when it was sent.
  test("the derived editor line box seats a prose atom at every font size", () => {
    for (const size of [11, 12, 13, 14, 15, 16, 18, 20]) {
      const lineBoxPx = size * editorLineHeightFor(size);
      expect(lineBoxPx).toBeGreaterThanOrEqual(atomEditorLineBoxFloorPx("prose"));
    }
  });

  // A line of code with no atom on it should not be pushed apart by one, so
  // the leading never drops below the reading minimum however large the type.
  test("never falls below the editor's own reading leading", () => {
    for (const size of [11, 13, 16, 20, 24]) {
      expect(editorLineHeightFor(size)).toBeGreaterThanOrEqual(1.5);
    }
  });
});
