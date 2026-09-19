/**
 * Pure-logic coverage for ConfigureTug's subscription copy ([D105]). The signed-in
 * step's subscription line can only be exercised live for whatever tier the
 * golden-run test account happens to hold, so the per-tier wording is pinned
 * here instead — covering the nodes a VM run can't reach without an account of
 * each tier. Also pins the pending open-step copy's zero-card vs open-cards
 * branch.
 */

import { describe, expect, test } from "bun:test";

import {
  subscriptionLabel,
  pendingOpenStepCopy,
  claudeInstalledCopy,
  compareVersions,
  isLoginOnlyWizard,
  hostToolsCopy,
  returnHomeStepKey,
  COMMAND_LINE_TOOLS_SIZE,
} from "../configure-tug-copy";

describe("subscriptionLabel", () => {
  test("maps each known tier to its formal label (no trailing period)", () => {
    expect(subscriptionLabel("max")).toBe("Claude Max plan");
    expect(subscriptionLabel("pro")).toBe("Claude Pro plan");
    expect(subscriptionLabel("team")).toBe("Claude Team plan");
    expect(subscriptionLabel("enterprise")).toBe("Claude Enterprise plan");
    expect(subscriptionLabel("free")).toBe("Claude Free plan");
  });

  test("is case- and whitespace-insensitive on the wire value", () => {
    expect(subscriptionLabel("MAX")).toBe("Claude Max plan");
    expect(subscriptionLabel("  Pro  ")).toBe("Claude Pro plan");
  });

  test("omits the line when the tier is unknown/empty", () => {
    expect(subscriptionLabel(null)).toBeUndefined();
    expect(subscriptionLabel(undefined)).toBeUndefined();
    expect(subscriptionLabel("")).toBeUndefined();
    expect(subscriptionLabel("   ")).toBeUndefined();
  });

  test("title-cases an unrecognized tier rather than leaking it raw", () => {
    expect(subscriptionLabel("startup")).toBe("Claude Startup plan");
    // Never a bare lowercase token or a trailing period.
    expect(subscriptionLabel("scale")).toBe("Claude Scale plan");
  });
});

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareVersions("2.1.222", "2.1.226")).toBeLessThan(0);
    expect(compareVersions("2.2.0", "2.1.999")).toBeGreaterThan(0);
    expect(compareVersions("2.1.222", "2.1.222")).toBe(0);
  });

  test("a pre-release precedes its own release", () => {
    expect(compareVersions("2.2.0-rc.1", "2.2.0")).toBeLessThan(0);
    expect(compareVersions("2.2.0", "2.2.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("2.2.0-rc.1", "2.2.0-rc.2")).toBeLessThan(0);
  });
});

describe("claudeInstalledCopy", () => {
  test("behind the channel → names both versions and offers the update", () => {
    expect(claudeInstalledCopy("2.1.222", "2.1.226")).toEqual({
      detail: "Version 2.1.222 — 2.1.226 is available.",
      updatable: true,
    });
  });

  test("current → says so, with nothing to press", () => {
    expect(claudeInstalledCopy("2.1.226", "2.1.226")).toEqual({
      detail: "Version 2.1.226 — up to date.",
      updatable: false,
    });
  });

  test("ahead of the channel reads as current, never as behind", () => {
    // A locally built or pre-release `claude` must not be offered a downgrade.
    expect(claudeInstalledCopy("2.2.0", "2.1.226")).toEqual({
      detail: "Version 2.2.0 — up to date.",
      updatable: false,
    });
  });

  test("no channel answer → names what is installed and says no more", () => {
    expect(claudeInstalledCopy("2.1.222", null)).toEqual({
      detail: "Version 2.1.222",
      updatable: false,
    });
  });

  test("nothing probed yet → the plain ready line", () => {
    expect(claudeInstalledCopy(null, null)).toEqual({
      detail: "Claude Code is ready.",
      updatable: false,
    });
    expect(claudeInstalledCopy(null, "2.1.226")).toEqual({
      detail: "Claude Code is ready.",
      updatable: false,
    });
  });
});

describe("isLoginOnlyWizard", () => {
  test("logged out past the first run → only the login questions", () => {
    expect(isLoginOnlyWizard(false, false)).toBe(true);
  });

  test("a first run still gets the whole checklist", () => {
    expect(isLoginOnlyWizard(false, true)).toBe(false);
  });

  test("logged in is never login-only, first run or not", () => {
    expect(isLoginOnlyWizard(true, false)).toBe(false);
    expect(isLoginOnlyWizard(true, true)).toBe(false);
  });
});

describe("pendingOpenStepCopy", () => {
  test("zero cards → first-run wording, no detail", () => {
    expect(pendingOpenStepCopy(0)).toEqual({
      label: "Start a session",
    });
  });

  test("cards open → 'Continue working' preview with a pluralized count", () => {
    expect(pendingOpenStepCopy(1)).toEqual({
      label: "Continue working",
      detail: "You'll return to your 1 open card.",
    });
    expect(pendingOpenStepCopy(3)).toEqual({
      label: "Continue working",
      detail: "You'll return to your 3 open cards.",
    });
  });
});

