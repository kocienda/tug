/**
 * beep-report.test.ts — pure-logic tests for the beep tripwire's harness-side
 * report shape (`beep-report.ts`). No app, no DOM: the failure message and the
 * accumulator are the whole subject.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  caughtBeeps,
  formatBeepFailure,
  recordBeeps,
  resetCaughtBeeps,
  type CaughtBeep,
} from "./beep-report";

afterEach(() => resetCaughtBeeps());

describe("formatBeepFailure", () => {
  test("one beep names the origin, the verb, and the silence contract", () => {
    const msg = formatBeepFailure([{ origin: "noResponderFor(keyDown:)", verb: "nativeKey" }]);
    const lines = msg.split("\n");
    expect(lines[0]).toBe("1 beep during this run — the harness contract is silence (brief [B03]).");
    expect(lines[1]).toBe("  • noResponderFor(keyDown:) after verb `nativeKey`");
    expect(lines).toHaveLength(2);
  });

  test("pluralizes the count and groups repeats with a multiplier", () => {
    const beeps: CaughtBeep[] = [
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey" },
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey" },
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey" },
    ];
    const msg = formatBeepFailure(beeps);
    const lines = msg.split("\n");
    expect(lines[0]).toStartWith("3 beeps during this run");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("  • noResponderFor(keyDown:) after verb `nativeKey` ×3");
  });

  test("orders distinct groups by frequency, most frequent first", () => {
    const beeps: CaughtBeep[] = [
      { origin: "noResponderFor(keyDown:)", verb: "nativeType" },
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey" },
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey" },
    ];
    const lines = formatBeepFailure(beeps).split("\n");
    expect(lines[1]).toBe("  • noResponderFor(keyDown:) after verb `nativeKey` ×2");
    expect(lines[2]).toBe("  • noResponderFor(keyDown:) after verb `nativeType`");
  });

  test("a beep with no verb says so rather than printing an empty verb", () => {
    const lines = formatBeepFailure([{ origin: "noResponderFor(keyDown:)" }]).split("\n");
    expect(lines[1]).toBe("  • noResponderFor(keyDown:) with no verb recorded");
  });

  test("names the launch a beep happened in, and keeps launches apart", () => {
    const beeps: CaughtBeep[] = [
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey", launch: "row-06-jots" },
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey", launch: "row-06-text" },
      { origin: "noResponderFor(keyDown:)", verb: "nativeKey", launch: "row-06-text" },
    ];
    const lines = formatBeepFailure(beeps).split("\n");
    expect(lines[1]).toBe("  • noResponderFor(keyDown:) after verb `nativeKey` in launch `row-06-text` ×2");
    expect(lines[2]).toBe("  • noResponderFor(keyDown:) after verb `nativeKey` in launch `row-06-jots`");
    expect(lines).toHaveLength(3);
  });

  test("shows the first beep's stack past the tripwire, as image and symbol", () => {
    const stack = [
      "0   Tug                                 0x0000000104a1b2c3 $s3Tug12BeepTripwireC6record6originSbSS_tF + 120",
      "1   Tug                                 0x0000000104a1c4d5 $s3Tug10MainWindowC11noResponder3foryyF + 88",
      "2   AppKit                              0x00000001a2b3c4d5 -[NSResponder noResponderFor:] + 60",
      "3   AppKit                              0x00000001a2b3c5e6 -[NSWindow keyDown:] + 44",
      "4   AppKit                              0x00000001a2b3c6f7 -[NSResponder keyDown:] + 52",
      "5   WebKit                              0x00000001b2c3d4e5 WebKit::WebViewImpl::doneWithKeyEvent + 300",
      "6   AppKit                              0x00000001a2b3c7a8 -[NSWindow sendEvent:] + 1200",
      "7   AppKit                              0x00000001a2b3c8b9 -[NSApplication(NSEvent) sendEvent:] + 2000",
      "8   Tug                                 0x0000000104a1d6e7 $s3Tug11AppDelegateC9sendEventyySo7NSEventCF + 40",
      "9   AppKit                              0x00000001a2b3c9ca -[NSApplication run] + 600",
    ];
    const lines = formatBeepFailure([{ origin: "noResponderFor(keyDown:)", verb: "nativeKey", stack }]).split("\n");
    expect(lines[1]).toBe("  • noResponderFor(keyDown:) after verb `nativeKey`");
    expect(lines[2]).toBe("      AppKit: -[NSWindow keyDown:] + 44");
    expect(lines[3]).toBe("      AppKit: -[NSResponder keyDown:] + 52");
    expect(lines[4]).toBe("      WebKit: WebKit::WebViewImpl::doneWithKeyEvent + 300");
    expect(lines[5]).toBe("      AppKit: -[NSWindow sendEvent:] + 1200");
    expect(lines[6]).toBe("      AppKit: -[NSApplication(NSEvent) sendEvent:] + 2000");
    expect(lines[7]).toBe("      Tug: $s3Tug11AppDelegateC9sendEventyySo7NSEventCF + 40");
    expect(lines).toHaveLength(8);
  });
});

describe("recordBeeps", () => {
  test("accumulates beeps across launches within a file", () => {
    recordBeeps({ count: 1, beeps: [{ origin: "noResponderFor(keyDown:)", verb: "nativeKey" }] });
    recordBeeps({ count: 1, beeps: [{ origin: "noResponderFor(keyDown:)", verb: "nativeType" }] });
    expect(caughtBeeps()).toHaveLength(2);
  });

  test("stamps each beep with the launch it was read from", () => {
    recordBeeps({ count: 1, beeps: [{ origin: "noResponderFor(keyDown:)" }] }, "smoke-native-cmd-a");
    recordBeeps({ count: 1, beeps: [{ origin: "noResponderFor(keyDown:)" }] });
    expect(caughtBeeps().map((b) => b.launch)).toEqual(["smoke-native-cmd-a", undefined]);
  });

  test("a null or malformed report folds in nothing — a missing tripwire is not a beep", () => {
    recordBeeps(null);
    recordBeeps(undefined);
    recordBeeps({ count: 0, beeps: [] });
    // @ts-expect-error — exercising a malformed payload from an older app
    recordBeeps({ count: 1 });
    expect(caughtBeeps()).toHaveLength(0);
  });

  test("skips an entry that carries no origin string", () => {
    // @ts-expect-error — an entry missing its origin must not count
    recordBeeps({ count: 1, beeps: [{ verb: "nativeKey" }] });
    expect(caughtBeeps()).toHaveLength(0);
  });
});
