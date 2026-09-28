/**
 * dictation-store — who holds the mic, and every way they lose it.
 *
 * Taking the mic is one gesture and the tests for it are short. Most of what is
 * pinned here is release, because a release that does not happen is a live
 * microphone the user has forgotten about, and there are ten triggers
 * (Table T03) with only one of them being the button.
 *
 * The claims: a claim opens the span before it asks the host, so the composer
 * looks like it is listening first; a second composer's claim ends the first
 * one's session rather than running beside it; an event naming a session that
 * is no longer live reaches nothing, which is what makes a superseded
 * session's late callbacks harmless; text reaches the handle and notifies
 * nobody, because a render per recogniser revision would repaint the composer
 * under the user's hands; a host-side end does not post a `stop` back at a
 * session the host already closed; a refusal is remembered and does not
 * prevent the next press; the two releases only the store can see — the app
 * resigning active, a modal hold landing on the owning card — fire and then
 * unsubscribe, so an idle store observes nothing; and a face is identical
 * across updates that do not change it, so one composer's claim does not
 * re-render another's button.
 *
 * Every test builds its own `DictationStore` over a scripted transport. The
 * exported singleton is wired to the real bridge at module load and is not
 * what these are about.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  DictationStore,
  REFUSAL_TEXT,
  refusalText,
  type DictationTransport,
} from "../dictation-store";
import type { DictationEvent } from "../dictation-bridge";
import type { DictationHandle } from "../prompt-insert-target";
import { registerAppLifecycle, AppLifecycle } from "../app-lifecycle";
import { cardModalHoldStore } from "../card-modal-hold-store";

/** A handle that records the order it was called in, which is the claim here. */
function recordingHandle(): DictationHandle & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    begin: () => calls.push("begin"),
    volatile: (text: string) => calls.push(`volatile:${text}`),
    final: (text: string) => calls.push(`final:${text}`),
    end: () => calls.push("end"),
  };
}

/** A transport that records what the host would have been told. */
function scriptedTransport(): DictationTransport & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    start: (id: string) => posts.push(`start:${id}`),
    stop: (id: string) => posts.push(`stop:${id}`),
  };
}

/** A store whose session ids are predictable, so assertions can name them. */
function freshStore(transport: DictationTransport) {
  let n = 0;
  return new DictationStore({
    transport,
    mintId: () => {
      n += 1;
      return `s${n}`;
    },
  });
}

describe("claiming the mic", () => {
  it("opens the span before it asks the host", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();

    const claim = store.claim("composer-a", "card-a", handle);

    expect(handle.calls).toEqual(["begin"]);
    expect(transport.posts).toEqual(["start:s1"]);
    expect(claim.sessionId).toBe("s1");
    expect(claim.phase).toBe("starting");
  });

  it("shows starting, then preparing, then live", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    store.claim("composer-a", "card-a", recordingHandle());

    expect(store.faceFor("composer-a").mode).toBe("starting");
    store.onEvent({ id: "s1", kind: "preparing" });
    expect(store.faceFor("composer-a").mode).toBe("preparing");
    store.onEvent({ id: "s1", kind: "ready" });
    expect(store.faceFor("composer-a").mode).toBe("live");
  });

  it("shows nothing to a composer that does not hold it", () => {
    const store = freshStore(scriptedTransport());
    store.claim("composer-a", "card-a", recordingHandle());
    expect(store.faceFor("composer-b").mode).toBe("idle");
    expect(store.faceFor("composer-b").sessionId).toBeNull();
  });
});

describe("text on the wire", () => {
  it("reaches the handle and notifies nobody", () => {
    const store = freshStore(scriptedTransport());
    const handle = recordingHandle();
    store.claim("composer-a", "card-a", handle);
    store.onEvent({ id: "s1", kind: "ready" });

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.onEvent({ id: "s1", kind: "volatile", text: "hel" });
    store.onEvent({ id: "s1", kind: "volatile", text: "hello" });
    store.onEvent({ id: "s1", kind: "final", text: "hello world" });

    expect(handle.calls).toEqual([
      "begin",
      "volatile:hel",
      "volatile:hello",
      "final:hello world",
    ]);
    expect(notifications).toBe(0);
  });

  it("ignores level, which the host never sends", () => {
    const store = freshStore(scriptedTransport());
    const handle = recordingHandle();
    store.claim("composer-a", "card-a", handle);
    store.onEvent({ id: "s1", kind: "level", level: 0.5 });
    expect(handle.calls).toEqual(["begin"]);
  });

  it("drops an event naming a session that is not the live one", () => {
    const store = freshStore(scriptedTransport());
    const handle = recordingHandle();
    store.claim("composer-a", "card-a", handle);

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.onEvent({ id: "s-other", kind: "ready" });
    store.onEvent({ id: "s-other", kind: "final", text: "not ours" });
    store.onEvent({ id: "s-other", kind: "ended", reason: "stopped" });

    expect(handle.calls).toEqual(["begin"]);
    expect(notifications).toBe(0);
    expect(store.getSnapshot().claim?.sessionId).toBe("s1");
  });

  it("drops every event when nothing is claimed", () => {
    const store = freshStore(scriptedTransport());
    const events: DictationEvent[] = [
      { id: "s1", kind: "ready" },
      { id: "s1", kind: "final", text: "x" },
      { id: "s1", kind: "ended", reason: "stopped" },
    ];
    expect(() => {
      for (const event of events) store.onEvent(event);
    }).not.toThrow();
    expect(store.getSnapshot().claim).toBeNull();
  });
});

