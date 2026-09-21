/**
 * Which face a baked session chip wears, and the one token it borrows from
 * CSS to wear it.
 *
 * The chip is pixels, so this is where the decision can be checked at all:
 * `bakeAtomChipDataUri` reads theme tokens off `document.body` and paints on a
 * canvas, and tugdeck's `bun test` runs with no DOM (no jsdom, no happy-dom).
 * The two claims that need a raster — that `missing` changes no geometry, and
 * that a missing chip covered by the editor's selection still bakes dashed —
 * are pinned by the app-test that drives the real app, which is the only place
 * they are assertable rather than asserted about.
 *
 * What is pinnable here is the decision and the mirror:
 *
 *  - Only `unknown` is missing. `pending` is this client not having heard
 *    back, and dashing on it would flash every chip dashed for a round trip;
 *    `found` and `elsewhere` are both sessions a reader can reach.
 *  - The ink the bake paints a missing chip in is the same token the mounted
 *    pill's `data-missing` rule uses. A baked `<img>` cannot reach the host
 *    cascade, so the value is mirrored rather than shared — and a mirror with
 *    nothing watching it is a drift waiting to happen.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PILL_CHIP_MISSING_INK_TOKEN } from "@/lib/command-atom";
import { sessionChipVerdict } from "@/lib/session-chip-verdict";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { normalizeSessionRow, type SessionRow } from "@/protocol";
import type { AtomSegment } from "@/lib/tug-atom-img";

const FULL = "3c1f0a52-77bd-4f0e-9a11-5d2e6b8c4f30";
const VALUE = "tugtool/kind-floor";

function atom(over: Partial<AtomSegment> = {}): AtomSegment {
  return { kind: "atom", type: "session", label: VALUE, value: VALUE, ...over };
}

function row(): SessionRow {
  return normalizeSessionRow({
    session_id: FULL,
    workspace_key: "ws-1",
    project_dir: "/Users/dev/src/tugtool",
    created_at: 1,
    last_used_at: 2,
    turn_count: 3,
    last_user_prompt: null,
    state: "closed",
    card_id: null,
    name: null,
    tag: "kind-floor",
  } as Parameters<typeof normalizeSessionRow>[0]);
}

beforeEach(() => {
  sessionCitationStore.forgetAll();
});

describe("sessionChipVerdict", () => {
  test("a reference nobody has asked about yet is not missing", () => {
    // Pending and missing are different facts, and the chip says so: a dash
    // on `pending` would be every chip in the composer, for the width of one
    // round trip, every time the card opened.
    expect(sessionChipVerdict(atom())).toBe("default");
  });

  test("a session this ledger holds is not missing", () => {
    sessionCitationStore.applyResolved({
      found: [{ queried: VALUE, session: row() }],
      elsewhere: [],
      unknown: [],
    });
    expect(sessionChipVerdict(atom())).toBe("default");
  });

  test("a session ANOTHER instance recorded is not missing either", () => {
    // The whole point of the machine-wide index: this session exists and a
    // reader can read it. Dashing it would say the opposite of the truth.
    sessionCitationStore.applyResolved({
      found: [],
      elsewhere: [
        {
          queried: VALUE,
          sessionId: FULL,
          projectDir: "/Users/dev/src/tugtool",
          callsign: "kind-floor",
          title: "the find rewrite",
          instance: "other",
        },
      ],
      unknown: [],
    });
    expect(sessionChipVerdict(atom())).toBe("default");
  });

  test("a session nothing on this machine answers for is missing", () => {
    sessionCitationStore.applyResolved({
      found: [],
      elsewhere: [],
      unknown: [VALUE],
    });
    expect(sessionChipVerdict(atom())).toBe("missing");
  });

  test("the uuid is the key when the atom carries one", () => {
    // The atom's `value` spells a callsign pair; its `session.id` is what was
    // asked and answered. A verdict read under the other spelling finds a key
    // nobody filled and reads `pending` forever — which, on this surface,
    // means a chip that can never go dashed.
    sessionCitationStore.applyResolved({
      found: [],
      elsewhere: [],
      unknown: [FULL],
    });
    expect(
      sessionChipVerdict(
        atom({ session: { id: FULL, projectDir: "/Users/dev/src/tugtool" } }),
      ),
    ).toBe("missing");
  });

  test("a non-session atom is never missing", () => {
    sessionCitationStore.applyResolved({
      found: [],
      elsewhere: [],
      unknown: ["src/main.ts"],
    });
    expect(sessionChipVerdict(atom({ type: "file", value: "src/main.ts" }))).toBe(
      "default",
    );
  });
});

describe("the missing ink mirrors the CSS it copies", () => {
  test("the bake's token is the one the data-missing rule paints", () => {
    const css = readFileSync(
      join(
        import.meta.dir,
        "../../components/tugways/tug-session-identity.css",
      ),
      "utf8",
    );
    const rule = css.slice(css.indexOf('[data-missing="true"]'));
    const color = /color:\s*var\((--[a-z0-9-]+)\)/.exec(rule);
    expect(color).not.toBeNull();
    expect(color?.[1]).toBe(PILL_CHIP_MISSING_INK_TOKEN);
  });
});
