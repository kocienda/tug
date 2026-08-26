/**
 * command-atom — helpers for the slash-command atom: how its value
 * becomes the wire string claude expands, and how it reads in a chip.
 *
 * ## Why a command atom is special
 *
 * Accepting a `/` completion inserts an `AtomSegment` with
 * `type: "command"` whose `value` is the *bare* command name — no
 * leading slash (`tugplug:commit`, not `/tugplug:commit`). That bare
 * name is the single source of truth: it's what claude's catalog
 * reports, what the completion match keys off, what the
 * unsupported-command allowlist compares against, and what the chip
 * displays (a command chip reads as `tugplug:commit`, distinguished from
 * a file chip by its terminal icon, not by a leading slash).
 *
 * The leading slash is added at exactly one boundary — **the wire**
 * ({@link commandWireText}): the text block sent to claude must be a
 * *clean* `/name` (optionally ` args`) string. claude's CLI expands a
 * slash command into a **user invocation** (the path that bypasses a
 * skill's `disable-model-invocation` guard) only when the message text is
 * exactly the command. Any other shape — the backtick-`@` mention marker,
 * or a bare slashless name — defeats expansion: the literal reaches the
 * model instead, which tries the Skill tool (refused on a
 * `disable-model-invocation` skill) or improvises.
 *
 * Pure data helpers — no React, no DOM, no store dependency.
 *
 * @module lib/command-atom
 */

import type { ContentBlock } from "@/protocol";
import { isSessionAtomType } from "@/lib/session-atom-shape";
import { matchLeadingSlashCommand } from "@/lib/annotator/command-grammar";

/** Strip a single leading slash so the helpers are idempotent on a
 *  value that already carries one (defensive — `value` is canonically
 *  the bare name). */
