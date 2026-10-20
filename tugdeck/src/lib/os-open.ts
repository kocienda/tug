/**
 * os-open.ts — hand a filesystem path to the macOS host to open ([#step-12a]).
 *
 * The Tug.app host registers an `openPath` `WKScriptMessageHandler`
 * (`MainWindow.swift`) that expands a leading `~` and routes the path through
 * `NSWorkspace` by `kind`: a `"file"` opens in its default editor (created
 * with its parent dirs if absent, so a not-yet-written memory file still opens
 * to edit), and a `"folder"` opens in Finder (or reveals its parent if
 * missing — never auto-created). This is the web → host half: `/memory` calls
 * it to open a memory file / folder in the OS, since editing happens in the OS
 * app (no in-app editor, no write-back).
 *
 * Outside the host (browser dev / tests) the `webkit` bridge is absent and
 * this no-ops after a debug log — the caller needs no capability check.
 *
 * @module lib/os-open
 */

import { hostAvailable, postToHost } from "../host/channel";
import { openPathToHost } from "../host/declarations/services";

/**
 * How the host opens `path`: `file` opens it in the default editor,
 * `folder` opens it in Finder, `reveal` opens Finder with the file
 * selected (highlighted) inside its containing folder.
 */
export type OsOpenKind = "file" | "folder" | "reveal";

/**
 * Ask the host to open `path` in the OS. `path` may be absolute or
 * `~`-relative (the host expands the tilde — the web layer has no home dir).
 * `kind` decides routing: a `file` opens in the default editor (created if
 * absent), a `folder` opens in Finder. No-op when the host bridge is
 * unavailable.
 */
export function openPathInOS(path: string, kind: OsOpenKind = "file"): void {
  if (hostAvailable(openPathToHost)) {
    postToHost(openPathToHost, { path, kind });
  } else {
    console.info(`os-open: host bridge unavailable, cannot open ${path}`);
  }
}

/**
 * Open an external URL in the user's default browser. WKWebView has no place
 * to put a second window, so a `window.open` for an http(s) URL is caught by
 * the host's `createWebViewWith` delegate (`MainWindow.swift`) and routed to
 * `NSWorkspace.shared.open` — the link lands in the system browser, never
 * inside the Session card. Outside the host (browser dev / tests) `window.open`
 * opens an ordinary tab. The `noopener` feature keeps the opened page from
 * reaching back into `window.opener`.
 */
/**
 * Show a file in the Finder — the folder open *and the file selected*, which
 * is what "reveal" means everywhere else on the system. Reveal a screenshot in
 * a folder of screenshots and merely opening the folder leaves the user to
 * find it again by name.
 *
 * The `reveal` kind is the host's `activateFileViewerSelecting`, and it falls
 * back to the deepest existing ancestor when the file is gone — which is the
 * right answer for a link to a file that used to be there.
 *
 * Shared by every surface that offers Show in Finder — the deck-level
 * chain handler and the transcript's file annotations — so they cannot
 * drift on what "reveal" means.
 */
export function revealPathInFinder(path: string): void {
  openPathInOS(path === "" ? "/" : path, "reveal");
}

/**
 * Show a directory in the Finder — the directory itself, opened, rather
 * than its parent with the directory selected. Distinct from
 * {@link revealPathInFinder}, which reveals a *file* and so must open the
 * folder containing it; here the target already is the folder.
 */
export function revealDirectoryInFinder(path: string): void {
  openPathInOS(path === "" ? "/" : path, "folder");
}

export function openUrlInOS(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
