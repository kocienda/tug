/**
 * Unit tests for the notification status the Settings card shows
 * (`lib/notify-status.ts`): the line each macOS answer reads as, the action
 * beside it, and how a host reply moves the snapshot.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  notifyStatusLine,
  notifyStatusSnapshot,
  notifyTestLine,
  resetNotifyStatus,
  takeNotifyStatus,
  type NotifyStatus,
} from "@/lib/notify-status";

const ALLOWED: NotifyStatus = { authorization: "authorized", banners: true };
const QUIET: NotifyStatus = { authorization: "authorized", banners: false };

afterEach(() => resetNotifyStatus());

describe("notifyStatusLine", () => {
  it("offers to ask when macOS has not been asked", () => {
    const line = notifyStatusLine({ authorization: "notDetermined", banners: false });
    expect(line.action).toBe("authorize");
    expect(line.text).toContain("hasn’t been asked");
  });

  it("sends a refused user to System Settings", () => {
    const line = notifyStatusLine({ authorization: "denied", banners: false });
    expect(line.action).toBe("settings");
    expect(line.text).toContain("turned off");
  });

  it("says where notifications go when banners are off", () => {
    const line = notifyStatusLine(QUIET);
    expect(line.action).toBe("settings");
    expect(line.text).toContain("Notification Center");
  });

  it("offers a test only when a banner can show", () => {
    expect(notifyStatusLine(ALLOWED).action).toBe("test");
  });
});

describe("notifyTestLine", () => {
  it("says nothing before a test", () => {
    expect(notifyTestLine({ kind: "idle" }, ALLOWED)).toBeNull();
  });

  it("names a Focus when the test was delivered with banners on", () => {
    expect(notifyTestLine({ kind: "delivered" }, ALLOWED)).toContain("Focus");
  });

  it("does not blame a Focus when banners are off", () => {
    const line = notifyTestLine({ kind: "delivered" }, QUIET);
    expect(line).not.toContain("Focus");
    expect(line).toContain("Notification Center");
  });

  it("reports a post macOS dropped", () => {
    expect(notifyTestLine({ kind: "dropped" }, ALLOWED)).toContain("did not deliver");
  });

  it("carries the host's error", () => {
    expect(notifyTestLine({ kind: "failed", error: "not allowed" }, ALLOWED)).toContain("not allowed");
  });
});

describe("takeNotifyStatus", () => {
  it("keeps the last test across a plain status read", () => {
    takeNotifyStatus({ authorization: "authorized", banners: true, test: "delivered", error: "" });
    takeNotifyStatus({ authorization: "denied", banners: false, test: "none", error: "" });
    expect(notifyStatusSnapshot()).toEqual({
      status: { authorization: "denied", banners: false },
      test: { kind: "delivered" },
    });
  });

  it("takes a failed test with its error", () => {
    takeNotifyStatus({ authorization: "denied", banners: false, test: "failed", error: "refused" });
    expect(notifyStatusSnapshot().test).toEqual({ kind: "failed", error: "refused" });
  });
});
