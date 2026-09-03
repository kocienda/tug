/**
 * `SessionNoticeBlock` — a notice from Tug that arrived with no turn open, on
 * the `$`-route ([P08]).
 *
 * This is the **between-turns seat**, the same arrangement `arc-note` has: a
 * notice that lands mid-turn is seated inside the open turn by
 * `handleStandaloneNotice` and rendered there as a `source: "notice"` system
 * note, while one that lands at idle becomes an ink turn of its own and
 * arrives here. Both render {@link SessionNoticeLine} — one visual register,
 * two seats.
 *
 * The row's command is synthetic: `tug notice <origin>`, minted by the reducer
 * rather than echoed from anything anybody typed. Nothing ran on this card, so
 * the registration says `presentation: "quiet"` and `ShellTurnCell` renders it
 * without exchange chrome — no participant header, no command block, no exit
 * badge. The attribution is `"tug"`, which is neither the user nor the model
 * nor the wheel: it is the app itself, which is the whole point of the row.
 */
import type React from "react";

import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
import { SessionNoticeLine } from "./session-notice-line";
import { formatTranscriptTimestamp } from "./transcript-host-helpers";

/** The synthetic head the reducer mints — never a command a user could type. */
export function matchesTugNotice(command: string): boolean {
  return /^tug notice\b/.test(command.trim());
}

/**
 * The origin is the command's third word, which is where the reducer put it.
 * A command with nothing there still renders — the row is Tug's either way,
 * and losing the label is a worse answer than losing the notice.
 */
function originOf(command: string): string {
  return command.trim().split(/\s+/)[2] ?? "tug";
}

export function SessionNoticeBlock({
  message,
}: CommandBlockProps): React.ReactElement {
  const timestamp = formatTranscriptTimestamp(message.startedAtMs);
  return (
    <SessionNoticeLine
      origin={originOf(message.command)}
      text={message.output}
      title={timestamp !== "" ? `${timestamp} · ${message.command}` : undefined}
    />
  );
}

/**
 * The searchable text is the notice itself. The synthetic command is a hover
 * title and nothing the painter can flash, so projecting it would count
 * matches the find can never reach.
 */
export function tugNoticeFindParts(message: ShellExchangeMessage): string[] {
  return [message.output];
}

// Registration is a side effect of importing this module — the import sits
// beside `session-arc-note-block`'s in `session-card-transcript.tsx`.
registerCommandBlock("tug-notice", matchesTugNotice, SessionNoticeBlock, {
  attribution: "tug",
  presentation: "quiet",
  findParts: tugNoticeFindParts,
});
