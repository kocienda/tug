/**
 * settings-keymap-probe.ts — what a chord means, asked without binding it.
 *
 * The pane could already answer "is ⌥⌘J free", but only by borrowing a row's
 * Change button: you armed some command's capture, read the conflict note,
 * and cancelled. That is the answer at the price of standing one keystroke
 * away from rebinding a command you never meant to touch. The probe is the
 * same question with no writer anywhere near it.
 *
 * A pure projection over `resolveChord`, so every case — free, taken at the
 * menu bar, taken in one surface, taken by something whose menu item happens
 * to validate disabled — is decided here and asserted without mounting the
 * pane.
 *
 * ## Why the verdict is three kinds and not five
 *
 * `resolveChord` distinguishes a live winner from a *claiming but disabled*
 * menu item: the second fires nothing at all, beeps, and does not fall
 * through. That distinction is load-bearing inside the registry and invisible
 * to the person asking this question, because the answer they can act on is
 * the same one either way — the chord is spoken for, and here is by what. So
 * both land as {@link ChordProbeTaken}, and the fourth and fifth verdicts a
 * more literal reading would produce are folded in rather than shown.
 *
 * What is *not* folded in is how absolutely the chord is gone. A menu-bar
 * claim preempts every scoped binding regardless of focus ([P15]); a scoped
 * claim leaves the chord free everywhere else. Those change what the user
 * would do next, so the verdict names the layer — in one of three fixed
 * phrases, never a scope's own identifier. `session-composer` is a fact about
 * the code and would be read as a place the user could go look.
 *
 * @module components/tugways/cards/settings-keymap-probe
 */

import type { Chord } from "../command-registry";
import { COMMANDS_BY_ID } from "../command-registry";
import {
  chordHasKeyEquivalent,
  formatChord,
  isRecordableChord,
} from "../chord-format";
import type { ChordResolution, ResolutionLayer } from "../keymap-registry";
import { keymapRegistry } from "../keymap-registry";

/** Where a claim on the chord lives, said in the pane's own words. */
export type ProbeLayerPhrase =
  /** An `NSMenuItem` carries it. Nothing below the menu bar can have it. */
  | "on the menu bar"
  /** The global JS layer — bound wherever no nearer claim beats it. */
  | "everywhere"
  /** A responder or a focus mode. Free in every surface but that one. */
  | "in one surface";

/** The chord is not one any surface could record. */
export interface ChordProbeUnrecordable {
  readonly kind: "unrecordable";
  readonly chord: Chord;
  readonly label: string;
}

/** Nothing claims the chord. */
export interface ChordProbeFree {
  readonly kind: "free";
  readonly chord: Chord;
  readonly label: string;
  /**
   * The chord can also be carried by a menu item. `false` is a caveat on a
   * yes — the chord is bindable, but a command wearing it would have no
   * menu-bar form ([P15] cuts the other way here).
   */
  readonly menuEligible: boolean;
}

/** Something has the chord. */
export interface ChordProbeTaken {
  readonly kind: "taken";
  readonly chord: Chord;
  readonly label: string;
  readonly commandId: string;
  /** The command's own title, or its id when the table has no entry. */
  readonly title: string;
  readonly layer: ProbeLayerPhrase;
  /** Other commands claiming the same chord below the one named. */
  readonly others: number;
  /** Every claimant, the named one included — what the pane filters to. */
  readonly commandIds: ReadonlySet<string>;
}

export type ChordProbeVerdict =
  | ChordProbeUnrecordable
  | ChordProbeFree
  | ChordProbeTaken;

/** Which of the three phrases a resolution layer earns. */
function phraseForLayer(layer: ResolutionLayer): ProbeLayerPhrase {
  if (layer.kind === "native") return "on the menu bar";
  return layer.scope.kind === "global" ? "everywhere" : "in one surface";
}

/**
 * The claim to report, out of a stack that may hold several.
 *
 * The live winner when there is one. Failing that, a menu item that claims
 * the chord while validating disabled: it fires nothing, but the chord is
 * eaten at the menu bar and reaches no one, so it is taken in every sense
 * the person asking cares about.
 */
function reportableClaim(
  stack: readonly ChordResolution[],
): ChordResolution | undefined {
  const winner = stack.find((r) => r.active);
  if (winner !== undefined) return winner;
  return stack.find(
    (r) => r.layer.kind === "native" && r.layer.claims && !r.layer.enabled,
  );
}

/**
 * Ask what a chord means, changing nothing.
 *
 * The registry is a parameter so the verdict can be asserted against a
 * constructed multi-layer world; the pane passes nothing and gets the live
 * one.
 */
export function probeChord(
  chord: Chord,
  registry: Pick<typeof keymapRegistry, "resolveChord"> = keymapRegistry,
): ChordProbeVerdict {
  const label = formatChord(chord);
  if (!isRecordableChord(chord)) {
    return { kind: "unrecordable", chord, label };
  }

  const stack = registry.resolveChord(chord);
  const claim = reportableClaim(stack);
  if (claim === undefined) {
    return {
      kind: "free",
      chord,
      label,
      menuEligible: chordHasKeyEquivalent(chord),
    };
  }

  // Every command in the stack, not just the one named: the pane narrows its
  // list to all of them, because a chord claimed at two layers is exactly the
  // case where seeing one row would be misleading.
  const commandIds = new Set(stack.map((r) => r.commandId));
  return {
    kind: "taken",
    chord,
    label,
    commandId: claim.commandId,
    title: COMMANDS_BY_ID.get(claim.commandId)?.title ?? claim.commandId,
    layer: phraseForLayer(claim.layer),
    others: Math.max(0, commandIds.size - 1),
    commandIds,
  };
}
