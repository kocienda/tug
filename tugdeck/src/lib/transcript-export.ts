/**
 * transcript-export.ts — serialize a session-card transcript to an exportable
 * document ([#step-13c]).
 *
 * `/export` saves the current session's transcript to a file the user picks
 * via the macOS save panel. The export *content* is built here, client-side,
 * from the committed transcript we already hold (the same `TurnEntry[]` the
 * session card renders) — the host bridge only owns the save panel + file write.
 *
 * Two formats, mirroring the terminal's export choices:
 *  - **Markdown** — a readable document: each turn as a `## You` prompt above
 *    the assistant's tool calls + prose — the share serializer
 *    ({@link shareDocumentMarkdown}) over every entry, every tool call in
 *    full, with no header and no scrub: an archive for oneself rather than
 *    something sent, so its bytes are what `/export` has always written.
 *  - **JSON Lines** — one JSON object per transcript Message, in order: a
 *    faithful, machine-readable journal. Every line is independently
 *    `JSON.parse`-able.
 *
 * Pure data transforms — no React, no DOM, no store dependency.
 *
 * @module lib/transcript-export
 */

import type { TurnEntry } from "@/lib/code-session-store/types";
import { resolveSessionIdentity } from "@/lib/session-identity";
import { shareDocumentMarkdown } from "@/lib/share-turns";

/** The export formats `/export` offers. */
export type ExportFormat = "markdown" | "jsonl";

/**
 * Render the whole transcript as a single markdown document: each turn's user
 * prompt under a `## You` heading, followed by the assistant's tool calls +
 * prose under `## Claude`. Turns with no content on a side simply omit that
 * heading; an empty transcript yields a lone title.
 */
export function transcriptToMarkdown(
  transcript: ReadonlyArray<TurnEntry>,
): string {
  return shareDocumentMarkdown({ turns: transcript, toolMode: "full", header: null });
}

/**
 * Render the transcript as JSON Lines: one `JSON.stringify`'d Message per line,
 * in transcript order across every turn. A faithful journal — every Message
 * kind (prompts, prose, thinking, tool calls, system notes) is preserved. The
 * trailing newline keeps the file POSIX-clean. An empty transcript yields `""`.
 */
export function transcriptToJsonl(
  transcript: ReadonlyArray<TurnEntry>,
): string {
  const lines: string[] = [];
  for (const turn of transcript) {
    for (const message of turn.messages) {
      lines.push(JSON.stringify(message));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** File extension for a format. */
export function exportExtension(format: ExportFormat): string {
  return format === "markdown" ? "md" : "jsonl";
}

/**
 * Suggested base filename (no extension) for an export:
 * `tug-session-<callsign>-<shortid>` ([P10]).
 *
 * The callsign leads because a file named after a hash is a file nobody can
 * find again — the short id stays after it so two exports of two sessions never
 * collide, which is the job the hash was doing alone. A legacy session with no
 * callsign degrades to `tug-session-<shortid>`, which is exactly what this
 * produced before.
 *
 * Resolved through the bare resolver rather than the hook: an export is a
 * command, not a render, and there is nothing to keep subscribed.
 */
export function exportBaseName(sessionId: string | null): string {
  if (sessionId === null || sessionId === "") return "tug-session";
  const identity = resolveSessionIdentity(sessionId);
  return identity.tag === null
    ? `tug-session-${identity.shortId}`
    : `tug-session-${identity.tag}-${identity.shortId}`;
}
