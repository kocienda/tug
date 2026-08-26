/**
 * dash-prompts.ts — the cockpit's affordances, as prompts.
 *
 * Every graphical gesture the dash cockpit offers — start a dash, review a
 * plan, implement a plan — is a **prompt submitted into a real session**, never
 * a call into machinery. `tugutil` is the engine's and the models' tool, so a
 * button that ran one would be a graphical surface doing the machine's job
 * behind the reader's back; a submitted prompt is an ordinary, visible,
 * interruptible user message, and the model runs the arc from there.
 *
 * Two halves live here, both pure enough to test as tables:
 *
 * - The **templates**: the canonical, plugin-qualified command lines. They are
 *   composed here rather than in surface code so no component ever string-builds
 *   a command. A programmatic send bypasses the composer's bare-name
 *   canonicalization, so the qualified spelling is what goes out — nothing
 *   depends on the submit path resolving an ambiguous bare `/dash`.
 * - The **target ladder**: which card a press lands in, or why it cannot. The
 *   ladder stops at the Lens's followed card for the reason
 *   `resolveBindTarget` does — reaching past it would make a press succeed more
 *   often at the cost of submitting into a card the reader was not looking at.
 *
 * `submitPromptToCard` is the one impure export: it resolves the card's stores
 * and sends. It is deliberately thin, so what is worth testing stays in the
 * two halves above.
 *
 * @module lib/dash-prompts
 */

import { cardServicesStore } from "@/lib/card-services-store";
import { dispatchCommand } from "@/command-dispatch";
import type { CodeSessionPhase } from "@/lib/code-session-store/types";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Start a dash from an idea, and optionally a name.
 *
 * `/tugplug:dash` is the arc's conversational on-ramp: it sizes the idea,
 * decides brief-or-not, devises, stops at the review gate, and carries the
 * reviewed plan into implementation. The sheet's job is only to hand it a
 * sentence.
 *
 * The name rides as prose rather than as a flag, because the receiver is a
 * skill reading English, not a CLI parsing argv.
 */
export function startDashPrompt(idea: string, name?: string | null): string {
  const trimmedIdea = idea.trim();
  const trimmedName = (name ?? "").trim();
  if (trimmedName.length === 0) return `/tugplug:dash ${trimmedIdea}`;
  return `/tugplug:dash ${trimmedIdea} — name it ${trimmedName}`;
}

/**
 * The next gesture for a dash that exists only as documents.
 *
 * Every verb takes the **name**: a dash's documents live at one address, so the
 * skills resolve where to read and a prompt cannot point at the wrong file.
 *
 * A dash with a brief and no plan wants the arc's front door, which is where a
 * plan gets devised. A plan nothing has vouched for wants the review turn —
 * its own turn on its own model, deliberately, so the user can choose one. A
 * reviewed plan wants implementing. `stale` is the same answer as
 * `never-reviewed`: a review that predates an edit vouches for a document that
 * no longer exists.
 *
 * **Begun outranks all of it.** A dash with work already on its ledger wants
 * resuming whatever its review says, and the same `dash-implement` line carries
 * it: the skill resumes at the first row that is not `done`, and its own setup
 * gate re-checks the review and raises the ask if the plan went stale — so a
 * deck that sent the reader to a review first would pre-empt a decision the
 * skill already owns.
 */
export function documentDashNextGesturePrompt(
  review: string | undefined,
  name: string,
  begun: boolean,
  hasPlan: boolean,
): string {
  if (!hasPlan) return `/tugplug:dash ${name}`;
  return begun || review === "reviewed"
    ? `/tugplug:dash-implement ${name}`
    : `/tugplug:dash-review ${name}`;
}

/** What the row's affordance says, given its review state and its ledger. */
export function documentDashNextGestureLabel(
  review: string | undefined,
  begun: boolean,
  hasPlan: boolean,
): string {
  if (!hasPlan) return "Devise";
  if (begun) return "Resume";
  return review === "reviewed" ? "Implement" : "Review";
}

// ---------------------------------------------------------------------------
// The target ladder
// ---------------------------------------------------------------------------

/** Where a prompt press would land, or why it cannot. Exactly one is non-null. */
export interface PromptTarget {
  cardId: string | null;
  reason: string | null;
}

/**
 * Resolve a prompt affordance's target — pure, so its whole truth table is a
 * unit test rather than a DOM one.
 *
 * Every refusal is a sentence the control wears itself ([L31]): a press that
 * would be dropped cannot be made, and a disabled control that declines without
 * saying why is the failure this whole cockpit exists to retire.
 *
 * `requireProjectDir` is the plan-row rung: a plan path is relative to one
 * project root, so it may only be handed to a session inside that project. The
 * start sheet passes null — a new dash belongs to whatever project the followed
 * session is in, and the sheet names that project so the reader sees it.
 *
 * The last rung is `phase === "replaying"`, and deliberately **not** a full
 * can-submit check. A session mid-turn does not drop a send, it enqueues it as
 * a visible ghost row that flushes when the turn completes — queueing a next
 * gesture behind a running turn is a feature. Replay is the one phase whose
 * send is discarded silently, so it is the one phase this refuses.
 */
export function resolvePromptTarget(input: {
  followedCardId: string | null;
  binding: { tugSessionId: string; projectDir: string } | undefined;
  /** The project a plan row's path belongs to, or null for project-free acts. */
  requireProjectDir?: string | null;
  /** That project's display name, for the mismatch sentence. */
  projectLabel?: string;
  /** The target session's phase, or null when it has no live store. */
  phase: CodeSessionPhase | null;
}): PromptTarget {
  if (input.followedCardId === null) {
    return { cardId: null, reason: "Focus a session card to send this" };
  }
  if (input.binding === undefined) {
    return { cardId: null, reason: "The focused card has no session" };
  }
  const required = input.requireProjectDir ?? null;
  if (required !== null && input.binding.projectDir !== required) {
    return {
      cardId: null,
      reason: `This plan belongs to ${input.projectLabel ?? required}`,
    };
  }
  if (input.phase === null) {
    return { cardId: null, reason: "The focused card's session is not ready" };
  }
  if (input.phase === "replaying") {
    return { cardId: null, reason: "The focused card is replaying its transcript" };
  }
  return { cardId: input.followedCardId, reason: null };
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

/**
 * Submit `text` into `cardId`'s session as an ordinary user message, and front
 * the card so the reader sees where their press went.
 *
 * A no-op when the card has no services — the ladder has already refused that
 * case before a press is possible, and a surface that could still call this
 * during a teardown frame should do nothing rather than throw.
 */
export function submitPromptToCard(cardId: string, text: string): void {
  const services = cardServicesStore.getServices(cardId);
  if (services === null) return;
  services.codeSessionStore.send(text, []);
  dispatchCommand("focus-session-card", { cardId });
}