describe("the button's toggle", () => {
  it("ends the owner's session and clears the claim", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();
    store.claim("composer-a", "card-a", handle);
    store.onEvent({ id: "s1", kind: "ready" });

    store.toggle("composer-a", "card-a", handle);

    expect(handle.calls).toEqual(["begin", "end"]);
    expect(transport.posts).toEqual(["start:s1", "stop:s1"]);
    expect(store.getSnapshot().claim).toBeNull();
    expect(store.faceFor("composer-a").mode).toBe("idle");
  });

  it("claims when someone else holds it rather than stopping theirs blindly", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const a = recordingHandle();
    const b = recordingHandle();
    store.claim("composer-a", "card-a", a);

    store.toggle("composer-b", "card-b", b);

    expect(store.getSnapshot().claim?.composerId).toBe("composer-b");
    expect(b.calls).toEqual(["begin"]);
  });
});

describe("a second composer claiming", () => {
  it("ends the first, then starts its own", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const a = recordingHandle();
    const b = recordingHandle();

    store.claim("composer-a", "card-a", a);
    store.onEvent({ id: "s1", kind: "ready" });
    store.claim("composer-b", "card-b", b);

    expect(a.calls).toEqual(["begin", "end"]);
    expect(b.calls).toEqual(["begin"]);
    expect(transport.posts).toEqual(["start:s1", "stop:s1", "start:s2"]);
    expect(store.getSnapshot().claim?.composerId).toBe("composer-b");
    expect(store.faceFor("composer-a").mode).toBe("idle");
    expect(store.faceFor("composer-b").mode).toBe("starting");
  });

  it("leaves the first composer unable to end the second's session", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const a = recordingHandle();
    const b = recordingHandle();

    store.claim("composer-a", "card-a", a);
    store.claim("composer-b", "card-b", b);
    store.endIfOwnedBy("composer-a", "dismissed");

    expect(store.getSnapshot().claim?.composerId).toBe("composer-b");
    expect(b.calls).toEqual(["begin"]);
  });
});

describe("the host ending it", () => {
  it("does not post a stop back at a session the host already closed", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();
    store.claim("composer-a", "card-a", handle);
    store.onEvent({ id: "s1", kind: "ready" });

    store.onEvent({ id: "s1", kind: "ended", reason: "device-lost" });

    expect(handle.calls).toEqual(["begin", "end"]);
    expect(transport.posts).toEqual(["start:s1"]);
    expect(store.getSnapshot().claim).toBeNull();
  });

  it("records a refusal so every composer's button can speak it", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();
    store.claim("composer-a", "card-a", handle);

    store.onEvent({ id: "s1", kind: "refused", reason: "microphone-permission" });

    expect(store.getSnapshot().claim).toBeNull();
    expect(transport.posts).toEqual(["start:s1"]);
    const face = store.faceFor("composer-a");
    expect(face.mode).toBe("refused");
    expect(face.refusalText).toBe(REFUSAL_TEXT["microphone-permission"]);
    expect(store.faceFor("composer-b").mode).toBe("refused");
  });

  it("lets the next press claim again despite the refusal", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();
    store.claim("composer-a", "card-a", handle);
    store.onEvent({ id: "s1", kind: "refused", reason: "microphone-permission" });

    store.toggle("composer-a", "card-a", handle);

    expect(store.getSnapshot().claim?.sessionId).toBe("s2");
    expect(store.getSnapshot().refusal).toBeNull();
    expect(store.faceFor("composer-a").mode).toBe("starting");
    expect(transport.posts).toEqual(["start:s1", "start:s2"]);
  });

  it("appends the host's own words to an error refusal and not to the others", () => {
    expect(refusalText({ reason: "error", message: "the tap fell over" })).toBe(
      `${REFUSAL_TEXT.error}: the tap fell over`,
    );
    expect(refusalText({ reason: "error" })).toBe(REFUSAL_TEXT.error);
    expect(refusalText({ reason: "no-model", message: "ignored" })).toBe(
      REFUSAL_TEXT["no-model"],
    );
  });
});

