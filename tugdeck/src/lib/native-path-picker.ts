/**
 * native-path-picker.ts — request/response client for the macOS host's
 * filesystem picker (`NSOpenPanel`), used by {@link TugFileChooser}'s
 * "Browse…" button.
 *
 * The Tug.app host exposes a `choosePath` `WKScriptMessageHandler`. We post
 * `{ id, kind, initialPath }`; the host opens an open-panel (directories or
 * files per `kind`) and calls back
 * `window.__tugBridge.onPathChosen({ id, path, paths })` — the first path
 * chosen (`null` on cancel) and every path chosen (empty on cancel; more than
 * one only for `insert`, whose panel allows a multiple selection). Each call
 * carries a unique id so concurrent pickers don't cross wires.
 *
 * Graceful degradation: outside the host (dev browser, or before the app is
 * rebuilt with the handler) {@link isPathPickerAvailable} is `false` and
 * {@link pickPath} resolves `null`, so callers can hide the affordance.
 *
 * @module lib/native-path-picker
 */

import { hostAvailable, onHostMessage, postToHost } from "../host/channel";
import { choosePathToHost, pathChosenToPage } from "../host/declarations/services";

/**
 * What the picker selects. `directory` / `file` run an NSOpenPanel;
 * `save` runs an NSSavePanel choosing a NEW file path (Move To… /
 * Save As… — the web layer performs the actual write). `file` is
 * restricted to text types; `insert` is Session ▸ Insert File…'s panel,
 * which takes any files, several at once.
 */
export type PathPickerKind = "directory" | "file" | "save" | "insert";

/** Resolvers awaiting a native callback, keyed by request id. */
const pending = new Map<string, (paths: string[]) => void>();

/** Monotonic request-id counter (no Date/random — resume-safe and unique enough). */
let nextId = 0;

let receiving = false;

/** Take `__tugBridge.onPathChosen({id, path})` in this page, once. */
function ensureBridge(): void {
  if (receiving) return;
  receiving = true;
  onHostMessage(pathChosenToPage, ({ id, paths }) => {
    const resolve = pending.get(id);
    if (resolve !== undefined) {
      pending.delete(id);
      resolve(paths);
    }
  });
}

/** Whether the native picker is reachable (running inside Tug.app). */
export function isPathPickerAvailable(): boolean {
  return hostAvailable(choosePathToHost);
}

/**
 * Open the host's picker for `kind`, resolving the chosen absolute path, or
 * `null` on cancel / when the picker is unavailable. `initialPath` hints the
 * panel's starting directory; `suggestedName` pre-fills a `save` panel's
 * filename field (e.g. an untitled buffer's "Untitled-2").
 */
export function pickPath(
  kind: PathPickerKind,
  initialPath?: string,
  suggestedName?: string,
): Promise<string | null> {
  return pickPaths(kind, initialPath, suggestedName).then(
    (paths) => paths[0] ?? null,
  );
}

/**
 * Open the host's picker for `kind`, resolving every path chosen in the
 * panel's order — empty on cancel or when the picker is unavailable. Only
 * `insert` lets the panel choose more than one.
 */
export function pickPaths(
  kind: PathPickerKind,
  initialPath?: string,
  suggestedName?: string,
): Promise<string[]> {
  if (!hostAvailable(choosePathToHost)) return Promise.resolve([]);
  ensureBridge();
  const id = `path-${(nextId += 1)}`;
  return new Promise<string[]>((resolve) => {
    pending.set(id, resolve);
    postToHost(choosePathToHost, {
      id,
      kind,
      initialPath: initialPath ?? null,
      suggestedName: suggestedName ?? null,
    });
  });
}
