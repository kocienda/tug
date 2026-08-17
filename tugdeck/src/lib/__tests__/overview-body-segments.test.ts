/**
 * Unit tests for the Overview's mention filter — the predicate that decides
 * whether a ref is already named in the prose (and therefore already
 * clickable there, marked by the content annotator) or needs a trailing
 * chip of its own.
 */

import { describe, expect, test } from "bun:test";

import {
  bodyMentionsRef,
  unmentionedRefs,
} from "@/lib/overview-body-segments";
import type { OverviewRef } from "@/protocol";

const file = (target: string): OverviewRef => ({ kind: "file", target });
const commit = (target: string): OverviewRef => ({ kind: "commit", target });
const session = (target: string): OverviewRef => ({ kind: "session", target });

describe("bodyMentionsRef", () => {
  test("a body that never names the ref does not mention it", () => {
    expect(
      bodyMentionsRef("Fixed the flaky test.", file("tugdeck/src/main.tsx")),
    ).toBe(false);
  });

  test("the full target counts", () => {
    expect(
      bodyMentionsRef(
        "Retuned tugdeck/src/main.tsx to match.",
        file("tugdeck/src/main.tsx"),
      ),
    ).toBe(true);
  });

  test("the basename counts, so prose may drop the directories", () => {
    expect(
      bodyMentionsRef(
        "Wrote xcodebuild-quiet.sh to tame the build.",
        file("tugrust/scripts/xcodebuild-quiet.sh"),
      ),
    ).toBe(true);
  });

  test("a basename never claims the tail of a longer, different path", () => {
    expect(
      bodyMentionsRef(
        "See other/place/foo.ts for the twin.",
        file("tugdeck/src/lib/foo.ts"),
      ),
    ).toBe(false);
  });

  test("a mention closing a sentence still counts", () => {
    expect(
      bodyMentionsRef(
        "Reworked tugdeck/src/lib/layout-imposer.ts.",
        file("tugdeck/src/lib/layout-imposer.ts"),
      ),
    ).toBe(true);
  });

  test("a name embedded in a longer name does not count", () => {
    expect(bodyMentionsRef("Renamed foo.ts.bak today.", file("foo.ts"))).toBe(
      false,
    );
  });

  test("a sha spelled longer or shorter than the ref still counts", () => {
    expect(
      bodyMentionsRef("Commit 957d2350b422 landed.", commit("957d2350b")),
    ).toBe(true);
    expect(bodyMentionsRef("Commit 957d2350 landed.", commit("957d2350b"))).toBe(
      true,
    );
  });

  test("an unrelated hex run does not count as the commit", () => {
    expect(bodyMentionsRef("Commit deadbeef1 landed.", commit("957d2350b"))).toBe(
      false,
    );
  });

  test("a session ref is never suppressed by the prose", () => {
    // Its citation is a different surface with a different gesture, so the
    // prose naming the session does not make the chip a duplicate.
    expect(bodyMentionsRef("Session abc-123 did it.", session("abc-123"))).toBe(
      false,
    );
  });

  test("an empty target is never a mention", () => {
    expect(bodyMentionsRef("Anything at all.", file(""))).toBe(false);
  });
});

describe("unmentionedRefs", () => {
  test("keeps only what the prose left unsaid", () => {
    const body = "Reworked layout-imposer.ts after 957d2350b422 landed.";
    const refs = [
      file("tugdeck/src/lib/layout-imposer.ts"),
      commit("957d2350b"),
      file("tugdeck/src/lib/untouched.ts"),
    ];
    expect(unmentionedRefs(body, refs).map((r) => r.target)).toEqual([
      "tugdeck/src/lib/untouched.ts",
    ]);
  });
});
