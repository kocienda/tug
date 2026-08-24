/**
 * dash-prompt-target.ts — where a cockpit affordance's prompt would land, read
 * from the live stores.
 *
 * `resolvePromptTarget` in `lib/dash-prompts.ts` is the pure ladder and holds
 * the argument; this is the subscription that feeds it. It lives in its own
 * module because both consumers need it — the section's plan rows and the
 * start sheet — and the section renders the sheet, so a hook exported from
 * either one would make them import each other.
 *
 * The phase read is a two-step subscription ([L02]): the services bag comes
 * from `cardServicesStore`, and whatever store it resolves to is subscribed
 * separately, with a module-level stable no-op for the null case. That shape
 * is `TelemetryBirthRow`'s in `session-masthead.tsx` — followed here rather
 * than reinvented, because a fresh closure passed as `subscribe` re-subscribes
 * on every render.
 *
 * @module components/lens/sections/dash-prompt-target
 */

import { useSyncExternalStore } from "react";

import { useLensFollowedCard } from "@/components/lens/lens-followed-card";
import { cardServicesStore } from "@/lib/card-services-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { resolvePromptTarget, type PromptTarget } from "@/lib/dash-prompts";

/** A stable subscribe for a card that resolves to no session store. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** The followed card, its binding, and where a prompt from it would land. */
export interface PromptDestination extends PromptTarget {
  /** The followed session's project directory, or null when there is none. */
  projectDir: string | null;
}

/**
 * {@link resolvePromptTarget} against the live followed card.
 *
 * `requireProjectDir` is the plan-row rung — a plan path is relative to one
 * project root, so it may only be handed to a session inside that project.
 * Omit it for a project-free act: a new dash belongs to whatever project the
 * followed session is in.
 */
export function usePromptTarget(input: {
  requireProjectDir?: string | null;
  projectLabel?: string;
}): PromptDestination {
  const followedCardId = useLensFollowedCard();
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  const services = useSyncExternalStore(cardServicesStore.subscribe, () =>
    followedCardId === null
      ? null
      : cardServicesStore.getServices(followedCardId),
  );
  const store = services?.codeSessionStore ?? null;
  const phase = useSyncExternalStore(
    store?.subscribe ?? NOOP_SUBSCRIBE,
    store !== null ? () => store.getSnapshot().phase : () => null,
    () => null,
  );
  const binding =
    followedCardId !== null ? bindings.get(followedCardId) : undefined;
  return {
    ...resolvePromptTarget({
      followedCardId,
      binding,
      requireProjectDir: input.requireProjectDir ?? null,
      projectLabel: input.projectLabel,
      phase,
    }),
    projectDir: binding?.projectDir ?? null,
  };
}
