/**
 * Unit tests for the session-notify rule (`notifyEventFor`) and its watcher
 * (`installSessionNotify`): when the shell asks the host to bounce the dock
 * or post a notification for a session card.
 */

import { describe, expect, it } from "bun:test";

import {
  installSessionNotify,
  notifyEventFor,
  type SessionNotifyPost,
  type SessionNotifySources,
} from "@/lib/session-notify";
import {
  DEFAULT_DOCK_BOUNCE,
  parseDockBounce,
  parseNotifyBanner,
  type DockBounce,
  type SessionNotifyEvent,
} from "@/settings-api";

describe("notifyEventFor", () => {
  it("treats a card's first reading as a baseline, whatever it says", () => {
    expect(notifyEventFor(null, "idle")).toBeNull();
    expect(notifyEventFor(null, "awaiting_approval")).toBeNull();
    expect(notifyEventFor(null, "done")).toBeNull();
  });

  it("calls a live turn falling to rest a completion", () => {
    for (const live of ["submitting", "awaiting_first_token", "streaming", "tool_work", "waking"]) {
      for (const rest of ["idle", "done", "ready"]) {
        expect(notifyEventFor(live, rest)).toBe("complete");
      }
    }
  });

  it("calls a dialog raised inside a live turn a request for input", () => {
    expect(notifyEventFor("tool_work", "awaiting_approval")).toBe("input");
    expect(notifyEventFor("streaming", "awaiting_approval")).toBe("input");
  });

  it("calls a turn that ends straight from a dialog a completion", () => {
    expect(notifyEventFor("awaiting_approval", "idle")).toBe("complete");
  });

  it("says nothing for an interrupt, which the user asked for", () => {
    expect(notifyEventFor("streaming", "interrupting")).toBeNull();
    expect(notifyEventFor("interrupting", "idle")).toBeNull();
  });

  it("says nothing for a replay settling or a wire coming back", () => {
    expect(notifyEventFor("replaying", "idle")).toBeNull();
    expect(notifyEventFor("restoring", "awaiting_approval")).toBeNull();
    expect(notifyEventFor("offline", "idle")).toBeNull();
  });

  it("says nothing for a turn that hands its work to the background or errors", () => {
    expect(notifyEventFor("tool_work", "background")).toBeNull();
    expect(notifyEventFor("streaming", "errored")).toBeNull();
  });

  it("says nothing for a key that did not move", () => {
    expect(notifyEventFor("streaming", "streaming")).toBeNull();
  });
});

describe("parseDockBounce / parseNotifyBanner", () => {
  it("reads the three bounce choices and defaults anything else", () => {
    expect(parseDockBounce({ kind: "string", value: "continued" })).toBe("continued");
    expect(parseDockBounce({ kind: "string", value: "never" })).toBe("never");
    expect(parseDockBounce({ kind: "string", value: "twice" })).toBe(DEFAULT_DOCK_BOUNCE);
    expect(parseDockBounce(undefined)).toBe(DEFAULT_DOCK_BOUNCE);
  });

  it("reads the notification switch as off unless it is a true bool", () => {
    expect(parseNotifyBanner({ kind: "bool", value: true })).toBe(true);
    expect(parseNotifyBanner({ kind: "bool", value: false })).toBe(false);
    expect(parseNotifyBanner({ kind: "string", value: "true" })).toBe(false);
    expect(parseNotifyBanner(undefined)).toBe(false);
  });
});

/** A deck of cards whose phases the test moves by hand. */
function fakeDeck(settings: Record<SessionNotifyEvent, { bounce: DockBounce; notification: boolean }>) {
  const phases = new Map<string, string>();
  const listeners = new Set<() => void>();
  const posts: SessionNotifyPost[] = [];
  const sources: SessionNotifySources = {
    cardIds: () => phases.keys(),
    phaseOf: (cardId) => phases.get(cardId) ?? "idle",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settingsFor: (event) => settings[event],
    describe: (cardId, event) => ({ title: event, body: cardId }),
    post: (note) => posts.push(note),
  };
  const set = (cardId: string, phase: string | null): void => {
    if (phase === null) phases.delete(cardId);
    else phases.set(cardId, phase);
    for (const listener of listeners) listener();
  };
  return { sources, set, posts, listeners };
}

describe("installSessionNotify", () => {
  const both = {
    complete: { bounce: "once" as DockBounce, notification: false },
    input: { bounce: "continued" as DockBounce, notification: true },
  };

  it("posts nothing for the phases standing when it is installed", () => {
    const deck = fakeDeck(both);
    deck.set("a", "awaiting_approval");
    deck.set("b", "done");
    installSessionNotify(deck.sources);
    expect(deck.posts).toEqual([]);
  });

  it("posts each event once, with the settings for that event", () => {
    const deck = fakeDeck(both);
    deck.set("a", "idle");
    installSessionNotify(deck.sources);
    deck.set("a", "streaming");
    deck.set("a", "awaiting_approval");
    deck.set("a", "awaiting_approval");
    deck.set("a", "tool_work");
    deck.set("a", "idle");
    expect(deck.posts).toEqual([
      { event: "input", bounce: "continued", notification: true, cardId: "a", title: "input", body: "a" },
      { event: "complete", bounce: "once", notification: false, cardId: "a", title: "complete", body: "a" },
    ]);
  });

  it("posts nothing for an event set to Never with no notification", () => {
    const deck = fakeDeck({ ...both, complete: { bounce: "never", notification: false } });
    deck.set("a", "streaming");
    installSessionNotify(deck.sources);
    deck.set("a", "idle");
    expect(deck.posts).toEqual([]);
  });

  it("forgets a card that leaves, so one that comes back starts from a baseline", () => {
    const deck = fakeDeck(both);
    deck.set("a", "streaming");
    installSessionNotify(deck.sources);
    deck.set("a", null);
    deck.set("a", "idle");
    expect(deck.posts).toEqual([]);
  });

  it("stops listening when released", () => {
    const deck = fakeDeck(both);
    const release = installSessionNotify(deck.sources);
    expect(deck.listeners.size).toBe(1);
    release();
    expect(deck.listeners.size).toBe(0);
  });
});
