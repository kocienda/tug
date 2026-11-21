/**
 * paid-login — the pay-per-token gate's deck half ([B08]).
 *
 * tugcast refuses a `spawn_session` whose session would run on a login that
 * is not the user's subscription until the user has confirmed that login. The
 * refusal is a `spawn_session_error` with detail `paid_login_unconfirmed`,
 * carrying the login it found ({@link PaidLogin}). The deck names that login
 * in the picker's notice; confirming writes its identity to the tugbank key
 * the gate reads per spawn, and Configure Tug revokes it by deleting the key.
 *
 * The identity is the gate's own word for the login — source plus profile and
 * org, or the variable's name — so a different login is a different identity
 * and asks again. Nothing here computes one: the deck stores what the gate
 * sent.
 *
 * @module lib/paid-login
 */

import { getTugbankClient } from "@/lib/tugbank-singleton";
import { deleteDefault } from "@/settings-api";
import type { TaggedValue } from "@/lib/tugbank-client";

/** The tugbank domain and key the gate reads its confirmation from. */
export const PAID_LOGIN_DOMAIN = "dev.tugapp.auth";
export const PAID_LOGIN_CONFIRMED_KEY = "paid_login_confirmed";

/** The refusal's wire reason. */
export const PAID_LOGIN_REASON = "paid_login_unconfirmed";

/** The login a refused session would have run on, as the gate reported it. */
export interface PaidLogin {
  identity: string;
  loginSource:
    | "console_profile"
    | "environment_key"
    | "environment_token"
    | "settings_helper"
    | "unknown";
  apiKeySource: string | null;
  orgName: string | null;
  profileName: string | null;
  /** The project's own settings set the variables this login uses. */
  fromProject: boolean;
}

const SOURCES: readonly PaidLogin["loginSource"][] = [
  "console_profile",
  "environment_key",
  "environment_token",
  "settings_helper",
  "unknown",
];

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Read a refusal's `login` object, or `null` when it is not one. */
export function parsePaidLogin(raw: unknown): PaidLogin | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const identity = str(o.identity);
  if (identity === null) return null;
  const source = SOURCES.find((s) => s === o.loginSource) ?? "unknown";
  return {
    identity,
    loginSource: source,
    apiKeySource: str(o.apiKeySource),
    orgName: str(o.orgName),
    profileName: str(o.profileName),
    fromProject: o.fromProject === true,
  };
}

/** The login named in a sentence's middle — "on …". */
export function paidLoginPhrase(login: PaidLogin): string {
  const where = login.fromProject ? " in this project's Claude Code settings" : "";
  switch (login.loginSource) {
    case "console_profile":
      return login.profileName
        ? `the ant CLI's "${login.profileName}" Console profile`
        : "a Console profile from the ant CLI";
    case "environment_key":
      return `an API key from ${login.apiKeySource ?? "ANTHROPIC_API_KEY"}${where}`;
    case "environment_token":
      return `an auth token from ANTHROPIC_AUTH_TOKEN${where}`;
    case "settings_helper":
      return "an apiKeyHelper in Claude Code's settings";
    case "unknown":
      return "a login Tug can't identify";
  }
}

/** The picker notice's copy for a refused session. */
export function paidLoginNoticeCopy(login: PaidLogin): { title: string; message: string } {
  const org = login.orgName ? ` to ${login.orgName}` : "";
  return {
    title: "This session would be billed per token",
    message: `Claude Code would run it on ${paidLoginPhrase(login)}, not your Claude subscription, and bill it per token${org}. Use this login for sessions, or log in with your subscription in Configure Tug.`,
  };
}

/**
 * Remember `login` as confirmed. Resolves once tugcast has stored it, so a
 * spawn sent after it meets the confirmation rather than racing it.
 */
export async function confirmPaidLogin(login: PaidLogin): Promise<void> {
  const value: TaggedValue = { kind: "string", value: login.identity };
  getTugbankClient()?.setLocalValue(PAID_LOGIN_DOMAIN, PAID_LOGIN_CONFIRMED_KEY, value);
  await fetch(
    `/api/defaults/${PAID_LOGIN_DOMAIN}/${encodeURIComponent(PAID_LOGIN_CONFIRMED_KEY)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    },
  ).catch((err) => {
    console.warn("[paid-login] confirm PUT failed", err);
  });
}

/** Forget the confirmation, so the next session asks again. */
export function revokePaidLogin(): Promise<void> {
  getTugbankClient()?.deleteLocalValue(PAID_LOGIN_DOMAIN, PAID_LOGIN_CONFIRMED_KEY);
  return deleteDefault(PAID_LOGIN_DOMAIN, PAID_LOGIN_CONFIRMED_KEY);
}

/** Parse the stored confirmation for `useTugbankValue`. */
export function parseConfirmedIdentity(entry: TaggedValue | undefined): string | null {
  return entry?.kind === "string" && typeof entry.value === "string" && entry.value !== ""
    ? entry.value
    : null;
}
