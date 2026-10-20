/**
 * card-facts-mirror — what a body page holds of the cards the shell holds.
 *
 * Mirror what the shell holds about cards other than this page's own — their
 * session bindings, titles, live identities and reported session phases —
 * into this page's stores: every body reads other cards' sessions and phases
 * (a session's identity menu, the Overview's dots), and an arrangement card
 * lists their titles and identities too.
 * Those stores are per page and hold only this card's entries otherwise.
 *
 * The page's own card is never written: it owns its entries — but for the
 * arc its session is mated to. A bind is one fact whichever door it came
 * through, and the doors that name no card (`tugtool arc bind`,
 * `arc create`'s auto-bind) are answered by the shell, which maps a session
 * to its card across every card it holds. So the own card's arc follows the
 * shell's, applied when the shell's moves, which leaves a bind this page
 * heard first standing until the shell agrees.
 *
 * @module body/card-facts-mirror
 */

import type { CardIdentityFacts } from "../card-registry";
import { cardActivityElsewhere } from "../lib/card-activity-elsewhere";
import { cardIdentityElsewhere } from "../lib/card-identity";
import { cardSessionBindingStore, type CardSessionBinding } from "../lib/card-session-binding-store";
import { cardTitleStore, type CardMastheadPayload } from "../lib/card-title-store";

/** One apply of the mirror: the shell's facts for every card, as it holds them now. */
export type CardFactsMirror = (
  bindings: Record<string, CardSessionBinding>,
  titles: Record<string, { title: string | null; masthead: CardMastheadPayload | null }>,
  identities: Record<string, CardIdentityFacts>,
  activities: Record<string, string>,
) => void;

/**
 * The mirror for the page holding `ownCardId`. Each apply replaces the last,
 * clearing what it no longer names, and writes only what changed.
 */
export function createCardFactsMirror(ownCardId: string): CardFactsMirror {
  let boundBefore = new Map<string, string>();
  let titledBefore = new Set<string>();
  let knownBefore = new Set<string>();
  let reportedBefore = new Set<string>();
  let ownArcBefore: string | undefined;
  return (bindings, titles, identities, activities) => {
    const bound = new Map<string, string>();
    for (const [id, binding] of Object.entries(bindings)) {
      if (id === ownCardId) {
        const arc = JSON.stringify(binding.arc ?? null);
        if (arc !== ownArcBefore) cardSessionBindingStore.setArcBinding(id, binding.arc ?? null);
        ownArcBefore = arc;
        continue;
      }
      const json = JSON.stringify(binding);
      bound.set(id, json);
      if (JSON.stringify(cardSessionBindingStore.getBinding(id)) !== json) cardSessionBindingStore.setBinding(id, binding);
    }
    for (const id of boundBefore.keys()) if (!bound.has(id)) cardSessionBindingStore.clearBinding(id);
    boundBefore = bound;
    const titled = new Set(Object.keys(titles).filter((id) => id !== ownCardId));
    for (const id of titled) {
      const { title, masthead } = titles[id];
      if (title !== null) cardTitleStore.set(id, title, masthead ?? undefined);
      else if (masthead !== null) cardTitleStore.setMasthead(id, masthead);
      else cardTitleStore.clear(id);
    }
    for (const id of titledBefore) if (!titled.has(id)) cardTitleStore.clear(id);
    titledBefore = titled;
    const known = new Set(Object.keys(identities).filter((id) => id !== ownCardId));
    for (const id of known) cardIdentityElsewhere.set(id, identities[id]);
    for (const id of knownBefore) if (!known.has(id)) cardIdentityElsewhere.set(id, null);
    knownBefore = known;
    const reported = new Set(Object.keys(activities).filter((id) => id !== ownCardId));
    for (const id of reported) cardActivityElsewhere.set(id, activities[id]);
    for (const id of reportedBefore) if (!reported.has(id)) cardActivityElsewhere.set(id, null);
    reportedBefore = reported;
  };
}
