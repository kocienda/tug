/**
 * Pure-logic tests for `tug-inline-dialog.tsx`.
 *
 * `TugInlineDialog` is a presentation primitive — its observable
 * behaviour is its prop-to-DOM mapping plus a small set of exported
 * helpers (`iconRoleSlot`, `shouldRenderOptions`, the
 * `TUG_INLINE_DIALOG_ICON_ROLES` enumeration). Per project policy
 * (pure-logic `bun:test` + real-app tests; no fake-DOM render tests),
 * the suite pins those helpers exhaustively. The visual layout +
 * the radio-group integration with `TugDialogButton` are vetted in
 * the gallery card and HMR-vetted end-to-end via `PermissionDialog`
 * and `QuestionDialog`.
 *
 * Coverage:
 *  - `iconRoleSlot` — every declared role maps to its
 *    `--tugx-idialog-icon-{role}-color` slot.
 *  - `TUG_INLINE_DIALOG_ICON_ROLES` lists exactly the five expected
 *    roles in declaration order.
 *  - `shouldRenderOptions` — `undefined` / `[]` → false; non-empty
 *    array → true.
 *  - `inlineDialogLayout` — `"header"` only when none of the three
 *    rows below the header render; `"full"` for every other
 *    combination, enumerated exhaustively.
 */

import { describe, it, expect } from "bun:test";

import {
  TUG_INLINE_DIALOG_ICON_ROLES,
  iconRoleSlot,
  inlineDialogLayout,
  shouldRenderOptions,
  type TugInlineDialogIconRole,
  type TugInlineDialogOption,
} from "./tug-inline-dialog";

// ---------------------------------------------------------------------------
// iconRoleSlot — slot-name contract
// ---------------------------------------------------------------------------

describe("iconRoleSlot", () => {
  it("maps every declared icon role to its --tugx-idialog-icon-{role}-color slot", () => {
    const expected: Record<TugInlineDialogIconRole, string> = {
      default: "--tugx-idialog-icon-default-color",
      caution: "--tugx-idialog-icon-caution-color",
      danger:  "--tugx-idialog-icon-danger-color",
      success: "--tugx-idialog-icon-success-color",
      info:    "--tugx-idialog-icon-info-color",
    };
    for (const role of TUG_INLINE_DIALOG_ICON_ROLES) {
      expect(iconRoleSlot(role)).toBe(expected[role]);
    }
  });
});

// ---------------------------------------------------------------------------
// TUG_INLINE_DIALOG_ICON_ROLES — enumeration contract
// ---------------------------------------------------------------------------

describe("TUG_INLINE_DIALOG_ICON_ROLES", () => {
  it("enumerates exactly the five declared roles in stable order", () => {
    expect(TUG_INLINE_DIALOG_ICON_ROLES).toEqual([
      "default",
      "caution",
      "danger",
      "success",
      "info",
    ]);
  });
});

// ---------------------------------------------------------------------------
// shouldRenderOptions — presence + non-empty
// ---------------------------------------------------------------------------

describe("shouldRenderOptions", () => {
  it("returns false when options is undefined (the no-radio path)", () => {
    expect(shouldRenderOptions(undefined)).toBe(false);
  });

  it("returns false for an empty array (consumer wired the prop but had no choices)", () => {
    // An empty array reaches the primitive when the consumer maps a
    // dynamic source (e.g. `permission_suggestions`) that resolved to
    // zero usable entries. The dialog should still render — just
    // without the options block.
    expect(shouldRenderOptions([])).toBe(false);
  });

  it("returns true for a non-empty array", () => {
    const opts: ReadonlyArray<TugInlineDialogOption> = [
      { value: "a", label: "Allow once" },
    ];
    expect(shouldRenderOptions(opts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inlineDialogLayout — which shape the frame is
// ---------------------------------------------------------------------------

describe("inlineDialogLayout", () => {
  it("is header only when no row below the header renders", () => {
    expect(
      inlineDialogLayout({
        hasDescription: false,
        hasChildren: false,
        hasOptions: false,
      }),
    ).toBe("header");
  });

  it("is full whenever any one of the three rows renders", () => {
    // Exhaustive over the other seven combinations: any row below the header
    // is what the frame's asymmetric bottom padding exists to separate, so
    // one row is enough to earn it and the count never matters.
    for (const hasDescription of [false, true]) {
      for (const hasChildren of [false, true]) {
        for (const hasOptions of [false, true]) {
          if (!hasDescription && !hasChildren && !hasOptions) continue;
          expect(
            inlineDialogLayout({ hasDescription, hasChildren, hasOptions }),
          ).toBe("full");
        }
      }
    }
  });
});
