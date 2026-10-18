/**
 * A shell gesture holds the keyboard for its length: the shell hears the
 * hold begin and end, overlapping holds release in either order, and a
 * release is good once.
 *
 * @covers tugdeck/src/lib/shell-keyboard-hold.ts
 */
import { describe, expect, test } from "bun:test";

import { holdShellKeyboard, shellKeyboardHeld, subscribeShellKeyboardHold } from "../shell-keyboard-hold";

describe("shell keyboard hold", () => {
  test("held from the first hold to the last release, heard at each edge", () => {
    const heard: boolean[] = [];
    const stop = subscribeShellKeyboardHold(() => heard.push(shellKeyboardHeld()));
    expect(shellKeyboardHeld()).toBe(false);
    const a = holdShellKeyboard();
    const b = holdShellKeyboard();
    expect(shellKeyboardHeld()).toBe(true);
    a();
    expect(shellKeyboardHeld()).toBe(true);
    b();
    expect(shellKeyboardHeld()).toBe(false);
    expect(heard).toEqual([true, false]);
    stop();
  });

  test("a release is good once", () => {
    const a = holdShellKeyboard();
    const b = holdShellKeyboard();
    a();
    a();
    expect(shellKeyboardHeld()).toBe(true);
    b();
    expect(shellKeyboardHeld()).toBe(false);
  });
});
