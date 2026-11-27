/**
 * arc-entry-fixture.ts — reaching a bound arc's own reading in the raised
 * shade.
 *
 * The shade draws the cycle body for every bound arc: the cycle that holds
 * it, or, while none does, the cycle of one it is about to be. The arc is an
 * entry there, closed until it is pressed, and opening it shows the arc's
 * reading and its verbs, the same `ArcPopoverContent` the cell's popup draws.
 * A test whose arc is on no cycle finds it as entry 1.
 */

import type { App } from "./_harness";

/** The raised shade. */
export const RAISED_SHADE = '[data-slot="session-arc-shade"][data-raised="true"]';

/** Entry 1's asset in the raised shade: a bound arc on no cycle is that entry. */
export const ARC_ENTRY = `${RAISED_SHADE} [data-slot="session-cycle-shade-asset"][data-asset="e1"]`;

/** The entry's headline, which a press opens and closes it by. */
export const ARC_ENTRY_HEADLINE = `${ARC_ENTRY} [data-slot="session-cycle-shade-headline"]`;

/** The arc's own reading in its open entry. */
export const ARC_ENTRY_BODY = `${ARC_ENTRY} [data-slot="session-cycle-shade-here"] [data-slot="session-arc-popover-body"]`;

/** The arc's whole popover content in its open entry, head and verbs included. */
export const ARC_ENTRY_POPOVER = `${ARC_ENTRY} [data-slot="session-cycle-shade-here"] .session-arc-popover`;

/**
 * With the shade raised, wait for its rise to end, open the arc's entry if it
 * is closed, and wait for the arc's reading to draw.
 */
export async function openArcEntry(app: App, cardId = "A", timeoutMs = 10_000): Promise<void> {
  await app.body(cardId).waitForCondition<boolean>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(RAISED_SHADE)});
       if (shade === null || document.querySelector(${JSON.stringify(ARC_ENTRY_HEADLINE)}) === null) return false;
       return shade.getAnimations().length === 0 && getComputedStyle(shade).transform === "none";
     })()`,
    { timeoutMs },
  );
  const open = await app
    .body(cardId)
    .evalJS<boolean>(`document.querySelector(${JSON.stringify(`${ARC_ENTRY}[data-open]`)}) !== null`);
  if (!open) await app.body(cardId).click(ARC_ENTRY_HEADLINE);
  await app.body(cardId).waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ARC_ENTRY_BODY)}) !== null`,
    { timeoutMs },
  );
}
