/**
 * arc-note-command.ts — the one reading of an arc-note row's synthetic
 * command, shared by the layers that must agree on it.
 *
 * An arc gesture's quiet line ([P12]) rides the shell ledger as a row whose
 * command is *rendered from the record* by tugcast's `command_for_line`
 * (`arc step <name> done`, `arc create <name>`, `arc mark <name> built`,
 * `arc commit <name>`) — never echoed from an invocation, so the bare verb
 * head is the synthetic tell: a command a user actually typed spells
 * `tugtool arc …`.
 *
 * **Both heads.** The shell ledger is durable and every row written before
 * the word moved carries `arc …` ([F19]); a matcher that claimed only the
 * new head would turn each of those back into an ordinary shell entry — full
 * row, address badge, exit end-state — in a transcript that had rendered it
 * as a quiet line. Nothing writes the retired head any more.
 *
 * Two layers read that tell and must never drift: the command-block registry
 * (`session-arc-note-block.tsx`, which claims the row for quiet rendering)
 * and the transcript absorption pass (`absorbArcNotes` in the
 * code-session-store reducer, which re-seats a restored row inside the turn
 * it narrated). One regex, imported by both.
 *
 * **One gesture reaches the grammar without reaching the matcher.** An arc's
 * finish already has a row — the `/arc-run` receipt tugcast writes from the
 * record — so `note_for_line` deliberately paints no quiet line for it, and a
 * second one would be the doubling this whole report exists to end ([F09]).
 * What changed is the shape that row takes: on the `complete` outcome
 * `SessionArcReceiptBlock` renders the quiet line itself ([B04]), and it
 * composes `arc done <name>` to read the gesture out of this one grammar
 * rather than spelling `Finished · N stages` a second time. So `arc done` is
 * a gesture {@link arcNoteParts} knows and {@link ARC_NOTE_COMMAND} does not
 * claim: nothing writes that command to the shell ledger.
 */

export const ARC_NOTE_COMMAND = /^(arc|dash) (create|step|mark|commit)\s+\S+/;

/** Whether a shell-ledger command is an arc gesture's synthetic quiet line. */
export function matchesArcNote(command: string): boolean {
  return ARC_NOTE_COMMAND.test(command);
}

/**
 * The line's sentence: the server-derived output (`note_for_line`), or the
 * synthetic command for a row old enough to carry none.
 */
export function arcNoteSentence(message: { command: string; output: string }): string {
  const trimmed = message.output.trim();
  return trimmed !== "" ? trimmed : message.command;
}

/**
 * The glyph an arc gesture takes, named rather than imported ([B04]).
 *
 * This module is pure — it is read by the store layer as well as the row, so
 * it must not pull React or `lucide-react` in. The renderer maps these names
 * to components; the mapping here is the decision about *which* shape a
 * gesture wears, and state is carried by shape rather than by hue.
 */
export type ArcNoteGlyph =
  | "Wrench"
  | "CircleCheck"
  | "CircleMinus"
  | "RotateCcw"
  | "Undo2"
  | "GitCommitHorizontal"
  | "ListChecks"
  | "ShipWheel";

/**
 * The parts one arc-note row renders: three weights left to right, plus the
 * shape ([B01], [B03]).
 *
 * `name` is present whenever the *command* read, `label` whenever the
 * sentence read too — so a recognised gesture whose sentence did not parse
 * keeps its name and its shape and carries the sentence whole in `subject`,
 * and a command this module does not recognise renders today's shape, the
 * whole sentence under the wheel with neither. Never a blank row, and never
 * a row that has silently dropped text the server sent.
 */
export interface ArcNoteParts {
  /** The arc's name, its own quiet run at the head of the label node. */
  name: string | null;
  /** The bold verb. */
  label: string | null;
  /** The muted tail: a step's title, a round's sha, the instruction. */
  subject: string | null;
  glyph: ArcNoteGlyph;
}

/** What a recognised command says the gesture was. */
type ArcGesture =
  | "created"
  | "run-through"
  | "step-start"
  | "step-done"
  | "step-withdrawn"
  | "step-reset"
  | "step-reopen"
  | "built"
  | "audited"
  | "finished"
  | "round";

const GLYPHS: Record<ArcGesture, ArcNoteGlyph> = {
  created: "ShipWheel",
  "run-through": "ListChecks",
  "step-start": "Wrench",
  "step-done": "CircleCheck",
  "step-withdrawn": "CircleMinus",
  "step-reset": "RotateCcw",
  "step-reopen": "Undo2",
  built: "ShipWheel",
  audited: "ShipWheel",
  finished: "ShipWheel",
  round: "GitCommitHorizontal",
};

/**
 * Which gesture a synthetic command names, and the arc it names it for.
 *
 * The command is the marker ([F05]): tugcast renders it from the record in
 * `command_for_line`, one-to-one with the marker `note_for_line` composed the
 * sentence from. So the gesture is read here and never parsed back out of the
 * rendered prose — a sentence is the server's output, and re-reading it would
 * be the wrong direction.
 *
 * Both heads are claimed for the same reason the matcher claims both: the
 * shell ledger is durable and rows written before the word moved carry
 * `dash …` ([F19]).
 */