describe("the releases only the store can see", () => {
  let savedHolds: (() => void) | null = null;

  beforeEach(() => {
    registerAppLifecycle(null);
  });

  afterEach(() => {
    registerAppLifecycle(null);
    savedHolds?.();
    savedHolds = null;
  });

  it("ends the claim when the app resigns active, and stops observing after", () => {
    const lifecycle = new AppLifecycle();
    registerAppLifecycle(lifecycle);

    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();

    store.claim("composer-a", "card-a", handle);
    store.onEvent({ id: "s1", kind: "ready" });
    lifecycle.notifyApplicationDidResignActive();

    expect(handle.calls).toEqual(["begin", "end"]);
    expect(transport.posts).toEqual(["start:s1", "stop:s1"]);
    expect(store.getSnapshot().claim).toBeNull();

    // A second resign with nothing claimed must reach nothing.
    lifecycle.notifyApplicationDidResignActive();
    expect(handle.calls).toEqual(["begin", "end"]);
    expect(transport.posts).toEqual(["start:s1", "stop:s1"]);
  });

  it("ends the claim when a modal hold lands on the owning card", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();

    store.claim("composer-a", "card-a", handle);
    store.onEvent({ id: "s1", kind: "ready" });

    savedHolds = cardModalHoldStore.hold("card-a", {
      reason: "compacting",
      refuse: () => {},
    });

    expect(handle.calls).toEqual(["begin", "end"]);
    expect(transport.posts).toEqual(["start:s1", "stop:s1"]);
    expect(store.getSnapshot().claim).toBeNull();
  });

  it("leaves the claim alone when the hold lands on another card", () => {
    const transport = scriptedTransport();
    const store = freshStore(transport);
    const handle = recordingHandle();

    store.claim("composer-a", "card-a", handle);
    savedHolds = cardModalHoldStore.hold("card-elsewhere", {
      reason: "compacting",
      refuse: () => {},
    });

    expect(handle.calls).toEqual(["begin"]);
    expect(store.getSnapshot().claim?.composerId).toBe("composer-a");
  });

  it("registers no listener with nothing claimed, and none after a release", () => {
    const lifecycle = new AppLifecycle();
    registerAppLifecycle(lifecycle);

    const store = freshStore(scriptedTransport());
    const handle = recordingHandle();

    const holdsBefore = countHoldListeners();
    const resignBefore = countResignListeners(lifecycle);

    store.claim("composer-a", "card-a", handle);
    expect(countHoldListeners()).toBe(holdsBefore + 1);
    expect(countResignListeners(lifecycle)).toBe(resignBefore + 1);

    store.end("stopped");
    expect(countHoldListeners()).toBe(holdsBefore);
    expect(countResignListeners(lifecycle)).toBe(resignBefore);
  });

  it("does not stack a listener per claim when composers hand the mic around", () => {
    const lifecycle = new AppLifecycle();
    registerAppLifecycle(lifecycle);

    const store = freshStore(scriptedTransport());
    const holdsBefore = countHoldListeners();

    store.claim("composer-a", "card-a", recordingHandle());
    store.claim("composer-b", "card-b", recordingHandle());
    store.claim("composer-c", "card-c", recordingHandle());

    expect(countHoldListeners()).toBe(holdsBefore + 1);
    expect(countResignListeners(lifecycle)).toBe(1);
  });
});

/**
 * How many listeners each store is carrying.
 *
 * Neither store publishes a count, and the claim these two exist for cannot be
 * made from the outside: "a released claim leaves no listener behind" is a
 * statement about the set, and a leak there is silent by construction — the
 * store keeps working, and every stale listener fires on every later event.
 * So these reach in, and they are the only place in this file that does. They
 * are pinned to the field names (`listeners`, `subs`) rather than to a shape,
 * so a rename breaks the test loudly instead of quietly returning 0 forever.
 */
function countHoldListeners(): number {
  const internals = cardModalHoldStore as unknown as { listeners: Set<unknown> };
  return internals.listeners.size;
}

function countResignListeners(lifecycle: AppLifecycle): number {
  const internals = lifecycle as unknown as {
    subs: Record<string, Set<unknown>>;
  };
  return internals.subs.applicationDidResignActive.size;
}

describe("face identity", () => {
  it("hands back the same object across updates that do not change it", () => {
    const store = freshStore(scriptedTransport());
    store.claim("composer-a", "card-a", recordingHandle());
    store.onEvent({ id: "s1", kind: "ready" });

    const first = store.faceFor("composer-b");
    store.onEvent({ id: "s1", kind: "volatile", text: "hel" });
    store.onEvent({ id: "s1", kind: "final", text: "hello" });
    const second = store.faceFor("composer-b");

    expect(second).toBe(first);
  });

  it("hands the owner the same object across a repeated phase", () => {
    const store = freshStore(scriptedTransport());
    store.claim("composer-a", "card-a", recordingHandle());
    store.onEvent({ id: "s1", kind: "ready" });

    const first = store.faceFor("composer-a");
    store.onEvent({ id: "s1", kind: "ready" });
    expect(store.faceFor("composer-a")).toBe(first);
  });

  it("hands back a different object when the phase moves", () => {
    const store = freshStore(scriptedTransport());
    store.claim("composer-a", "card-a", recordingHandle());
    const starting = store.faceFor("composer-a");
    store.onEvent({ id: "s1", kind: "ready" });
    expect(store.faceFor("composer-a")).not.toBe(starting);
  });

  it("carries the session id so the button can name what it is showing", () => {
    const store = freshStore(scriptedTransport());
    store.claim("composer-a", "card-a", recordingHandle());
    expect(store.faceFor("composer-a").sessionId).toBe("s1");
  });
});
