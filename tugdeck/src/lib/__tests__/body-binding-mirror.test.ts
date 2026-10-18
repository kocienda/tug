/**
 * The shell lets go of a body card's binding only when the card let go of
 * its session — not across a rebind's masthead gap.
 *
 * A resume onto another segment rebuilds the card's stores in its body, and
 * the masthead goes away for that beat while the card's binding, and the
 * identity the body publishes from it, already name the new session. The
 * shell cleared its binding on the masthead going away, after the new
 * segment's ack had set it, and nothing set it again (`at0480`'s line facts
 * lost their card). It clears now only when the body reports neither a
 * masthead nor an identity naming a session.
 *
 * @covers tugdeck/src/lib/body-binding-mirror.ts
 * @covers tugdeck/src/lib/body-shell.ts
 */
import { describe, expect, test } from "bun:test";
import type { CardFacts } from "@tugproto/bus";
import { BodySessionHolds, bodyHoldsSession } from "../body-binding-mirror";

type Said = Pick<CardFacts, "masthead" | "identity">;

const MASTHEAD = { kind: "session" };
const NAMES = (id: string): Said["identity"] => ({ title: "tug/odd-kiln", tugSessionId: id, projectDir: "/p" });

const bound = (id: string): Said => ({ masthead: MASTHEAD, identity: NAMES(id) });
const rebinding = (id: string): Said => ({ masthead: null, identity: NAMES(id) });
const unbound: Said = { masthead: null, identity: null };

describe("a body card's session hold", () => {
  test("a masthead or an identity naming a session is a hold", () => {
    expect(bodyHoldsSession(bound("s1"))).toBe(true);
    expect(bodyHoldsSession(rebinding("s2"))).toBe(true);
    expect(bodyHoldsSession(unbound)).toBe(false);
    expect(bodyHoldsSession({ masthead: null, identity: { title: "Text" } })).toBe(false);
  });

  test("a rebind's masthead gap does not let the binding go", () => {
    const holds = new BodySessionHolds();
    expect(holds.letGo("A", bound("s1"))).toBe(false);
    expect(holds.letGo("A", rebinding("s2"))).toBe(false);
    expect(holds.letGo("A", bound("s2"))).toBe(false);
  });

  test("letting the session go does, once", () => {
    const holds = new BodySessionHolds();
    holds.letGo("A", bound("s1"));
    expect(holds.letGo("A", unbound)).toBe(true);
    expect(holds.letGo("A", unbound)).toBe(false);
  });

  test("a card that never held a session lets nothing go", () => {
    const holds = new BodySessionHolds();
    expect(holds.letGo("A", unbound)).toBe(false);
    holds.letGo("B", bound("s1"));
    holds.forget("B");
    expect(holds.letGo("B", unbound)).toBe(false);
  });
});
