/**
 * at0268-session-history-paging-filter.test.ts — the History shade pages in
 * more commits as the reader reaches the foot of the list, and the header's
 * filter field trims what is shown.
 *
 * Driven against a real repo — this worktree itself, which tugcast registers as
 * its bootstrap `--source-tree` (the same rationale as at0239: a synthetic temp
 * repo hangs the app's boot). It has thousands of commits, which is exactly
 * what a paging test needs and a temp fixture cannot cheaply provide.
 *
 * Scenario:
 *   1. Bind a card to the repo, open the History shade → the first page lands
 *      and stops at the page size rather than the whole history.
 *   2. Scroll the list to its foot → the next page appends. Every commit that
 *      was on screen is still there, in the same order, ABOVE the new ones —
 *      the load-on-scroll contract is that content grows downward and the
 *      reader's place does not move.
 *   3. Type a path only some commits touched into the filter → the list trims
 *      to matching rows, and a row kept by its file roster names the path that
 *      matched (otherwise the match is invisible and reads as a filter bug).
 *      Then switch the header's `Files` target off → those rows drop, because
 *      the roster was the only thing that kept them; back on, they return. The
 *      band's title, field text, and target labels share one baseline, and a
 *      dash's name finds its join commit and marks the badge that states it.
 *   4. Filter by a word that appears ONLY in some commit's message BODY → the
 *      collapsed row shows the matching line marked, and expanding it marks the
 *      term inside the syntax-highlighted message itself. This is the path that
 *      silently painted nothing before `renderFilterHighlightSpans`.
 *   5. Filter by a commit's short sha → exactly that commit survives.
 *   6. Clear the filter → the full walk comes back, no shorter than before.
 *
 * @covers tugdeck/src/lib/git-log-store.ts
 * @covers tugdeck/src/lib/commit-filter-scope.ts
 * @covers tugdeck/src/components/tugways/tug-option-group.css
 * @covers tugdeck/src/components/tugways/cards/session-history/session-history-view.tsx
 * @covers tugdeck/src/components/tugways/tug-history-list.tsx
 * @covers tugdeck/src/components/tugways/filter-highlight.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-text.tsx
 * @covers tugrust/crates/tugcast/src/feeds/git.rs
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const VIEW = `[data-slot="session-history-view"]`;
const ROW = `${VIEW} [data-testid="session-history-commit"]`;
const FILTER = `[data-testid="session-history-filter"] input`;

/** Mirrors `GIT_LOG_PAGE_SIZE` in `lib/git-log-store.ts`. */
const PAGE_SIZE = 40;

