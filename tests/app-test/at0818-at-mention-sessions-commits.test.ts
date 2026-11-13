/**
 * at0818-at-mention-sessions-commits.test.ts — `@` in the Session card's
 * composer finds a session in another project and a commit far down the
 * history, and each is accepted as its own atom.
 *
 * ## What this gates
 *
 * The unit suites cover the pieces over recorded answers: the providers'
 * exchange, the merge's groups, the strip that keeps a prefix's colon. What
 * only the running app has is the whole path at once — the popup asking
 * tugcast, tugcast searching its ledger and the repository's history, the
 * answer finding its way back to the provider that asked, and the accepted
 * row becoming the chip every other surface mints.
 *
 *   A. **A session in another project is offered and accepted.** The card is
 *      open on one project; the session it names lives in another. The row
 *      reads `<project>/<callsign>` and wears the session's dot, and Return
 *      inserts a session chip.
 *   B. **A commit older than any page the log shows is offered and
 *      accepted.** The repository has sixty commits and the one named is the
 *      first of them, so only a search in git can have found it. The row
 *      wears the commit's ring, and Return inserts a commit chip carrying the
 *      full sha.
 *   C. **Submitted, each goes out as its own marker**: the session typed as
 *      `@session:<project>/<callsign>`, the commit as its sha.
 *
 * @covers tugdeck/src/components/tugways/cards/completion-providers/session-mentions.ts
 * @covers tugdeck/src/components/tugways/cards/completion-providers/commit-mentions.ts
 * @covers tugdeck/src/components/tugways/cards/completion-providers/remote-search.ts
 * @covers tugdeck/src/components/tugways/cards/completion-providers/mention-merge.ts
 * @covers tugdeck/src/components/tugways/cards/completion-providers/mentions.ts
 * @covers tugdeck/src/components/tugways/cards/use-session-card-services.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/completion-extension.ts
 * @covers tugdeck/src/lib/session-search-answers.ts
 * @covers tugrust/crates/tugcast/src/feeds/session_search.rs
 * @covers tugrust/crates/tugcast/src/feeds/git.rs
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The card's own session. */
const SESSION_ID = "c1d2e3f4-0000-4000-8000-00000000a818";

/** The session the mention names — another project entirely. */
const OTHER_SESSION = "d2e3f4a5-0000-4000-8000-00000000b818";
const OTHER_DIR = "/Users/tester/src/beta";
const OTHER_TAG = "quiet-harbor";
const OTHER_TITLE = "the beta rewrite";
const REFERENCE = `beta/${OTHER_TAG}`;

/** The subject of the repository's FIRST commit, sixty deep. */
const OLD_SUBJECT = "Calibrate the zephyrine sextant";
const COMMIT_COUNT = 60;

const COMPOSER = '[data-card-id="S"] [data-slot="tug-text-editor"] .cm-content';
const COMPLETION_MENU = '[data-slot="tug-completion-menu"]';
const ITEM = `${COMPLETION_MENU} .tug-completion-menu-item`;
const chip = (type: string) => `${COMPOSER} img[data-atom-type="${type}"]`;

/** Each popup row: its text and the kind mark it wears. */
const ROWS_JS = `Array.from(document.querySelectorAll(${JSON.stringify(ITEM)})).map(function (el) {
  var mark = el.querySelector(".tug-completion-menu-mark");
  return { text: (el.textContent || "").trim(), mark: mark ? mark.getAttribute("data-mark") : null };
})`;

interface Row {
  text: string;
  mark: string | null;
}

