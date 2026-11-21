/**
 * paid-login — the deck half of the pay-per-token gate ([B08]).
 *
 * A `spawn_session_error` with detail `paid_login_unconfirmed` carries the
 * login the gate found. These pin what the deck reads off it, how the picker
 * names it, and that the refusal reaches the card's spawn-error store with
 * the login attached, which is what the picker's confirm reads.
 */

import { describe, expect, test } from "bun:test";
import {
  PAID_LOGIN_REASON,
  paidLoginNoticeCopy,
  paidLoginPhrase,
  parseConfirmedIdentity,
  parsePaidLogin,
} from "../paid-login";
import { noticeContent } from "@/components/tugways/cards/session-picker-notice-content";
import { getRegistryHandler } from "../../action-registry";
import { registerSessionControlActions } from "../session-control-actions";
import { sessionSpawnErrorStore, spawnErrorMessage } from "../session-spawn-error-store";

const PROFILE_WIRE = {
  identity: "console_profile:default:org-1",
  loginSource: "console_profile",
  apiKeySource: null,
  orgName: "Example Org",
  profileName: "default",
  fromProject: false,
};

describe("paid-login: reading the refusal", () => {
  test("reads the login the gate sent", () => {
    expect(parsePaidLogin(PROFILE_WIRE)).toEqual({
      identity: "console_profile:default:org-1",
      loginSource: "console_profile",
      apiKeySource: null,
      orgName: "Example Org",
      profileName: "default",
      fromProject: false,
    });
  });

  test("a login with no identity is not one, and an unknown source reads as unknown", () => {
    expect(parsePaidLogin({ ...PROFILE_WIRE, identity: "" })).toBeNull();
    expect(parsePaidLogin(null)).toBeNull();
    expect(parsePaidLogin("x")).toBeNull();
    expect(parsePaidLogin({ ...PROFILE_WIRE, loginSource: "martian" })?.loginSource).toBe("unknown");
  });

  test("a stored confirmation is a non-empty string", () => {
    expect(parseConfirmedIdentity({ kind: "string", value: "environment_token" })).toBe(
      "environment_token",
    );
    expect(parseConfirmedIdentity({ kind: "string", value: "" })).toBeNull();
    expect(parseConfirmedIdentity(undefined)).toBeNull();
  });
});

describe("paid-login: naming the login", () => {
  test("names a profile and the org it bills", () => {
    const login = parsePaidLogin(PROFILE_WIRE)!;
    expect(paidLoginNoticeCopy(login)).toEqual({
      title: "This session would be billed per token",
      message: `Claude Code would run it on the ant CLI's "default" Console profile, not your Claude subscription, and bill it per token to Example Org. Use this login for sessions, or log in with your subscription in Configure Tug.`,
    });
  });

  test("says when the project's own settings set the key", () => {
    const login = parsePaidLogin({
      identity: "environment_key:ANTHROPIC_API_KEY",
      loginSource: "environment_key",
      apiKeySource: "ANTHROPIC_API_KEY",
      fromProject: true,
    })!;
    expect(paidLoginPhrase(login)).toBe(
      "an API key from ANTHROPIC_API_KEY in this project's Claude Code settings",
    );
  });

  test("the picker notice names it, and has copy without one", () => {
    const login = parsePaidLogin(PROFILE_WIRE)!;
    const named = noticeContent({ category: "paid_login", message: "m", login });
    expect(named.title).toBe("This session would be billed per token");
    expect(named.message).toContain(`"default" Console profile`);
    expect(named.tone).toBe("caution");
    const bare = noticeContent({ category: "paid_login", message: spawnErrorMessage(PAID_LOGIN_REASON) });
    expect(bare.message).toBe(
      "This session would be billed per token, not to your Claude subscription.",
    );
  });
});

describe("paid-login: the refusal reaches the card", () => {
  test("a spawn_session_error carries its login into the spawn-error store", () => {
    registerSessionControlActions();
    const handler = getRegistryHandler("spawn_session_error");
    expect(handler).toBeDefined();
    handler!({ card_id: "card-paid", detail: PAID_LOGIN_REASON, login: PROFILE_WIRE });
    const error = sessionSpawnErrorStore.get("card-paid");
    expect(error?.reason).toBe(PAID_LOGIN_REASON);
    expect(error?.login?.identity).toBe("console_profile:default:org-1");
    sessionSpawnErrorStore.clear("card-paid");

    handler!({ card_id: "card-other", detail: "does_not_exist" });
    expect(sessionSpawnErrorStore.get("card-other")?.login).toBeNull();
    sessionSpawnErrorStore.clear("card-other");
  });
});
