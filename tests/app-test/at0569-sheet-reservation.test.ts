/**
 * at0569-sheet-reservation.test.ts — an unbound Session card stands at LEAST
 * at its picker's height with the sessions list at its cap, takes more when its
 * column has more to give, and gives the room back when a session opens.
 *
 * Two mechanisms meet on one card here, and this file is where the meeting is
 * pinned THROUGH THE LIVE APP.
 *
 * A modal surface whose natural height is content-bounded declares that height
 * at its call site, the sheet measures the panel and reports the number out,
 * and the deck derives the host member's floor from it and holds the member
 * there for as long as the sheet is up. That is the RESERVATION, and the
 * DERIVATION is the deck's ([B03]): the sheet knows its panel, and everything
 * between a panel and the member under it — the title bar, the clip's drop,
 * the gap the clamp keeps against the canvas, less the gap the imposition
 * leaves under a column's last member — is arithmetic the card does not know
 * and should not.
 *
 * That is why the claim is no longer 64px short of what the card needs. It
 * used to store the sheet's number unchanged, which made it inert on a Session
 * card — a floor under a member already well above it — and the picker's real
 * height was carried separately, by hand, in a registration's doc-comment. The
 * two are one quantity now, and with the sessions list at its cap the deck's
 * measured claim and the height the card DECLARED are the same number. This
 * file asserts that directly.
 *
 * What sizes the card is the other contributor: the height a Session card
 * DECLARES while it is unbound ([B01]). A Session card with no session behind
 * it is nothing but the picker it exists to raise — no transcript, no composer,
 * and so none of what the 600px floor is for. So the card declares what it is
 * worth unbound — MEASURED, off the picker's own panel, before the commit that
 * appends the pane — and `placeMembers` reads that bid as one more
 * contributor to the member's FLOOR: the largest thing
 * standing on the member wins, and the member keeps its weight. The card
 * stands at the picker's height whenever its share of the run would put it
 * lower, takes the share when the share is higher — which is the second test
 * below, and the whole of what changed — and the sheet going drops the
 * declaration ([B02]) so the stored division comes back either way.
 *
 * ## Why the frames MOVE here, where they used to be asserted not to
 *
 * This file's older claim was that nothing moves at all, which was the honest
 * reading of the reservation alone: a floor under a member already above it is
 * inert. The declaration is a floor, but it is not the STACK floor: it is a
 * number of its own, set by the picker with its sessions list at its cap
 * rather than by anything the 600px floor is for, and this fixture's shares
 * are chosen so the stack floor and the weighted share would each put the card
 * somewhere else — which is what makes the declaration's reading
 * distinguishable from theirs, and is asserted directly below. So the geometry
 * assertions say
 * where the two frames stand rather than that they did not move, and the
 * binding commit's assertion is the one that did not change: after
 * `bindSession` the division is the stored one again.
 *
 * ## The picker this file measures, and why it is not the one a fresh instance shows
 *
 * Every test launches on a quiet project, so the picker a card raises here
 * lists one empty group and its panel is some 415px tall. The Sessions list
 * is capped at 34rem with a 3.5rem floor per row, so on a real project the
 * list stands at its cap and the panel is 850px — more than the lower member
 * of a split column in this window can hold. A fit measured against the short
 * picker fits the short picker, and says nothing about the card a real
 * project presents.
 *
 * So the fit claim that matters is made over a SEEDED project
 * (`picker-sessions-fixture.ts`): five two-line sessions, enough to stand the
 * list at its cap. The Session card is the LOWER member of a split column,
 * standing UNDER the height its picker claims, which is the case the grouped
 * picker lays out for ([B07]): the Choose Session header, the filter, the
 * trash row and the actions all stand wholly inside the FRAME, and the
 * Sessions list is the element that gave way. The frame is the edge that
 * matters and the clip is not: `.tug-sheet-clip` is `height: 100vh` on
 * purpose ("it must NOT bound the panel"), so a reading against its bottom is
 * a reading against something a viewport below anything on screen. The short
 * picker's fit is still read before the list fills.
 *
 * ## Two fixtures, and what each of them can say
 *
 * The first two tests SEED their deck, including the opening bid, because
 * `addCard` is the only thing that writes one and nothing here calls it —
 * `seedDeckState` is an atomic in-process state replace, so a `DeckState`
 * field passes straight through it. What they are about is the ALLOCATOR's
 * reading of a bid, and what the sheet's own claim does to one. And because a
 * seeded bid is by definition a number nobody measured, they are also where
 * the first-report rule is seen REFUSING: the live report disagrees with the
 * seeded number, the deck records the disagreement instead of quietly
 * re-targeting, and the claim lands later on an honest update ([P04], [P05]).
 *
 * The third test adds its card through the production `show-card` path, so
 * `addCard` measures the card's opening form and bids what it read. That is
 * where the rule is seen AGREEING — the number the deck holds for the member
 * is the panel the user is looking at, at two picker heights far enough apart
 * that no constant could have satisfied both.
 *
 * The card is bound through the harness rather than by driving the picker's
 * Open, because the binding update IS what unmounts the picker on the real path
 * — `session-card.tsx` defers its wire send by the sheet's exit duration for
 * exactly that reason — and a live spawn would put a claude process inside a
 * geometry test.
 *
 * Deliberately NOT declaring `@covers tugdeck/src/components/tugways/cards/session-card.tsx`,
 * though the DECLARATION under test is made at that module's picker call site.
 * Its honest fan-out is already recorded debt at 21, one past the selection
 * budget, and naming it here would make it 22 — which the covers-check refuses
 * outright on the commit that does it. What stands in its place are the two
 * seams the call site reaches the deck through, `lib/sheet-reservation.ts` and
 * `lib/opening-bid.ts`: an edit that changes where the picker's numbers go
 * selects this file, and only an edit that drops a declaration while leaving
 * both modules alone would slip past.
 *
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/sheet-reservation.ts
 * @covers tugdeck/src/lib/opening-bid.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-registration.tsx
 * @family at0569
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { bodyOfKind, kindBody } from "./_harness/card-reach";
import { PIXEL_TOL } from "./_harness/tolerances";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { IMPOSITION_GAP_PX } from "../../tugdeck/src/lib/layout-imposer";
import {
  PICKER_FORM,
  REPORTER_DRIFT,
  SHEET_PANEL,
  SHEET_PANEL_TO_MEMBER_PX,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  bidMismatches,
  landed,
  launchOnQuietProject,
  pins,
  reservations,
} from "./sheet-reservation-fixture";
import {
  describePickerFit,
  pickerFit,
  pickerFitProblems,
  pickerListScrolls,
  pickerPanelNaturalHeight,
  pointPickerAt,
  removePickerSessions,
  seedPickerSessions,
  type PickerSessionsFixture,
} from "./picker-sessions-fixture";

/**
 * The Session card's own stack floor (`session-card-registration.tsx`). Named
 * here because the pin standing somewhere the floor would not put the card is
 * what separates a pin from a reservation, and that is asserted rather than
 * assumed.
 */
