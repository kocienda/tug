/**
 * landing-press-receipt — one durable line per land press ([L31]).
 *
 * The arc-join hunt turned on a single backend log line; without it there was
 * nothing to read at all. The deck's own dev log cannot fill that role, because
 * it dies with a reload and the incident that motivated this *contained* a
 * reload. tugcast's log is the only durable record an instance keeps, so every
 * land press — accepted or refused — sends it one.
 *
 * The receipt carries the same gate-input object the gate judged, so the line
 * and the sentence beside it cannot disagree, and it carries the message's
 * *length* rather than its text: a landing draft is the user's writing and does
 * not belong in a log.
 *
 * Fire-and-forget by design. A receipt that could fail loudly would be a
 * diagnostic with a failure mode of its own; with no connection it degrades to
 * the dev-log line, and that degradation is itself written down.
 *
 * Distinct from `landing-receipt.ts`, which parses the `Tug-Dash:` trailer a
 * landed commit carries. That describes a landing that happened; this describes
 * the press that asked for one.
 *
 * @module lib/landing-press-receipt
 */

import { getConnection } from "@/lib/connection-singleton";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

import type { LandingKind } from "@/lib/landing-mode";

export interface LandingPressReceipt {
  /** Which landing was pressed. */
  kind: LandingKind;
  /** `ok` when the gate passed; `refused` otherwise. */
  verdict: "ok" | "refused";
  /** The gate's failing reason, or the fault marker, when refused. */
  reason?: string;
  /** The sentence the user was shown, when refused. */
  sentence?: string;
  /** The gate's inputs, message text excluded (`*GateFacts`). */
  gate: Record<string, unknown>;
}

export function sendLandingReceipt(receipt: LandingPressReceipt): void {
  const connection = getConnection();
  if (connection === null) {
    tugDevLogStore.warn("landing", "landing receipt not sent — no connection", receipt);
    return;
  }
  // A record of a landing must never be able to break the landing. A transport
  // that is closing, or has been torn down under this call, would otherwise
  // throw straight through the land path and take the user's press with it —
  // the diagnostic destroying the act it exists to describe.
  try {
    connection.sendControlFrame("landing_receipt", { ...receipt });
  } catch (err) {
    tugDevLogStore.warn("landing", "landing receipt not sent — transport refused", {
      ...receipt,
      error: String(err),
    });
  }
}