function gitOut(args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", REPO, ...args]);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

/**
 * A recent commit with a distinctive word in its message BODY that appears
 * nowhere in its subject — the exact shape whose match was invisible before
 * the styled-span highlight path existed.
 *
 * Derived from the repo rather than hardcoded, so the test does not rot as
 * history moves past whichever commit happened to fit when it was written.
 */
function bodyOnlyMatch(): { sha: string; word: string } {
  const records = gitOut([
    "log",
    "-z",
    "-n40",
    "--format=%H%x1f%s%x1f%b",
  ]).split("\0");
  for (const record of records) {
    const [sha, subject, body] = record.split("\x1f");
    if (sha === undefined || subject === undefined || body === undefined) continue;
    const subjectLower = subject.toLowerCase();
    for (const word of body.toLowerCase().match(/[a-z]{8,}/g) ?? []) {
      // Not in the subject, and not in the sha's hex either, so the collapsed
      // row genuinely cannot account for the match on its own.
      if (subjectLower.includes(word)) continue;
      if (sha.slice(0, 8).includes(word)) continue;
      return { sha, word };
    }
  }
  throw new Error("no recent commit has a body-only word — fixture assumption broke");
}

/**
 * A recent commit plus a file name it changed that NO commit in reach of the
 * filter's own walk mentions in its message — so a query for it can only ever
 * be answered by a file roster.
 *
 * That exclusivity is the point: it makes "switch Files off ⇒ nothing matches"
 * a statement about the control rather than about this repo's phrasing. A
 * hardcoded path fails it the moment someone writes the file name into a commit
 * message, which is exactly what commit messages are for.
 */
function rosterOnlyMatch(): { sha: string; token: string } {
  // The `-z --name-only` stream interleaves record and path chunks; records
  // carry the field separator, paths never do (the same rule `parse_git_log`
  // classifies on). Scanned as deep as the filter's automatic walk can page,
  // so a commit the walk reaches cannot contradict the fixture.
  const commits: { sha: string; text: string; files: string[] }[] = [];
  for (const raw of gitOut([
    "log",
    "-z",
    "-n400",
    "--name-only",
    "--format=%H%x1f%s%x1f%b%x1f",
  ]).split("\0")) {
    const chunk = raw.replace(/^\n+/, "");
    if (chunk.length === 0) continue;
    if (chunk.includes("\x1f")) {
      const [sha, subject, body] = chunk.split("\x1f");
      commits.push({
        sha: sha ?? "",
        text: `${subject ?? ""}\n${body ?? ""}`.toLowerCase(),
        files: [],
      });
    } else if (commits.length > 0) {
      commits[commits.length - 1]!.files.push(chunk);
    }
  }
  const messages = commits.map((c) => c.text);
  // Only the newest commits are candidates — the row has to be on screen
  // before the reader ever aims the filter.
  for (const commit of commits.slice(0, 40)) {
    for (const path of commit.files) {
      const token = (path.split("/").pop() ?? "").toLowerCase();
      if (token.length < 10) continue;
      if (messages.some((m) => m.includes(token))) continue;
      return { sha: commit.sha, token };
    }
  }
  throw new Error("no recent commit has a roster-only file name — fixture assumption broke");
}

/**
 * The newest commit that landed as a dash join, and the dash it came from —
 * the row that wears a `^<name>` dash atom ([P09]).
 */
function joinCommit(): { sha: string; name: string } | null {
  for (const line of gitOut([
    "log",
    "-n200",
    "--format=%H%x1f%(trailers:key=Tug-Dash,valueonly)",
  ]).split("\n")) {
    const [sha, trailer] = line.split("\x1f");
    const ref = (trailer ?? "").trim().split(/\s+/)[0] ?? "";
    if (!ref.startsWith("tugdash/")) continue;
    const name = ref.slice("tugdash/".length);
    if (name.length >= 6) return { sha: sha ?? "", name };
  }
  return null;
}

describe.skipIf(!SHOULD_RUN)(
  "at0268 — History pages in on scroll and filters down",
  () => {
    test(
      "scrolling to the foot appends a page; the filter trims by path and by sha",
      async () => {
        const head8 = gitOut(["rev-parse", "HEAD"]).slice(0, 8);
        const headSubject = gitOut(["show", "-s", "--format=%s", "HEAD"]);
        const { sha: bodySha, word: bodyWord } = bodyOnlyMatch();
        const { token: rosterToken } = rosterOnlyMatch();

        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
          const app = await launchTugApp({
            testName: "at0268-session-history-paging-filter",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.waitForCondition<boolean>(
              `typeof window.__tug !== "undefined"`,
              { timeoutMs: 5_000 },
            );

            await app.seedDeckState({
              state: {
                cards: [
                  { id: "D", componentId: "session", title: "Session", closable: true },
                ],
                panes: [
                  {
                    id: "pD",
                    position: { x: 40, y: 40 },
                    size: { width: 900, height: 620 },
                    cardIds: ["D"],
                    activeCardId: "D",
                    title: "",
                    acceptsFamilies: ["maker"],
                  },
                ],
                activePaneId: "pD",
                hasFocus: true,
              },
              focusCardId: "D",
            });
            await app.waitForCondition<boolean>(
              `window.__tug.assertHostRootRegistered("D")`,
              { timeoutMs: 5_000 },
            );

            await app.bindSession("D", { projectDir: REPO });

            await app.dispatchControlAction("toggle-history-view");
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length > 0`,
              { timeoutMs: 8_000 },
            );

            // ── 1. The first page stops at the page size ──────────────────
            // Settle first: the view tops up on its own until the list
            // overflows the shade, so read the count once it has stopped
            // moving rather than the instant the first rows appear.
            const shasNow = `Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).map(function(e){ return e.getAttribute("data-sha"); })`;
            await app.waitForCondition<boolean>(
              `document.querySelector('[data-testid="session-history-loading-more"]') === null`,
              { timeoutMs: 8_000 },
            );
            const firstPage = await app.evalJS<string[]>(shasNow);
            expect(firstPage.length).toBeGreaterThan(0);
            // A page at a time — not the repo's whole history in one frame.
            expect(firstPage.length).toBeLessThanOrEqual(PAGE_SIZE * 2);

            // ── 2. Scrolling to the foot appends the next page ────────────
            await app.evalJS(
              `(function(){
                var v = document.querySelector(${JSON.stringify(VIEW)});
                v.scrollTop = v.scrollHeight;
              })()`,
            );
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length > ${firstPage.length}`,
              { timeoutMs: 8_000 },
            );
            const grown = await app.evalJS<string[]>(shasNow);

            // The page APPENDED: everything that was on screen is still on
            // screen, in the same order, at the same indices. That is what
            // keeps the scroll offset meaningful and the reader's place fixed.
            expect(grown.slice(0, firstPage.length)).toEqual(firstPage);

            // ── 3. Filter by a path ───────────────────────────────────────
            // A file only some commits touch, whose name appears in no commit
            // MESSAGE within the walk's reach — so a row that survives can only
            // have been kept by its file roster.
            await app.click(FILTER);
            await app.type(FILTER, rosterToken);
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length < ${grown.length}`,
              { timeoutMs: 8_000 },
            );
            const byPath = await app.evalJS<string[]>(shasNow);
            expect(byPath.length).toBeGreaterThan(0);
            expect(byPath.length).toBeLessThan(grown.length);
            // Every surviving row is a row that was already loaded — the
            // filter trims, it does not fetch a different list.
            for (const sha of byPath) expect(grown).toContain(sha);

            // The match is legible: the row names the path the query found,
            // with the matched span marked inside it.
            const pathContext = await app.evalJS<{ text: string; mark: string }>(
              `(function(){
                var el = document.querySelector('[data-testid="session-history-matched-context"]');
                if (!el) return { text: "", mark: "" };
                var m = el.querySelector('mark.tug-filter-mark');
                return { text: el.textContent, mark: m ? m.textContent : "" };
              })()`,
            );
            expect(pathContext.text.toLowerCase()).toContain(rosterToken);
            expect(pathContext.mark.length).toBeGreaterThan(0);

            // ── 3B. Aim the filter: switch Files off ──────────────────────
            // Those rows were kept BY their file roster, so turning the Files
            // target off must drop them — the option group is what makes the
            // filter a way of finding one commit instead of listing many.
            const SCOPE = `[data-testid="session-history-filter-scope"]`;
            const FILES_OPTION = `${SCOPE} [data-option-value="files"]`;
            await app.click(FILES_OPTION);
            // No message in the walk's reach names the file, so with Files off
            // nothing accounts for the query at all.
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length === 0`,
              { timeoutMs: 8_000 },
            );
            const offState = await app.evalJS<string | null>(
              `document.querySelector(${JSON.stringify(FILES_OPTION)}).getAttribute("data-state")`,
            );
            expect(offState).toBe("off");

            // Back on, and every row returns — the choice is a filter over the
            // walk already held, not a re-fetch. (At least: the automatic walk
            // kept paging while nothing matched, so it may now hold more.)
            await app.click(FILES_OPTION);
            const restoredAll = `${shasNow}.filter(function(s){ return ${JSON.stringify(byPath)}.indexOf(s) >= 0; }).length === ${byPath.length}`;
            await app.waitForCondition<boolean>(restoredAll, { timeoutMs: 8_000 });
            expect(await app.evalJS<boolean>(restoredAll)).toBe(true);

            // ── 3C. The band reads as one line of text ────────────────────
            // The title, the filter field's text, and the target labels each
            // ride the header's one-line box, which is what puts them on a
            // shared baseline. Measured, not eyeballed: the text baseline of a
            // run centered in a box is derivable from the box, the line height,
            // and the font's own ascent (Canvas reports it), and drift here is
            // a 1-3px float the eye reads immediately but no DOM assertion
            // about heights or paddings would catch.
            const baselines = await app.evalJS<Record<string, number>>(
              `(function(){
                var cv = document.createElement("canvas").getContext("2d");
                function baseline(el){
                  var cs = getComputedStyle(el);
                  cv.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
                  var m = cv.measureText("Hxg");
                  var A = m.fontBoundingBoxAscent, D = m.fontBoundingBoxDescent;
                  var r = el.getBoundingClientRect();
                  var top = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
                  var bot = r.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
                  var L = cs.lineHeight === "normal" ? (A + D) : parseFloat(cs.lineHeight);
                  return top + ((bot - top) - L)/2 + (L - (A + D))/2 + A;
                }
                var hdr = document.querySelector('[data-testid="session-history-header"]');
                return {
                  title: baseline(hdr.querySelector(".tool-call-header-name")),
                  field: baseline(hdr.querySelector(".tug-filter-field-input")),
                  target: baseline(hdr.querySelector('[data-option-value="message"]')),
                };
              })()`,
            );
            const spread =
              Math.max(...Object.values(baselines)) -
              Math.min(...Object.values(baselines));
            expect(spread).toBeLessThan(1);

            // ── 3D. The dash attribution filters as part of the Message ───
            // `Tug-Dash:` is a trailer on the message, and the dash atom is how
            // the row states it — so the dash's name finds the commit, and the
            // mark lands on the atom the reader is looking at.
            const join = joinCommit();
            if (join !== null) {
              await app.evalJS(
                `(function(){
                  var i = document.querySelector(${JSON.stringify(FILTER)});
                  i.value = "";
                  i.dispatchEvent(new Event("input", { bubbles: true }));
                })()`,
              );
              await app.type(FILTER, join.name);
              const joinRow = `${VIEW} [data-testid="session-history-commit"][data-sha="${join.sha}"]`;
              await app.waitForCondition<boolean>(
                `document.querySelector(${JSON.stringify(joinRow)} + ' [data-testid="session-history-join-badge"] mark.tug-filter-mark') !== null`,
                { timeoutMs: 8_000 },
              );
              const badge = await app.evalJS<{ text: string; mark: string }>(
                `(function(){
                  var el = document.querySelector(${JSON.stringify(joinRow)} + ' [data-testid="session-history-join-badge"]');
                  var m = el.querySelector('mark.tug-filter-mark');
                  return { text: el.textContent, mark: m ? m.textContent : "" };
                })()`,
              );
              expect(badge.text).toContain(`^${join.name}`);
              expect(badge.mark.length).toBeGreaterThan(0);
              expect(join.name).toContain(badge.mark);
            }

            // ── 4. Filter by a word only the message BODY carries ─────────
            await app.evalJS(
              `(function(){
                var i = document.querySelector(${JSON.stringify(FILTER)});
                i.value = "";
                i.dispatchEvent(new Event("input", { bubbles: true }));
              })()`,
            );
            await app.type(FILTER, bodyWord);
            const bodyRow = `${VIEW} [data-testid="session-history-commit"][data-sha="${bodySha}"]`;
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(bodyRow)}) !== null`,
              { timeoutMs: 8_000 },
            );

            // Collapsed, the row cannot explain itself from its subject — so it
            // shows the matching message line, marked.
            const collapsedEvidence = await app.evalJS<{
              context: string;
              mark: string;
            }>(
              `(function(){
                var row = document.querySelector(${JSON.stringify(bodyRow)});
                var el = row.querySelector('[data-testid="session-history-matched-context"]');
                if (!el) return { context: "", mark: "" };
                var m = el.querySelector('mark.tug-filter-mark');
                return { context: el.textContent, mark: m ? m.textContent.toLowerCase() : "" };
              })()`,
            );
            expect(collapsedEvidence.context.toLowerCase()).toContain(bodyWord);
            expect(collapsedEvidence.mark).toBe(bodyWord);

            // Expanded, the term is marked inside the real message body — the
            // syntax-highlighted render, where a plain string renderer could
            // not reach and so used to paint nothing at all.
            await app.click(`${bodyRow} .tug-history-list-row-hit`);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(bodyRow)} + '' ) !== null && document.querySelector(${JSON.stringify(bodyRow)}).getAttribute("data-expanded") === "true"`,
              { timeoutMs: 5_000 },
            );
            const bodyMark = await app.evalJS<string>(
              `(function(){
                var row = document.querySelector(${JSON.stringify(bodyRow)});
                var msg = row.querySelector('[data-slot="tug-history-list-message"]');
                if (!msg) return "";
                var m = msg.querySelector('mark.tug-filter-mark');
                return m ? m.textContent.toLowerCase() : "";
              })()`,
            );
            expect(bodyMark).toBe(bodyWord);

            // The expanded detail reads in a recessed well, like a tool
            // block's body — a real painted surface, not a bare region.
            const wellPainted = await app.evalJS<boolean>(
              `(function(){
                var row = document.querySelector(${JSON.stringify(bodyRow)});
                var well = row.querySelector('.tug-history-list-commit-detail');
                if (!well) return false;
                var cs = getComputedStyle(well);
                var bg = cs.backgroundColor;
                return bg !== "" && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)"
                  && parseFloat(cs.borderTopWidth) > 0;
              })()`,
            );
            expect(wellPainted).toBe(true);

            // ── 5. Filter by a short sha ─────────────────────────────────
            await app.evalJS(
              `(function(){
                var i = document.querySelector(${JSON.stringify(FILTER)});
                i.value = "";
                i.dispatchEvent(new Event("input", { bubbles: true }));
              })()`,
            );
            await app.type(FILTER, head8);
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length === 1`,
              { timeoutMs: 8_000 },
            );
            const soleRow = await app.evalJS<string>(
              `(function(){
                var row = document.querySelector(${JSON.stringify(ROW)});
                return row ? row.textContent : "";
              })()`,
            );
            expect(soleRow).toContain(head8);
            expect(soleRow).toContain(headSubject);

            // The matched span wears the shared filter mark, so the reader can
            // see WHY the row survived.
            const markText = await app.evalJS<string>(
              `(function(){
                var m = document.querySelector(${JSON.stringify(ROW)} + ' mark.tug-filter-mark');
                return m ? m.textContent : "";
              })()`,
            );
            expect(head8).toContain(markText);
            expect(markText.length).toBeGreaterThan(0);

            // ── 6. Clearing restores the whole walk ──────────────────────
            await app.click(
              `[data-testid="session-history-filter"] [aria-label="Clear filter"]`,
            );
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length >= ${grown.length}`,
              { timeoutMs: 8_000 },
            );
            const restored = await app.evalJS<string[]>(shasNow);
            // Nothing was lost to the round trip through the filter: the pages
            // already walked are still held, in order.
            expect(restored.slice(0, grown.length)).toEqual(grown);
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
