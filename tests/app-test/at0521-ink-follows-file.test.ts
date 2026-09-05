/**
 * at0521-ink-follows-file.test.ts — a path in ink acts like the file it
 * names, as that file is right now.
 *
 * ## What this gates
 *
 * Two paths in one transcript, written the same way, naming two files that
 * both existed, behaved differently: one carried the file's menu and opened
 * in the editor, the other was inert text. The reader had no way to account
 * for the difference, because there was none in the world — the real
 * difference was *when the sentence was painted relative to when the file
 * was written*, which is a fact about the implementation and nothing a
 * reader should ever have to know.
 *
 * The sequence that produced it is the sequence this file drives, in order:
 *
 *  1. a Bash tool header names the path in the command that is about to
 *     create it, so the resolver is asked about a file that is not there yet
 *     and the answer `missing` is cached app-wide;
 *  2. the assistant's prose names the same path, twice, and reads that
 *     cached "no";
 *  3. the command runs and the file appears.
 *
 * Before this arc, step 3 reached nothing: only a `pending` verdict marked a
 * container as awaiting an answer, so a container that met `missing` was
 * never walked again, and the sixty-second re-ask lived inside a pass that
 * never came. The ink stayed plain for the life of the app.
 *
 * ## The four facts, in one frame
 *
 * Once the file exists the mention must earn everything a confirmed path
 * earns anywhere — there is no second seam to close, because the menu and
 * the press are already uniform and both hang off the verdict:
 *
 *  1. **the underline** — `data-tug-annotation="file-path"` on both spans,
 *     with no reload and no scroll, within a beat rather than a minute;
 *  2. **the registry menu** — a secondary press opens the file's own menu,
 *     with `open-file` on it;
 *  3. **the whole-entity selection** — the same two facts `at0520` asserts
 *     on every surface: the DOM selection stands on the entity and the
 *     entity wears `data-tug-entity-selected`, so press and verdict are
 *     proven on one surface together rather than in two files that drift;
 *  4. **one path, one face** — the debug audit finds no spelling the
 *     transcript is drawing two ways.
 *
 * Then the other direction, which is the half a "waiting" flag could never
 * have reached: the file is **deleted**, and both mentions go plain.
 *
 * The file is created under this worktree because the repo is the app-test's
 * bootstrap workspace — the one tugcast's `FileWatcher` watches — so the
 * `FILESYSTEM` frame that carries the news is a real frame off the real
 * wire. It is removed again in `afterAll` whichever way the run ends.
 *
 * @covers tugdeck/src/lib/annotator/
 * @covers tugdeck/src/lib/annotator/path-resolution.ts
 * @covers tugdeck/src/lib/annotator/verdict-keys.ts
 * @covers tugdeck/src/lib/annotator/verdict-batching.ts
 * @covers tugdeck/src/lib/annotator/annotate-content.ts
 * @covers tugdeck/src/lib/annotator/path-face-audit.ts
 * @covers tugdeck/src/lib/filesystem-feed.ts
 * @covers tugdeck/src/lib/whole-entity-press.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/annotation-scope.tsx
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/test-surface.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-I";

/** This worktree — the app-test's bootstrap workspace, and what is watched. */
const REPO = resolve(import.meta.dir, "..", "..");

/**
 * The file the transcript names before it exists. Under `notes/`, which is a
 * tracked directory the watcher covers; the pid keeps two runs on one machine
 * from sharing a name.
 */
const REL = `notes/at0521-ink-follows-file-${process.pid}.md`;
const ABS = join(REPO, REL);
const BODY = "the file the sentence was about\n";

afterAll(() => {
  if (existsSync(ABS)) rmSync(ABS, { force: true });
});

const CARD = '[data-card-id="I"]';
const TRANSCRIPT = `${CARD} .session-card-transcript-code-body`;
const MENU = '[data-slot="tug-editor-context-menu"]';

function deckShape() {
  return {
    cards: [{ id: "I", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "pI",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
        cardIds: ["I"],
        activeCardId: "I",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pI",
    hasFocus: true,
  };
}

/**
 * Both mentions of the path, and what face each is wearing. Read as one
 * object so the two are compared in one frame rather than across two reads
 * that could straddle a batch.
 */
const mentionsJS = `JSON.stringify((function(){
  var codes = Array.from(document.querySelectorAll(
    ${JSON.stringify(TRANSCRIPT)} + ' code'));
  var ours = codes.filter(function (c) {
    var text = (c.textContent || '') + (c.getAttribute('data-tugx-file-text') || '');
    return text === ${JSON.stringify(ABS)};
  });
  return {
    count: ours.length,
    kinds: ours.map(function (c) { return c.getAttribute('data-tug-annotation'); }),
    paths: ours.map(function (c) { return c.getAttribute('data-path'); }),
  };
})())`;

interface Mentions {
  count: number;
  kinds: (string | null)[];
  paths: (string | null)[];
}

/** The whole-entity press's two facts, read while the menu is open. */
function settledJS(selector: string): string {
  return `JSON.stringify((function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return { found: false };
    var sel = window.getSelection();
    var tidy = function (s) { return (s || "").replace(/[\\s\\u200B\\uFEFF]+/g, ""); };
    var covers = false;
    if (sel !== null && !sel.isCollapsed) {
      for (var i = 0; i < sel.rangeCount; i += 1) {
        if (sel.getRangeAt(i).intersectsNode(el)) covers = true;
      }
    }
    return {
      found: true,
      selected: tidy(sel === null ? "" : sel.toString()),
      text: tidy(el.textContent || el.getAttribute('data-tugx-file-text')),
      covers: covers,
      marked: el.hasAttribute("data-tug-entity-selected"),
    };
  })())`;
}

interface Settled {
  found: boolean;
  selected?: string;
  text?: string;
  covers?: boolean;
  marked?: boolean;
}

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string, seq: number) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq,
});

