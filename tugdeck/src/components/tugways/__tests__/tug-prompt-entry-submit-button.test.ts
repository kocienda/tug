/**
 * Pure-logic tests for `resolveSubmitButtonView` — the Z5 submit /
 * stop button's mode → view projection.
 *
 * One assertion per `SessionSubmitButtonMode` kind: the `data-mode`
 * attribute, the `aria-label`, the `disabled` flag, the icon glyph,
 * and the danger-role flag must match the lifecycle matrix's Z5
 * column. The `disabled` field doubles as the keyboard-activation
 * gate (`performSubmit` no-ops when it is true), so pinning it per
 * mode pins both the visual and the "a disabled mode does not fire
 * on Enter" contract.
 *
 * The button's mount identity — one `<button>` node across every
 * mode — is structural: `tug-prompt-entry.tsx` renders exactly one
 * `<TugPushButton>` JSX element whose props this view drives, never
 * two elements in alternate branches. That, and focus survival
 * across a turn, are the HMR vet's job per the no-fake-DOM rule.
 */

import { describe, it, expect } from "bun:test";

import { resolveSubmitButtonView } from "@/components/tugways/tug-prompt-entry-submit-button";
import type { SessionSubmitButtonMode } from "@/lib/code-session-store/lifecycle-state";

describe("resolveSubmitButtonView — Z5 mode → view", () => {
  it("submit — enabled, action role, send glyph", () => {
    const mode: SessionSubmitButtonMode = {
      kind: "submit",
      disabled: false,
    };
    expect(resolveSubmitButtonView(mode)).toEqual({
      dataMode: "submit",
      ariaLabel: "Send prompt",
      disabled: false,
      icon: "submit",
      danger: false,
    });
  });

  it("stop — enabled, danger role, stop glyph", () => {
    expect(resolveSubmitButtonView({ kind: "stop" })).toEqual({
      dataMode: "stop",
      ariaLabel: "Stop turn",
      disabled: false,
      icon: "stop",
      danger: true,
    });
  });

  it("awaiting_user — disabled, action role, send glyph", () => {
    expect(resolveSubmitButtonView({ kind: "awaiting_user" })).toEqual({
      dataMode: "awaiting-user",
      ariaLabel: "Awaiting your input",
      disabled: true,
      icon: "submit",
      danger: false,
    });
  });

  it("stopping — disabled, danger role, stop glyph", () => {
    expect(resolveSubmitButtonView({ kind: "stopping" })).toEqual({
      dataMode: "stopping",
      ariaLabel: "Stopping turn",
      disabled: true,
      icon: "stop",
      danger: true,
    });
  });

  it("reconnecting — disabled, action role, send glyph", () => {
    expect(resolveSubmitButtonView({ kind: "reconnecting" })).toEqual({
      dataMode: "reconnecting",
      ariaLabel: "Reconnecting",
      disabled: true,
      icon: "submit",
      danger: false,
    });
  });

  it("restoring — disabled, action role, send glyph", () => {
    expect(resolveSubmitButtonView({ kind: "restoring" })).toEqual({
      dataMode: "restoring",
      ariaLabel: "Restoring session",
      disabled: true,
      icon: "submit",
      danger: false,
    });
  });

  it("force_stop — enabled, danger role, stop glyph", () => {
    expect(resolveSubmitButtonView({ kind: "force_stop" })).toEqual({
      dataMode: "force-stop",
      ariaLabel: "Force stop",
      disabled: false,
      icon: "stop",
      danger: true,
    });
  });

  it("exactly the four inert modes are disabled", () => {
    // The `disabled` field is also `performSubmit`'s Enter-gate:
    // submit / stop fire, the rest do not.
    const fires = (m: SessionSubmitButtonMode): boolean =>
      !resolveSubmitButtonView(m).disabled;
    expect(fires({ kind: "submit", disabled: false })).toBe(true);
    expect(fires({ kind: "stop" })).toBe(true);
    // The only other enabled member of the stop family. A card whose stop
    // went unanswered has something left to do.
    expect(fires({ kind: "force_stop" })).toBe(true);
    expect(fires({ kind: "awaiting_user" })).toBe(false);
    expect(fires({ kind: "stopping" })).toBe(false);
    expect(fires({ kind: "reconnecting" })).toBe(false);
    expect(fires({ kind: "restoring" })).toBe(false);
  });
});