function readCommand(command: string): { gesture: ArcGesture; name: string } | null {
  const tokens = command.trim().split(/\s+/);
  const [head, verb, name, sub, flag] = tokens;
  if (head !== "arc" && head !== "dash") return null;
  if (!name) return null;
  switch (verb) {
    case "create":
      return { gesture: "created", name };
    case "done":
      return { gesture: "finished", name };
    case "commit":
      return { gesture: "round", name };
    case "mark":
      return sub === "built" || sub === "audited" ? { gesture: sub, name } : null;
    case "step":
      switch (sub) {
        case "start":
          return { gesture: flag === "--through" ? "run-through" : "step-start", name };
        case "done":
          return { gesture: "step-done", name };
        case "withdraw":
          return { gesture: "step-withdrawn", name };
        case "reset":
          return { gesture: "step-reset", name };
        case "reopen":
          return { gesture: "step-reopen", name };
        default:
          return null;
      }
    default:
      return null;
  }
}

/**
 * The sentence with its `{arc}: ` prefix taken off, and its ` — ` tail split
 * away.
 *
 * `note_for_line` prefixes the arc's name to every sentence it composes
 * ([F07]) and joins a tail with an em dash. The prefix is stripped against
 * the name the *command* carried rather than against the first colon in the
 * sentence, so a round whose instruction contains a colon is never cut at the
 * wrong place.
 */
function readSentence(
  sentence: string,
  name: string,
): { head: string; tail: string | null; rest: string } {
  const trimmed = sentence.trim();
  const prefix = `${name}: `;
  const rest = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  const at = rest.indexOf(" — ");
  return at === -1
    ? { head: rest, tail: null, rest }
    : { head: rest.slice(0, at), tail: rest.slice(at + 3) || null, rest };
}

/** The `N/M` a step sentence opens with, when it reads. */
function readFraction(head: string): string | null {
  return /^step (\d+\/\d+)\b/.exec(head)?.[1] ?? null;
}

/**
 * The parts an arc-note row renders, from its synthetic command and the
 * server's sentence ([B01]).
 *
 * The command decides the gesture and the glyph; the sentence supplies the
 * tail, which is the only thing the command cannot carry — a step's title, a
 * round's sha, the verbatim instruction. A command this does not recognise,
 * and a sentence that does not read the way its command says it should, both
 * degrade to today's shape rather than to a blank row.
 */
export function arcNoteParts(command: string, sentence: string): ArcNoteParts {
  const read = readCommand(command);
  const whole = sentence.trim();
  if (!read) return { name: null, label: null, subject: whole || null, glyph: "ShipWheel" };

  const { gesture, name } = read;
  const glyph = GLYPHS[gesture];
  const { head, tail, rest } = readSentence(whole, name);
  /**
   * A sentence that did not read: keep the name and the gesture's shape, and
   * show the sentence WHOLE — `rest`, not `head`. The split into head and
   * tail is only meaningful once the sentence has read the way its command
   * says it should; on this path it has not, so honouring it would drop
   * everything past the em dash on exactly the rows least understood.
   */
  const unread: ArcNoteParts = { name, label: null, subject: rest || null, glyph };

  switch (gesture) {
    case "created":
      return { name, label: "Arc opened", subject: null, glyph };
    case "finished": {
      // `Finished · N stages` is one label rather than a label and a subject:
      // it is the event, not a detail under one, so it keeps the register's
      // own semibold whole ([B09]).
      const stages = /^finished · (.+)$/.exec(head)?.[1];
      return stages ? { name, label: `Finished · ${stages}`, subject: null, glyph } : unread;
    }
    case "built":
    case "audited":
      return { name, label: `Marked ${gesture}`, subject: null, glyph };
    case "run-through": {
      const through = /^run declared (.+)$/.exec(head)?.[1];
      return through ? { name, label: "Run declared", subject: through, glyph } : unread;
    }
    case "round": {
      const sha = /^round ([0-9a-f]+)$/.exec(head)?.[1];
      return sha ? { name, label: `Round ${sha}`, subject: tail, glyph } : unread;
    }
    default: {
      const fraction = readFraction(head);
      if (!fraction) return unread;
      // A done's tail is its round's sha, and the sentence parenthesises it.
      if (gesture === "step-done") {
        return {
          name,
          label: `Step ${fraction} closed`,
          subject: /\(([^)]+)\)$/.exec(head)?.[1] ?? null,
          glyph,
        };
      }
      const WORD: Record<string, string> = {
        "step-start": "",
        "step-withdrawn": " withdrawn",
        "step-reset": " parked",
        "step-reopen": " reopened",
      };
      return { name, label: `Step ${fraction}${WORD[gesture]}`, subject: tail, glyph };
    }
  }
}