const SESSION_FLOOR_PX = 600;

/**
 * The opening bid this fixture SEEDS. It is no longer a copy of anything in
 * the app, because there is nothing left to copy: the declared unbound height
 * is gone, and `addCard` measures the card's opening form and bids what it
 * reads. This file seeds its deck rather than adding to it, so the number
 * below is one this fixture chose — large enough to clear both the stack floor
 * and the share the hand gives the member, which is what makes a reading here
 * distinguishable from either.
 *
 * And it is deliberately above what the picker first reports here. Every test
 * launches on a quiet project ({@link launchOnQuietProject}), so the picker
 * raises one empty group, and its claim sits well under this number. A seeded
 * bid is a number nobody measured, so that first live report disagrees with
 * it — and the first-report rule refusing that report, with a row in the
 * trace naming both numbers, is what this file asserts below ([P04],
 * [Spec S04]).
 *
 * It is NOT above every picker. The grouped picker with its list at the cap
 * claims more than this, which is the honest update {@link assertFitAtListCap}
 * makes: a report that follows a genuine change to the picker, landing over
 * the bid ([P05]).
 */
const SEEDED_OPENING_BID_PX = 640;

/**
 * A project whose Sessions list stands at its cap. The picker a quiet project
 * opens lists one empty group, and a fit read against that picker says
 * nothing about a real project's; the fixture is what makes the card here too
 * short for the picker it holds.
 */