describe("hostToolsCopy", () => {
  // Every machine that runs this corpus has git, so five of the six readings
  // are unreachable live. They are pinned here instead.
  const probed = {
    gitVersion: null as string | null,
    gitPath: null as string | null,
    developerDir: null as string | null,
    gitFloor: "2.23",
    usable: false,
    probed: true,
    offering: false,
    offerError: null as string | null,
  };

  test("says it is looking before the probe has answered", () => {
    const copy = hostToolsCopy({ ...probed, probed: false });
    expect(copy.status).toBe("busy");
    expect(copy.cta).toBeUndefined();
    expect(copy.secondaryCta).toBeUndefined();
  });

  test("a machine with no git gets the offer, its size, and a skip", () => {
    const copy = hostToolsCopy(probed);
    expect(copy.status).toBe("active");
    expect(copy.label).toBe("Install git");
    // The number is the point: an Install button that does not say what it
    // costs is an ambush.
    expect(copy.detail).toContain(COMMAND_LINE_TOOLS_SIZE);
    expect(copy.cta).toBe("Install");
    expect(copy.secondaryCta).toBe("Skip for now");
  });

  test("a git at the floor is settled and asks nothing", () => {
    const copy = hostToolsCopy({
      ...probed,
      gitVersion: "2.39.5",
      gitPath: "/usr/bin/git",
      developerDir: "/Library/Developer/CommandLineTools",
      usable: true,
    });
    expect(copy.status).toBe("done");
    expect(copy.detail).toBe("Version 2.39.5");
    expect(copy.cta).toBeUndefined();
  });

  test("an old Apple git is offered the same install, and names the floor", () => {
    const copy = hostToolsCopy({
      ...probed,
      gitVersion: "2.19.1",
      gitPath: "/usr/bin/git",
      developerDir: "/Library/Developer/CommandLineTools",
    });
    expect(copy.status).toBe("error");
    expect(copy.label).toBe("Update git");
    expect(copy.detail).toContain("2.23");
    expect(copy.cta).toBe("Install");
  });

  test("an old third-party git is named, not offered a button that cannot work", () => {
    // Installing Apple's tools would leave the older git first on PATH and
    // change nothing, so the row points at the path instead of pretending.
    const copy = hostToolsCopy({
      ...probed,
      gitVersion: "2.19.1",
      gitPath: "/opt/homebrew/bin/git",
    });
    expect(copy.status).toBe("error");
    expect(copy.detail).toContain("/opt/homebrew/bin/git");
    expect(copy.cta).toBeUndefined();
  });

  test("an accepted offer waits with Apple's installer and offers a recheck", () => {
    const copy = hostToolsCopy({ ...probed, offering: true });
    expect(copy.status).toBe("busy");
    expect(copy.detail).toContain(COMMAND_LINE_TOOLS_SIZE);
    expect(copy.secondaryCta).toBe("Recheck");
  });

  test("an offer that genuinely failed says so and offers a retry", () => {
    const copy = hostToolsCopy({ ...probed, offerError: "no network" });
    expect(copy.status).toBe("error");
    expect(copy.detail).toContain("no network");
    expect(copy.cta).toBe("Retry");
  });

  test("the floor named is the one the wire carried, not a local constant", () => {
    const copy = hostToolsCopy({
      ...probed,
      gitVersion: "2.19.1",
      gitPath: "/usr/bin/git",
      developerDir: "/Library/Developer/CommandLineTools",
      gitFloor: "2.30",
    });
    expect(copy.detail).toContain("2.30");
  });
});

describe("returnHomeStepKey", () => {
  const row = (key: string, status: string, hasAction = true) => ({ key, status, hasAction });

  test("the active row's button is Return's home, not Done", () => {
    expect(
      returnHomeStepKey([row("install", "done"), row("signin", "done"), row("project-dir", "active")]),
    ).toBe("project-dir");
  });

  test("an error row's retry is the home too", () => {
    expect(returnHomeStepKey([row("install", "error"), row("signin", "pending", false)])).toBe(
      "install",
    );
  });

  test("the first row that wants something wins, so there is only ever one", () => {
    expect(
      returnHomeStepKey([row("host-tools", "active"), row("install", "active"), row("signin", "pending", false)]),
    ).toBe("host-tools");
  });

  test("a settled row's Update offer is never the home, so Done keeps the ring", () => {
    expect(returnHomeStepKey([row("install", "done"), row("signin", "done", false)])).toBeNull();
  });

  test("busy rows and a buttonless error row are not the home", () => {
    expect(
      returnHomeStepKey([row("install", "busy"), row("host-tools", "error", false)]),
    ).toBeNull();
  });
});
