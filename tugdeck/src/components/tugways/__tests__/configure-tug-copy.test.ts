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
  authOfflineCopy,
  deriveProbingHold,
  deriveConfigureTugRequired,
  deriveFirstRunComplete,
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

// ── The offline readings ─────────────────────────────────────────────────

describe("deriveProbingHold", () => {
  const base = {
    forced: false,
    inFirstRun: true,
    loggedIn: null as boolean | null,
    reason: null as string | null,
    deadlinePassed: false,
  };

  test("holds a first run while the probe has not answered", () => {
    expect(deriveProbingHold(base)).toBe(true);
  });

  test("does not hold on a probe that answered 'could not tell'", () => {
    // `probe_failed` carries `loggedIn: null` like silence does, and it is
    // the opposite of silence: the news arrived. Holding on it put the wizard
    // back on "Looking for Claude Code…" for the whole deadline after the
    // answer was already in hand — which a real launch showed doing exactly
    // that before this clause existed.
    expect(deriveProbingHold({ ...base, reason: "probe_failed" })).toBe(false);
  });

  test("lets go at the deadline, whatever the store still says", () => {
    // The whole reason this is a function. `loggedIn` is still `null` — the
    // answer never came — and the hold ends anyway, because `probing` is a
    // term of `required` and an unbounded one holds the app shut.
    expect(deriveProbingHold({ ...base, deadlinePassed: true })).toBe(false);
  });

  test("does not hold once the probe answers, either way", () => {
    expect(deriveProbingHold({ ...base, loggedIn: true })).toBe(false);
    expect(deriveProbingHold({ ...base, loggedIn: false })).toBe(false);
  });

  test("does not hold outside a first run, or under a forced scenario", () => {
    expect(deriveProbingHold({ ...base, inFirstRun: false })).toBe(false);
    expect(deriveProbingHold({ ...base, forced: true })).toBe(false);
  });
});

describe("deriveConfigureTugRequired", () => {
  const base = {
    suppressed: false,
    forced: false,
    notReady: false,
    needsFirstSession: false,
    probing: false,
    reason: null as string | null,
    pathStatus: null as string | null,
  };

  test("a probe that could not tell does not claim the app", () => {
    // `probe_failed` carries `loggedIn: null`, so `notReady` (`loggedIn ===
    // false`) is false and the hold has ended. Nothing is left to require the
    // wizard, which is what makes the deck behind it reachable.
    expect(deriveConfigureTugRequired(base)).toBe(false);
  });

  test("a definite logged-out answer still claims it", () => {
    expect(deriveConfigureTugRequired({ ...base, notReady: true })).toBe(true);
  });

  test("the probing hold claims it, and releasing the hold releases the claim", () => {
    expect(deriveConfigureTugRequired({ ...base, probing: true })).toBe(true);
    expect(deriveConfigureTugRequired({ ...base, probing: false })).toBe(false);
  });

  test("a first session still owed claims it", () => {
    expect(deriveConfigureTugRequired({ ...base, needsFirstSession: true })).toBe(true);
  });

  test("suppression beats every other term", () => {
    expect(
      deriveConfigureTugRequired({
        suppressed: true,
        forced: true,
        notReady: true,
        needsFirstSession: true,
        probing: true,
        reason: "logged_out",
        pathStatus: "unsatisfied",
      }),
    ).toBe(false);
  });
});

