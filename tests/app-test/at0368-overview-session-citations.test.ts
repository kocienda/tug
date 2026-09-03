/**
 * at0368-overview-session-citations.test.ts — a session named in prose becomes
 * the live citation chip, and the run it occupies is never claimed by the
 * wrong scan.
 *
 * A `project/callsign` token is shaped EXACTLY like a relative path, and the
 * answer that tells the two apart — does the ledger hold this session? —
 * arrives asynchronously, a verdict batch after the ink is painted. Scan order
 * cannot settle that: every scan's matches land in one array sorted by offset,
 * and whichever claims the run first blocks the other permanently. So a
 * pending session candidate RESERVES its run: marked by nobody, available to
 * nobody, until the verdict lands.
 *
 * All three outcomes are asserted on the real app, because all three are
 * properties of a DOM pass over rendered markdown and there is no in-process
 * DOM to run one in:
 *
 *  1. **Reserved.** Before the ledger answers, the session-shaped run carries
 *     no annotation of any kind — not a citation, and NOT the path annotation
 *     it would have been given had the path scan been allowed to take it.
 *  2. **Confirmed.** Once the ledger answers with the session, the run becomes
 *     a live `TugSessionCitation`, portaled into the span the annotator marked.
 *  3. **Refuted.** A look-alike the ledger has never heard of stays ordinary
 *     text — no chip, not even a slashed one. An unresolvable *declared* ref
 *     wears the slashed chip; a scanned token that turns out to be nothing is
 *     just a word.
 *
 * And the other direction, which is the half a session scan can break: a real
 * repository path in the same post still ends up a path annotation.
 *
 * The ledger's answer is delivered through `dispatchControlAction`, which is
 * the production `resolve_sessions_ok` handler — the same function the wire
 * frame reaches. Everything downstream of it is production: the citation
 * store, the verdict batch, the re-mark, the portal.
 *
 * And one geometry claim about the OTHER place a session shows up in this card
 * — the narrated session's own citation, which leads the provenance strip under
 * the post body. A session name is the one run whose length the user chooses,
 * so the atom has to be able to compress to whatever width it is given: it
 * gives way in a declared order (the minted handle first, the user's own words
 * last) but it always gives way, and it never hangs out of the rail.
 *
 * A named session carries a handle to give way with only under a NAME
 * COLLISION ([D141]) — a custom name removes the callsign outright, and it
 * returns as the final disambiguation when two sessions share one name. So the
 * fixture resolves a twin that shares the short name and is posted about by
 * nothing: it exists to make the three-run grammar real, which is the same
 * device and the same reason as `at0439`.
 *
 * The strip is where it lives BECAUSE of the other half of the claim. The atom
 * used to ride the header's trailing edge, sharing one flex line with the
 * author and the clock — and whatever an over-wide atom would not give up, the
 * clock paid for by breaking across two lines. Nothing of variable width lands
 * in that header now, so the clock reads on one line no matter how long a name
 * the user chose; the assertion stays because that is the regression.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-card.css
 * @covers tugdeck/src/lib/annotator/detect-session-ref.ts
 * @covers tugdeck/src/lib/annotator/session-resolution.ts
 * @covers tugdeck/src/lib/annotator/annotate-content.ts
 * @covers tugdeck/src/lib/annotator/wrap-matches.ts
 * @covers tugdeck/src/components/tugways/session-citation-portals.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/tug-session-identity.css
 * @covers tugdeck/src/lib/session-identity.ts
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.css
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-testid="overview-card"]';
const BODY = `${CARD} .overview-post-body`;

/** This checkout — so the post's paths resolve through the real chain. */
const REPO_ROOT = resolve(import.meta.dir, "../..");
/** Its leaf name, which is what a `project/callsign` spelling carries. */
const PROJECT = REPO_ROOT.split("/").pop()!;

const SESSION_ID = "b3c4d5e6-1a2b-4c3d-8e4f-5a6b7c8d9e02";
const HELD = "brisk-lantern";
const MISSING = "imaginary-lantern";

/** The ledger's answer, through the production `resolve_sessions_ok` handler. */
function resolveSessions(): string {
  return `window.__tug.dispatchControlAction("resolve_sessions_ok", ${JSON.stringify({
    sessions: [
      {
        queried: HELD,
        session: {
          session_id: SESSION_ID,
          workspace_key: "ws-1",
          project_dir: REPO_ROOT,
          created_at: 1_754_600_000_000,
          last_used_at: 1_754_600_100_000,
          turn_count: 4,
          last_user_prompt: null,
          state: "closed",
          card_id: null,
          name: null,
          tag: HELD,
        },
      },
    ],
    unknown: [MISSING],
  })})`;
}

