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
import { authStore, applyAuthResultPayload } from "../auth-store";

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
