/**
 * forwarded-keydown — a forwarded keydown resolves to the same chord as the
 * keydown it stands in for.
 *
 * The two factories below are the two engines the helper has to be right
 * under: one whose `KeyboardEvent` constructor keeps `keyCode` from the init
 * dictionary, and one that ignores it and reports 0. There is no DOM here,
 * so each returns a plain object shaped like the event it would build; the
 * AZERTY keydown is one recorded from that layout in a lab guest
 * (`fixtures/keyboard-layouts.json`).
 */

import { describe, expect, test } from "bun:test";

import { chordMatchesEvent, effectiveCode } from "../chord-format";
import type { Chord } from "../command-registry";
import { forwardedKeydown, type ForwardableKeydown } from "../forwarded-keydown";
import { recordedKeydown } from "./fixtures/keyboard-layouts";

type Built = ForwardableKeydown & { readonly bubbles: boolean; readonly cancelable: boolean };

function build(init: KeyboardEventInit, keyCode: number): Built {
  return {
    key: init.key ?? "",
    code: init.code ?? "",
    keyCode,
    altKey: init.altKey === true,
    ctrlKey: init.ctrlKey === true,
    metaKey: init.metaKey === true,
    shiftKey: init.shiftKey === true,
    bubbles: init.bubbles === true,
    cancelable: init.cancelable === true,
  };
}

/** An engine whose constructor keeps the init dictionary's `keyCode`. */
const keepsKeyCode = (init: KeyboardEventInit): Built => build(init, init.keyCode ?? 0);
/** An engine whose constructor ignores it. */
const dropsKeyCode = (init: KeyboardEventInit): Built => build(init, 0);

/** ⌘ with the AZERTY key that types "a", which sits at the US Q position. */
const recorded = recordedKeydown("French", "KeyQ", ["meta"]);
const azertyCommandA: ForwardableKeydown = {
  key: recorded.key,
  code: recorded.code,
  keyCode: recorded.keyCode,
  altKey: recorded.altKey,
  ctrlKey: recorded.ctrlKey,
  metaKey: recorded.metaKey,
  shiftKey: recorded.shiftKey,
};

const selectAll: Chord = { key: "KeyA", meta: true };
const quit: Chord = { key: "KeyQ", meta: true };

describe("forwardedKeydown", () => {
  for (const [engine, make] of [
    ["an engine that keeps keyCode", keepsKeyCode],
    ["an engine that drops keyCode", dropsKeyCode],
  ] as const) {
    test(`under ${engine}, an AZERTY ⌘A is forwarded as ⌘A`, () => {
      const forwarded = forwardedKeydown(azertyCommandA, make);
      expect(forwarded.keyCode).toBe(65);
      expect(forwarded.code).toBe("KeyQ");
      expect(forwarded.key).toBe("a");
      expect(effectiveCode(forwarded)).toBe(effectiveCode(azertyCommandA));
      expect(chordMatchesEvent(forwarded, selectAll)).toBe(true);
      expect(chordMatchesEvent(forwarded, quit)).toBe(false);
    });
  }

  test("the copy bubbles and can be cancelled, and keeps every modifier", () => {
    const forwarded = forwardedKeydown(
      { ...azertyCommandA, altKey: true, ctrlKey: true, shiftKey: true },
      dropsKeyCode,
    );
    expect(forwarded.bubbles).toBe(true);
    expect(forwarded.cancelable).toBe(true);
    expect(forwarded.metaKey).toBe(true);
    expect(forwarded.altKey).toBe(true);
    expect(forwarded.ctrlKey).toBe(true);
    expect(forwarded.shiftKey).toBe(true);
  });

  test("a key with no keyCode of its own is forwarded with none", () => {
    const forwarded = forwardedKeydown({ ...azertyCommandA, keyCode: 0 }, dropsKeyCode);
    expect(forwarded.keyCode).toBe(0);
    expect(effectiveCode(forwarded)).toBe("KeyQ");
  });
});