let fixture: PickerSessionsFixture | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  fixture = seedPickerSessions("at0569");
});

afterAll(() => {
  removePickerSessions(fixture);
});

interface Rect {
  top: number;
  bottom: number;
  height: number;
}

/**
 * A two-up whose slot 0 is SPLIT between a plain card and a Session card, with
 * the shares the caller names.
 *
 * The upper member is a `hello` card rather than a second Session card for one
 * reason: an unbound Session card raises its picker the moment it activates,
 * and a fixture with two of them has two pickers up and two claims against one
 * run — which is a case the brief left open rather than the one under test.
 *
 * `openingBids` is SEEDED because this fixture seeds rather than adds:
 * `addCard` is the only thing that writes a pin, and nothing here calls it. See
 * the header for what that does and does not leave proven. The field is the
 * OPENING BID a card arrives carrying ([B02]): a floor for the arrival window,
 * cleared by a claim at least as high as it and by the sheet going.
 */
function deckShape(shares: Record<string, number>) {
  const pane = (id: string, cardId: string, slot: number) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 600, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "B", componentId: "session", title: "Session", closable: true },
      { id: "C", componentId: "hello", title: "Card C", closable: true },
    ],
    panes: [
      pane("p1", "A", 0),
      pane("p2", "B", 0),
      pane("p3", "C", 1),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "two-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p1", "p2"], shares } },
    },
    openingBids: { p2: SEEDED_OPENING_BID_PX },
    hasFocus: true,
  };
}

/** Every named pane's live frame, in viewport coordinates. */
async function rects(app: App, paneIds: string[]): Promise<Record<string, Rect>> {
  // card-dom: shell
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      ${JSON.stringify(paneIds)}.forEach(function (id) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
        if (el === null) return;
        var r = el.getBoundingClientRect();
        out[id] = { top: r.top, bottom: r.bottom, height: r.height };
      });
      return out;
    })()`,
  );
}

/**
 * The panel's natural height as the SHEET computes it — `scrollHeight` plus its
 * borders and its own margins — the overflow of that natural height against the
 * room the panel actually has, and how far the panel's own bottom edge sits
 * INSIDE the pane frame around it.
 *
 * The first two are the contract the reservation rests on: `scrollHeight` is
 * what the panel wants whether or not a cap is biting, which is what makes the
 * number stable against the room it wins, and an overflow above a pixel is the
 * panel capped short.
 *
 * `bottomSlack` is here for the PIN, and the two readings catch different
 * failures. The panel is capped against the CANVAS rather than against the pane
 * ([`clampSheetToCanvas`]), so a frame too short to hold it clips the panel with
 * the clip's own `overflow: hidden` and leaves `scrollHeight` untouched —
 * invisible to the overflow reading, and exactly the failure a height constant
 * one pixel too small produces. Negative slack is the panel hanging past the
 * frame's bottom edge.
 *
 * The panel is in the Session card's body and the frame is the shell's, so
 * `bottomSlack` compares the two edges in screen coordinates, each mapped
 * from its own page (as `panelFit` in `picker-card-arrival-fixture.ts` does).
 */
async function panelMeasure(app: App): Promise<{
  natural: number;
  overflow: number;
  bottomSlack: number;
} | null> {
  const body = await bodyOfKind(app, "session");
  const own = await body.evalJS<{ natural: number; overflow: number } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(SHEET_PANEL)});
      if (el === null) return null;
      var cs = getComputedStyle(el);
      var px = function (v) { return parseFloat(v) || 0; };
      return {
        natural:
          el.scrollHeight +
          px(cs.borderTopWidth) +
          px(cs.borderBottomWidth) +
          px(cs.marginTop) +
          px(cs.marginBottom),
        overflow: el.scrollHeight - el.clientHeight,
      };
    })()`,
  );
  if (own === null) return null;
  const frameSel = await paneOfCard(app, body.cardId);
  if (frameSel === null) return { ...own, bottomSlack: -1 };
  // card-dom: shell
  const frame = await app.getElementScreenBounds(frameSel);
  const panel = await body.getElementScreenBounds(SHEET_PANEL);
  return { ...own, bottomSlack: frame.y + frame.height - (panel.y + panel.height) };
}

