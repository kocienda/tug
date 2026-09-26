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
} from "../auth-store";

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
    });
    expect(snap.signInFailed).toBe(false);
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
