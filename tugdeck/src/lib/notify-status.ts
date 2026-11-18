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
 * A Focus cannot be read. It is what is left when a test was delivered,
 * banners are on, and no banner appeared, and {@link notifyTestLine} says so.
 *
 * The snapshot is external state: components read it through
 * {@link useNotifyStatus} ([L02]). Outside the host nothing is asked and the
 * snapshot stays empty, so the card shows no line.
 *
 * @module lib/notify-status
 */

import { useSyncExternalStore } from "react";
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
 * How long a test may go unanswered. The host answers about two seconds
 * after it posts; the bound is for a host that never answers.
 */
export const NOTIFY_TEST_TIMEOUT_MS = 10_000;

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

/** The line for the last test, or null when none has been sent. */
export function notifyTestLine(test: NotifyTest, status: NotifyStatus | null): string | null {
  switch (test.kind) {
    case "idle":
      return null;
    case "sending":
      return "Sending a test notification…";
    case "delivered":
      return status !== null && status.banners
        ? "macOS delivered the test notification. If no banner appeared, a Focus is silencing Tug: allow it under System Settings › Focus."
        : "macOS delivered the test notification to Notification Center.";
    case "dropped":
      return "macOS accepted the test notification but did not deliver it.";
    case "failed":
      return `The test notification failed: ${test.error}`;
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
  test: "none" | "delivered" | "dropped" | "failed";
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
