/**
 * network-path-store — the host's path hint, and the asymmetry that is the
 * point of it.
 *
 * Two kinds of claim are pinned here. The ordinary ones: a bridge payload
 * lands on the snapshot, an identical payload replaces nothing and notifies
 * nobody, a payload the store does not recognize reads as no evidence rather
 * than as a guess.
 *
 * And one that is not about behaviour at all — **the module exposes no
 * boolean predicate**. `isOnline()` is the API that would quietly undo this
 * whole module: the asymmetry (`unsatisfied` is believed, `satisfied` is only
 * a nudge to try) cannot survive a name that sounds trustworthy, so the
 * absence is enforced here rather than left to a comment. The last describe
 * block reads the module's own exports and fails if one appears.
 *
 * The store is a module singleton, so every test applies the state it needs
 * rather than assuming a fresh one.
 */

import { describe, it, expect } from "bun:test";

import * as pathModule from "../network-path-store";
import {
  networkPathStore,
  networkPathFromPayload,
  installNetworkPathBridge,
} from "../network-path-store";

describe("network-path-store: a host report lands on the snapshot", () => {
  it("records each of the three path states", () => {
    for (const status of [
      "satisfied",
      "unsatisfied",
      "requiresConnection",
    ] as const) {
      networkPathStore.apply(networkPathFromPayload({ status }));
      expect(networkPathStore.getSnapshot().status).toBe(status);
    }
  });

  it("carries the expensive and constrained flags", () => {
    networkPathStore.apply(
      networkPathFromPayload({
        status: "satisfied",
        isExpensive: true,
        isConstrained: true,
      }),
    );
    const snap = networkPathStore.getSnapshot();
    expect(snap.isExpensive).toBe(true);
    expect(snap.isConstrained).toBe(true);
  });

  it("reads an unrecognized status as no evidence, not as either extreme", () => {
    // The host said something this build does not understand. That is the
    // same answer as "the host has not said", and emphatically not a guess
    // at offline — an absent hint is not an offline hint.
    networkPathStore.apply(networkPathFromPayload({ status: "sideways" }));
    expect(networkPathStore.getSnapshot().status).toBeNull();

    networkPathStore.apply(networkPathFromPayload({}));
    expect(networkPathStore.getSnapshot().status).toBeNull();
  });

  it("reads a missing flag as false rather than as present", () => {
    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    const snap = networkPathStore.getSnapshot();
    expect(snap.isExpensive).toBe(false);
    expect(snap.isConstrained).toBe(false);
  });
});

describe("network-path-store: reference stability and notification", () => {
  it("notifies exactly once per change", () => {
    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    let notices = 0;
    const unsubscribe = networkPathStore.subscribe(() => {
      notices += 1;
    });

    networkPathStore.apply(networkPathFromPayload({ status: "unsatisfied" }));
    expect(notices).toBe(1);
    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    expect(notices).toBe(2);

    unsubscribe();
  });

  it("an identical report replaces nothing and notifies nobody", () => {
    // `NWPathMonitor` reports interface churn that changes none of the three
    // fields this store reads. A consumer must not re-render for it, and
    // [L02] reference stability is what makes that true.
    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    const before = networkPathStore.getSnapshot();
    let notices = 0;
    const unsubscribe = networkPathStore.subscribe(() => {
      notices += 1;
    });

    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    expect(notices).toBe(0);
    expect(networkPathStore.getSnapshot()).toBe(before);

    unsubscribe();
  });

  it("a change in a flag alone is still a change", () => {
    networkPathStore.apply(
      networkPathFromPayload({ status: "satisfied", isExpensive: false }),
    );
    const before = networkPathStore.getSnapshot();
    networkPathStore.apply(
      networkPathFromPayload({ status: "satisfied", isExpensive: true }),
    );
    expect(networkPathStore.getSnapshot()).not.toBe(before);
  });

  it("an unsubscribed listener stops hearing", () => {
    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    let notices = 0;
    const unsubscribe = networkPathStore.subscribe(() => {
      notices += 1;
    });
    unsubscribe();
    networkPathStore.apply(networkPathFromPayload({ status: "unsatisfied" }));
    expect(notices).toBe(0);
  });
});

describe("network-path-store: the bridge receiver", () => {
  it("installs onto the shared __tugBridge without replacing it", () => {
    const w = globalThis as unknown as {
      __tugBridge?: Record<string, unknown>;
    };
    w.__tugBridge = { onSomethingElse: () => {} };
    installNetworkPathBridge();

    // The other host callbacks are still there — the object is merged into,
    // never replaced.
    expect(typeof w.__tugBridge.onSomethingElse).toBe("function");
    expect(typeof w.__tugBridge.onNetworkPath).toBe("function");
  });

  it("feeds the store from a host push", () => {
    const w = globalThis as unknown as {
      __tugBridge?: { onNetworkPath?: (r: Record<string, unknown>) => void };
    };
    installNetworkPathBridge();
    w.__tugBridge?.onNetworkPath?.({ status: "unsatisfied" });
    expect(networkPathStore.getSnapshot().status).toBe("unsatisfied");
  });
});

describe("network-path-store: the API is the enforcement", () => {
  it("exports no boolean predicate about being online", () => {
    // Not a style check. A predicate named for the positive reading is an
    // invitation to gate a send on it, and `satisfied` is the reading that
    // lies — a captive portal hands out a route and answers everything with
    // its login page. Callers read `status` and branch on the member they
    // mean, so "I am relying on satisfied" is visible in the diff.
    const forbidden = [
      "isOnline",
      "isOffline",
      "online",
      "offline",
      "hasNetwork",
      "isConnected",
      "isReachable",
      "canReachNetwork",
    ];
    const exported = Object.keys(pathModule);
    for (const name of forbidden) {
      expect(exported).not.toContain(name);
    }
  });

  it("exposes the raw path state and nothing that summarizes it", () => {
    // The snapshot's only status-shaped field is the state itself. A second
    // one — a derived boolean beside it — would be the same mistake wearing
    // a field's clothes rather than a function's.
    networkPathStore.apply(networkPathFromPayload({ status: "satisfied" }));
    const snap = networkPathStore.getSnapshot();
    expect(Object.keys(snap).sort()).toEqual([
      "isConstrained",
      "isExpensive",
      "status",
    ]);
  });
});
