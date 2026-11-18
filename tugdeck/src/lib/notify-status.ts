/**
 * notify-status.ts — what macOS will do with a Tug notification, for the
 * Settings card to say.
 *
 * macOS can accept a notification and show nothing: permission was never
 * asked or was refused, the alert style is None, or a Focus is on. It
 * reports none of that to the user, so a switch that is on and a banner that
 * never appears look like a Tug that is broken. The host answers
 * `notifyCheck` (`tugapp/Sources/SessionNotifier.swift`) with what it can
 * read, and this module keeps the latest answer and turns it into the one
 * line the Settings card shows under its switches, with the one action that
 * state calls for.
 *
 * A test is posted the way a session's notification is: after a few seconds,
 * and only if Tug is no longer the frontmost app. Its line says what the host
 * read — delivered, not delivered, not posted — and nothing about why a
 * banner did or did not draw, which macOS does not report and Tug cannot
 * infer.
 *
 * The snapshot is external state: components read it through
 * {@link useNotifyStatus} ([L02]). Outside the host nothing is asked and the
 * snapshot stays empty, so the card shows no line.
 *
 * @module lib/notify-status
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { hostAvailable, onHostMessage, postToHost } from "@/host/channel";
import { notifyCheckToHost, notifyStatusToPage } from "@/host/declarations/services";

/** What the host can ask of macOS. */
export type NotifyVerb = "status" | "authorize" | "test" | "settings";

/** macOS's standing answer for Tug. */
export interface NotifyStatus {
  authorization: "notDetermined" | "denied" | "authorized";
  /** False when the alert style is None or alerts are off. */
  banners: boolean;
}

/** Where the last test notification stands. */
export type NotifyTest =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "delivered" }
  | { kind: "dropped" }
  | { kind: "frontmost" }
  | { kind: "failed"; error: string };

/** What the Settings card reads. `status` is null until the host answers. */
export interface NotifyStatusSnapshot {
  status: NotifyStatus | null;
  test: NotifyTest;
}

/** The one action a status calls for. */
export type NotifyAction = "authorize" | "settings" | "test";

/** The status line: what macOS says, and the button beside it. */
export interface NotifyStatusLine {
  text: string;
  action: NotifyAction;
  actionLabel: string;
}

/**
 * How long a test may go unanswered. The host posts five seconds after it is
 * asked and answers about two seconds after that; the bound is for a host
 * that never answers.
 */
export const NOTIFY_TEST_TIMEOUT_MS = 15_000;

/** The line for `status`. */
export function notifyStatusLine(status: NotifyStatus): NotifyStatusLine {
  if (status.authorization === "notDetermined") {
    return {
      text: "macOS hasn’t been asked to allow Tug’s notifications yet.",
      action: "authorize",
      actionLabel: "Ask Now",
    };
  }
  if (status.authorization === "denied") {
    return {
      text: "Notifications are turned off for Tug in System Settings.",
      action: "settings",
      actionLabel: "Open System Settings",
    };
  }
  if (!status.banners) {
    return {
      text: "macOS allows Tug’s notifications, but banners are off, so they go straight to Notification Center.",
      action: "settings",
      actionLabel: "Open System Settings",
    };
  }
  return {
    text: "macOS allows Tug’s notifications, with banners.",
    action: "test",
    actionLabel: "Send Test",
  };
}

/**
 * What to say about the last test, one sentence to a line, or null when none
 * has been sent.
 */
export function notifyTestLines(test: NotifyTest): string[] | null {
  switch (test.kind) {
    case "idle":
      return null;
    case "sending":
      return ["A test notification will be posted in 5 seconds.", "Switch to another app to see it."];
    case "delivered":
      return ["macOS delivered the test notification."];
    case "dropped":
      return ["macOS accepted the test notification but did not deliver it."];
    case "frontmost":
      return ["Tug was still the frontmost app, so no test was posted.", "Press Send Test, then switch to another app."];
    case "failed":
      return [`The test notification failed: ${test.error}`];
  }
}

const EMPTY: NotifyStatusSnapshot = { status: null, test: { kind: "idle" } };

let snapshot: NotifyStatusSnapshot = EMPTY;
const listeners = new Set<() => void>();
let installed = false;
let nextId = 0;
let testTimer: ReturnType<typeof setTimeout> | null = null;

function set(next: NotifyStatusSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function clearTestTimer(): void {
  if (testTimer !== null) clearTimeout(testTimer);
  testTimer = null;
}

/** Take the host's reply into the snapshot. Exported for tests. */
export function takeNotifyStatus(reply: {
  authorization: NotifyStatus["authorization"];
  banners: boolean;
  test: "none" | "delivered" | "dropped" | "frontmost" | "failed";
  error: string;
}): void {
  const status: NotifyStatus = { authorization: reply.authorization, banners: reply.banners };
  if (reply.test === "none") {
    set({ status, test: snapshot.test });
    return;
  }
  clearTestTimer();
  set({
    status,
    test: reply.test === "failed" ? { kind: "failed", error: reply.error } : { kind: reply.test },
  });
}

/** Take `__tugBridge.onNotifyStatus` in this page. Idempotent. */
function install(): void {
  if (installed) return;
  installed = true;
  onHostMessage(notifyStatusToPage, takeNotifyStatus);
}

/**
 * Ask the host: read the status, ask macOS for permission, send a test, or
 * open System Settings. Every verb is answered with the status. Outside the
 * host this is a no-op.
 */
export function askNotify(verb: NotifyVerb): void {
  if (!hostAvailable(notifyCheckToHost)) return;
  install();
  if (verb === "test") {
    clearTestTimer();
    set({ status: snapshot.status, test: { kind: "sending" } });
    testTimer = setTimeout(() => {
      testTimer = null;
      set({ status: snapshot.status, test: { kind: "failed", error: "Tug did not answer." } });
    }, NOTIFY_TEST_TIMEOUT_MS);
  }
  postToHost(notifyCheckToHost, { requestId: `tug-notify-${++nextId}`, verb });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): NotifyStatusSnapshot {
  return snapshot;
}

/** The latest status and test, re-rendering when either moves. */
export function useNotifyStatus(): NotifyStatusSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Read the snapshot outside React. Exported for tests. */
export function notifyStatusSnapshot(): NotifyStatusSnapshot {
  return snapshot;
}

/** Drop the snapshot and any pending test. For tests. */
export function resetNotifyStatus(): void {
  clearTestTimer();
  snapshot = EMPTY;
}