/** What every session-shaped run in the post currently is. */
const RUNS_JS = `(function () {
  var body = document.querySelector(${JSON.stringify(BODY)});
  if (body === null) return null;
  function classify(needle) {
    var wrapped = Array.from(body.querySelectorAll("[data-tug-annotation]"))
      .find(function (el) {
        var text = (el.textContent || "") + (el.getAttribute("data-tugx-session-text") || "");
        return text.indexOf(needle) !== -1;
      });
    return wrapped === undefined
      ? null
      : {
          kind: wrapped.getAttribute("data-tug-annotation"),
          target: wrapped.getAttribute("data-target"),
          chip: wrapped.querySelector('[data-slot="tug-session-identity"], .tug-session-identity') !== null,
        };
  }
  return {
    held: classify(${JSON.stringify(`${PROJECT}/${HELD}`)}),
    missing: classify(${JSON.stringify(`${PROJECT}/${MISSING}`)}),
    path: classify("tugdeck/src/lib/overview-store.ts"),
    text: (body.textContent || "").replace(/\\s+/g, " ").trim(),
    awaiting: body.querySelector("[data-tugx-awaiting]") !== null
      || (body.firstElementChild !== null
          && body.firstElementChild.hasAttribute("data-tugx-awaiting")),
  };
})()`;

interface Run {
  kind: string | null;
  target: string | null;
  chip: boolean;
}

interface Runs {
  held: Run | null;
  missing: Run | null;
  path: Run | null;
  text: string;
  awaiting: boolean;
}

/* ── The narrated-citation claim's fixtures. ───────────────────────────── */

const NAMED_SHORT = "c4d5e6f7-1a2b-4c3d-8e4f-5a6b7c8d9e03";
const NAMED_LONG = "d5e6f7a8-1a2b-4c3d-8e4f-5a6b7c8d9e04";
/**
 * A session nothing posts about, resolved only so that it SHARES
 * {@link SHORT_NAME} with {@link NAMED_SHORT}.
 *
 * Under [D141] a custom name removes the callsign from a title outright, and
 * it returns only when two sessions share one name. So the three-run grammar
 * whose elision order this claim measures does not otherwise exist on a named
 * session — there would be no handle to give way first. The twin is what makes
 * the run real, the same device `at0439` uses for the same reason.
 *
 * `resolve_sessions_ok` seeds the name store (`session-citation-store.ts`), so
 * a row in that frame is enough to create the collision; it needs no post.
 */
const NAMED_TWIN = "e6f7a8b9-1a2b-4c3d-8e4f-5a6b7c8d9e05";

/** A name the rail holds whole with room to spare — the screenshot's own. */
const SHORT_NAME = "arc-integration-1";
/**
 * A name past the strip's own width, so the run that carries it has to elide
 * even with the whole row to itself. The strip measures ~500px at the
 * Overview's registered width and this spells to half again that, so the claim
 * does not rest on the rail being any exact size.
 */
const LONG_NAME =
  "arc-integration-phase-two-attachment-parity-and-composer-metrics-and-the-follow-on-sweep-that-came-after-it";
/** Minted handles long enough that both atoms are genuinely over-wide. */
const SHORT_TAG =
  "violet-mesa-plateau-of-considerable-length-with-an-escarpment-and-a-long-ridge-beyond";
const LONG_TAG = "amber-thicket-escarpment-of-similar-length";
/** The twin's own handle — distinct, so only the NAME is what collides. */
const TWIN_TAG = "cobalt-spur-ridgeline-of-no-particular-consequence";

/** One resolvable row, as the ledger's answer carries it. */
function namedRow(sessionId: string, name: string, tag: string): unknown {
  return {
    queried: sessionId,
    session: {
      session_id: sessionId,
      workspace_key: "ws-1",
      project_dir: REPO_ROOT,
      created_at: 1_754_600_000_000,
      last_used_at: 1_754_600_100_000,
      turn_count: 2,
      last_user_prompt: null,
      state: "closed",
      card_id: null,
      // `name_user_set` is what makes the name the user's own word rather
      // than a synopsis — only then does it lead the atom's title.
      name,
      name_user_set: true,
      tag,
    },
  };
}

function resolveNamedSessions(): string {
  return `window.__tug.dispatchControlAction("resolve_sessions_ok", ${JSON.stringify(
    {
      sessions: [
        namedRow(NAMED_SHORT, SHORT_NAME, SHORT_TAG),
        namedRow(NAMED_LONG, LONG_NAME, LONG_TAG),
        namedRow(NAMED_TWIN, SHORT_NAME, TWIN_TAG),
      ],
      unknown: [],
    },
  )})`;
}