function deckShape() {
  return {
    cards: [{ id: "S", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
        cardIds: ["S"],
        activeCardId: "S",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * A repository of {@link COMMIT_COUNT} commits whose first is
 * {@link OLD_SUBJECT}, written in one `git fast-import`. Returns that first
 * commit's sha.
 */
function makeRepo(dir: string): string {
  const git = (args: string[], stdin?: string) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git(["init", "-q", "-b", "main"]);
  let stream = "";
  for (let i = 1; i <= COMMIT_COUNT; i += 1) {
    const subject = i === 1 ? OLD_SUBJECT : `Routine change ${i}`;
    stream += `commit refs/heads/main\nmark :${i}\n`;
    stream += `committer Tester <tester@example.com> ${1_700_000_000 + i * 60} +0000\n`;
    stream += `data ${Buffer.byteLength(subject)}\n${subject}\n`;
    if (i > 1) stream += `from :${i - 1}\n`;
    stream += "\n";
  }
  git(["fast-import", "--quiet"], stream);
  return git(["rev-list", "--max-parents=0", "main"]);
}

/** Wait for a popup row whose text holds `needle`, and return every row. */
async function waitForRow(app: App, needle: string): Promise<Row[]> {
  await app.body("S").waitForCondition<boolean>(
    `(function () {
      return ${ROWS_JS}.some(function (r) { return r.text.indexOf(${JSON.stringify(needle)}) !== -1; });
    })()`,
    { timeoutMs: 15_000 },
  );
  return app.body("S").evalJS<Row[]>(ROWS_JS);
}

describe.skipIf(!SHOULD_RUN)("at0818 — @ finds sessions and commits", () => {
  test(
    "a session elsewhere and a commit sixty deep are offered, accepted as their atoms, and sent as their markers",
    async () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "at0818-")));
      const oldSha = makeRepo(scratch);
      const app = await launchTugApp({ testName: "at0818-at-mention-sessions-commits" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
        await waitForBodyReady(app, "S");
        await app.bindSession("S", { tugSessionId: SESSION_ID, projectDir: scratch });
        // After the bind, as every ledger seed is: the row names no card, and
        // tugcast has already made its one startup pass over the ledger.
        app.seedLedger({
          sessions: [
            {
              session_id: OTHER_SESSION,
              workspace_key: OTHER_DIR,
              project_dir: OTHER_DIR,
              name: OTHER_TITLE,
              tag: OTHER_TAG,
            },
          ],
        });

        // ---- A. A session in another project. -----------------------------
        await app.body("S").nativeClickAtElement(COMPOSER);
        await app.nativeType("@harbor");
        const sessionRows = await waitForRow(app, REFERENCE);
        note("the popup for @harbor", JSON.stringify(sessionRows));
        const sessionRow = sessionRows.find((r) => r.text.includes(REFERENCE));
        expect(sessionRow?.mark, "a session row wears the dot").toBe("dot");
        expect(sessionRows[0]?.text, "nothing else matches, so the session leads").toContain(REFERENCE);
        await app.nativeKey("Return");
        await app.body("S").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(chip("session"))}) !== null`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.body("S").evalJS<string | null>(
            `document.querySelector(${JSON.stringify(chip("session"))}).getAttribute("data-atom-value")`,
          ),
        ).toBe(REFERENCE);

        // ---- B. A commit older than any page. ------------------------------
        await app.nativeType(" @zephyrine");
        const commitRows = await waitForRow(app, OLD_SUBJECT);
        note("the popup for @zephyrine", JSON.stringify(commitRows));
        const commitRow = commitRows.find((r) => r.text.includes(OLD_SUBJECT));
        expect(commitRow?.mark, "a commit row wears the ring").toBe("ring");
        expect(commitRow?.text, "the row leads with the short sha").toContain(oldSha.slice(0, 8));
        expect(commitRows[0]?.text, "nothing else matches, so the commit leads").toContain(OLD_SUBJECT);
        await app.nativeKey("Return");
        await app.body("S").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(chip("commit"))}) !== null`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.body("S").evalJS<string | null>(
            `document.querySelector(${JSON.stringify(chip("commit"))}).getAttribute("data-atom-value")`,
          ),
        ).toBe(oldSha);

        // ---- C. Submitted, each goes out as its own marker. ----------------
        // Shift-Return submits in this composer; dispatched on the focused
        // editor, it travels the capture pipeline as a hardware key would.
        await app.body("S").evalJS<null>(
          `(function () {
            (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", {
              key: "Enter", code: "Enter", shiftKey: true, bubbles: true, cancelable: true,
            }));
            return null;
          })()`,
        );
        await app.body("S").waitForCondition<boolean>(
          `window.__tug.lastSentUserMessage("S") !== null`,
          { timeoutMs: 10_000 },
        );
        const wire = JSON.parse(
          (await app.body("S").evalJS<string>(`window.__tug.lastSentUserMessage("S")`))!,
        ) as { type: string; content: Array<{ type: string; text?: string }> };
        const sent = wire.content.map((block) => block.text ?? "").join("");
        note("the submission", sent.slice(0, 600));
        expect(sent).toContain(`\`@session:${REFERENCE}\``);
        expect(sent).toContain(`\`@${oldSha}\``);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0818] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
