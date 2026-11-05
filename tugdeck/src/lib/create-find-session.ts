/**
 * create-find-session — the one way a find surface builds its session.
 *
 * Every find surface seeds the same way: the option toggles come from the
 * deck-wide find preference and persist back to it, and a surface that can
 * replace also starts from the remembered replacement and persists that too.
 * Written once here, so a new surface gets the seeding by naming what it can
 * do rather than by copying a block from a neighbour.
 *
 * A fresh deck with no tugbank client falls back to the session's own
 * defaults: all options off, an empty replacement.
 *
 * @module lib/create-find-session
 */

import { FindSession } from "./find-session";
import type { TugbankClient } from "./tugbank-client";
import { getTugbankClient } from "./tugbank-singleton";
import {
  readFindOptions,
  putFindOptions,
  readFindReplacement,
  putFindReplacement,
} from "@/settings-api";

export interface CreateFindSessionOptions {
  /**
   * Whether the surface can replace. A replace-capable surface seeds the
   * remembered replacement and persists every change to it; one that only
   * finds neither reads nor writes it.
   */
  replace: boolean;
  /** The cache to seed from; the deck's own client unless a caller names one. */
  client?: TugbankClient | null;
}

/** Build a find session seeded from, and persisting to, the deck-wide preference. */
export function createFindSession({
  replace,
  client = getTugbankClient(),
}: CreateFindSessionOptions): FindSession {
  const options = client ? readFindOptions(client) : null;
  if (!replace) {
    return new FindSession(options ?? undefined, { onOptionsChanged: putFindOptions });
  }
  return new FindSession(
    options ?? undefined,
    { onOptionsChanged: putFindOptions, onReplacementChanged: putFindReplacement },
    client ? readFindReplacement(client) : "",
  );
}