/**
 * Each post's geometry, in document order: the clock in its header, and the
 * session atom leading its provenance strip.
 *
 * "Elided" is `scrollWidth > clientWidth` on the run itself — the run's text
 * is wider than the box it was given, which is exactly the condition
 * `text-overflow: ellipsis` paints. Reading the rendered string instead would
 * not work: the ellipsis is painted, never inserted, so `textContent` is the
 * whole name either way.
 */
const POSTS_JS = `Array.from(
  document.querySelectorAll(${JSON.stringify(`${CARD} .overview-cell`)}),
)
  .filter(function (cell) {
    return cell.querySelector(".overview-post-refs .tug-session-identity") !== null;
  })
  .map(function (cell) {
    var clock = cell.querySelector(".tug-transcript-entry__timestamp time");
    var strip = cell.querySelector(".overview-post-refs");
    var chip = strip.querySelector(".tug-session-identity");
    var name = chip.querySelector(".tug-session-identity-name");
    var callsign = chip.querySelector(".tug-session-identity-callsign");
    return {
      clockLines: clock === null ? 0 : clock.getClientRects().length,
      // The atom leads the strip, so it is the strip's first element child.
      leadsStrip: strip.firstElementChild === chip,
      stripWidth: Math.round(strip.getBoundingClientRect().width),
      stripRight: Math.round(strip.getBoundingClientRect().right),
      chipRight: Math.round(chip.getBoundingClientRect().right),
      nameText: name === null ? "" : (name.textContent || "").trim(),
      nameElided: name !== null && name.scrollWidth > name.clientWidth,
      hasCallsignRun: callsign !== null,
    };
  })`;

interface Post {
  clockLines: number;
  leadsStrip: boolean;
  stripWidth: number;
  stripRight: number;
  chipRight: number;
  nameText: string;
  nameElided: boolean;
  hasCallsignRun: boolean;
}

