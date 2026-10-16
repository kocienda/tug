/**
 * server-identity — which tugcast this page is talking to, and whether a
 * reconnect found the same one.
 *
 * tugcast mints one `server_id` per process start and sends it on the
 * handshake response, the first thing a page hears after every connect. The
 * page holds the id of the server it is bound to and compares on every
 * reconnect: the same id is a dropped socket to a server that kept running
 * (`same-server`), a different one is a server that restarted
 * (`server-restart`). Bindings the page holds against a restarted server are
 * dead and must be rebuilt; against the same server they are still good.
 *
 * Each `TugConnection` owns one, as `connection.serverIdentity`, and records
 * each handshake in it before it fires the lifecycle's open and reconnect
 * events, so a reconnect handler reads the classification of the reconnect it
 * is handling.
 *
 * A handshake that names no id — a server older than the field, or a test
 * host — classifies as `server-restart`: when the page cannot tell, it takes
 * the path that is right after a restart, which is also right (if costly)
 * after a dropped socket.
 *
 * @module lib/server-identity
 */

import { logSessionLifecycle } from "./session-lifecycle-log";

/** What a reconnect found on the other end of the wire. */
export type ReconnectKind = "same-server" | "server-restart";

/** The `server_id` a parsed handshake response names, or null. */
export function parseHandshakeServerId(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const id = (raw as Record<string, unknown>).server_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Classify a reconnect from the id the page held and the id it just heard.
 * Only two known, equal ids are the same server.
 */
export function classifyReconnect(held: string | null, heard: string | null): ReconnectKind {
  return held !== null && heard !== null && held === heard ? "same-server" : "server-restart";
}

export class ServerIdentity {
  private held: string | null = null;
  private opens = 0;
  private lastKind: ReconnectKind | null = null;

  /**
   * Record the handshake of a connection that just opened. The first open is
   * the page's connect and classifies nothing; every open after it follows a
   * close, so it is a reconnect and is classified against the id held until
   * now. Returns the classification, or null for the first open.
   */
  noteOpen(handshake: unknown): ReconnectKind | null {
    const heard = parseHandshakeServerId(handshake);
    this.opens += 1;
    if (this.opens === 1) {
      this.held = heard;
      this.lastKind = null;
      return null;
    }
    const kind = classifyReconnect(this.held, heard);
    logSessionLifecycle("connection.reconnect_classified", {
      kind,
      held_server_id: this.held,
      heard_server_id: heard,
    });
    this.held = heard;
    this.lastKind = kind;
    return kind;
  }

  /** The id of the server this page is bound to, or null while unknown. */
  serverId(): string | null {
    return this.held;
  }

  /** How the most recent reconnect classified, or null before any. */
  lastReconnect(): ReconnectKind | null {
    return this.lastKind;
  }
}
