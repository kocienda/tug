/**
 * at0365-overview-card.test.ts — the Overview rail, from the chord to the answer.
 *
 * The Overview is the app's narration channel: a sidebar card reading one
 * scrolling column of posts, oldest at the top, written by three voices. Nothing
 * about it is per-session, so there is no session card to stand it up beside and
 * no transcript to seed — the whole surface is the rail, the posts in it, and
 * the composer under them.
 *
 * Three claims, in the order a user meets them:
 *
 *  1. **The chord opens the rail.** ⌃⌘O, posted as a real keystroke, brings up
 *     the card; a second press puts it away. The binding is registry-routed and
 *     menu-eligible, so this exercises the chord table and the menu item's
 *     handler at once — the two places a sidebar toggle can be wired wrong.
 *     Arriving also engages keyboard-focus mode, because the card registers
 *     `kbfAtRest` — and a card that engages the mode has to have a stop to put
 *     the keyboard on. Overview's first stop is its composer, a text stop the
 *     engagement seeds, so the arrival state is a granted caret with the
 *     mode's paint standing down ([#kbf-paint-route]), asserted alongside.
 *  2. **A post renders as its author wrote it.** Frames go in through
 *     `publishOverviewPost`, which hands the bytes to the production parser and
 *     the production fold, so what lands on screen came off the same code path a
 *     live Observer's would. Asserted: one row per post, in arrival order, each
 *     carrying its author's glyph, and a post's unmentioned refs rendering
 *     as the app's own read-only atom skin, labelled by the target's last
 *     segment.
 *     Everything is REAL: the posts carry this repo as their
 *     `project_dir`, the paths exist, and the sha is this checkout's own
 *     HEAD, so the assertions watch the production chain (workspace acquire
 *     → fs stat / git commit-files) confirm them. The load-bearing claim is
 *     that the PROSE is annotated: a file and a sha named in a sentence but
 *     absent from the post's ref list still become clickable, because the
 *     content annotator scans the text rather than matching the ref list.
 *     The ref list feeds only the trailing provenance strip, and only for
 *     entries the prose never named — and the strip sits at the END of the
 *     content, above the Z1B, where "the rest of what this post rests on"
 *     belongs.
 *     The body is MARKDOWN, through the Session transcript's own
 *     `TugMarkdownBlock`: a backticked name renders as a code span with no
 *     literal backticks left in the reader's text, and the span is annotated
 *     because it is a code span; a bare URL renders as a real anchor.
 *  3. **The composer completes a round trip.** Typing a question and pressing
 *     the send button sends OVERVIEW_INPUT; the Operator echoes the question as a user post
 *     and then answers. Under the app-test gate the agent pool answers nothing
 *     by design, so what comes back is the transient "couldn't answer" post —
 *     which is the assertion that matters here. The question left the card,
 *     reached the Operator, and the Operator's reply came back and cleared the
 *     pending row. Answer *quality* is not an app-test's business (it has no
 *     model behind it); the round trip is.
 *     Then the same round trip **with a file pointed at**: `@`-complete a real
 *     path into the composer through the live FILETREE provider, send, and
 *     find the path on the question post that comes back. The atom is doing
 *     two jobs there — it flattens into the sentence, and it rides the wire as
 *     a structured ref tugcast verifies against the tree before the first verb
 *     runs. The wire itself is covered by tugcast's own tests and the deck's
 *     `encodeOverviewInput` tests; what only the app can prove is that the
 *     gesture a person makes reaches the post.
 *
 * One further claim, on its own app because it is a whole second round trip:
 *
 *  4. **A picture is part of a question, both ways.** An image dropped on the
 *     composer previews where it was dropped — the Session composer's own
 *     attachment strip, tiles and ✕ and all — and then renders in the post it
 *     was sent with. Nothing along that path is stubbed: the drop runs the
 *     substrate's real downsample pipeline, the bytes ride OVERVIEW_INPUT, the
 *     Operator writes them beside the ledger and records the paths on the
 *     question's row, and the strip in the transcript reads them back through
 *     `/api/fs/blob`. A tile with `naturalWidth > 0` at each end is the
 *     assertion, because pixels are the only evidence that every link in that
 *     chain held. And it is the RAIL'S tier of that strip: the Overview asks
 *     the Session card's own component for `compact`, so the tiles step down
 *     a size and the sheet opens as a panel on the rail — with real margin at
 *     both edges — rather than a lid over it.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-card.css
 * @covers tugdeck/src/components/overview/overview-card-registration.tsx
 * @covers tugdeck/src/lib/overview-store.ts
 * @covers tugdeck/src/protocol.ts
 * @covers tugdeck/src/lib/overview-attachment-bytes.ts
 * @covers tugdeck/src/components/tugways/cards/tug-attachment-preview.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-attachment-preview.css
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/overview-ref-resolve.ts
 * @covers tugdeck/src/lib/overview-body-segments.ts
 * @covers tugdeck/src/components/tugways/entity-tips.tsx
 * @covers tugdeck/src/lib/contextual-stamp.ts
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.css
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor.css
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-testid="overview-card"]';
const POST = `${CARD} .overview-cell`;
const PENDING = '[data-testid="overview-pending-row"]';
const BODY = `${CARD} .overview-post-body`;
const FIELD = '[data-testid="overview-composer-field"]';
const SEND = '[data-testid="overview-composer-send"]';

/** One post as the wire carries it. `id` is the ledger rowid a real post has. */
interface WirePost {
  id: number;
  at_ms: number;
  author: "observer" | "operator" | "user" | "tripwire";
  body: string;
  refs: { kind: string; target: string }[];
  session_id?: string;
  wake_reason?: string;
  elapsed_ms?: number;
  project_dir?: string;
}

/** This checkout — the posts' `project_dir`, so refs resolve against the
 *  real repo through the real chain rather than a fixture tree. */
const REPO_ROOT = resolve(import.meta.dir, "../..");

/** This checkout's own HEAD — a sha `git show` genuinely answers for. */
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT })
  .toString()
  .trim();

/** Its subject line — what a hover over that sha has to be able to say. */
const HEAD_SUBJECT = execSync("git log -1 --format=%s HEAD", { cwd: REPO_ROOT })
  .toString()
  .trim();