describe.skipIf(!SHOULD_RUN)("at0368 — sessions named in Overview prose", () => {
  test(
    "a reserved run is claimed by neither scan, then becomes a citation or plain text",
    async () => {
      const app = await launchTugApp({
        testName: "at0368-overview-session-citations",
      });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // One post naming three things: a session the ledger will hold, a
        // look-alike it will not, and a real file. All three are shaped alike
        // enough to contend.
        const post = {
          id: 9201,
          at_ms: 1_754_600_000_000,
          author: "observer",
          body: `Session ${PROJECT}/${HELD} finished its turn while ${PROJECT}/${MISSING} sat idle; both touched tugdeck/src/lib/overview-store.ts today.`,
          // A ref is what makes the card acquire this post's workspace
          // (`useOverviewRefRoots`), and the workspace is what mints the path
          // and commit resolvers the annotation context runs on. Without one
          // the post's prose has nothing to resolve against.
          refs: [{ kind: "file", target: "tugdeck/src/lib/overview-store.ts" }],
          project_dir: REPO_ROOT,
        };
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
          ),
        ).toBe(true);

        // ---- 1. Reserved: the path resolves, the sessions do not yet. ----
        await app.waitForCondition<boolean>(
          `(function () {
            var body = document.querySelector(${JSON.stringify(BODY)});
            return body !== null
              && body.querySelector('[data-tug-annotation="file-path"]') !== null;
          })()`,
          { timeoutMs: 25_000 },
        );
        const pending = await app.evalJS<Runs>(RUNS_JS);
        note("while the ledger is being asked", JSON.stringify(pending));
        // Neither session run is marked — and crucially neither is a
        // `file-path`, which is what the path scan would have made of a
        // `project/callsign` token had the reservation not held the run.
        expect(pending.held).toBeNull();
        expect(pending.missing).toBeNull();
        // The real path was never in contention and resolved normally.
        expect(pending.path?.kind).toBe("file-path");
        // Every character is still on screen: a reservation marks nothing and
        // changes nothing.
        expect(pending.text).toContain(`${PROJECT}/${HELD}`);
        expect(pending.text).toContain(`${PROJECT}/${MISSING}`);

        // ---- 2 & 3. The ledger answers: one session, one miss. ----
        await app.evalJS<unknown>(resolveSessions());

        // Waited on the CHIP rather than on the mark: the mark is the
        // annotator's layout pass, the chip is the React commit that follows
        // it, and asserting between the two is a race the mark always wins.
        await app.waitForCondition<boolean>(
          `(function () {
            var body = document.querySelector(${JSON.stringify(BODY)});
            return body !== null
              && body.querySelector('[data-tug-annotation="session"] [data-slot="tug-session-identity"]') !== null;
          })()`,
          { timeoutMs: 15_000 },
        );
        const settled = await app.evalJS<Runs>(RUNS_JS);
        note("after the ledger answered", JSON.stringify(settled));

        // The held session is a citation, carrying the FULL id however the
        // prose spelled it, with the live chip portaled into the run.
        expect(settled.held?.kind).toBe("session");
        expect(settled.held?.target).toBe(SESSION_ID);
        expect(settled.held?.chip).toBe(true);

        // The look-alike is nothing at all — not a chip, not a slashed one,
        // not a path. Just words.
        expect(settled.missing).toBeNull();
        expect(settled.text).toContain(`${PROJECT}/${MISSING}`);

        // And the path is still a path: a session scan that stole path runs
        // would show here.
        expect(settled.path?.kind).toBe("file-path");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the narrated citation leads the provenance strip and compresses to it, and the clock never wraps",
    async () => {
      const app = await launchTugApp({ testName: "at0368-overview-post-atom" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // Two posts, two narrated sessions, one difference: how long a name
        // the user gave. Both are wider than the rail can spell in full, so
        // both atoms are under a squeeze — the question each answers is WHICH
        // run pays for it. Neither post declares a ref, so the strip each one
        // grows holds the narrated session and nothing else.
        for (const post of [
          {
            id: 9301,
            at_ms: 1_754_600_000_000,
            author: "observer",
            body: "A short custom name, on a session whose minted handle is long.",
            refs: [],
            session_id: NAMED_SHORT,
            project_dir: REPO_ROOT,
          },
          {
            id: 9302,
            at_ms: 1_754_600_060_000,
            author: "observer",
            body: "A name long enough that nothing else on the row could fit beside it.",
            refs: [],
            session_id: NAMED_LONG,
            project_dir: REPO_ROOT,
          },
        ]) {
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
            ),
          ).toBe(true);
        }

        // The atoms mount inert and ask the ledger; this is the ledger
        // answering, through the production handler.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(
            ${JSON.stringify(`${CARD} .overview-post-refs .tug-session-identity`)}).length === 2`,
          { timeoutMs: 15_000 },
        );
        await app.evalJS<unknown>(resolveNamedSessions());
        await app.waitForCondition<boolean>(
          `(function () {
            var runs = document.querySelectorAll(
              ${JSON.stringify(`${CARD} .overview-post-refs .tug-session-identity-name`)});
            return runs.length === 2 && (runs[1].textContent || "").length > 0;
          })()`,
          { timeoutMs: 15_000 },
        );

        const posts = await app.evalJS<Post[]>(POSTS_JS);
        note("post atoms", JSON.stringify(posts));
        expect(posts.length, "one strip per post").toBe(2);

        for (const post of posts) {
          // Where the atom sits is the whole point of the move: the first
          // thing the post rests on, at the head of the row that names what a
          // post rests on.
          expect(post.leadsStrip, "the atom leads the strip").toBe(true);
          // THE bug this pins: an atom sharing the header's flex line could
          // not compress far enough, and the clock paid by breaking in two. A
          // wrapped inline element reports one client rect per line, so this
          // is the wrap itself, measured — not a height compared against a
          // guess.
          expect(post.clockLines, "the clock reads on one line").toBe(1);
          // And the atom stayed inside its row rather than overhanging it —
          // compression, not overflow. One pixel of slack for subpixel layout.
          expect(
            post.chipRight - post.stripRight,
            "the atom ends inside the strip",
          ).toBeLessThanOrEqual(1);
        }

        // What a named row shows, read off the two rows. A custom name means
        // NO handle beside it, unconditionally ([D141]) — the name is unique,
        // because the ledger takes it from anyone already wearing it, so there
        // is nothing left for a handle to disambiguate. This row and the one
        // below are both named, and neither carries a callsign run.
        //
        // The fixture still seeds two sessions with the same name: what it now
        // pins is that even a client map momentarily holding both — a push in
        // flight, a stale row — puts no handle on either.
        for (const post of posts) {
          expect(
            post.hasCallsignRun,
            "a custom name means no callsign run at all",
          ).toBe(false);
        }
        // Short name: the row can hold it, so it is shown whole.
        expect(
          posts[0]!.nameElided,
          "and a name this row can hold is shown whole",
        ).toBe(false);
        expect(posts[0]!.nameText).toBe(SHORT_NAME);

        // Long name: past the row's width the name elides. It has to be ABLE
        // to — a run that refuses to shrink is what breaks the row it sits in.
        expect(
          posts[1]!.nameElided,
          "a name past the row's width elides rather than pushing",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