describe("deriveConfigureTugRequired — the path hint's one use", () => {
  // The table the whole hint exists for, and the reason it is a table: the
  // relaxation must fire on exactly one combination and on nothing that
  // merely resembles it.
  const loggedOut = {
    suppressed: false,
    forced: false,
    notReady: true,
    needsFirstSession: false,
    probing: false,
    reason: "logged_out" as string | null,
    pathStatus: null as string | null,
  };

  test("logged out with no route does not claim the app", () => {
    // Tug knows the user is signed out AND knows the one fix — a browser
    // round-trip to Anthropic — cannot work. Holding the app behind a button
    // that cannot succeed is the failure this relaxes.
    expect(
      deriveConfigureTugRequired({ ...loggedOut, pathStatus: "unsatisfied" }),
    ).toBe(false);
  });

  test("logged out with a route still claims it", () => {
    // `satisfied` is not an assurance — captive wifi reports it while nothing
    // gets through — so it relaxes nothing. The user can try, and the sign-in
    // attempt's own timeout is what tells them if it went nowhere.
    expect(
      deriveConfigureTugRequired({ ...loggedOut, pathStatus: "satisfied" }),
    ).toBe(true);
  });

  test("logged out with no report yet still claims it", () => {
    // An absent hint is not an offline hint. `null` is "the host has not
    // said", which is where every deck starts and where a browser tab stays.
    expect(deriveConfigureTugRequired(loggedOut)).toBe(true);
  });

  test("requiresConnection is not the believed negative either", () => {
    // A route exists and something must be brought up first (an on-demand
    // VPN). Not "there is no network", so not this relaxation's case.
    expect(
      deriveConfigureTugRequired({
        ...loggedOut,
        pathStatus: "requiresConnection",
      }),
    ).toBe(true);
  });

  test("no route does not relax a reason that is not logged_out", () => {
    // `claude_missing` is not fixed by the network coming back — the CLI is
    // not installed — so the wizard's claim stands however the path reads.
    expect(
      deriveConfigureTugRequired({
        ...loggedOut,
        reason: "claude_missing",
        pathStatus: "unsatisfied",
      }),
    ).toBe(true);
  });

  test("no route does not relax a first session still owed", () => {
    // A different term of `required` entirely, and one the network has no
    // bearing on: the user is logged in and has no card open.
    expect(
      deriveConfigureTugRequired({
        ...loggedOut,
        notReady: false,
        needsFirstSession: true,
        pathStatus: "unsatisfied",
      }),
    ).toBe(true);
  });

  test("no route does not relax the probing hold", () => {
    expect(
      deriveConfigureTugRequired({
        ...loggedOut,
        notReady: false,
        probing: true,
        pathStatus: "unsatisfied",
      }),
    ).toBe(true);
  });

  test("a forced wizard is unaffected by the path", () => {
    // `forced` is the app-test/demo door into the wizard; the host's network
    // has nothing to say about whether a caller asked for it.
    for (const pathStatus of ["unsatisfied", "satisfied", null]) {
      expect(
        deriveConfigureTugRequired({ ...loggedOut, forced: true, pathStatus }),
      ).toBe(true);
    }
  });
});

describe("deriveFirstRunComplete", () => {
  const base = {
    inFirstRun: true,
    suppressed: false,
    required: false,
    effectiveLoggedIn: true,
  };

  test("records a first run that genuinely finished", () => {
    expect(deriveFirstRunComplete(base)).toBe(true);
  });

  test("does NOT record one on the offline path, even though nothing is required", () => {
    // The finding this test exists for. The offline case drops `required` so
    // the app is reachable; read as "setup finished" it would permanently
    // record a first run the user never completed, and the next launch would
    // hand them a login wizard for a setup they never did.
    expect(deriveFirstRunComplete({ ...base, effectiveLoggedIn: false })).toBe(false);
  });

  test("does not record while the wizard still has a claim", () => {
    expect(deriveFirstRunComplete({ ...base, required: true })).toBe(false);
  });

  test("a suppressed instance was never asked, so it answers nothing", () => {
    expect(deriveFirstRunComplete({ ...base, suppressed: true })).toBe(false);
  });

  test("nothing to record outside a first run", () => {
    expect(deriveFirstRunComplete({ ...base, inFirstRun: false })).toBe(false);
  });
});

describe("authOfflineCopy", () => {
  test("an unanswered probe says it does not know, rather than that you are signed out", () => {
    const copy = authOfflineCopy("probe_failed");
    expect(copy.label).toBe("Can't check your login right now");
    expect(copy.detail).toContain("got no answer");
    // The claim Tug does not have must not appear in the row that is about
    // not having it.
    expect(copy.label).not.toContain("logged out");
    expect(copy.detail).not.toContain("logged out");
  });

  test("a known logout while offline names the network as the reason", () => {
    const copy = authOfflineCopy("logged_out_offline");
    expect(copy.label).toBe("Can't log in right now");
    expect(copy.detail).toContain("network connection");
    expect(copy.detail).toContain("browser");
  });

  test("both readings keep a button, because the user has no other retry", () => {
    for (const reading of ["probe_failed", "logged_out_offline"] as const) {
      expect(authOfflineCopy(reading).cta.length).toBeGreaterThan(0);
    }
  });

  test("both readings say what is still possible or why it is not — never a bare failure", () => {
    expect(authOfflineCopy("probe_failed").detail).toContain("existing sessions");
    expect(authOfflineCopy("logged_out_offline").detail).toContain("offline");
  });
});