async function publish(app: App, post: WirePost): Promise<boolean> {
  return app.evalJS<boolean>(
    `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
  );
}

/** Each rendered row's author and body text, in document order. */
const ROWS_JS = `Array.from(document.querySelectorAll(${JSON.stringify(POST)}))
  .filter(function (el) { return !el.hasAttribute("data-pending"); })
  .map(function (el) {
    var body = el.querySelector(".overview-post-body");
    return {
      author: el.getAttribute("data-author"),
      identifier: (function () {
        var i = el.querySelector(".tug-transcript-entry__identifier");
        return i === null ? null : (i.textContent || "").trim();
      })(),
      body: (body === null ? "" : body.textContent || "").trim(),
      chips: Array.from(
        el.querySelectorAll(
          '.overview-post-refs .tug-atom-ref, .overview-post-refs [data-slot="tug-commit-atom"]',
        ),
      )
        .map(function (c) { return (c.textContent || "").trim(); }),
      glyph: el.querySelector(".tug-transcript-entry__icon svg") !== null,
      glyphPx: (function () {
        var s = el.querySelector(".tug-transcript-entry__icon svg");
        return s === null ? 0 : Math.round(s.getBoundingClientRect().width);
      })(),
      stamp: (function () {
        var t = el.querySelector(".tug-transcript-entry__timestamp time");
        return t === null ? null : (t.textContent || "").trim();
      })(),
      z1b: (function () {
        var z = el.querySelector(".overview-post-z1b");
        return z === null ? null : (z.textContent || "").replace(/\\s+/g, " ").trim();
      })(),
    };
  })`;

interface Row {
  author: string;
  identifier: string | null;
  body: string;
  chips: string[];
  glyph: boolean;
  glyphPx: number;
  stamp: string | null;
  z1b: string | null;
}

const AT_MS = 1_754_600_000_000;

describe.skipIf(!SHOULD_RUN)("at0365 — the Overview card", () => {
  test(
    "⌃⌘O raises the rail, posts render with their glyphs and chips, and the composer round-trips",
    async () => {
      const app = await launchTugApp({ testName: "at0365-overview-card" });
      try {
        // ── 1. The chord opens the rail. ──────────────────────────────────
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // And puts it away again — a toggle, not an open.
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) === null`,
          { timeoutMs: 10_000 },
        );

        // The chord this card used to answer to is now nobody's, and driving
        // it has to leave the rail shut. Asserting that directly would race
        // the keystroke — "still absent" is true a moment before the app has
        // even read the event. So the NEXT chord carries the proof: the rail
        // is down, ⌃⌘G runs, and ⌃⌘O is expected to bring it UP. Had ⌃⌘G
        // opened it, ⌃⌘O would put it away and the wait below would time out
        // rather than pass. This is also what makes the claim about the
        // binding MOVING rather than gaining a second spelling — the positive
        // claim above passes either way.
        await app.nativeKey("g", ["cmd", "ctrl"]);

        // Back up for the rest of the test.
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // ── 1b. The rail engages KBF, and it has somewhere to put the caret. ─
        // Overview registers `kbfAtRest` (Class B): arriving here engages
        // keyboard-focus mode with no gesture at all. A card that engages the
        // mode owes it a stop — "an empty group never holds the keyboard" at
        // card scale — and Overview's first stop is its composer, a text stop
        // the engagement SEEDS: a seed is a placement, so it grants rather
        // than parks, the caret lands in the field, and the mode's
        // paint stands down for it (`data-kbf` keys on the route —
        // [#kbf-paint-route]). So the assertion is all three halves together:
        // the mode is ON (`kbfEngaged`), the paint is DOWN, and the caret is
        // in the composer. A ring here alongside the caret is the pre-(B)
        // coexistence bug; paint up with no caret means the seed never landed.
        await app.waitForCondition<boolean>(
          `window.__tug.kbfEngaged() === true &&
           !document.documentElement.hasAttribute("data-kbf") &&
           (function () {
             var field = document.querySelector(${JSON.stringify(`${CARD} [data-testid="overview-composer-field"]`)});
             return field !== null && document.activeElement !== null &&
               field.contains(document.activeElement);
           })()`,
          { timeoutMs: 10_000 },
        );
        note(
          "arrival",
          await app.evalJS<string>(
            `(function () {
              var ringed = document.querySelector(${JSON.stringify(`${CARD} [data-key-view-kbd]`)});
              var active = document.activeElement;
              return JSON.stringify({
                engaged: window.__tug.kbfEngaged(),
                kbf: document.documentElement.hasAttribute("data-kbf"),
                ringed: ringed === null ? null : (ringed.getAttribute("data-testid") || ringed.tagName),
                active: active === null ? null : (active.getAttribute("data-slot") || active.tagName),
              });
            })()`,
          ),
        );

        // ── 2. Posts render as their authors wrote them. ──────────────────
        // The transcript is the surface the folds land on; wait for it to
        // mount before feeding the store anything.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${CARD} .overview-transcript`)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // The post shape that exposed the old matcher: the prose names one
        // real file, and the ref list names a DIFFERENT one. The mention has
        // to atomize because it is in the sentence — no ref backs it — and
        // the unmentioned ref has to ride the trailing strip. Under the old
        // ref-matching placement the sentence stayed dead text and only the
        // unrelated chip appeared.
        const observerPost: WirePost = {
          id: 9001,
          at_ms: AT_MS,
          author: "observer",
          body: "Reworked overview-ref-resolve.ts and left the imposer alone.",
          refs: [{ kind: "file", target: "tugdeck/src/lib/layout-imposer.ts" }],
          wake_reason: "sitrep",
          // Clocked on the wire — tugcast times every agent run — but a
          // Observer's row must not READ it out. See the assertion below.
          elapsed_ms: 4_200,
          project_dir: REPO_ROOT,
        };
        const operatorPost: WirePost = {
          id: 9002,
          at_ms: AT_MS + 60_000,
          author: "operator",
          body: "Two sessions touched that file today.",
          refs: [],
          // The answer's own time — the reader asked and waited on it, so the
          // Z1B reads it, the way a session turn reports its time.
          elapsed_ms: 4_200,
        };
        // The commit half of the same shape: a sha spelled in the prose with
        // NO commit ref at all behind it. Git confirms it, so it annotates —
        // the case where the model cited one sha in the sentence and listed
        // another in its refs, and the sentence's went unmarked.
        const commitPost: WirePost = {
          id: 9003,
          at_ms: AT_MS + 120_000,
          author: "observer",
          body: `Commit ${HEAD_SHA.slice(0, 12)} landed the sticky-header fixes; verified against ${HEAD_SHA.slice(0, 12)}; see commit \`${HEAD_SHA.slice(0, 12)}\`.`,
          refs: [],
          wake_reason: "turn-end",
          project_dir: REPO_ROOT,
        };
        // The fourth voice. A wire speaks because an event it was watching
        // for happened — nobody asked it a question — and the row has to say
        // so: the author names the voice, `wake_reason` names which wire, and
        // the arc chip is the one ref kind no path lookup could ever resolve.
        const tripwirePost: WirePost = {
          id: 9010,
          at_ms: AT_MS + 240_000,
          author: "tripwire",
          body: "The edit program went stale against a tree that had moved on.",
          refs: [{ kind: "arc", target: "wire-tugedit-abc12345" }],
          wake_reason: "wire:tugedit",
          project_dir: REPO_ROOT,
        };

        expect(
          await publish(app, observerPost),
          "the store is attached, so the frame was accepted",
        ).toBe(true);
        expect(await publish(app, operatorPost)).toBe(true);
        expect(await publish(app, commitPost)).toBe(true);
        expect(
          await publish(app, tripwirePost),
          "the tripwire author survives the parse edge",
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length >= 4`,
          { timeoutMs: 10_000 },
        );

        const rows = await app.evalJS<Row[]>(ROWS_JS);
        note("rendered rows", JSON.stringify(rows));

        expect(rows.length, "one row per published post").toBe(4);

        // Arrival order, oldest first — the channel is read as a running feed.
        expect(rows[0]!.author).toBe("observer");
        expect(rows[0]!.body).toBe(observerPost.body);
        expect(rows[1]!.author).toBe("operator");
        expect(rows[1]!.body).toBe(operatorPost.body);
        expect(rows[2]!.author).toBe("observer");
        expect(rows[2]!.body).toContain("landed the sticky-header fixes");

        // The tripwire row: its own author, its own label, and an arc chip
        // that a path resolver would have rendered inert.
        expect(rows[3]!.author).toBe("tripwire");
        expect(rows[3]!.identifier).toBe("Tripwire");
        expect(rows[3]!.body).toBe(tripwirePost.body);
        expect(
          rows[3]!.chips,
          "an arc chip names the arc, not a basename of it",
        ).toContain("wire-tugedit-abc12345");

        // Every row leads with its author's glyph — the only thing on the row
        // that says who is speaking.
        for (const row of rows) {
          expect(row.glyph, `${row.author}'s row carries a glyph`).toBe(true);
        }

        // And the two Overview voices are OPTICALLY sized rather than sharing
        // the row's one box. A glyph's size is the side of its square, not how
        // large it reads: the Observer's newspaper inks nearly the whole
        // square and the Operator sprite carries margin inside its viewBox, so
        // at one shared number the first out-weighed the row above it and the
        // second read a size below.
        //
        // Measured, because the first attempt at this correction was written
        // on the icon registry's `size` prop and changed nothing — the card's
        // own `em` rule overrides that prop, so both voices went on painting
        // at the same width. An eye can judge whether the pair is right; only
        // a measurement can tell a pair apart from a change that never reached
        // the render.
        expect(
          rows[0]!.glyphPx,
          "the Observer is drawn under the box",
        ).toBeLessThan(17);
        expect(
          rows[1]!.glyphPx,
          "the Operator is drawn over it",
        ).toBeGreaterThan(17);

        // A ref the prose did not name rides the trailing strip as an ATOM —
        // the app's own `TugAtomRef`, the read-only skin, labelled by the
        // target's last segment, with the whole path on the wrapper's tooltip
        // because the rail is too narrow to spell a path twice. No box: the
        // box is the editable skin's, and nothing in this row is manipulable
        // where it sits.
        expect(rows[0]!.chips).toEqual(["layout-imposer.ts"]);
        expect(rows[1]!.chips, "a post with no refs shows no atoms").toEqual([]);
        expect(
          rows[2]!.chips,
          "the sha is in the sentence, so it needs no chip repeating it",
        ).toEqual([]);

        // Every post carries the transcript's own end-state row under its
        // body: the OK badge and the text+icon COPY, in the Session card's
        // vocabulary.
        for (const row of rows) {
          expect(row.z1b, `${row.author}'s row carries a Z1B`).toContain("OK");
          expect(row.z1b, `${row.author}'s COPY is text+icon`).toContain("Copy");
        }
        // EVERY voice is stamped — the Observer's narration included. "When
        // did this arrive?" is a fact about all three posts, and the column's
        // order cannot answer it.
        for (const row of rows) {
          expect(
            row.stamp,
            `${row.author}'s header carries a clock`,
          ).toMatch(/\d/);
        }

        // Elapsed, though, is the OPERATOR'S alone, and both of these posts are
        // clocked at 4.2s on the wire — so the two rows differ only by who is
        // speaking. The Operator's post is an answer the reader waited on, so
        // how long it took is part of what happened; the Observer's arrived
        // unbidden, and a duration on it is a number about nobody. That is a
        // different question from WHEN, which is why the stamp above is on both.
        expect(
          rows[1]!.z1b,
          "the Operator's answer reports how long it took",
        ).toContain("4.2s");
        expect(
          rows[0]!.z1b,
          "the Observer's post reads no elapsed, clocked or not",
        ).not.toContain("4.2s");

        // ── 2b. The PROSE is annotated, by the app's own annotator. ───────
        // This is the claim the card exists to keep: a file named in a
        // sentence becomes clickable because it is in the sentence. Post 1's
        // body names `overview-ref-resolve.ts` and its ref list does NOT —
        // under the ref-matching placement this replaced, that mention could
        // never be found, because the matcher only ever looked for targets
        // the model had already listed. The mark is the annotator's own
        // (`data-tugx-wrapped` + the payload dataset), so the click, the
        // menu and the hover are the same ones every annotated surface has.
        const INLINE_FILE = `${POST} .overview-post-body [data-tugx-wrapped][data-tug-annotation="file-path"]`;
        // Both halves in the SAME condition. The mark lands in two beats —
        // the wrapper carries `data-path` from the resolver before the run's
        // text is back under it — so waiting on the path alone and then
        // reading the text in a second round trip catches an empty wrapper
        // about half the time.
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(INLINE_FILE)});
            if (el === null) return false;
            var path = el.getAttribute("data-path");
            return path !== null
              && path.indexOf("overview-ref-resolve.ts") !== -1
              && (el.textContent || "").trim() !== "";
          })()`,
          { timeoutMs: 20_000 },
        );
        const inlineFile = await app.evalJS<{
          text: string;
          path: string | null;
        } | null>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(INLINE_FILE)});
            if (el === null) return null;
            return {
              text: (el.textContent || "").trim(),
              path: el.getAttribute("data-path"),
            };
          })()`,
        );
        note("inline file mention", JSON.stringify(inlineFile));
        // Marked in place: the run is the words the model wrote, and the
        // payload is the absolute path the resolver confirmed.
        expect(inlineFile?.text).toBe("overview-ref-resolve.ts");
        expect(inlineFile?.path?.startsWith("/")).toBe(true);

        // The commit half, same claim: a sha spelled in the prose with no ref
        // behind it at all. Git confirms it, and the answer that verifies it
        // also describes it — the hover carries the subject and the file
        // count, because eight characters of hex name nothing on their own.
        const INLINE_COMMIT = `${POST} .overview-post-body [data-tugx-wrapped][data-tug-annotation="commit-sha"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INLINE_COMMIT)}) !== null`,
          { timeoutMs: 25_000 },
        );
        const inlineCommits = await app.evalJS<
          {
            text: string;
            sha: string | null;
            root: string | null;
            title: string | null;
          }[]
        >(
          `(function () {
            var els = document.querySelectorAll(${JSON.stringify(INLINE_COMMIT)});
            return Array.prototype.map.call(els, function (el) {
              return {
                text: (el.textContent || "").trim(),
                sha: el.getAttribute("data-sha"),
                root: el.getAttribute("data-root"),
                title: el.getAttribute("title"),
              };
            });
          })()`,
        );
        note("inline commit mentions", JSON.stringify(inlineCommits));
        expect(inlineCommits.length, "the body cites the sha three times").toBe(3);
        // The reader sees the mention label — `commit:<8ch>`, the worded,
        // uniform form — while the payload keeps the sha as the prose spelled
        // it (12 characters here), which is what the resolver was asked about.
        // The first citation follows the word "Commit" in the sentence
        // itself, so the label yields the word and shows the hash alone; the
        // second stands wordless in its clause and the label supplies it; the
        // third is the agents' own house style — the word outside a backtick,
        // the sha inside — and the yield reaches across the code-element
        // boundary.
        expect(inlineCommits[0]?.text).toBe(HEAD_SHA.slice(0, 8));
        expect(inlineCommits[1]?.text).toBe(`commit:${HEAD_SHA.slice(0, 8)}`);
        expect(inlineCommits[2]?.text).toBe(HEAD_SHA.slice(0, 8));
        for (const mention of inlineCommits) {
          expect(mention.sha).toBe(HEAD_SHA.slice(0, 12));
          expect(mention.root?.startsWith("/")).toBe(true);
          // The hover is the app's own bubble, not the OS's: the mark carries
          // no native title at all, and what a reader sees is a TugTooltip
          // mounted onto it by the annotator's portal layer.
          expect(mention.title).toBeNull();
        }

        // Hover it and read the tip: the commit's own subject, its shape, and
        // the whole hash — read off this checkout's real HEAD, so a wrong
        // commit fails loudly.
        await app.evalJS<null>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(INLINE_COMMIT)});
            var anchor = el === null ? null : el.firstElementChild;
            if (anchor === null) return null;
            anchor.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
            anchor.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
            return null;
          })()`,
        );
        const TIP = '[data-slot="tug-tooltip"][data-variant="entity"]';
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TIP)}) !== null`,
          { timeoutMs: 8000 },
        );
        const tip = await app.evalJS<string>(
          `(function () {
            var bubble = document.querySelector(${JSON.stringify(TIP)});
            if (bubble === null) return "";
            // Radix renders the content twice — once to be seen, once in a
            // visually-hidden node a screen reader announces. Take the
            // visible children only, or every phrase reads doubled.
            return Array.prototype.filter
              .call(bubble.childNodes, function (n) {
                return !(n.nodeType === 1 && n.getAttribute("role") === "tooltip");
              })
              .map(function (n) { return n.textContent || ""; })
              .join(" ")
              .trim();
          })()`,
        );
        note("inline commit tip", tip);
        expect(tip).toContain(HEAD_SUBJECT);
        expect(tip).toContain("file");
        expect(tip).toContain(HEAD_SHA.slice(0, 12));

        // The trailing chip — the ref the prose never named — is stamped the
        // same way, so its click and menu are the registry's too.
        const fileChip = await app.evalJS<{
          title: string | null;
          annotation: string | null;
          path: string | null;
        } | null>(
          `(function () {
            var wrap = document.querySelector('[data-overview-ref-kind="file"]');
            if (wrap === null) return null;
            return {
              title: wrap.getAttribute("title"),
              annotation: wrap.getAttribute("data-tug-annotation"),
              path: wrap.getAttribute("data-path"),
            };
          })()`,
        );
        note("trailing file chip", JSON.stringify(fileChip));
        // …and it sits at the END OF THE CONTENT, above the Z1B — the rest
        // of what the post rests on, not debris after the footer. Asserted
        // as DOM order within the controls slot, which is what the reading
        // order follows (the slot stacks; see `overview-card.css`).
        const stripOrder = await app.evalJS<{
          strip: number;
          z1b: number;
        } | null>(
          `(function () {
            var cell = document.querySelector(${JSON.stringify(POST)});
            if (cell === null) return null;
            var controls = cell.querySelector(".tug-transcript-entry__controls");
            if (controls === null) return null;
            var kids = Array.from(controls.children);
            return {
              strip: kids.findIndex(function (k) {
                return k.classList.contains("overview-post-refs");
              }),
              z1b: kids.findIndex(function (k) {
                return k.classList.contains("overview-post-z1b");
              }),
            };
          })()`,
        );
        note("controls order", JSON.stringify(stripOrder));
        expect(stripOrder?.strip, "the strip is in the controls slot").toBeGreaterThanOrEqual(0);
        expect(stripOrder?.z1b, "so is the Z1B").toBeGreaterThanOrEqual(0);
        expect(
          stripOrder!.strip < stripOrder!.z1b,
          "the strip precedes the Z1B",
        ).toBe(true);
        expect(fileChip?.annotation).toBe("file-path");
        expect(fileChip?.path?.startsWith("/")).toBe(true);
        // A file ref carries NO native title: its hover is the house file tip
        // in the app's own bubble, the same one the commit beside it uses.
        // This post used to show one of each.
        expect(fileChip?.title).toBeNull();

        // ── 2c. The body is MARKDOWN, rendered by the transcript's own
        // primitive. A backticked name is a code span rather than three
        // literal characters, and being a code span is what makes it
        // clickable — `classifyInlineCode` runs the path resolver over every
        // inline `<code>`. A bare URL is an anchor for the same reason: the
        // markdown pipeline's enhancer chain does link detection, which the
        // old plain-text `<p>` never reached.
        const markdownPost: WirePost = {
          id: 9004,
          at_ms: AT_MS + 180_000,
          author: "observer",
          body: "Touched `overview-body-segments.ts` while reading https://example.com/overview for context.",
          refs: [],
          wake_reason: "turn-end",
          project_dir: REPO_ROOT,
        };
        expect(await publish(app, markdownPost)).toBe(true);

        // Located by its own words rather than by position: the row order is
        // claim 2's business, and a positional selector here would fail for
        // that reason instead of this one.
        const MD_BODY = `(function () {
          return Array.from(document.querySelectorAll(${JSON.stringify(BODY)}))
            .find(function (el) {
              return (el.textContent || "").indexOf("for context") !== -1;
            }) || null;
        })()`;
        await app.waitForCondition<boolean>(
          `(function () {
            var el = ${MD_BODY};
            if (el === null) return false;
            var code = el.querySelector("code");
            return code !== null
              && code.getAttribute("data-tug-annotation") === "file-path";
          })()`,
          { timeoutMs: 25_000 },
        );
        const markdown = await app.evalJS<{
          text: string;
          code: string | null;
          codePath: string | null;
          href: string | null;
          anchorKind: string | null;
        } | null>(
          `(function () {
            var el = ${MD_BODY};
            if (el === null) return null;
            var code = el.querySelector("code");
            var anchor = el.querySelector("a[href]");
            return {
              text: (el.textContent || "").trim(),
              code: code === null ? null : (code.textContent || "").trim(),
              codePath: code === null ? null : code.getAttribute("data-path"),
              href: anchor === null ? null : anchor.getAttribute("href"),
              anchorKind:
                anchor === null ? null : anchor.getAttribute("data-tug-annotation"),
            };
          })()`,
        );
        note("markdown body", JSON.stringify(markdown));
        // The backticks are gone from the reader's text — they were syntax,
        // and syntax is what a renderer consumes.
        expect(markdown?.text).not.toContain("`");
        expect(markdown?.code).toBe("overview-body-segments.ts");
        // And the span the backticks made is annotated, against this repo.
        expect(markdown?.codePath?.startsWith("/")).toBe(true);
        expect(markdown?.codePath).toContain("overview-body-segments.ts");
        // The bare URL is a real anchor, marked as one.
        expect(markdown?.href).toBe("https://example.com/overview");
        expect(markdown?.anchorKind).toBe("url");

        // ── 3. The composer round-trips through the Operator. ─────────────
        // It opens at THREE lines, empty. A question to the Operator is a
        // sentence, and a one-line slot reads as a box to fill with a phrase.
        // Measured against the field's own ROW — `--tug-text-editor-row-height`,
        // the height CM6 measured a `.cm-line` to occupy — rather than a pixel
        // constant, so the user's editor font-size setting moves both sides
        // together; the row count is the claim. A row is not `1lh`: the
        // baseline-aligned `.cm-line::before` ghost leaves leading under the
        // line box, which is why a floor stated in `1lh` grew a line early.
        const openingRows = await app.evalJS<number>(
          `(function () {
            var field = document.querySelector(${JSON.stringify(FIELD)});
            var scroller = field.querySelector(".cm-scroller");
            var row = parseFloat(
              getComputedStyle(field).getPropertyValue("--tug-text-editor-row-height"),
            );
            // The +16 is the cm-content 8px top + 8px bottom padding, which
            // both the floor and the maxRows ceiling account for.
            return Math.round((scroller.getBoundingClientRect().height - 16) / row);
          })()`,
        );
        note("composer opening rows", String(openingRows));
        expect(openingRows, "the empty composer opens three lines tall").toBe(3);

        const question = "which sessions touched the imposer";
        await app.nativeClickAtElement(`${FIELD} .cm-content`);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null
            && document.activeElement.closest(${JSON.stringify(FIELD)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // Three lines are what the opening height PROMISES, so three lines are
        // what it has to hold: the field stands still through them and grows on
        // the fourth. At the shipped `newline` setting ⏎ is a line break, which
        // is what makes this typeable at all.
        const fieldHeight = `document.querySelector(${JSON.stringify(
          `${FIELD} .cm-scroller`,
        )}).getBoundingClientRect().height`;
        const openHeight = await app.evalJS<number>(fieldHeight);
        for (let line = 2; line <= 3; line += 1) {
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(`${FIELD} .cm-line`)}).length === ${line}`,
            { timeoutMs: 8_000 },
          );
        }
        const threeLineHeight = await app.evalJS<number>(fieldHeight);
        await app.nativeKey("Return");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${FIELD} .cm-line`)}).length === 4`,
          { timeoutMs: 8_000 },
        );
        const fourLineHeight = await app.evalJS<number>(fieldHeight);
        note(
          "composer growth",
          JSON.stringify({ openHeight, threeLineHeight, fourLineHeight }),
        );
        expect(
          threeLineHeight,
          "three lines fit the height the composer opened at",
        ).toBe(openHeight);
        expect(
          fourLineHeight,
          "the fourth line is what grows the composer",
        ).toBeGreaterThan(threeLineHeight);

        // Back to empty for the round trip — one Backspace per line break.
        for (let line = 3; line >= 1; line -= 1) {
          await app.nativeKey("Backspace");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(`${FIELD} .cm-line`)}).length === ${line}`,
            { timeoutMs: 8_000 },
          );
        }
        await app.nativeType(question);
        await app.waitForCondition<boolean>(
          `(function () {
            var content = document.querySelector(${JSON.stringify(`${FIELD} .cm-content`)});
            return content !== null && (content.textContent || "").indexOf("imposer") !== -1;
          })()`,
          { timeoutMs: 8_000 },
        );

        // The send button is the shell's default, and it says which key fires
        // it: at the shipped `newline` setting that key is ⇧⏎, so the button
        // wears the CHORD variant of the default ring ([#chord-ring]) — dotted
        // while the promise is conditional. Asserted as the declaration plus
        // the style it resolves to, since the ring is painted from a knob the
        // attribute sets, not from the attribute itself.
        const chordRing = await app.evalJS<{
          chord: string | null;
          style: string;
        } | null>(
          `(function () {
            var send = document.querySelector(${JSON.stringify(SEND)});
            if (send === null) return null;
            return {
              chord: send.getAttribute("data-default-chord"),
              style: getComputedStyle(send).outlineStyle,
            };
          })()`,
        );
        note("send chord ring", JSON.stringify(chordRing));
        expect(chordRing?.chord, "the send button names ⇧⏎ as its chord").toBe(
          "shift",
        );
        expect(
          chordRing?.style,
          "a conditional promise is a dotted ring",
        ).toBe("dotted");

        // And the chord really submits — the gesture, not just its advertising.
        await app.nativeKey("Return", ["shift"]);

        // Nothing is asserted about the pending placeholder standing: under
        // the app-test gate the Operator's reply comes back in the same
        // breath as the question goes out, so "the placeholder is up" is a
        // window too narrow to observe. What it resolves to is checked below.

        // The question echoes back as a user post — the Operator persists and
        // broadcasts it before running anything, so this is the first proof
        // the frame reached the server.
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(POST)}))
            .some(function (el) { return el.getAttribute("data-author") === "user"; })`,
          { timeoutMs: 20_000 },
        );

        // Then the answer. Under the app-test gate the pool answers nothing, so
        // what arrives is the transient "couldn't answer" post — which still
        // proves the round trip, and clears the pending row on its way.
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(POST)}))
            .filter(function (el) { return !el.hasAttribute("data-pending"); })
            .some(function (el) {
              var body = el.querySelector(".overview-post-body");
              return el.getAttribute("data-author") === "operator"
                // Matched from the apostrophe onward: the body renders as
                // markdown, and pulldown-cmark's smart punctuation turns the
                // typed "Couldn't" into a curly one on the way to the reader.
                && (body === null ? "" : body.textContent || "").indexOf("t answer that") !== -1;
            })`,
          { timeoutMs: 30_000 },
        );

        const after = await app.evalJS<Row[]>(ROWS_JS);
        note("rows after the round trip", JSON.stringify(after));

        const userRow = after.find((r) => r.author === "user");
        expect(userRow, "the question is echoed back as a user post").toBeDefined();
        expect(userRow!.body).toBe(question);

        // The pending placeholder is gone: the answer resolved the wait.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PENDING)}) === null`,
          { timeoutMs: 10_000 },
        );

        // And the composer is live again — one question at a time means
        // *while* one is outstanding, not ever after.
        expect(
          await app.evalJS<boolean>(
            `(function () {
              var field = document.querySelector(${JSON.stringify(FIELD)});
              return field !== null && field.querySelector(".cm-content") !== null;
            })()`,
          ),
          "the field is back after the answer landed",
        ).toBe(true);

        // ── The pointing gesture ────────────────────────────────────────
        //
        // A second question, asked the way someone asks about a particular
        // file: `@`-complete it into the composer as an atom, then send. The
        // atom is not decoration — it flattens into the sentence AND rides
        // the wire as a structured ref the pipeline verifies against the tree
        // before any verb runs. What this asserts is the surface end of that:
        // the path the asker pointed at is on the post that comes back.
        //
        // The `@` provider is the live FILETREE one against the bootstrap
        // workspace, which is this checkout — so `CLAUDE.md`, a real file at
        // the root, is something it can genuinely find.
        //
        // The wait is on the FILTERED popup, not merely on a populated one.
        // The provider answers asynchronously and the menu shows the cached
        // root listing in the meantime, so "the popup has items" is true
        // several hundred milliseconds before the items are the query's — and
        // accepting then takes whatever alphabetically came first (a
        // directory, as it turned out). Waiting for the typed name to be the
        // head of the list is waiting for the answer rather than the echo.
        const MENU = '[data-slot="tug-completion-menu"]';
        const ITEMS_JS = `Array.from(
          document.querySelectorAll(${JSON.stringify(`${MENU} .tug-completion-menu-item`)}),
        ).map(function (el) { return (el.textContent || "").trim(); })`;
        const NAMED_FILE = "CLAUDE.md";
        await app.nativeClickAtElement(FIELD);
        await app.nativeType("@CLAUDE");
        await app.waitForCondition<boolean>(
          `(function () {
            var items = ${ITEMS_JS};
            return items.length > 0 && items[0] === ${JSON.stringify(NAMED_FILE)};
          })()`,
          { timeoutMs: 15_000 },
        );
        note("@ completion items", JSON.stringify(await app.evalJS<string[]>(ITEMS_JS)));
        // Accepted with a modifier-free Return, which the typeahead keymap
        // claims — the keyboard gesture a person actually makes, and the one
        // that needs nothing from the portalled popup's geometry.
        await app.nativeKey("Return");

        // The atom is in the document — a real placed atom, the same one a
        // drop makes, not text that looks like a path.
        await app.waitForCondition<boolean>(
          `(function () {
            var field = document.querySelector(${JSON.stringify(FIELD)});
            if (field === null) return false;
            return field.querySelectorAll(".cm-content img").length > 0;
          })()`,
          { timeoutMs: 8_000 },
        );
        note(
          "the placed atom",
          JSON.stringify(
            await app.evalJS<unknown>(
              `(function () {
                var field = document.querySelector(${JSON.stringify(FIELD)});
                if (field === null) return null;
                return Array.from(field.querySelectorAll(".cm-content img")).map(
                  function (img) { return img.getAttribute("data-atom-label"); },
                );
              })()`,
            ),
          ),
        );

        await app.nativeType(" what does this say");
        await app.nativeKey("Return", ["shift"]);

        // The question comes back carrying the path — either annotated inside
        // the prose (the atom flattened into the sentence, and the content
        // annotator marks it because the words name it) or as a trailing ref
        // chip when they do not. Both are the ref arriving; which one shows is
        // the card's existing `unmentionedRefs` rule, not this step's claim.
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(POST)}))
            .filter(function (el) { return el.getAttribute("data-author") === "user"; })
            .some(function (el) {
              return (el.textContent || "").indexOf(${JSON.stringify(NAMED_FILE)}) !== -1;
            })`,
          { timeoutMs: 20_000 },
        );
        const pointed = await app.evalJS<{ body: string; atoms: string[] } | null>(
          `(function () {
            var rows = Array.from(document.querySelectorAll(${JSON.stringify(POST)}))
              .filter(function (el) { return el.getAttribute("data-author") === "user"; });
            var el = rows[rows.length - 1];
            if (el === undefined) return null;
            var body = el.querySelector(".overview-post-body");
            return {
              body: (body === null ? "" : body.textContent || "").trim(),
              atoms: Array.from(el.querySelectorAll("img[data-atom-label]")).map(
                function (img) { return img.getAttribute("data-atom-label") || ""; },
              ),
            };
          })()`,
        );
        note("the pointed-at question", JSON.stringify(pointed));
        expect(
          `${pointed?.body ?? ""} ${(pointed?.atoms ?? []).join(" ")}`,
          "the file the asker pointed at is on the question post",
        ).toContain(NAMED_FILE);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an attached image previews while it is composed and renders in the post it was sent with",
    async () => {
      const app = await launchTugApp({ testName: "at0365-overview-attachments" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIELD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // A real PNG through the real pipeline: the drop lands on the editor
        // host, the substrate downsamples it, stages the bytes, and drops an
        // `image-1` chip at the caret. Nothing is stubbed — the same code the
        // Session composer runs.
        await app.evalJS<void>(
          `(function () {
            window.__at0365Dropped = false;
            var host = document.querySelector(${JSON.stringify(FIELD)});
            var canvas = document.createElement("canvas");
            canvas.width = 48;
            canvas.height = 32;
            var ctx = canvas.getContext("2d");
            ctx.fillStyle = "#2f6f4f";
            ctx.fillRect(0, 0, 48, 32);
            ctx.fillStyle = "#e8f2ec";
            ctx.fillRect(6, 6, 36, 20);
            canvas.toBlob(function (blob) {
              var file = new File([blob], "shot.png", { type: "image/png" });
              var dt = new DataTransfer();
              dt.items.add(file);
              var r = host.getBoundingClientRect();
              var ev = new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                clientX: r.left + r.width / 2,
                clientY: r.top + 8,
              });
              Object.defineProperty(ev, "dataTransfer", { value: dt });
              host.dispatchEvent(ev);
              window.__at0365Dropped = true;
            }, "image/png");
          })()`,
        );
        await app.waitForCondition<boolean>(`window.__at0365Dropped === true`, {
          timeoutMs: 8_000,
        });

        // ── The compose-phase preview. This is the miss the whole feature is
        // about: an image dropped into the Overview used to leave nothing to
        // look at. The strip is the Session composer's own component, so what
        // is asserted is its own DOM — a tile with pixels in it, its `image-1`
        // caption, and the ✕ that only a compose-phase tile carries.
        const COMPOSE_STRIP = '[data-testid="overview-composer-attachment-strip"]';
        await app.waitForCondition<boolean>(
          `(function () {
            var img = document.querySelector(${JSON.stringify(
              `${COMPOSE_STRIP} .tug-attachment-preview__thumb-img`,
            )});
            return img !== null && img.complete && img.naturalWidth > 0;
          })()`,
          { timeoutMs: 20_000 },
        );
        const composeTile = await app.evalJS<{
          tiles: number;
          caption: string;
          deletable: boolean;
          naturalWidth: number;
        } | null>(
          `(function () {
            var strip = document.querySelector(${JSON.stringify(COMPOSE_STRIP)});
            if (strip === null) return null;
            var caption = strip.querySelector(".tug-attachment-preview__caption");
            var img = strip.querySelector(".tug-attachment-preview__thumb-img");
            return {
              tiles: strip.querySelectorAll(".tug-attachment-preview__cell").length,
              caption: caption === null ? "" : (caption.textContent || "").trim(),
              deletable:
                strip.querySelector(".tug-attachment-preview__delete") !== null,
              naturalWidth: img === null ? 0 : img.naturalWidth,
            };
          })()`,
        );
        note("composer tile", JSON.stringify(composeTile));
        expect(composeTile?.tiles, "one image, one tile").toBe(1);
        // The rail's tier. The strip is the Session card's component and the
        // Overview asks it for `compact`, so the tile is the rail's size —
        // measured against the comfortable slot the component declares at its
        // own root, which is what a card gets. Reading BOTH is the point: a
        // number alone would pass just as happily if the option stopped
        // arriving and every surface silently went small.
        const density = await app.evalJS<{
          stamped: string | null;
          tileHeight: number;
          comfortable: number;
        } | null>(
          `(function () {
            var strip = document.querySelector(${JSON.stringify(COMPOSE_STRIP)});
            if (strip === null) return null;
            var px = function (el, name) {
              return parseFloat(getComputedStyle(el).getPropertyValue(name));
            };
            // The comfortable value, read off a surface that never asked for
            // compact — the base declaration on any strip root, before the
            // density block overrides it.
            var probe = document.createElement("div");
            probe.setAttribute("data-slot", "tug-attachment-preview");
            document.body.appendChild(probe);
            var comfortable = px(probe, "--tugx-attachment-tile-height-rest");
            probe.remove();
            return {
              stamped: strip.getAttribute("data-density"),
              tileHeight: px(strip, "--tugx-attachment-tile-height-rest"),
              comfortable: comfortable,
            };
          })()`,
        );
        note("compose density", JSON.stringify(density));
        expect(density?.stamped, "the Overview asks for the rail's tier").toBe(
          "compact",
        );
        expect(
          density!.tileHeight,
          "and the tier is genuinely smaller than a card's",
        ).toBeLessThan(density!.comfortable);
        expect(composeTile?.caption).toContain("image-1");
        expect(
          composeTile?.deletable,
          "a draft attachment can still be taken back",
        ).toBe(true);
        expect(composeTile!.naturalWidth).toBeGreaterThan(0);

        // A question that is only a picture is a question, so the send button
        // is live with an empty field — the emptiness bridge counts images.
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(
              '[data-testid="overview-composer"]',
            )}).getAttribute("data-empty")`,
          ),
          "an attached image is not an empty composer",
        ).toBe("false");

        await app.nativeClickAtElement(SEND);

        // ── The transcript half. The bytes went up with the question, tugcast
        // rested them beside the ledger, and the post that came back names
        // where. The strip reads them through `/api/fs/blob` — so a tile with
        // real pixels here proves the whole path: wire → operator → disk →
        // ledger row → post → blob route → the same preview component.
        await app.waitForCondition<boolean>(
          `(function () {
            var img = document.querySelector(${JSON.stringify(
              '[data-testid="overview-post-attachments"] .tug-attachment-preview__thumb-img',
            )});
            return img !== null && img.complete && img.naturalWidth > 0;
          })()`,
          { timeoutMs: 30_000 },
        );
        const postStrip = await app.evalJS<{
          author: string | null;
          tiles: number;
          deletable: boolean;
          naturalWidth: number;
        } | null>(
          `(function () {
            var strip = document.querySelector(${JSON.stringify(
              '[data-testid="overview-post-attachments"]',
            )});
            if (strip === null) return null;
            var cell = strip.closest(".overview-cell");
            var img = strip.querySelector(".tug-attachment-preview__thumb-img");
            return {
              author: cell === null ? null : cell.getAttribute("data-author"),
              tiles: strip.querySelectorAll(".tug-attachment-preview__cell").length,
              deletable:
                strip.querySelector(".tug-attachment-preview__delete") !== null,
              naturalWidth: img === null ? 0 : img.naturalWidth,
            };
          })()`,
        );
        note("post strip", JSON.stringify(postStrip));
        expect(postStrip?.author, "the picture is on the question").toBe("user");
        expect(postStrip?.tiles).toBe(1);
        expect(postStrip!.naturalWidth).toBeGreaterThan(0);
        expect(
          postStrip?.deletable,
          "a picture already in the channel is as final as the sentence",
        ).toBe(false);

        // A tile opens the full-resolution sheet, the way it does on a
        // Session transcript — the strip owns that gesture, so what this
        // proves is that the Overview's rail can host the sheet it opens.
        await app.nativeClickAtElement(
          '[data-testid="overview-post-attachments"] .tug-attachment-preview__tile',
        );
        await app.waitForCondition<boolean>(
          `(function () {
            var img = document.querySelector(
              '[data-slot="tug-attachment-preview-sheet__image"]',
            );
            return img !== null && img.complete && img.naturalWidth > 0;
          })()`,
          { timeoutMs: 15_000 },
        );
        note(
          "preview sheet",
          await app.evalJS<string>(
            `(function () {
              var img = document.querySelector(
                '[data-slot="tug-attachment-preview-sheet__image"]',
              );
              return JSON.stringify({
                width: img === null ? 0 : img.naturalWidth,
                height: img === null ? 0 : img.naturalHeight,
              });
            })()`,
          ),
        );

        // And it opens as a panel ON the rail, not a lid over it: the compact
        // tier is capped well short of the card, so there is real margin on
        // both sides. Measured against the card's own frame, because "narrow"
        // is only meaningful relative to what it opened inside.
        const sheetFit = await app.evalJS<{
          density: string | null;
          inlineMax: string;
          sheet: number;
          card: number;
          leading: number;
          trailing: number;
        } | null>(
          `(function () {
            var body = document.querySelector(
              '[data-slot="tug-attachment-preview-sheet"]',
            );
            if (body === null) return null;
            var panel = body.closest(".tug-sheet-content");
            var card = document.querySelector(${JSON.stringify(CARD)});
            if (panel === null || card === null) return null;
            var p = panel.getBoundingClientRect();
            var c = card.getBoundingClientRect();
            return {
              density: body.getAttribute("data-density"),
              // The cap the sheet was actually given, so a failure says
              // whether the fraction was wrong or something overrode it.
              inlineMax: panel.style.maxWidth,
              sheet: Math.round(p.width),
              card: Math.round(c.width),
              leading: Math.round(p.left - c.left),
              trailing: Math.round(c.right - p.right),
            };
          })()`,
        );
        note("preview sheet fit", JSON.stringify(sheetFit));
        expect(sheetFit?.density, "the sheet wears the strip's tier").toBe(
          "compact",
        );
        // Stated as the MARGIN rather than as a fraction: the cap the sheet is
        // given is a fraction of the pane's frame, which is wider than the
        // card's content box by whatever chrome the pane wears — so a fraction
        // asserted here would be asserting against the wrong denominator. What
        // the reader actually sees is the gap at each edge, and that is what
        // "smashing into the sides" names.
        expect(
          sheetFit!.leading,
          "there is real margin at the leading edge",
        ).toBeGreaterThanOrEqual(24);
        expect(
          sheetFit!.trailing,
          "and the same at the trailing edge",
        ).toBeGreaterThanOrEqual(24);
        // The margin is not a rounding artifact of a cap that nearly bound —
        // the panel is a clear step narrower than the column it opened in.
        // This is what the drag-resize floor was defeating: it outranked the
        // cap, so on any host under ~640px the sheet came out at the floor's
        // 460px however small a fraction the caller asked for.
        expect(
          sheetFit!.sheet / sheetFit!.card,
          "the sheet reads as nested, not as a lid",
        ).toBeLessThanOrEqual(0.85);

        // The chrome is the rail's scale too. Three card-scale buttons are
        // most of what a footer this wide holds, so the tier is stamped on
        // each of them — asserted as the size class the button family writes,
        // which is the same thing the CSS keys its metrics on.
        const chromeSizes = await app.evalJS<string[]>(
          `Array.from(
            document.querySelectorAll(
              '[data-slot="tug-attachment-preview-sheet"] button',
            ),
          )
            .map(function (b) {
              var cls = Array.from(b.classList).find(function (c) {
                return c.indexOf("tug-button-size-") === 0;
              });
              return cls === undefined ? "" : cls.replace("tug-button-size-", "");
            })
            .filter(function (s) { return s.length > 0; })`,
        );
        note("sheet chrome sizes", JSON.stringify(chromeSizes));
        // Copy and Done. This sheet was opened from a POST, which is
        // read-only — there is no Delete on a picture already in the channel,
        // which is claim 4's own rule restated from the sheet's side.
        expect(chromeSizes.length, "Copy and Done").toBe(2);
        for (const size of chromeSizes) {
          expect(size, "every control is at the rail's scale").toBe("sm");
        }
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-slot="tug-attachment-preview-sheet"]') === null`,
          { timeoutMs: 10_000 },
        );

        // And the composer let go of it: the strip is gone, so the next
        // question starts empty rather than re-sending the last picture.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSE_STRIP)}) === null`,
          { timeoutMs: 10_000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