function bareName(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

/**
 * The clean wire string for a command atom: `/<name>` plus any
 * trailing argument text. This is the shape claude expands as a user
 * invocation. `args` is the editor text that followed the chip (e.g.
 * `one two` for `/cmd one two`); omit it for a bare command.
 */
export function commandWireText(value: string, args?: string): string {
  const trimmed = args?.trim();
  return "/" + bareName(value) + (trimmed ? " " + trimmed : "");
}

/**
 * The label a chip displays. A slash command shows its leading slash
 * (`/tugplug:commit`) — the slash *is* the command, and is the marker that
 * sets it apart in the shared atom-chip family (a command leads with `/`, a
 * file leads with its icon). Every other atom type shows its stored `label`.
 *
 * The session atom does not reach here at all, and the exception is stated so
 * nobody adds a session branch to this function: a session chip draws the
 * identity's display title ([D141]), which needs a store read this leaf is
 * deliberately without. `tug-atom-img.ts` resolves it beside the phase dot,
 * which is the other fact about a session chip that is not in its segment.
 */
export function chipDisplayLabel(
  type: string,
  label: string,
  value: string,
): string {
  if (type !== "command") return label;
  return "/" + bareName(value);
}

/**
 * What a chip draws in front of its label.
 *
 * - `"icon"` — the type's {@link ATOM_ICON_PATHS} glyph, the family default.
 * - `"dot"` — the session atom's phase dot. The session's mark says what it is
 *   *doing*, which is the one thing a static glyph could never do ([P01]), so
 *   the chip leads with the dot and carries no glyph beside it.
 * - `"none"` — a slash command, whose leading `/` (see
 *   {@link chipDisplayLabel}) is its marker.
 *
 * Both marks occupy the same leading span, so geometry is one rule.
 */
export function chipMark(type: string): "icon" | "dot" | "none" {
  if (type === "command") return "none";
  if (isSessionAtomType(type)) return "dot";
  return "icon";
}

/** Whether a chip of this type reserves a leading mark span. */
export function chipHasIcon(type: string): boolean {
  return chipMark(type) !== "none";
}

// ---------------------------------------------------------------------------
// Chip style — the single source of truth for chip appearance
// ---------------------------------------------------------------------------

/**
 * The four theme-token *names* a chip paints with. Names (not resolved
 * values) so the React path can reference them as `var(--…)` (live
 * cascade) and the editor data-URI path can bake them via
 * `getTokenValue(--…)` — both selecting the same tokens.
 */
export interface ChipTokens {
  /** Base surface the chip rect fills with, before the key wash. */
  surface: string;
  /** Theme **Key** hue (the selection / filled-action axis) — washed lightly
   *  into {@link surface} at {@link ATOM_KEY_WASH} so the chip carries a hint
   *  of the active theme instead of reading as flat neutral. */
  key: string;
  /** Recess edge colour: the soft inset top-shade gradient and the faint
   *  all-round inset hairline that bound the unit in place of a hard stroke. */
  border: string;
  /** Stroke of the icon glyph. */
  icon: string;
  /** Fill of the label text. */
  text: string;
}

/** The geometry knobs a chip paints with. */
export interface ChipGeometryStyle {
  /** Corner radius (`rx`) of the chip rect, in px. */
  radius: number;
  /** Horizontal padding inside the chip, in px. */
  paddingX: number;
  /** Gap between the icon and the label, in px. */
  gap: number;
}

/** A chip's complete appearance contract: which tokens it paints with
 *  and what shape it takes. */
export interface ChipStyle {
  tokens: ChipTokens;
  geometry: ChipGeometryStyle;
}

/**
 * Which appearance a chip paints with. `"default"` is the resting chip;
 * `"selected"` is the chip when the editor's text selection covers it —
 * a more-saturated surface and lighter text/icon so the chip reads as a
 * distinct unit *forward* of the blue selection wash instead of
 * dissolving into it (blue-on-blue). Geometry is identical between the
 * two, so a chip swapping variants never changes size.
 */
export type ChipVariant = "default" | "selected";

/**
 * Strength of the Key-hue wash over the chip surface — the `fill-opacity` of
 * a Key-coloured overlay rect painted on top of the opaque surface. Both
 * renderers use the overlay technique rather than CSS `color-mix`: a Key fill
 * at alpha `a` over an opaque surface composites to `a·key + (1−a)·surface`,
 * exactly equal to `color-mix(in srgb, key a, surface)`, but `fill-opacity` is
 * universally supported — including inside the editor's `<img src="data:…">`
 * document, where `color-mix` support is not guaranteed. 0.09 ≈ a 9% wash.
 */
export const ATOM_KEY_WASH = 0.09;

/**
 * The one chip style every atom type shares — file, image, link, doc, and
 * command. All chips read as the same inline-reference family; the per-type
 * **icon** ({@link ATOM_ICON_PATHS}) is the only differentiator (a command
 * shows a terminal glyph, a file a document glyph, …). Defined once here
 * rather than as literals in the two renderers so the token names and corner
 * radius live in a single place.
 *
 * The chip reads as a *recessed* unit: a light Key wash over {@link
 * ChipTokens.surface} (see {@link ATOM_KEY_WASH}), bounded by a soft inset
 * top-shade + a faint inset hairline drawn from {@link ChipTokens.border} —
 * not a hard 1px stroke. The bounded shape still says "indivisible unit"; the
 * softer edge and full-size label keep it legible in flowing prose.
 */
const CHIP_STYLE: ChipStyle = {
  tokens: {
    surface: "--tug7-surface-atom-primary-normal-default-rest",
    key: "--tug7-surface-control-primary-filled-action-rest",
    border: "--tug7-element-atom-border-normal-default-rest",
    icon: "--tug7-element-atom-icon-normal-default-rest",
    text: "--tug7-element-atom-text-normal-default-rest",
  },
  geometry: { radius: 3, paddingX: 6, gap: 4 },
};

/**
 * The selected-state chip style. Swaps the three tokens the theme tunes
 * for selection — surface, text, icon — to their `-selected-rest`
 * variants (each theme authors these: a higher-chroma surface and
 * lighter glyphs). Border and key keep their default tokens; the theme
 * defines no selected variant for those, and the recess edge / key wash
 * read fine over the saturated surface. Geometry matches {@link
 * CHIP_STYLE} exactly so the chip never resizes when selection moves
 * across it.
 */
const CHIP_STYLE_SELECTED: ChipStyle = {
  tokens: {
    surface: "--tug7-surface-atom-primary-normal-selected-rest",
    key: "--tug7-surface-control-primary-filled-action-rest",
    border: "--tug7-element-atom-border-normal-default-rest",
    icon: "--tug7-element-atom-icon-normal-selected-rest",
    text: "--tug7-element-atom-text-normal-selected-rest",
  },
  geometry: { radius: 3, paddingX: 6, gap: 4 },
};

/** The shared chip style consumed by both chip renderers (the editor
 *  data-URI baker and the React `TugAtomChip`). Pass `"selected"` for
 *  the selection-covered appearance; defaults to the resting chip. */
export function chipStyle(variant: ChipVariant = "default"): ChipStyle {
  return variant === "selected" ? CHIP_STYLE_SELECTED : CHIP_STYLE;
}

/**
 * The session atom's face ([P13], Spec S05) — the one atom type outside the
 * shared family above.
 *
 * A rounded pill in **text ink**: no ground, no Key wash, and a plain hairline
 * at {@link SESSION_CHIP_BORDER_ALPHA} of the text color in place of the
 * family's recess. The dot is the chip's only color channel, because a colored
 * pill around a colored dot was two tints saying one thing.
 *
 * The numbers are the ones `tug-session-identity.css` authors for the `sm`
 * chip, so the composer's bake and the mounted component read as the same
 * object at the same size.
 */
export const SESSION_CHIP_GEOMETRY: ChipGeometryStyle = {
  // A pill: both renderers clamp a corner radius to half the box.
  radius: 999,
  paddingX: 9,
  gap: 5,
};

/** Alpha of the session chip's hairline, over the chip's own text ink —
 *  the bake's equivalent of the component's `currentcolor 30%` mix. */
export const SESSION_CHIP_BORDER_ALPHA = 0.3;

/** The text/border ink the session chip paints in — ordinary text color, not
 *  the atom family's own tokens. */
export const SESSION_CHIP_INK_TOKEN =
  "--tug7-element-global-text-normal-default-rest";

/** The painted dot's share of its mark box — the pulsing dot's own ratio. */
export const SESSION_CHIP_DOT_RATIO = 0.6;

// ---------------------------------------------------------------------------
// Expansion-echo detection
// ---------------------------------------------------------------------------

/** A command turn recovered from claude's expansion echo. */
export interface CommandEcho {
  /** Bare command name, no leading slash (matches an editor command atom). */
  value: string;
  /** Argument text the user passed after the command, if any. */
  args?: string;
}

const COMMAND_NAME_RE = /<command-name>([^<]+)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_ENVELOPE_RE =
  /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/g;

/**
 * Recognize claude's slash-command expansion echo in a user message's
 * content blocks. When claude expands a typed `/command`, it rewrites
 * the user turn to a single text block of the form:
 *
 * ```
 * <command-message>NAME</command-message>
 * <command-name>/NAME</command-name>
 * <command-args>ARGS</command-args>   (only when args were passed)
 * ```
 *
 * Returns the recovered `{ value, args }` (value is the **bare** name —
 * the leading slash is stripped so it equals an editor command atom's
 * `value`, which is what keeps the optimistic and replayed echoes
 * rendering the same chip), or `null` when the blocks are not a pure
 * command envelope.
 *
 * Tolerant by design ([Q01]): the `<command-message>` and
 * `<command-args>` siblings are optional and may appear in any order;
 * only `<command-name>` is required. Guards against prose false
 * positives by requiring the block to be *only* the envelope tags plus
 * whitespace — a message that merely quotes `<command-name>` mid-prose
 * is left to the generic synthesis path.
 *
 * Pure — no DOM, no store.
 */
export function detectCommandEcho(
  blocks: ReadonlyArray<ContentBlock>,
): CommandEcho | null {
  if (blocks.length !== 1) return null;
  const only = blocks[0];
  if (only.type !== "text") return null;
  const text = only.text;

  const nameMatch = COMMAND_NAME_RE.exec(text);
  if (nameMatch === null) return null;
  const value = bareName(nameMatch[1].trim());
  if (value === "") return null;

  // The block must be ONLY the command envelope (+ whitespace). Strip the
  // known tags; anything left means this is prose that happens to mention
  // the tags, not an expansion echo.
  const residue = text.replace(COMMAND_ENVELOPE_RE, "").trim();
  if (residue !== "") return null;

  const argsMatch = COMMAND_ARGS_RE.exec(text);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return args ? { value, args } : { value };
}

/**
 * Whether an editor substrate *leads* with a command atom — the shape
 * claude expands into a user invocation. Argument text and **further
 * atoms** (a `@`-mention file, a pasted image) may follow; only the
 * leading atom must be the command.
 *
 * The live submit path uses this to decide the *optimistic* echo: a
 * command atom is sent as a clean `/name` (markerless) so claude can
 * expand it, which means the wire can't round-trip the command-ness.
 * Re-synthesizing the optimistic substrate from that wire would render
 * plain `/name` text and then flip to a chip when claude's
 * `<command-name>` echo replays — a flicker. Worse, when an *argument
 * atom* follows (e.g. `/implement ⟨dash/x.md⟩`), the wire carries the
 * bare `/name` next to the file's mention marker, so the resynthesis
 * recovers the file chip but leaves the command as plain text — the
 * command chip is lost outright, not merely flickered. When this returns
 * true the caller preserves the editor's full substrate instead, so the
 * optimistic echo shows the same command chip (and argument chips) the
 * replay reconstructs.
 *
 * `atomChar` is the substrate placeholder (`U+FFFC`), passed in rather
 * than imported to keep this module free of a `tug-atom-img` cycle.
 * Pure.
 */
export function hasLeadingCommandAtom(
  text: string,
  atoms: ReadonlyArray<{ type: string }>,
  atomChar: string,
): boolean {
  return (
    atoms.length >= 1 &&
    atoms[0].type === "command" &&
    text.startsWith(atomChar)
  );
}

// ---------------------------------------------------------------------------
// Minting a command atom for a command that was typed rather than picked
// ---------------------------------------------------------------------------

/**
 * The atom this module mints — structurally an `AtomSegment`, declared
 * here so the module stays free of a `tug-atom-img` cycle (the same
 * reason {@link hasLeadingCommandAtom} takes `atomChar` as a parameter).
 */
export interface CommandAtomSegment {
  kind: "atom";
  type: "command";
  label: string;
  value: string;
}

/**
 * Lift a leading literal `/command` out of a submission's text into the
 * command atom the `/`-completion would have placed there, returning the
 * rewritten `(text, atoms)` substrate — or `null` when the text does not
 * open with a command, or already leads with a command atom.
 *
 * **Why a submission needs this at all.** A command that reaches the
 * transcript as characters is painted as prose, because prose is what it
 * is: the annotator marks only whole inline `<code>` spans, and nothing
 * in the substrate says these particular characters were an invocation.
 * Two submissions arrive that way — a command line typed out instead of
 * accepted from the completion popup, and the wheel's stage prompt,
 * which the runner composes as text. Both are *invocations*: somebody ran
 * a command, they did not write about one, and `entity-presentation.md`'s
 * rule is that a placed thing renders as an atom.
 *
 * Minting at submit also closes a divergence. Replay reconstructs the
 * command atom out of claude's `<command-name>` echo
 * (`detectCommandEcho`), so a row that painted as prose live comes back
 * as a chip after a reload — the same live-vs-restored mismatch
 * `hasLeadingCommandAtom` exists to prevent on the completion path.
 *
 * The atom takes offset 0 and is prepended to `atoms`, so every existing
 * atom keeps its `U+FFFC` and its ordinal: the command name the splice
 * removes cannot contain the placeholder (the grammar admits only
 * lowercase alphanumerics, `_`, `-` and one `:`).
 *
 * Distinct from `buildCommandSubmission`, which mints the same substrate
 * from a `(name, args)` pair for a command the app itself is running: that
 * one re-spells the arguments (trimmed, single-spaced), which is right when
 * the app composed them and wrong here, where the remainder is text somebody
 * submitted and may run for paragraphs.
 *
 * There is no known-command gate here, and the callers explain why they
 * need none: the composer has already dispatched or refused every local,
 * hidden and unknown name before it submits, and the wheel's prompt
 * is a command the runner is running. Pure.
 */
export function mintLeadingCommandAtom<A extends { kind: "atom"; type: string }>(
  text: string,
  atoms: ReadonlyArray<A>,
  atomChar: string,
): { text: string; atoms: Array<A | CommandAtomSegment> } | null {
  if (hasLeadingCommandAtom(text, atoms, atomChar)) return null;
  const match = matchLeadingSlashCommand(text);
  if (match === null) return null;
  const atom: CommandAtomSegment = {
    kind: "atom",
    type: "command",
    label: match.name,
    value: match.name,
  };
  return { text: atomChar + text.slice(match.end), atoms: [atom, ...atoms] };
}
