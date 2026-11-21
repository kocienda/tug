/**
 * auth-store — a probe that did not answer is not a signed-out user.
 *
 * `claude_auth_result` carries a three-valued `loggedIn`, and the third value
 * is what these tests are about: `null` with `reason: "probe_failed"` says the
 * backend asked `claude auth status` and got no answer inside its bound. The
 * store must record that as unknown, and — the part that would otherwise be
 * silently wrong — must not read it as a sign-in attempt that failed, because
 * that is what puts a "Sign-in didn't finish" error in front of a user who
 * never saw a browser.
 *
 * The store is a module singleton, so every test applies the state it needs
 * rather than assuming a fresh one.
 */

import { describe, it, expect } from "bun:test";
import {
  authStore,
  applyAuthResultPayload,
  applyDownloadFallbackPayload,
  applyDownloadProgressPayload,
  applyDownloadStoppedPayload,
  applyLogoutResultPayload,
} from "../auth-store";

describe("auth-store: the shell's auth variables", () => {
  it("carries the names every answer reports, logged in or not", () => {
    applyAuthResultPayload({ loggedIn: false, reason: "logged_out", shellAuthVars: ["ANTHROPIC_API_KEY"] });
    expect(authStore.getSnapshot().shellAuthVars).toEqual(["ANTHROPIC_API_KEY"]);
    applyAuthResultPayload({
      loggedIn: true,
      loginSource: "subscription",
      shellAuthVars: ["ANTHROPIC_API_KEY", 7, "", "CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(authStore.getSnapshot().shellAuthVars).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("keeps the same array while the names are unchanged, and clears on none", () => {
    applyAuthResultPayload({ loggedIn: false, reason: "logged_out", shellAuthVars: ["ANTHROPIC_AUTH_TOKEN"] });
    const first = authStore.getSnapshot().shellAuthVars;
    applyAuthResultPayload({ loggedIn: false, reason: "logged_out", shellAuthVars: ["ANTHROPIC_AUTH_TOKEN"] });
    expect(authStore.getSnapshot().shellAuthVars).toBe(first);
    applyAuthResultPayload({ loggedIn: false, reason: "logged_out" });
    expect(authStore.getSnapshot().shellAuthVars).toEqual([]);
  });
});

describe("auth-store: a probe that did not answer", () => {
  it("lands as unknown with the reason that says why", () => {
    applyAuthResultPayload({ loggedIn: null, reason: "probe_failed" });
    const snap = authStore.getSnapshot();
    expect(snap.loggedIn).toBeNull();
    expect(snap.reason).toBe("probe_failed");
    expect(snap.account).toBeNull();
  });

  it("does not set signInFailed, even mid sign-in", () => {
    // The shape that matters. A sign-in is in flight; the probe behind it
    // times out. Read as an ordinary not-logged-in result this would mean
    // "the browser never came back" — a claim about the user's attempt that
    // the frame does not make.
    authStore.setSigningIn(true);
    applyAuthResultPayload({ loggedIn: null, reason: "probe_failed" });
    const snap = authStore.getSnapshot();
    expect(snap.signingIn).toBe(false);
    expect(snap.signInFailed).toBe(false);
    expect(snap.loggedIn).toBeNull();
  });

  it("leaves an earlier sign-in failure standing rather than clearing it", () => {
    // The mirror of the case above: silence says nothing either way, so it
    // must not erase a failure a real result established.
    authStore.setSigningIn(true);
    applyAuthResultPayload({ loggedIn: false, reason: "logged_out" });
    expect(authStore.getSnapshot().signInFailed).toBe(true);

    applyAuthResultPayload({ loggedIn: null, reason: "probe_failed" });
    expect(authStore.getSnapshot().signInFailed).toBe(true);
  });

  it("reads a missing loggedIn as unknown, not as signed out", () => {
    applyAuthResultPayload({ reason: "probe_failed" });
    expect(authStore.getSnapshot().loggedIn).toBeNull();
  });
});

describe("auth-store: a definite answer is unchanged", () => {
  it("still records a login with its account", () => {
    applyAuthResultPayload({
      loggedIn: true,
      email: "user@example.com",
      subscriptionType: "max",
      authMethod: "claude.ai",
    });
    const snap = authStore.getSnapshot();
    expect(snap.loggedIn).toBe(true);
    expect(snap.reason).toBeNull();
    expect(snap.account).toEqual({
      email: "user@example.com",
      subscriptionType: "max",
      authMethod: "claude.ai",
      // A payload that names no source reads as one Tug cannot name.
      loginSource: "unknown",
      apiKeySource: null,
      orgName: null,
      planTier: null,
      profile: null,
      subscriptionStored: false,
    });
    expect(snap.signInFailed).toBe(false);
  });

  it("records the login's source and a profile beneath it", () => {
    applyAuthResultPayload({
      loggedIn: true,
      email: "user@example.com",
      authMethod: "claude.ai",
      loginSource: "subscription",
      orgName: "Org",
      planTier: "max_20x",
      subscriptionStored: true,
      profile: {
        name: "default",
        configDir: "/Users/user/.config/anthropic",
        authType: "user_oauth",
        organizationId: "org-1",
        workspaceId: null,
      },
    });
    const account = authStore.getSnapshot().account;
    expect(account?.loginSource).toBe("subscription");
    expect(account?.orgName).toBe("Org");
    expect(account?.subscriptionStored).toBe(true);
    expect(account?.profile).toEqual({
      name: "default",
      configDir: "/Users/user/.config/anthropic",
      authType: "user_oauth",
      organizationId: "org-1",
      workspaceId: null,
    });
  });

  it("reads a source it does not know as unknown, and a nameless profile as none", () => {
    applyAuthResultPayload({
      loggedIn: true,
      loginSource: "bedrock",
      apiKeySource: "ANTHROPIC_API_KEY",
      profile: { configDir: "/x" },
    });
    const account = authStore.getSnapshot().account;
    expect(account?.loginSource).toBe("unknown");
    expect(account?.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(account?.profile).toBeNull();
  });

  it("still records a signed-out state with its reason", () => {
    applyAuthResultPayload({ loggedIn: false, reason: "claude_missing" });
    const snap = authStore.getSnapshot();
    expect(snap.loggedIn).toBe(false);
    expect(snap.reason).toBe("claude_missing");
    expect(snap.account).toBeNull();
  });

  it("still reads a sign-in that came back signed out as a failed attempt", () => {
    applyAuthResultPayload({ loggedIn: true, email: "user@example.com" });
    authStore.setSigningIn(true);
    applyAuthResultPayload({ loggedIn: false, reason: "logged_out" });
    const snap = authStore.getSnapshot();
    expect(snap.signingIn).toBe(false);
    expect(snap.signInFailed).toBe(true);
  });
});

/**
 * The Claude Code download's half of the store ([B08], [B09]).
 *
 * Three things here are only true because they were written to be, and each
 * would be silently wrong otherwise: a pause keeps its bytes where a cancel
 * does not; a resume that comes back at zero is a restart and the only place
 * that can be told is the store, because received bytes never otherwise run
 * backwards; and the byte pair is elided from what React reads, so a bar that
 * moves a hundred times re-renders nothing.
 */
describe("auth-store: the Claude Code download", () => {
  it("carries the bytes and the version while they arrive", () => {
    applyDownloadProgressPayload({
      received: 4_000_000,
      expected: 48_100_000,
      version: "2.1.222",
    });
    const snap = authStore.getSnapshot();
    expect(snap.installing).toBe(true);
    expect(snap.downloadPaused).toBe(false);
    expect(snap.receivedBytes).toBe(4_000_000);
    expect(snap.expectedBytes).toBe(48_100_000);
    expect(snap.downloadVersion).toBe("2.1.222");
  });

  it("keeps the bytes through a pause and forgets them on a cancel", () => {
    applyDownloadProgressPayload({
      received: 4_000_000,
      expected: 48_100_000,
      version: "2.1.222",
    });
    applyDownloadStoppedPayload({
      reason: "paused",
      received: 4_000_000,
      expected: 48_100_000,
      version: "2.1.222",
    });
    let snap = authStore.getSnapshot();
    expect(snap.downloadPaused).toBe(true);
    expect(snap.installing).toBe(false);
    expect(snap.receivedBytes).toBe(4_000_000);

    applyDownloadStoppedPayload({ reason: "cancelled" });
    snap = authStore.getSnapshot();
    expect(snap.downloadPaused).toBe(false);
    expect(snap.receivedBytes).toBe(0);
    expect(snap.expectedBytes).toBe(0);
    expect(snap.downloadVersion).toBeNull();
  });

  it("reads a resume that comes back at zero as a restart", () => {
    applyDownloadProgressPayload({
      received: 4_000_000,
      expected: 48_100_000,
      version: "2.1.222",
    });
    authStore.setResuming();
    expect(authStore.getSnapshot().receivedBytes).toBe(4_000_000);
    applyDownloadProgressPayload({
      received: 0,
      expected: 48_500_000,
      version: "2.1.223",
    });
    expect(authStore.getSnapshot().downloadRestarted).toBe(true);
  });

  it("does not call an ordinary first frame a restart", () => {
    authStore.setInstalling(true);
    applyDownloadProgressPayload({
      received: 0,
      expected: 48_100_000,
      version: "2.1.222",
    });
    expect(authStore.getSnapshot().downloadRestarted).toBe(false);
  });

  it("holds the render snapshot's reference across a bytes-only change", () => {
    authStore.setInstalling(true);
    applyDownloadProgressPayload({ received: 1, expected: 100, version: "2.1.222" });
    const before = authStore.getRenderSnapshot();
    applyDownloadProgressPayload({ received: 2, expected: 100, version: "2.1.222" });
    expect(authStore.getRenderSnapshot()).toBe(before);
    expect(authStore.getSnapshot().receivedBytes).toBe(2);
    // …and moves it the moment something React can see does change.
    applyDownloadStoppedPayload({ reason: "paused", received: 2, expected: 100 });
    expect(authStore.getRenderSnapshot()).not.toBe(before);
  });

  it("calls the transfer over on its last byte, so Pause goes away", () => {
    // tugcast lets go of the download the moment the stream ends — the
    // checksum and the binary's own `install` run with nothing holding a
    // cancellation token — so a Pause still on the row past that point is a
    // button that finds nothing to stop.
    authStore.setInstalling(true);
    applyDownloadProgressPayload({
      received: 4_000_000,
      expected: 48_100_000,
      version: "2.1.222",
    });
    expect(authStore.getSnapshot().downloadComplete).toBe(false);

    applyDownloadProgressPayload({
      received: 48_100_000,
      expected: 48_100_000,
      version: "2.1.222",
    });
    expect(authStore.getSnapshot().downloadComplete).toBe(true);

    // And a fresh transfer is not over before it starts.
    authStore.setInstalling(true);
    expect(authStore.getSnapshot().downloadComplete).toBe(false);
  });

  it("says the script is running, with no bytes to count", () => {
    authStore.setInstalling(true);
    applyDownloadFallbackPayload();
    const snap = authStore.getSnapshot();
    expect(snap.downloadFallback).toBe(true);
    expect(snap.installing).toBe(true);
    expect(snap.expectedBytes).toBe(0);
  });

  it("puts the whole download down when the install result lands", () => {
    applyDownloadProgressPayload({
      received: 4_000_000,
      expected: 48_100_000,
      version: "2.1.222",
    });
    authStore.applyInstallResult(true, null);
    const snap = authStore.getSnapshot();
    expect(snap.installing).toBe(false);
    expect(snap.downloadPaused).toBe(false);
    expect(snap.receivedBytes).toBe(0);
    expect(snap.verifyingInstall).toBe(true);
  });
});

describe("auth-store: a listener that unsubscribes during a notify", () => {
  it("does not make the listener after it miss the change", () => {
    // The shape a React subtree takes when it unmounts in response to the
    // change it is being told about: its listener goes away mid-notify. The
    // listener subscribed after it must still hear this notification.
    authStore.setSigningIn(false);
    const calls: string[] = [];
    const offA = authStore.subscribe(() => {
      calls.push("a");
      offA();
    });
    const offB = authStore.subscribe(() => calls.push("b"));
    authStore.setSigningIn(true);
    offB();
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("auth-store: a logout that leaves a login in place", () => {
  const profileLogin = {
    loggedIn: true,
    reason: null,
    email: null,
    authMethod: "oauth_token",
    loginSource: "console_profile",
    subscriptionStored: false,
    profile: { name: "default", configDir: "/Users/user/.config/anthropic" },
  };

  it("records the remaining login when the result says one is left", () => {
    authStore.setLoggingOut(true);
    // The re-probed state lands first, then the result naming it.
    applyAuthResultPayload(profileLogin);
    applyLogoutResultPayload({ ok: true, error: null, stillLoggedIn: true });
    const snap = authStore.getSnapshot();
    expect(snap.loggingOut).toBe(false);
    expect(snap.logoutError).toBeNull();
    expect(snap.logoutRemaining?.loginSource).toBe("console_profile");
    expect(snap.logoutRemaining?.profile?.name).toBe("default");
    authStore.clearLogoutRemaining();
    expect(authStore.getSnapshot().logoutRemaining).toBeNull();
  });

  it("records nothing when the logout left the user logged out", () => {
    authStore.setLoggingOut(true);
    applyAuthResultPayload({ loggedIn: false, reason: "logged_out" });
    applyLogoutResultPayload({ ok: true, error: null, stillLoggedIn: false });
    expect(authStore.getSnapshot().logoutRemaining).toBeNull();
  });

  it("records an error, not a remaining login, when the logout failed", () => {
    authStore.setLoggingOut(true);
    applyAuthResultPayload(profileLogin);
    applyLogoutResultPayload({ ok: false, error: "boom", stillLoggedIn: true });
    const snap = authStore.getSnapshot();
    expect(snap.logoutRemaining).toBeNull();
    expect(snap.logoutError).toBe("boom");
    authStore.clearLogoutError();
  });

  it("forgets an unsurfaced remaining login when a new logout starts", () => {
    applyAuthResultPayload(profileLogin);
    applyLogoutResultPayload({ ok: true, error: null, stillLoggedIn: true });
    authStore.setLoggingOut(true);
    expect(authStore.getSnapshot().logoutRemaining).toBeNull();
    authStore.setLoggingOut(false);
  });
});