describe.skipIf(!SHOULD_RUN)("at0521 — ink follows the file", () => {
  test(
    "a path named before its file exists lights when the file arrives, and darkens when it goes",
    async () => {
      // A run that crashed before its afterAll could leave one behind.
      if (existsSync(ABS)) rmSync(ABS, { force: true });

      const app = await launchTugApp({ testName: "at0521-ink-follows-file" });
      const ingest = (decoded: unknown) =>
        app.driveSession("I", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });
      const readMentions = async (): Promise<Mentions> =>
        JSON.parse(await app.evalJS<string>(mentionsJS)) as Mentions;

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "I" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("I")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("I", { tugSessionId: SID, sessionMode: "resume" });

        await ingest({ type: "replay_started", tug_session_id: SID });
        await ingest(userMsg("write the note"));

        // 1. The Bash header asks about the path the command is about to
        //    create. This is what poisons the cache with `missing`.
        await ingest({
          type: "tool_use",
          tug_session_id: SID,
          msg_id: "m1",
          tool_use_id: "tc-1",
          tool_name: "Bash",
          input: { command: `cat > ${ABS} <<'EOF'\n${BODY}EOF` },
          seq: 1,
        });

        // 2. The prose names the same path twice, reading that cached "no".
        //    Each mention gets a paragraph of its own: an absolute path very
        //    nearly fills the transcript's width, and a run that wraps has a
        //    bounding box whose centre is in the empty margin past the short
        //    second line — which is the paragraph, not the run, and is where
        //    a press aimed at the box would land.
        await ingest(
          asstText(
            "m1",
            `Wrote the note.\n\n\`${ABS}\`\n\nAnd the same file again:\n\n\`${ABS}\`\n`,
            2,
          ),
        );
        await ingest({
          type: "turn_complete",
          tug_session_id: SID,
          msg_id: "m1",
          result: "success",
        });
        await ingest({
          type: "replay_complete",
          tug_session_id: SID,
          count: 1,
          firstLoadedTurnIndex: 0,
          totalTurns: 1,
          hasOlder: false,
        });

        await app.waitForCondition<boolean>(
          `JSON.parse(${mentionsJS}).count === 2`,
          { timeoutMs: 8000 },
        );
        const before = await readMentions();
        note("at0521 before the file exists", JSON.stringify(before));
        // Both spans are plain, and they agree about being plain: the fault
        // was never the silence, it was the silence being wrong.
        expect(before.kinds).toEqual([null, null]);

        // 3. The command runs.
        writeFileSync(ABS, BODY, "utf8");

        // Within a beat — the watcher's debounce plus one verdict batch —
        // and with no reload, both mentions carry the underline. Well inside
        // the sixty-second fallback, which is what makes this the feed's
        // claim rather than the timer's.
        await app.waitForCondition<boolean>(
          `JSON.parse(${mentionsJS}).kinds.every(function(k){ return k === "file-path"; })`,
          { timeoutMs: 15_000 },
        );
        const lit = await readMentions();
        note("at0521 after the file arrives", JSON.stringify(lit));
        expect(lit.count).toBe(2);
        expect(lit.kinds).toEqual(["file-path", "file-path"]);
        // The canonical path the endpoint returned — the same one for both,
        // which is what "one key, one face" means where it is observable.
        expect(lit.paths[0]).not.toBeNull();
        expect(lit.paths[1]).toBe(lit.paths[0]!);

        // --- the registry menu, and the whole-entity press ---------------
        const MENTION = `${TRANSCRIPT} [data-tug-annotation="file-path"]`;
        await app.nativeRightClickAtElement(MENTION);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="open-file"]') !== null`,
          { timeoutMs: 8000 },
        );
        const settled = JSON.parse(
          await app.evalJS<string>(settledJS(MENTION)),
        ) as Settled;
        note("at0521 press", JSON.stringify(settled));
        expect(settled.found).toBe(true);
        expect(settled.covers).toBe(true);
        expect(settled.marked).toBe(true);
        expect(settled.selected).toBe(settled.text!);

        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) === null`,
          { timeoutMs: 8000 },
        );

        // --- one path, one face -----------------------------------------
        const conflicts = await app.evalJS<unknown[]>(
          `window.__tug.auditPathFaces(${JSON.stringify(TRANSCRIPT)})`,
        );
        note("at0521 face audit", JSON.stringify(conflicts));
        expect(conflicts).toEqual([]);

        // --- and the other direction ------------------------------------
        rmSync(ABS, { force: true });
        await app.waitForCondition<boolean>(
          `JSON.parse(${mentionsJS}).kinds.every(function(k){ return k === null; })`,
          { timeoutMs: 15_000 },
        );
        const dark = await readMentions();
        note("at0521 after the file goes", JSON.stringify(dark));
        expect(dark.count).toBe(2);
        expect(dark.kinds).toEqual([null, null]);

        const afterConflicts = await app.evalJS<unknown[]>(
          `window.__tug.auditPathFaces(${JSON.stringify(TRANSCRIPT)})`,
        );
        expect(afterConflicts).toEqual([]);
      } finally {
        if (existsSync(ABS)) rmSync(ABS, { force: true });
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
