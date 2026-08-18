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
  test("logged out on a configured app → only the login questions", () => {
    expect(isLoginOnlyWizard(false, "/Users/ken/tug")).toBe(true);
  });

  test("a first run still gets the whole checklist", () => {
    expect(isLoginOnlyWizard(false, "")).toBe(false);
    expect(isLoginOnlyWizard(false, "   ")).toBe(false);
  });

  test("logged in is never login-only, configured or not", () => {
    expect(isLoginOnlyWizard(true, "/Users/ken/tug")).toBe(false);
    expect(isLoginOnlyWizard(true, "")).toBe(false);
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
