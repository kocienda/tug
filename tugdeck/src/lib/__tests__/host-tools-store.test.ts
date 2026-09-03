/**
 * Pure-logic coverage for the host-tools store's one subtle rule: what ends an
 * in-flight install offer.
 *
 * `xcode-select --install` returns as soon as Apple's panel is up, so its own
 * success frame proves nothing about whether git arrived. Only a probe that
 * sees a usable git does. Getting this backwards would flash the row settled
 * the instant the user pressed Install, over a machine still downloading 3 GB.
 */

import { describe, expect, test, beforeEach } from "bun:test";

import {
  hostToolsStore,
  applyHostToolsResultPayload,
  applyHostToolsOfferResultPayload,
} from "../host-tools-store";

const NO_GIT = {
  gitVersion: null,
  gitPath: null,
  developerDir: null,
  gitFloor: "2.23",
  usable: false,
};

const GIT = {
  gitVersion: "2.39.5",
  gitPath: "/usr/bin/git",
  developerDir: "/Library/Developer/CommandLineTools",
  gitFloor: "2.23",
  usable: true,
};

describe("hostToolsStore", () => {
  beforeEach(() => {
    hostToolsStore.setOffering(false);
    applyHostToolsResultPayload(NO_GIT);
  });

  test("a probe marks the store answered and carries the wire's floor", () => {
    applyHostToolsResultPayload(GIT);
    const snap = hostToolsStore.getSnapshot();
    expect(snap.probed).toBe(true);
    expect(snap.usable).toBe(true);
    expect(snap.gitFloor).toBe("2.23");
    expect(snap.gitVersion).toBe("2.39.5");
  });

  test("an offer stays in flight through a probe that still finds no git", () => {
    hostToolsStore.setOffering(true);
    applyHostToolsOfferResultPayload({ ok: true, error: null });
    applyHostToolsResultPayload(NO_GIT);
    expect(
      hostToolsStore.getSnapshot().offering,
      "Apple's installer is still running",
    ).toBe(true);
  });

  test("the probe that finds git is what ends the offer", () => {
    hostToolsStore.setOffering(true);
    applyHostToolsResultPayload(GIT);
    expect(hostToolsStore.getSnapshot().offering).toBe(false);
  });

  test("a failed offer ends in flight and surfaces the error", () => {
    hostToolsStore.setOffering(true);
    applyHostToolsOfferResultPayload({ ok: false, error: "no network" });
    const snap = hostToolsStore.getSnapshot();
    expect(snap.offering).toBe(false);
    expect(snap.offerError).toBe("no network");
  });

  test("starting a new offer clears the previous error", () => {
    applyHostToolsOfferResultPayload({ ok: false, error: "no network" });
    hostToolsStore.setOffering(true);
    expect(hostToolsStore.getSnapshot().offerError).toBeNull();
  });

  test("empty strings on the wire read as absent, never as a version", () => {
    applyHostToolsResultPayload({ ...NO_GIT, gitVersion: "", gitPath: "" });
    const snap = hostToolsStore.getSnapshot();
    expect(snap.gitVersion).toBeNull();
    expect(snap.gitPath).toBeNull();
  });
});
