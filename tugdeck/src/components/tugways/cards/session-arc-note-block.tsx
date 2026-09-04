/**
 * `SessionArcNoteBlock` — an arc run's quiet lines on the `$`-route, the
 * rows the server derives from the arc-log ([P12]). The row's command is
 * *rendered from the record* by tugcast's `command_for_line` (`arc step
 * <name> done`, `arc create <name>`, `arc mark <name> built`, `arc commit
 * <name>`), never echoed from an invocation, so the bare `arc` head is the
 * synthetic tell: a command a user actually typed spells `tugtool arc …`.
 *
 * This renderer is the **between-turns seat** — the restore path's ledger
 * replay, and a live note that arrived with no turn open (a hand-run verb, a
 * run-start line between stages). A note arriving mid-turn never comes here:
 * `handleArcNote` seats it inside the open turn as a `source: "arc"`
 * system_note, and the transcript renders it there on the same
 * `TugQuietLine` substrate — one visual register, two seats.
 *
 * {@link ArcNoteLine} is the row itself, and **both seats mount it** ([B06]):
 * with five moving parts — a name, a verb, a subject, a glyph and a fallback
 * — two hand-kept spellings would drift, and the drift would be invisible
 * because each seat is reached by a different path. The block below is the
 * between-turns seat's thin wrapper around it.
 *
 * A quiet line is one gesture and renders as one, in the Task step's own
 * grammar ([B01]): the arc's name as a quiet run, the gesture as a bold verb,
 * the detail muted after it, and the gesture's shape in the glyph slot — read
 * from the synthetic command, never parsed back out of the sentence. No
 * participant header, no command block, no output panel, no exit badge —
 * nothing was typed here and no process ran on this card, so every piece of
 * exchange chrome would be announcing something false. The registration says
 * so (`presentation: "quiet"`), and `ShellTurnCell` renders the claimed row
 * without the entry scaffolding. The synthetic command and the gesture's
 * wall-clock survive as the hover title.
 */
import type React from "react";
import {
  CircleCheck,
  CircleMinus,
  GitCommitHorizontal,
  ListChecks,
  RotateCcw,
  ShipWheel,
  Undo2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { TugQuietLine } from "@/components/tugways/tug-quiet-line";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import {
  arcNoteParts,
  arcNoteSentence,
  matchesArcNote,
  type ArcNoteGlyph,
} from "@/lib/arc-note-command";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
import { formatTranscriptTimestamp } from "./transcript-host-helpers";
import "./session-arc-note-block.css";

export { matchesArcNote };

/**
 * The shapes, resolved. `arcNoteParts` names a glyph rather than importing
 * one — it is read by the store layer too, and a pure module must not pull
 * React in — so this is where the name becomes a component.
 */
const GLYPHS: Record<ArcNoteGlyph, LucideIcon> = {
  Wrench,
  CircleCheck,
  CircleMinus,
  RotateCcw,
  Undo2,
  GitCommitHorizontal,
  ListChecks,
  ShipWheel,
};

export interface ArcNoteLineProps {
  /**
   * The gesture's synthetic command — the marker the verb and the glyph are
   * read from. `undefined` on a note restored from before the mid-turn seat
   * carried one ([B02]); the row then takes the fallback shape.
   */
  command: string | undefined;
  /** The server-derived sentence. */
  sentence: string;
  /** The gesture's wall-clock, for the hover title. */
  atMs: number;
  /** The seat's own wrapper class — each seat owns its rhythm and inset. */
  className: string;
  /** The seat's own `data-slot`. */
  slot: string;
}

/**
 * One arc gesture's row, mounted by both seats ([B06]).
 *
 * Three weights run left to right ([B03]): the arc's name as a quiet run at
 * the head of the label node, the bold verb after it, then the muted subject.
 * The name stays on every row because a transcript is scrollback read out of
 * order, and a `$`-route row is the one place the arc's record speaks with no
 * header on it — "which arc" is the first thing a reader landing mid-run
 * needs. The icon is the gesture's own shape and stays muted: state by shape,
 * not by hue, which is the precedent's argument and holds harder here, since
 * one run makes dozens of these.
 *
 * Two findable units, and they wrap exactly the text on screen: the label
 * node and the subject. `arcNoteFindParts` projects the same two, in the same
 * DOM order and with the same bytes — a projection the painter cannot reach
 * is a find that counts matches it can never flash.
 */
export function ArcNoteLine({
  command,
  sentence,
  atMs,
  className,
  slot,
}: ArcNoteLineProps): React.ReactElement {
  const { name, label, subject, glyph } = arcNoteParts(command ?? "", sentence);
  const Glyph = GLYPHS[glyph];
  // The name run stands whether or not a verb reads beside it ([B03]: the
  // arc's name is on EVERY row). Gating it on the label would take the name
  // off exactly the rows whose sentence this module could not parse — the
  // ones where "which arc" is hardest to recover from what is left.
  const head =
    name !== null || label !== null ? (
      <span className="session-arc-note-label" data-tugx-findable="">
        {name !== null ? <span className="session-arc-note-name">{name}</span> : null}
        {name !== null && label !== null ? " " : null}
        {label}
      </span>
    ) : undefined;
  const title = [formatTranscriptTimestamp(atMs), command ?? ""]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <div className={className} data-slot={slot} title={title !== "" ? title : undefined}>
      <TugQuietLine
        icon={<Glyph size={16} aria-hidden="true" />}
        label={head}
        subject={
          subject !== null ? <span data-tugx-findable="">{subject}</span> : undefined
        }
        tone="primary"
      />
    </div>
  );
}

export function SessionArcNoteBlock({ message }: CommandBlockProps): React.ReactElement {
  return (
    <ArcNoteLine
      command={message.command}
      sentence={arcNoteSentence(message)}
      atMs={message.startedAtMs}
      className="session-arc-note-line"
      slot="session-arc-note-line"
    />
  );
}

/**
 * The line's searchable text: exactly what is on screen, in DOM order — the
 * label node (the name and the verb, one space between them, as the row
 * renders them) and then the subject. The synthetic command is only a hover
 * title, and a projection the painter cannot reach is a find that counts
 * matches it can never flash.
 */
export function arcNoteFindParts(message: ShellExchangeMessage): string[] {
  const { name, label, subject } = arcNoteParts(
    message.command,
    arcNoteSentence(message),
  );
  const parts: string[] = [];
  const head = [name, label].filter((part) => part !== null).join(" ");
  if (head !== "") parts.push(head);
  if (subject !== null) parts.push(subject);
  return parts;
}

// Registration is a side effect of importing this module — the import sits
// beside the receipt blocks' in `session-card-transcript.tsx`.
registerCommandBlock("arc-note", matchesArcNote, SessionArcNoteBlock, {
  attribution: "wheel",
  presentation: "quiet",
  findParts: arcNoteFindParts,
});