/** The selector of the shell's pane frame holding `cardId`'s body, or null. */
async function paneOfCard(app: App, cardId: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var lid = document.querySelector('[data-body-placeholder][data-card-id=${JSON.stringify(cardId)}]');
      var pane = lid === null ? null : lid.closest('.tug-pane');
      return pane === null ? null : '.tug-pane[data-pane-id="' + pane.getAttribute("data-pane-id") + '"]';
    })()`,
  );
}

/** The run slot 0's column divides, as the two frames report it. */
function runOf(frames: Record<string, Rect>): number {
  return frames.p1.height + IMPOSITION_GAP_PX + frames.p2.height;
}

/**
 * How much run is left BENEATH the column's last member, read against slot
 * 1's frame — one member spanning the same vertical run, so the reading is
 * independent of the two heights the claims are about. {@link runOf} sums
 * those two and could never see a band; this is what can.
 *
 * A band is the failure from the screenshot: both members held at ceilings
 * with no weight, their heights adding up to less than the run, and the
 * surplus left as dead pixels under the lower card ([F01]).
 */
function bandBeneath(frames: Record<string, Rect>): number {
  return frames.p3.bottom - frames.p2.bottom;
}

/**
 * Point the open picker at the seeded project, which stands its Sessions list
 * at its cap and raises the claim to what the picker wants, and assert the
 * picker fits the card it stands in ([B07]).
 *
 * Filling the list is a genuine change to the picker, so the report it
 * provokes is an ordinary one rather than a first one ([P05]) — which is why
 * this is where the claim lands on a fixture whose bid was seeded rather than
 * measured. The claim is the picker with its list at its preferred height,
 * the height the card asks for when it has room, and it is a want rather than
 * a floor: the run pays the neighbour's hard floor first. In this window that
 * leaves the lower member less than the claim at either division, so the card
 * stands UNDER it — beside its neighbour, inside the run, never pushing the
 * column into a strip — and that is the case [B07] lays out for: the header,
 * the filter, the trash row and the actions all wholly inside the frame, and
 * the Sessions list the element that gave way.
 *
 * Every part is read in the card's own page, against the frame that page
 * draws, so a part hanging past the frame is a reading rather than a
 * coordinate error.
 */
async function assertFitAtListCap(app: App): Promise<void> {
  if (fixture === null) throw new Error("the picker sessions fixture was not seeded");
  await pointPickerAt(kindBody(app, "session"), fixture);
  await landed(app);
  const natural = await pickerPanelNaturalHeight(kindBody(app, "session"));
  const claimed = await reservations(app);
  const frames = await rects(app, ["p1", "p2", "p3"]);
  const fit = await pickerFit(kindBody(app, "session"));
  note(
    `with the list at its cap: panel natural ${natural ?? -1}px, the deck claims ${claimed?.p2 ?? -1}px, the card stands at ${frames.p2.height.toFixed(1)}px beside ${frames.p1.height.toFixed(1)}px`,
  );
  note(`the picker in its frame: ${describePickerFit(fit)}`);
  // ── The claim is still what the member needs for this panel — the
  //    reservation's own arithmetic, with the list at its preferred height.
  //    ──
  expect(
    Math.abs((claimed?.p2 ?? -1) - ((natural ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
    "the claim is what the member needs for this panel, not the panel's own height",
  ).toBeLessThanOrEqual(REPORTER_DRIFT);
  expect(fit, "the picker's parts are all on screen").not.toBeNull();
  if (fit === null) return;
  expect(
    pickerFitProblems(fit, PIXEL_TOL),
    "the header, filter, trash row and actions all stand inside the frame",
  ).toEqual([]);
  // ── This column cannot pay the claim, which is what makes this the short
  //    card rather than one that happened to fit — and it stands inside the
  //    run beside its neighbour's floor, rather than overflowing it. ──
  expect(
    frames.p2.height,
    "the card stands under the claim — the column has less to give",
  ).toBeLessThan((claimed?.p2 ?? 0) - PIXEL_TOL);
  expect(
    Math.abs(bandBeneath(frames)),
    "and it ends where the run ends — read against slot 1's frame, which spans it",
  ).toBeLessThanOrEqual(PIXEL_TOL);
  expect(
    pickerListScrolls(fit, PIXEL_TOL),
    "and the Sessions list is the element that gave way",
  ).toBe(true);
}

// Kept local: every file's `seed` builds its own deck and waits on its own
// readiness, so the name is shared and the function is not.
/** Seed the deck, wait for all three frames, and let the imposer settle. */
async function seed(app: App, shares: Record<string, number>): Promise<void> {
  await app.seedDeckState({ state: deckShape(shares), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await landed(app);
}

/** Activate the Session card by its title bar, in its own page, and wait for its picker. */
async function raisePicker(app: App): Promise<void> {
  await kindBody(app, "session").nativeClickAtElement('[data-testid="tug-pane-title-bar"]');
  // The picker is in the Session card's body.
  await kindBody(app, "session").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await landed(app);
}

describe.skipIf(!SHOULD_RUN)("AT0569 — an unbound Session card stands at least at its picker's height", () => {
  test(
    "the card opens at the pinned height, the neighbour holds the rest, and a session opening gives it back",
    async () => {
      const { app, tugbankPath } = await launchOnQuietProject("at0569-sheet-reservation");
      try {
        // Three parts to one. Without the pin the Session card's own share
        // would leave it a sliver and its 600px floor would hold it up; the
        // declaration stands above both, so it is the floor that binds.
        await seed(app, { p1: 3, p2: 1 });
        const before = await rects(app, ["p1", "p2", "p3"]);
        const run = runOf(before);
        note(
          `pinned division: p1=${before.p1.height.toFixed(1)} p2=${before.p2.height.toFixed(1)} of run ${run.toFixed(1)}`,
        );

        // ── The pin stands, and it is the card's own declared height. ──
        expect(
          await pins(app),
          "the pin is keyed by the host pane and carries the declared height",
        ).toEqual({ p2: SEEDED_OPENING_BID_PX });

        // ── The card stands there: the declaration is the largest floor on
        //    the member, and the one-part share the hand gave it is smaller. ──
        expect(
          Math.abs(before.p2.height - SEEDED_OPENING_BID_PX),
          `the unbound card stands at SEEDED_OPENING_BID_PX (${SEEDED_OPENING_BID_PX})`,
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── And the neighbour holds all of the rest of the run. ──
        expect(
          Math.abs(
            before.p1.height - (run - IMPOSITION_GAP_PX - SEEDED_OPENING_BID_PX),
          ),
          "the neighbour holds the run less the gap and the pinned height",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── And nothing is left BENEATH the lower member: the column divides
        //    its whole run. Read against slot 1's frame rather than against
        //    the two heights the claim is about, which could not show a band
        //    at all. A declaration that was a ceiling with no weight is what
        //    left one ([F01]). ──
        expect(
          Math.abs(bandBeneath(before)),
          "no run is left beneath the column's last member",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── The declaration is neither the stack floor nor the share. With
        //    these shares the weighted division would put the card at a
        //    quarter of the run and its 600px floor would lift it to 600; the
        //    picker's height is above both, which is why it is the number the
        //    card stands at, and why a reading here cannot be confused for
        //    either of them. ──
        expect(
          SEEDED_OPENING_BID_PX - SESSION_FLOOR_PX,
          "the declaration is above the stack floor, so it is the floor that binds",
        ).toBeGreaterThan(PIXEL_TOL);
        expect(
          (run - IMPOSITION_GAP_PX) * 0.25,
          "and above the share the hand gave it, so the share does not lift it",
        ).toBeLessThan(SEEDED_OPENING_BID_PX - PIXEL_TOL);

        await raisePicker(app);


        // ── The FIRST live report is held to the bid, and this bid was
        //    seeded rather than measured — so the report disagrees with it and
        //    is refused, with a row in the trace naming both numbers ([P04],
        //    [Spec S04]). The refusal is the point: a bid nobody measured is
        //    exactly the case the rule exists for, and the deck says so out
        //    loud instead of quietly re-targeting a settle already in flight. ──
        const refused = await bidMismatches(app);
        note(`first report against the seeded bid: ${JSON.stringify(refused)}`);
        expect(
          refused.map((m) => m.memberId),
          "the first live report on the seeded member was held to the bid",
        ).toEqual(["p2"]);
        expect(
          refused[0]?.bid,
          "and the row names the bid it was held to",
        ).toBe(SEEDED_OPENING_BID_PX);
        expect(
          Math.abs((refused[0]?.report ?? -1) - SEEDED_OPENING_BID_PX),
          "and a report far enough from it that no tolerance could have passed it",
        ).toBeGreaterThan(REPORTER_DRIFT);
        // The refused report wrote nothing, and a LATER one — the panel
        // settling a pixel or two under its own resize observer — comes
        // through the ordinary path and lands. That is the rule working
        // rather than a hole in it: the rule holds the FIRST report to the
        // bid, and a bid nobody measured loses that argument once.
        note(
          `the claim that stands after the refusal: ${JSON.stringify(await reservations(app))}`,
        );

        const panel = await panelMeasure(app);
        expect(panel, "the picker's panel is on screen").not.toBeNull();
        note(
          `panel natural ${panel?.natural ?? -1}px, overflow ${panel?.overflow ?? -1}, bottom slack ${(panel?.bottomSlack ?? -1).toFixed(1)}px`,
        );

        // ── And the panel does not clip at the pinned height, read both
        //    ways: uncapped in its own box, and inside the frame around it. ──
        expect(
          panel?.overflow ?? 999,
          "the panel stands at its natural height rather than capped short",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          panel?.bottomSlack ?? -1,
          "and its bottom edge sits inside the frame rather than clipped by it",
        ).toBeGreaterThanOrEqual(0);

        // ── The picker is up and the card has not moved for it: the
        //    declaration was already the picker's height, so there was nothing
        //    to make room for. This is what "no per-frame measurement" buys. ──
        const open = await rects(app, ["p1", "p2"]);
        expect(
          Math.abs(open.p2.height - before.p2.height),
          "raising the picker moves nothing — the card was already its height",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── The same picker over a project with more sessions than the
        //    list's cap holds — the case a real project presents, on the
        //    lower member of a split column, which is the case that clipped. ──
        await assertFitAtListCap(app);

        // ── A session opens: the picker goes with the binding, the claim and
        //    the bid come down with the sheet ([B02]), and the card falls back
        //    into the share the hand gave it. ──
        await app.bindSession("B");
        await app.body("B").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) === null`,
          { timeoutMs: 8_000 },
        );
        await landed(app);

        expect(
          await pins(app),
          "the bid came down with the sheet, absent rather than empty",
        ).toBeNull();
        expect(
          await reservations(app),
          "and the claim came down with the sheet",
        ).toBeNull();

        const settled = await rects(app, ["p1", "p2"]);
        note(
          `settled: p1=${settled.p1.height.toFixed(1)} p2=${settled.p2.height.toFixed(1)}`,
        );
        // Three parts to one over the run, with the Session card's 600px floor
        // holding its share up — which is what this fixture's shares are for.
        expect(
          Math.abs(settled.p2.height - SESSION_FLOOR_PX),
          "the bound card is back at the height its stored share gives it",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          Math.abs(settled.p1.height - (run - IMPOSITION_GAP_PX - SESSION_FLOOR_PX)),
          "and the neighbour gave the room back",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          Math.abs(settled.p2.height - before.p2.height),
          "the card really did move — the pin was doing something",
        ).toBeGreaterThan(PIXEL_TOL);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a large stored share DOES lift the unbound member — the declaration is a floor, not a ceiling",
    async () => {
      const { app, tugbankPath } = await launchOnQuietProject(
        "at0569-sheet-reservation-share-lifts",
      );
      try {
        // The shares the other way up, which is the case from the screenshot:
        // three parts of four is well clear of everything the member declares,
        // so the room goes to the card that can use it. This test asserted the
        // opposite until the declaration stopped being a ceiling — the card
        // stood at its declared height with the rest of the column left to the
        // neighbour, which is the dead band the one-rule change removed.
        await seed(app, { p1: 1, p2: 3 });
        const before = await rects(app, ["p1", "p2", "p3"]);
        const run = runOf(before);
        note(
          `share 1:3 unbound: p1=${before.p1.height.toFixed(1)} p2=${before.p2.height.toFixed(1)} of run ${run.toFixed(1)}`,
        );
        expect(
          Math.abs(before.p2.height - (run - IMPOSITION_GAP_PX) * 0.75),
          "the unbound card takes its three parts of four",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        // Read the other way, so a division that merely happened to land near
        // the declaration could not pass: the card stands ABOVE what it
        // declared, which a ceiling could never allow.
        expect(
          before.p2.height,
          "which is well above the height it declared — no ceiling held it",
        ).toBeGreaterThan(SEEDED_OPENING_BID_PX + PIXEL_TOL);
        expect(
          Math.abs(
            before.p1.height - (run - IMPOSITION_GAP_PX) * 0.25,
          ),
          "and the neighbour keeps its own one part, no more",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── The other half of the roomy case: the card that took the room
        //    reaches the bottom of the run, with no band under it. ──
        expect(
          Math.abs(bandBeneath(before)),
          "the member that took the room reaches the bottom of the run",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        await raisePicker(app);

        // The same refusal as the first test's, for the same reason: the bid
        // this fixture seeded is a number no picker measures, so the first
        // live report is held to it and written nowhere. What this test is
        // about is downstream of that — the DIVISION, which ignores the bid
        // whichever way the report went.
        const refused = await bidMismatches(app);
        note(`first report against the seeded bid: ${JSON.stringify(refused)}`);
        expect(
          refused.map((m) => m.memberId),
          "the first live report on the seeded member was held to the bid",
        ).toEqual(["p2"]);

        const panel = await panelMeasure(app);
        const open = await rects(app, ["p1", "p2"]);
        expect(
          panel?.overflow ?? 999,
          "and the panel was never capped short here either",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          panel?.bottomSlack ?? -1,
          "nor clipped by the frame around it",
        ).toBeGreaterThanOrEqual(0);
        expect(
          Math.abs(open.p2.height - before.p2.height),
          "raising the picker moves nothing — the card is already taller than the claim",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          Math.abs(open.p1.height - before.p1.height),
          "so the neighbour does not move either",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        await assertFitAtListCap(app);

        // ── And binding moves NOTHING here, which is the other half of the
        //    same fact: the card was already standing at its stored share, so
        //    dropping the declaration takes nothing away from it. Under the
        //    old ceiling this was the moment the card jumped. ──
        await app.bindSession("B");
        await app.body("B").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) === null`,
          { timeoutMs: 8_000 },
        );
        await landed(app);

        const settled = await rects(app, ["p1", "p2"]);
        note(
          `bound at 1:3: p1=${settled.p1.height.toFixed(1)} p2=${settled.p2.height.toFixed(1)}`,
        );
        expect(
          Math.abs(settled.p2.height - before.p2.height),
          "the card does not move across the binding",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          settled.p2.height,
          "the bound card takes its three parts of four, well clear of its floor",
        ).toBeGreaterThan(SESSION_FLOOR_PX + PIXEL_TOL);
        expect(
          Math.abs(settled.p2.height - (run - IMPOSITION_GAP_PX) * 0.75),
          "and the division really is the stored 3:1",
        ).toBeLessThanOrEqual(PIXEL_TOL);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
