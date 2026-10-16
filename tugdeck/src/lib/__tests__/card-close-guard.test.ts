/**
 * card-close-guard.test.ts — the per-card close-guard registry: register,
 * resolve, and release ([L27]).
 */

import { describe, test, expect } from "bun:test";
import {
  registerCardCloseGuard,
  getCardCloseGuard,
  watchCardCloseGuard,
  type CardCloseGuard,
} from "@/lib/card-close-guard";

function makeGuard(decision: "close" | "cancel", dirty = true): CardCloseGuard {
  return {
    needsDecision: () => dirty,
    run: async () => decision,
  };
}

describe("card close guard registry", () => {
  test("resolves the registered guard and releases it", () => {
    const guard = makeGuard("close");
    expect(getCardCloseGuard("c1")).toBeNull();

    const release = registerCardCloseGuard("c1", guard);
    expect(getCardCloseGuard("c1")).toBe(guard);

    release();
    expect(getCardCloseGuard("c1")).toBeNull();
  });

  test("a re-registration replaces the prior guard and owns the slot", () => {
    const first = makeGuard("cancel");
    const second = makeGuard("close");
    const releaseFirst = registerCardCloseGuard("c2", first);
    const releaseSecond = registerCardCloseGuard("c2", second);
    expect(getCardCloseGuard("c2")).toBe(second);

    // The stale first release must NOT evict the second guard.
    releaseFirst();
    expect(getCardCloseGuard("c2")).toBe(second);

    releaseSecond();
    expect(getCardCloseGuard("c2")).toBeNull();
  });

  test("guards for distinct cards are independent", () => {
    const a = makeGuard("close");
    const b = makeGuard("cancel");
    const releaseA = registerCardCloseGuard("cA", a);
    const releaseB = registerCardCloseGuard("cB", b);
    expect(getCardCloseGuard("cA")).toBe(a);
    expect(getCardCloseGuard("cB")).toBe(b);
    releaseA();
    releaseB();
  });

  test("needsDecision reflects the card's live dirty state", () => {
    let dirty = false;
    const release = registerCardCloseGuard("c3", {
      needsDecision: () => dirty,
      run: async () => "close",
    });
    expect(getCardCloseGuard("c3")!.needsDecision()).toBe(false);
    dirty = true;
    expect(getCardCloseGuard("c3")!.needsDecision()).toBe(true);
    release();
  });

  test("a watch hears the card's guard come and go, and its answer move, and nothing after its release", () => {
    const listeners = new Set<() => void>();
    let dirty = false;
    let heard = 0;
    const stop = watchCardCloseGuard("c4", () => {
      heard += 1;
    });
    const release = registerCardCloseGuard("c4", {
      needsDecision: () => dirty,
      run: async () => "close",
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    expect(heard).toBe(1);
    // The buffer goes dirty with no other event: the guard's own notify is heard.
    dirty = true;
    for (const l of listeners) l();
    expect(heard).toBe(2);
    // Another card's guard is not this watch's business.
    const other = registerCardCloseGuard("c5", makeGuard("close"));
    expect(heard).toBe(2);
    release();
    expect(heard).toBe(3);
    expect(listeners.size).toBe(0);
    stop();
    registerCardCloseGuard("c4", makeGuard("close"))();
    expect(heard).toBe(3);
    other();
  });
});
