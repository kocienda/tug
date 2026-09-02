/**
 * `SessionArcNoteBlock` — a dash run's quiet lines on the `$`-route, the
 * rows the server derives from the dash-log ([P12]). The row's command is
 * *rendered from the record* by tugcast's `command_for_line` (`dash step
 * <name> done`, `dash create <name>`, `dash mark <name> built`, `dash commit
 * <name>`), never echoed from an invocation, so the bare `dash` head is the
 * synthetic tell: a command a user actually typed spells `tugtool arc …`.
 *
 * This renderer is the **between-turns seat** — the restore path's ledger
 * replay, and a live note that arrived with no turn open (a hand-run verb, a
 * run-start line between stages). A note arriving mid-turn never comes here:
 * `handleDashNote` seats it inside the open turn as a `source: "dash"`
 * system_note, and the transcript renders it there on the same
 * `TugQuietLine` substrate — one visual register, two seats.
 *
 * A quiet line is one sentence and renders as one: the wheel's glyph, the
 * muted sentence, nothing else. No participant header, no command block, no
 * output panel, no exit badge — nothing was typed here and no process ran on
 * this card, so every piece of exchange chrome would be announcing something
 * false. The registration says so (`presentation: "quiet"`), and
 * `ShellTurnCell` renders the claimed row without the entry scaffolding. The
 * synthetic command and the gesture's wall-clock survive as the hover title.
 */
import type React from "react";
import { ShipWheel } from "lucide-react";

import { TugQuietLine } from "@/components/tugways/tug-quiet-line";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import { arcNoteSentence, matchesArcNote } from "@/lib/arc-note-command";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
import { formatTranscriptTimestamp } from "./transcript-host-helpers";
import "./session-arc-note-block.css";

export { matchesArcNote };

export function SessionArcNoteBlock({ message }: CommandBlockProps): React.ReactElement {
  const timestamp = formatTranscriptTimestamp(message.startedAtMs);
  return (
    <div
      className="session-dash-note-line"
      data-slot="session-dash-note-line"
      title={timestamp !== "" ? `${timestamp} · ${message.command}` : message.command}
    >
      <TugQuietLine
        icon={<ShipWheel size={16} aria-hidden="true" />}
        subject={<span data-tugx-findable="">{arcNoteSentence(message)}</span>}
        tone="quiet"
      />
    </div>
  );
}

/**
 * The line's searchable text: exactly the sentence on screen — the one
 * container the renderer marks findable. The synthetic command is only a
 * hover title, and a projection the painter cannot reach is a find that
 * counts matches it can never flash.
 */
export function arcNoteFindParts(message: ShellExchangeMessage): string[] {
  return [arcNoteSentence(message)];
}

// Registration is a side effect of importing this module — the import sits
// beside the receipt blocks' in `session-card-transcript.tsx`.
registerCommandBlock("dash-note", matchesArcNote, SessionArcNoteBlock, {
  attribution: "wheel",
  presentation: "quiet",
  findParts: arcNoteFindParts,
});
