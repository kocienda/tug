/**
 * `dev-log-port` — the one logging door for code that may run in the ingest
 * Worker.
 *
 * `tugDevLogStore` and `logSessionLifecycle` are main-thread singletons: the
 * store imports the connection and tugbank singletons, and the lifecycle log
 * imports the deck trace. Loaded into the Worker they would not fail; each
 * would quietly become a second, unread copy. So Worker-safe code logs here
 * instead, and this module imports nothing.
 *
 * Each call goes to whatever sink is installed. The main thread installs one
 * that delegates to the two stores, looking the method up at call time so a
 * test that reassigns `tugDevLogStore.warn` still sees the call. The Worker
 * installs one that turns each call into a `log` patch, which the page
 * replays into the same stores. With no sink installed, a call does nothing.
 */

export type DevLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Where a port call goes. The two halves install independently, so each is
 * installed by the module that already owns its store: `connection.ts`
 * installs `log`, and the session store installs `lifecycle`.
 */
export interface DevLogSink {
  log?(level: DevLogLevel, source: string, message: string, data?: unknown): void;
  lifecycle?(tag: string, fields: Record<string, unknown>): void;
}

let sink: DevLogSink = {};

/** Install the halves `next` names over the current sink; returns a release that restores them. */
export function installDevLogSink(next: DevLogSink): () => void {
  const previous = sink;
  sink = { ...sink, ...next };
  return () => {
    sink = previous;
  };
}

/** `tugDevLogStore`'s four methods, through the installed sink. */
export const devLog = {
  debug(source: string, message: string, data?: unknown): void {
    sink.log?.("debug", source, message, data);
  },
  info(source: string, message: string, data?: unknown): void {
    sink.log?.("info", source, message, data);
  },
  warn(source: string, message: string, data?: unknown): void {
    sink.log?.("warn", source, message, data);
  },
  error(source: string, message: string, data?: unknown): void {
    sink.log?.("error", source, message, data);
  },
};

/** `logSessionLifecycle`, through the installed sink. */
export function lifecycleLog(tag: string, fields: Record<string, unknown>): void {
  sink.lifecycle?.(tag, fields);
}
