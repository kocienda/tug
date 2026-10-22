/**
 * A placement names each rail member's side and order, each
 * imposed card's travel under a rail width change, each standing rail's width
 * bounds and the band, so the host can build one rail view per rail and carry
 * a rail's width drag from the pointer with the arithmetic the shell's own
 * preview uses.
 *
 * While the host carries the drag, the placement names the cards it holds
 * with the entries posted before the hold, so the shell's preview of their
 * stand-ins posts nothing; and the release forgets what was posted, so the
 * landing is posted though it reads what the preview last showed.
 *
 * @covers tugdeck/src/lib/card-placement.ts
 */
import { describe, expect, test } from "bun:test";
import { PlaceCardsGate, placeCardsOf, type BodyPlacement, type CardFacts } from "../card-placement";
import { CARD_APRON_PX } from "../chrome-placement";

const APRON = { top: CARD_APRON_PX, right: CARD_APRON_PX, bottom: CARD_APRON_PX, left: CARD_APRON_PX };

function view(cardId: string, x: number, y: number): BodyPlacement {
  return { cardId, x, y, width: 300, height: 200, visible: true, z: 0, shell: [], insets: APRON };
}

const base = { grips: [], free: false, min: { width: 0, height: 0 } };

const facts: CardFacts = {
  canvas: { x: 0, y: 28, width: 1440, height: 872 },
  zoom: 1,
  gap: 15,
  byCard: new Map([
    ["overview", { ...base, rail: { side: "left", index: 0 } }],
    ["jots", { ...base, rail: { side: "left", index: 1 } }],
    ["session", { ...base, railTravel: { kind: "fit", fraction: 0.5, slotWidth: 600 } }],
  ]),
  rails: { left: { min: 240, max: 675 } },
  band: { band: 980, flow: { offset: 12, strip: 1600 } },
};

describe("placeCardsOf names the rails", () => {
  const cards = placeCardsOf({ bodies: [view("overview", 0, 40), view("jots", 0, 260), view("session", 320, 40), view("free", 900, 40)] }, facts);
  const byId = new Map(cards.cards.map((c) => [c.cardId, c]));

  test("a member carries its side and order", () => {
    expect(byId.get("overview")?.rail).toEqual({ side: "left", index: 0 });
    expect(byId.get("jots")?.rail).toEqual({ side: "left", index: 1 });
    expect(byId.get("overview")?.railTravel).toBeUndefined();
  });

  test("an imposed card carries its travel and no membership", () => {
    expect(byId.get("session")?.railTravel).toEqual({ kind: "fit", fraction: 0.5, slotWidth: 600 });
    expect(byId.get("session")?.rail).toBeUndefined();
  });

  test("a card the measurement read no facts for carries neither", () => {
    const free = byId.get("free");
    expect(free !== undefined && "rail" in free).toBe(false);
    expect(free !== undefined && "railTravel" in free).toBe(false);
  });

  test("the message carries the rails' bounds and the band", () => {
    expect(cards.rails).toEqual({ left: { min: 240, max: 675 } });
    expect(cards.band).toEqual({ band: 980, flow: { offset: 12, strip: 1600 } });
  });

  test("a placement whose rail facts differ says something new to the host", () => {
    const without: CardFacts = { ...facts, byCard: new Map([["overview", base]]) };
    const a = JSON.stringify(placeCardsOf({ bodies: [view("overview", 0, 40)] }, facts));
    const b = JSON.stringify(placeCardsOf({ bodies: [view("overview", 0, 40)] }, without));
    expect(a).not.toBe(b);
  });
});

describe("the placement while the host holds cards", () => {
  const post = (x: number, y = 40) =>
    placeCardsOf({ bodies: [view("overview", x, y), view("jots", x, 260), view("session", 320 + x, 40)] }, facts);
  const rectOf = (cards: ReturnType<typeof post> | null, cardId: string) => cards?.cards.find((c) => c.cardId === cardId)?.x;

  test("held cards keep their last entries, the rest move, and the hold is named", () => {
    const gate = new PlaceCardsGate();
    expect(gate.offer(post(0))).not.toBeNull();
    gate.hold(["overview", "jots"]);
    const sent = gate.offer(post(30));
    expect(rectOf(sent, "overview")).toBe(rectOf(post(0), "overview"));
    expect(rectOf(sent, "jots")).toBe(rectOf(post(0), "jots"));
    expect(rectOf(sent, "session")).toBe(rectOf(post(30), "session"));
    expect(sent?.held).toEqual(["overview", "jots"]);
  });

  test("a preview that moves only held cards says nothing new", () => {
    const gate = new PlaceCardsGate();
    gate.offer(post(0));
    gate.hold(["overview", "jots", "session"]);
    expect(gate.offer(post(0))).not.toBeNull();
    expect(gate.offer(post(30))).toBeNull();
    expect(gate.offer(post(60))).toBeNull();
  });

  test("after the release every card is posted where it stands, with no hold named, even a landing the preview already read", () => {
    const gate = new PlaceCardsGate();
    gate.offer(post(0));
    gate.hold(["overview", "jots", "session"]);
    gate.offer(post(30));
    gate.release();
    const landing = gate.offer(post(30));
    expect(landing).not.toBeNull();
    expect(rectOf(landing, "overview")).toBe(rectOf(post(30), "overview"));
    expect(landing !== null && "held" in landing).toBe(false);
    expect(gate.offer(post(30))).toBeNull();
  });
});
