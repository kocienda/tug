/**
 * arc-stop-resume-fixture.ts — what the at0476 stop-and-resume files share.
 *
 * `at0476-arc-stop-resume` stops an arc on the card and presses its Resume;
 * `at0476-arc-stop-resume-restore` does the same and then reloads the card's
 * page. Both read the same rows the same way, so the selectors, the shell
 * route and the seat reading live here rather than twice.
 *
 * @module tests/app-test/arc-stop-resume-fixture
 */

import { note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

export const CARD = '[data-card-id="A"]';
export const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
/**
 * The offer's own title, as the block renders it — and the reason a *stop*
 * receipt is counted by this rather than by the header words `arc stopped`.
 * The block consumes that header and draws an identity strip in its place, so
 * the words never reach the row's text; the offer is the one string a stop
 * receipt puts on screen and nothing else does.
 */
export const ARC_RESUME_OFFER_TITLE = "Resume this arc";
/**
 * The Resume button inside the stop receipt's own block. Addressed through the
 * block's own class rather than the dialog primitive's slot, so a second
 * inline dialog appearing anywhere on the card cannot be pressed by accident.
 */
export const RESUME_BUTTON = `${CARD} .arc-receipt-resume [data-slot="tug-push-button"]`;
/** The words the pick-up's quiet line reads as, in either seat. */
export const PICKED_BACK_UP = "Picked back up";

/**
 * Run a shell command on the card and wait for the transcript to carry
 * `marker`.
 *
 * Not `shellAndSettle`: that waits for an exact row count, and the receipt
 * this file is about **is itself a shell row** ([D111]). A stop that lands its
 * receipt therefore leaves two rows where the count-based wait demanded one,
 * and the wait can never come true — the thing under test defeats the helper
 * that was supposed to observe it. Waiting on the text is indifferent to how
 * many rows the act produced.
 */
export async function shellUntil(app: App, command: string, marker: string): Promise<void> {
  const prompt = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
  const line = `/shell ${command}`;
  await app.body("A").nativeClickAtElement(prompt);
  // Type only once the click's focus has landed and settled. The host's own
  // refocus of the card can arrive after the click, and WebKit puts the caret
  // back at 0 when it does: keystrokes already sent then split around it, and
  // the composer holds `ll/s /Ushe…` instead of the line. That race is what
  // made this file red in batches with nothing wrong in the product.
  await app.body("A").waitForCondition<boolean>(
    `document.hasFocus() && document.activeElement === document.querySelector(${JSON.stringify(
      prompt,
    )})`,
    { timeoutMs: 5_000 },
  );
  await new Promise((r) => setTimeout(r, 300));
  await app.nativeType(line);
  // The line has to be in the composer before it is submitted. A submit that
  // sends nothing leaves the wait below to time out on a receipt that was
  // never asked for, which names the wrong thing; this names the right one.
  try {
    await app.body("A").waitForCondition<boolean>(
      `(document.querySelector(${JSON.stringify(prompt)})?.textContent ?? "").indexOf(${JSON.stringify(
        command,
      )}) !== -1`,
      { timeoutMs: 5_000 },
    );
  } catch (error) {
    const state = await app.body("A").evalJS<string>(`JSON.stringify({
      composer: document.querySelector(${JSON.stringify(prompt)})?.textContent ?? null,
      editable: document.querySelector(${JSON.stringify(prompt)})?.getAttribute("contenteditable") ?? null,
      active: document.activeElement === null ? null :
        document.activeElement.tagName + "." + String(document.activeElement.className),
      hasFocus: document.hasFocus(),
    })`);
    note("shellUntil: the typed line did not reach the composer", state);
    note("shellUntil: card when typing missed", (await app.screenshot()).path);
    throw error;
  }
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
  await app.body("A").waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}))
       .some((el) => (el.textContent || "").indexOf(${JSON.stringify(marker)}) !== -1)`,
    { timeoutMs: 60_000 },
  );
}

/** Every shell row's text, in transcript order. */
export async function shellRowText(app: App): Promise<string[]> {
  const raw = await app.body("A").evalJS<string>(
    `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
      SHELL_ROWS,
    )})).map((el) => el.textContent || ""))`,
  );
  return JSON.parse(raw) as string[];
}

/** Seat card A on `sid` in `projectDir`, and wait for its engine. */
export async function openCard(app: App, sid: string, projectDir: string): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 660 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: sid, projectDir });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/**
 * Where the pick-up sits, read off the list's own cell indices.
 *
 * The transcript is a list view, and its cells carry the row index they
 * render; that index is the transcript's order, which DOM order need not be.
 * `stop` is the stop receipt's row, `pickUp` the pick-up's quiet line in
 * whichever seat it took (its own row between turns, or a note inside a
 * turn), and `turnAfter` the first row after the stop that opens a turn — a
 * user row, or a Wheel-attributed entry that is not itself a receipt row.
 * `-1` for any that is not on the card. `offers` counts the Resume offers
 * still standing, and `rows` names each mounted row by its slot and the
 * start of its text, so a red names what was where.
 */
export interface ArcSeat {
  stop: number;
  pickUp: number;
  turnAfter: number;
  offers: number;
  rows: string[];
}

export async function readArcSeat(app: App): Promise<ArcSeat> {
  const raw = await app.body("A").evalJS<string>(`(() => {
    const card = document.querySelector(${JSON.stringify(CARD)});
    if (card === null) return JSON.stringify({ stop: -1, pickUp: -1, turnAfter: -1, offers: 0, rows: [] });
    const cellOf = (el) => {
      const cell = el.closest("[data-tug-list-cell-index]");
      return cell === null ? -1 : Number(cell.getAttribute("data-tug-list-cell-index"));
    };
    const stopBlock = card.querySelector('[data-slot="arc-receipt-block"]');
    const stop = stopBlock === null ? -1 : cellOf(stopBlock);
    let pickUp = -1;
    for (const el of card.querySelectorAll('[data-slot="session-arc-note-line"], [data-slot="arc-note"]')) {
      if ((el.textContent || "").indexOf(${JSON.stringify(PICKED_BACK_UP)}) !== -1) {
        pickUp = cellOf(el);
        break;
      }
    }
    let turnAfter = -1;
    const openers = card.querySelectorAll(
      '[data-testid="session-card-transcript-user-body"], .tug-transcript-entry[data-participant="wheel"]',
    );
    for (const el of openers) {
      if (el.closest('[data-slot="session-transcript-shell-row"]') !== null) continue;
      const at = cellOf(el);
      if (at > stop && (turnAfter === -1 || at < turnAfter)) turnAfter = at;
    }
    const offers = Array.from(card.querySelectorAll('[data-slot="session-transcript-shell-row"]'))
      .filter((el) => (el.textContent || "").indexOf(${JSON.stringify(ARC_RESUME_OFFER_TITLE)}) !== -1)
      .length;
    const rows = Array.from(card.querySelectorAll("[data-tug-list-cell-index]"))
      .map((cell) => {
        const slotted = cell.querySelector("[data-slot]");
        const participant = cell.querySelector("[data-participant]");
        return Number(cell.getAttribute("data-tug-list-cell-index")) + ":" +
          (slotted === null ? "-" : slotted.getAttribute("data-slot")) + ":" +
          (participant === null ? "-" : participant.getAttribute("data-participant")) + ":" +
          (cell.textContent || "").slice(0, 60);
      })
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return JSON.stringify({ stop, pickUp, turnAfter, offers, rows });
  })()`);
  return JSON.parse(raw) as ArcSeat;
}

/** Wait until the pick-up's quiet line is on the card, in either seat. */
export async function waitForPickUp(app: App): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(
      `${CARD} [data-slot="session-arc-note-line"], ${CARD} [data-slot="arc-note"]`,
    )})).some((el) => (el.textContent || "").indexOf(${JSON.stringify(PICKED_BACK_UP)}) !== -1)`,
    { timeoutMs: 30_000 },
  );
}

/**
 * The order the brief pins ([B07]): the pick-up sits after the stop it
 * answers and above the first row of the turn the resume opened, never below
 * it — and the stop's Resume offer has folded. Returned as the list of what
 * is wrong, so a red run names every part at once.
 */
export function seatProblems(seat: ArcSeat): string[] {
  const problems: string[] = [];
  if (seat.stop < 0) problems.push("no stop receipt on the card");
  if (seat.pickUp < 0) problems.push("no pick-up line on the card");
  if (seat.stop >= 0 && seat.pickUp >= 0 && seat.pickUp <= seat.stop) {
    problems.push(`the pick-up (row ${seat.pickUp}) is not below the stop (row ${seat.stop})`);
  }
  if (seat.turnAfter >= 0 && seat.pickUp >= seat.turnAfter) {
    problems.push(
      `the pick-up (row ${seat.pickUp}) is not above the resumed turn's first row (row ${seat.turnAfter})`,
    );
  }
  if (seat.offers !== 0) problems.push(`${seat.offers} Resume offer(s) still standing`);
  return problems;
}
