/**
 * at0307-transcript-file-path-links.test.ts — file paths in assistant prose
 * become links, but only the ones that are real.
 *
 * A path the assistant writes in backticks is inert text until the
 * annotator has asked the filesystem about it. This drives that whole
 * round trip against the real app and the real `POST /api/fs/stat`: two
 * path-shaped spans render, one naming a file that exists on disk and one
 * naming a sibling that does not, and only the first ever becomes
 * clickable. That asymmetry is the feature — a link that dead-ends is
 * worse than plain text, so verification, not grammar, is the gate.
 *
 * Then the payoff: clicking the confirmed path opens it in a Text card,
 * at the line the reference cited.
 *
 * Asserts:
 *  - **verification gates the affordance**: the existing path gains
 *    `data-tug-annotation="file-path"` + `data-path`; the missing one
 *    never does, however long we wait;
 *  - **the canonical path is what is stamped**, not the string as
 *    written (the endpoint resolves symlinks — on macOS the temp dir is
 *    one);
 *  - **focus discipline**: the annotation carries the attributes that
 *    stop a click from stealing the composer's caret;
 *  - **the click opens the file** in a Text card showing its content.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * The rest of the file is one test per source the same annotation comes
 * from, because each was a distinct way the annotator used to miss:
 *
 *  - **a tool-call header's file ref** — born confirmed (the tool just
 *    touched the file) and owning no handlers of its own; the delegated
 *    layer services it exactly as it services prose, and it wears the
 *    same resting rule a mention wears — on its label, so the leading
 *    glyph takes no line.
 *  - **a Glob result row** — the same annotation from a third source,
 *    cashing in the "make rows interactive" deferral `PathListBlock`'s
 *    docstring carried.
 *  - **a bare filename** with no path at all. `fs/stat` cannot answer it
 *    (a name says what to look for, not where), so the case rests on the
 *    project's file index, and the assertion is that the index finds the
 *    file where it actually lives — nowhere near the root the name was
 *    resolved against.
 *  - **a subagent's own prose**, which was skipped wholesale: markdown
 *    nested several components below the transcript cell, where every
 *    intervening renderer would have had to forward a context prop it does
 *    not care about. It also pins the whole path matching as one run —
 *    link detection splits a text node at a filename whose extension is a
 *    top-level domain (`.md` is Moldova's), and a half-scanned path reads
 *    as its own parent directory.
 *  - **a cited line range** (`path:124-135`), the shape prose uses for a
 *    function or a docstring. Until the range parsed, the suffix rode
 *    along as part of the path, so the reference resolved to nothing and
 *    sat entirely unmarked rather than merely line-less.
 *  - **a directory chip**, which used to render as an object the
 *    transcript showed and refused to act on.
 *  - **a Bash tool header**, the surface that showed the real structural
 *    limit: React-rendered rather than markdown, with the path *inside* a
 *    longer command line, so it needed both the non-markdown entry point
 *    and matching a run rather than a whole element. Its `cd` target is a
 *    directory, which the loosened stat reports as reachable and the pass
 *    marks with the folder gesture rather than the file one.
 *
 * A last case covers the gesture's twin: the reference's own **Open in
 * Editor** menu item. Both it and the click send the same `open-file`
 * command carrying the same target, so neither depends on an
 * intermediate responder to supply the path.
 *
 * @covers tugdeck/src/lib/annotator/
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 * @covers tugdeck/src/components/tugways/annotation-scope.tsx
 * @covers tugdeck/src/components/tugways/annotation-portals.tsx
 * @covers tugdeck/src/components/tugways/commit-tip-portals.tsx
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/tug-atom-ref.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/path-list-block.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/agent-transcript-block.tsx
 * @covers tugrust/crates/tugcast/src/fs_stat.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

/** This repository, which is the app-test bootstrap FILETREE workspace. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A file that exists exactly once here, named the way prose names it. */
const INDEXED_NAME = "tug-button.css";

const FILE_NAME = "notes.md";
const MISSING_NAME = "not-here.md";
const CITED_LINE = 3;
const FILE_BODY = ["alpha", "bravo", "charlie", "delta", "echo"].join("\n");

let projectDir = "";
let realPath = "";
let missingPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0307-paths-"));
  realPath = join(projectDir, FILE_NAME);
  missingPath = join(projectDir, MISSING_NAME);
  writeFileSync(realPath, FILE_BODY, "utf8");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

type Harness = Awaited<ReturnType<typeof launchTugApp>>;

/**
 * Open the annotation's context menu with a trusted native right-click
 * and wait for `action`'s item to mount. Synthetic events don't fire the
 * menu's real activation path, so the gestures here are native.
 */
async function openAnnotationMenu(
  app: Harness,
  selector: string,
  action: string,
): Promise<void> {
  await app.nativeRightClickAtElement(selector);
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-item-action="' + ${JSON.stringify(action)} + '"]') !== null`,
    { timeoutMs: 3000 },
  );
}

/** Trusted native-click the open menu's item with `data-item-action === action`. */
async function activateMenuItem(app: Harness, action: string): Promise<void> {
  const point = await app.evalJS<{ x: number; y: number } | null>(
    `(() => {
      const item = document.querySelector('[data-item-action="' + ${JSON.stringify(action)} + '"]');
      if (item === null) return null;
      const r = item.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  if (point === null) throw new Error(`menu item ${action} not found`);
  await app.nativeClick(point);
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
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});

/** Read one assistant code span's annotation state by a text substring. */
const spanStateJS = (needle: string) => `JSON.stringify((function(){
  var codes = Array.from(document.querySelectorAll(
    '[data-card-id="A"] .session-card-transcript-code-body code'));
  var el = codes.find(function(c){
    return (c.textContent || '') === ${JSON.stringify(needle)};
  });
  if (!el) return { found: false };
  return {
    found: true,
    kind: el.getAttribute('data-tug-annotation'),
    path: el.getAttribute('data-path'),
    line: el.getAttribute('data-line'),
    focus: el.getAttribute('data-tug-focus'),
    noActivate: el.hasAttribute('data-no-activate'),
  };
})())`;

describe.skipIf(!SHOULD_RUN)(
  "AT0307: verified file paths in transcript prose become links",
  () => {
    test(
      "only the path that exists becomes clickable, and clicking it opens the file",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });
        const readSpan = async (needle: string) =>
          JSON.parse(await app.evalJS<string>(spanStateJS(needle))) as {
            found: boolean;
            kind?: string | null;
            path?: string | null;
            line?: string | null;
            focus?: string | null;
            noActivate?: boolean;
          };

        // One span per case: an existing file with a line citation, and a
        // sibling that was never written.
        const citedSpan = `${realPath}:${CITED_LINE}`;
        const assistantText =
          `See \`${citedSpan}\` — but not \`${missingPath}\`.`;

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          await ingest(replayStarted());
          await ingest(userMsg("where is it"));
          await ingest(asstText("m1", assistantText, 1));
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          // Both spans render. Neither is actionable yet — nothing has
          // been asked of the filesystem at paint time.
          await app.waitForCondition<boolean>(
            `JSON.parse(${spanStateJS(citedSpan)}).found === true`,
            { timeoutMs: 8000 },
          );

          // --- verification confirms one and refuses the other ---------
          await app.waitForCondition<boolean>(
            `JSON.parse(${spanStateJS(citedSpan)}).kind === "file-path"`,
            { timeoutMs: 8000 },
          );
          const confirmed = await readSpan(citedSpan);
          // The stamped path is the endpoint's canonical form, so it may
          // differ from what was written (macOS resolves the temp dir
          // through /private) — what must hold is that it is absolute and
          // names the file.
          expect(confirmed.path?.startsWith("/")).toBe(true);
          expect(confirmed.path?.endsWith(`/${FILE_NAME}`)).toBe(true);
          expect(confirmed.line).toBe(String(CITED_LINE));
          // Focus discipline: a click here must not pull the caret out of
          // wherever the user is typing.
          expect(confirmed.focus).toBe("refuse");
          expect(confirmed.noActivate).toBe(true);

          const missing = await readSpan(missingPath);
          expect(missing.found).toBe(true);
          expect(missing.kind).toBeNull();
          expect(missing.path).toBeNull();

          // --- the click opens the file --------------------------------
          await app.click(
            `[data-card-id="A"] code[data-tug-annotation="file-path"]`,
          );
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a tool header's file ref is the same annotation, serviced by the same layer",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-header",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          await ingest(replayStarted());
          await ingest(userMsg("read it"));
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-1",
            tool_name: "Read",
            input: { file_path: realPath },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            tug_session_id: SID,
            tool_use_id: "tc-1",
            output: FILE_BODY,
          });
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          // The header ref is born confirmed — the tool just read this
          // file — so it carries the annotation immediately, with no
          // probe and nothing to wait for.
          const HEADER_REF = '[data-card-id="A"] [data-slot="read-tool-block-path"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${HEADER_REF}') !== null`,
            { timeoutMs: 8000 },
          );
          const ref = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${HEADER_REF}');
              if (!el) return { found: false };
              return {
                found: true,
                kind: el.getAttribute('data-tug-annotation'),
                path: el.getAttribute('data-path'),
                annotated: el.classList.contains('tugx-annotation'),
                focus: el.getAttribute('data-tug-focus'),
                noActivate: el.hasAttribute('data-no-activate'),
              };
            })())`),
          ) as Record<string, unknown>;
          expect(ref.kind).toBe("file-path");
          expect(ref.annotated).toBe(true);
          expect(ref.path).toBe(realPath);
          expect(ref.focus).toBe("refuse");
          expect(ref.noActivate).toBe(true);

          // And it wears the same resting rule a confirmed mention wears
          // in prose — the whole point of one declaration keyed on the
          // contract. The rule sits on the LABEL, not on the skin: a
          // decoration on the skin would paint across the leading glyph
          // too, and an atom's mark is its name.
          const decoration = (selector: string) =>
            app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector(${JSON.stringify(selector)});
              if (el === null) return null;
              var s = getComputedStyle(el);
              return { line: s.textDecorationLine, thickness: s.textDecorationThickness, style: s.textDecorationStyle };
            })())`);
          const labelRule = JSON.parse(
            await decoration(`${HEADER_REF} .tug-atom-ref-label`),
          ) as { line: string; thickness: string; style: string };
          expect(labelRule.line).toBe("underline");
          expect(labelRule.thickness).toBe("1px");
          expect(labelRule.style).toBe("solid");
          const skinRule = JSON.parse(await decoration(HEADER_REF)) as {
            line: string;
          };
          expect(skinRule.line).toBe("none");

          // And the delegated layer — not any handler the component owns
          // — turns a click on it into an open.
          await app.click(HEADER_REF);
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the reference's Open in Editor menu item opens it too",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-menu",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          await ingest(replayStarted());
          await ingest(userMsg("read it"));
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-1",
            tool_name: "Read",
            input: { file_path: realPath },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            tug_session_id: SID,
            tool_use_id: "tc-1",
            output: FILE_BODY,
          });
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const HEADER_REF = '[data-card-id="A"] [data-slot="read-tool-block-path"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${HEADER_REF}') !== null`,
            { timeoutMs: 8000 },
          );

          // The item names what it acts on: its dispatch carries the
          // annotation's path as its own value, so it reaches the deck's
          // open-file handler rather than stopping at a surface that
          // would have had to supply the argument.
          await openAnnotationMenu(app, HEADER_REF, "open-file");
          await activateMenuItem(app, "open-file");
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a Glob result row opens the file it names",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-glob",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-card-id="A"] [data-slot="session-telemetry-status-row"]') !== null`,
            { timeoutMs: 8000 },
          );

          // A live turn, not a replay: the tool call has to reach its
          // settled state for the block to render a body at all.
          await app.driveSession("A", { op: "send", text: "find it" });
          await ingest({
            type: "tool_use",
            msg_id: "m1",
            tool_use_id: "tc-g1",
            tool_name: "Glob",
            input: { pattern: "*.md", path: projectDir },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            tool_use_id: "tc-g1",
            output: realPath,
          });
          await ingest({
            type: "tool_use_structured",
            tool_use_id: "tc-g1",
            tool_name: "Glob",
            structured_result: {
              filenames: [realPath],
              numFiles: 1,
              truncated: false,
            },
          });
          await ingest({ type: "turn_complete", msg_id: "m1", result: "success" });

          // A Glob block mounts collapsed — its header is the whole block
          // until the disclosure is opened, so the rows are not in the DOM
          // yet.
          const GLOB = '[data-card-id="A"] [data-slot="glob-tool-block"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${GLOB}') !== null`,
            { timeoutMs: 8000 },
          );
          await app.click(`${GLOB} [data-slot="tool-call-header-disclosure"]`);

          const ROW = '[data-card-id="A"] [data-slot="path-list-row"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${ROW}') !== null`,
            { timeoutMs: 8000 },
          );
          const row = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${ROW}');
              if (!el) return { found: false };
              return {
                found: true,
                kind: el.getAttribute('data-tug-annotation'),
                path: el.getAttribute('data-path'),
                annotated: el.classList.contains('tugx-annotation'),
              };
            })())`),
          ) as Record<string, unknown>;
          expect(row.kind).toBe("file-path");
          expect(row.annotated).toBe(true);
          expect(row.path).toBe(realPath);

          await app.click(ROW);
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a bare filename in prose resolves through the project's file index",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-name",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          // Bound to this repository, which is the app-test bootstrap
          // workspace — so FILETREE answers about real files here.
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
            projectDir: REPO_ROOT,
            workspaceKey: REPO_ROOT,
          });

          // A bare filename with no path at all, written as code — the
          // form the corpus actually uses, and the one the grammar
          // trusts. `fs/stat` cannot answer it (a name says what to look
          // for, not where), so the whole case rests on the index.
          await ingest(replayStarted());
          await ingest(userMsg("which file"));
          await ingest(
            asstText("m1", `I changed \`${INDEXED_NAME}\` to match.`, 1),
          );
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          // The span is entirely one reference, so it is marked on the
          // `<code>` element it already has rather than split out.
          const MARK = `[data-card-id="A"] code[data-tug-annotation="file-path"]`;
          await app.waitForCondition<boolean>(
            `document.querySelector('${MARK}') !== null`,
            { timeoutMs: 20_000 },
          );
          const mark = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${MARK}');
              return { text: el.textContent, path: el.getAttribute('data-path') };
            })())`),
          ) as { text: string; path: string | null };
          expect(mark.text).toBe(INDEXED_NAME);
          // The index knows where it actually lives, which is nowhere near
          // the repo root the name was resolved against.
          expect(mark.path).toBe(
            `${REPO_ROOT}/tugdeck/src/components/tugways/internal/${INDEXED_NAME}`,
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the same bare filename marks unbackticked, split out of the sentence",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-bare",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
            projectDir: REPO_ROOT,
            workspaceKey: REPO_ROOT,
          });

          // The same name as the case above, with the backticks taken
          // off. Whether the model reached for backticks decides the code
          // TONE and nothing else; the resolver is the only gate on the
          // mark, so this run has to come back marked exactly like its
          // backticked twin — split out of the sentence, since it is a run
          // inside a longer text node rather than its own element.
          await ingest(replayStarted());
          await ingest(userMsg("which file"));
          await ingest(asstText("m1", `I changed ${INDEXED_NAME} to match.`, 1));
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const MARK = `[data-card-id="A"] span[data-tugx-wrapped][data-tug-annotation="file-path"]`;
          // The mark's own words come back one render after the mark does:
          // the file tip portals into the run, and hosting a portal means
          // emptying the span first (`file-tip-portals.tsx`). Waiting on the
          // element alone would read the empty host mid-flight.
          await app.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector('${MARK}');
              return el !== null && (el.textContent || "") !== "";
            })()`,
            { timeoutMs: 20_000 },
          );
          const mark = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${MARK}');
              return {
                text: el.textContent,
                path: el.getAttribute('data-path'),
                inCode: el.closest('code') !== null,
              };
            })())`),
          ) as { text: string; path: string | null; inCode: boolean };
          expect(mark.text).toBe(INDEXED_NAME);
          expect(mark.path).toBe(
            `${REPO_ROOT}/tugdeck/src/components/tugways/internal/${INDEXED_NAME}`,
          );
          // Running prose, not a code span — this is the run the old
          // license refused.
          expect(mark.inCode).toBe(false);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a subagent's own prose is annotated like everyone else's",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-subagent",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          // A subagent's answer is markdown nested several components
          // below the transcript cell. It was skipped wholesale, because
          // every intervening renderer would have had to forward a context
          // prop it does not otherwise care about — and none did.
          await ingest(replayStarted());
          await ingest(userMsg("go look"));
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-a1",
            tool_name: "Agent",
            input: { subagent_type: "Explore", description: "find it" },
            seq: 1,
          });
          await ingest({
            type: "tool_use_structured",
            tug_session_id: SID,
            tool_use_id: "tc-a1",
            tool_name: "Agent",
            structured_result: {
              agentType: "Explore",
              status: "completed",
              content: [
                {
                  type: "text",
                  text: `File: ${realPath}\n\nAlso see \`${realPath}\`.`,
                },
              ],
            },
          });
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const AGENT_TEXT = `[data-card-id="A"] [data-slot="agent-transcript-text"]`;
          await app.waitForCondition<boolean>(
            `document.querySelector('${AGENT_TEXT}') !== null`,
            { timeoutMs: 10_000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('${AGENT_TEXT} [data-tug-annotation="file-path"]').length === 2`,
            { timeoutMs: 15_000 },
          );
          const marks = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var els = Array.from(document.querySelectorAll(
                '${AGENT_TEXT} [data-tug-annotation="file-path"]'));
              return {
                paths: els.map(function(e){ return e.getAttribute('data-path'); }),
                tags: els.map(function(e){ return e.tagName; }),
              };
            })())`),
          ) as { paths: (string | null)[]; tags: string[] };
          // Both forms resolve to the same file: the absolute path in
          // running prose (unmistakable, so prose keeps it) and the one
          // written as code. The prose one also proves the whole path is
          // matched as one run — link detection splits a text node at a
          // filename whose extension is a top-level domain (`.md` is
          // Moldova's), and a half-scanned path reads as its own parent
          // directory.
          expect(marks.paths.every((p) => p?.endsWith(`/${FILE_NAME}`))).toBe(
            true,
          );
          expect(marks.tags).toContain("CODE");
          expect(marks.tags).toContain("SPAN");

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a cited line range in prose opens the file at those lines",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-range",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          // The shape prose uses to cite a function or a docstring. Before
          // the range was parsed, the `:124-135` suffix rode along as part
          // of the path, so the whole reference resolved to nothing and
          // sat inert — not merely line-less, entirely unmarked.
          await ingest(replayStarted());
          await ingest(userMsg("where is it"));
          await ingest(
            asstText("m1", `Model A (${realPath}:2-4) wires it.`, 1),
          );
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const MARK = `[data-card-id="A"] [data-tug-annotation="file-path"]`;
          await app.waitForCondition<boolean>(
            `document.querySelector('${MARK}') !== null`,
            { timeoutMs: 15_000 },
          );
          const mark = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${MARK}');
              return {
                text: el.textContent,
                path: el.getAttribute('data-path'),
                line: el.getAttribute('data-line'),
                endLine: el.getAttribute('data-end-line'),
              };
            })())`),
          ) as Record<string, unknown>;
          // The citation is inside the link and the parenthesis is not.
          expect(mark.text).toBe(`${realPath}:2-4`);
          expect(mark.path).toBe(`/private${realPath}`);
          expect(mark.line).toBe("2");
          expect(mark.endLine).toBe("4");

          // And the click lands on the cited lines, not merely the file.
          await app.click(MARK);
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a directory chip is not inert — it carries the annotation its type earns",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-dir",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          // A `@`-mention whose value ends in `/` replays as a directory
          // atom. It used to render as a chip with nothing behind it —
          // an object the transcript showed and refused to act on.
          await ingest(replayStarted());
          await ingest(userMsg(`look in \`@${projectDir}/\``));
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const CHIP = '[data-card-id="A"] [data-tug-annotation="directory"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${CHIP}') !== null`,
            { timeoutMs: 8000 },
          );
          const chip = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${CHIP}');
              return {
                path: el.getAttribute('data-path'),
                annotated: el.classList.contains('tugx-annotation'),
                focus: el.getAttribute('data-tug-focus'),
                noActivate: el.hasAttribute('data-no-activate'),
              };
            })())`),
          ) as Record<string, unknown>;
          // The payload is a path, so the index form's trailing separator
          // is gone.
          expect(chip.path).toBe(projectDir);
          expect(chip.annotated).toBe(true);
          expect(chip.focus).toBe("refuse");
          expect(chip.noActivate).toBe(true);

          // The click is deliberately not driven here: it hands the path
          // to the Finder, and an app-test that opens Finder windows is a
          // test that fights the machine it runs on.

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a path inside a Bash command line is annotated where it sits",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-bash",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          // The header is React-rendered, not markdown, and the path is a
          // fragment of a longer command line. Both were reasons the
          // annotator used to miss it: it only ran over rendered markdown,
          // and it only ever matched a whole element.
          // A `cd` target is a directory, and a directory is a real thing
          // to point at — the stat behind this asks whether anything is
          // there, not whether it is a regular file.
          const commandLine = `cd ${projectDir} && wc -l ${realPath} ${missingPath}`;
          await ingest(replayStarted());
          await ingest(userMsg("count them"));
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-b1",
            tool_name: "Bash",
            input: { command: commandLine },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            tug_session_id: SID,
            tool_use_id: "tc-b1",
            output: "5 total",
          });
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const COMMAND =
            '[data-card-id="A"] [data-slot="bash-tool-block-command"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${COMMAND}') !== null`,
            { timeoutMs: 8000 },
          );

          // The run that names a real file becomes its own annotated span
          // inside the command; the run naming a missing sibling does not,
          // so verification still gates the affordance one fragment at a
          // time rather than for the header as a whole.
          await app.waitForCondition<boolean>(
            `document.querySelector('${COMMAND} [data-tug-annotation="file-path"]') !== null`,
            { timeoutMs: 8000 },
          );
          const marks = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var host = document.querySelector('${COMMAND}');
              if (!host) return { found: false };
              var spans = Array.from(
                host.querySelectorAll('[data-tug-annotation="file-path"]'));
              var dirs = Array.from(
                host.querySelectorAll('[data-tug-annotation="directory"]'));
              return {
                found: true,
                count: spans.length,
                text: spans.map(function(s){ return s.textContent; }),
                paths: spans.map(function(s){ return s.getAttribute('data-path'); }),
                dirText: dirs.map(function(s){ return s.textContent; }),
                wrapped: spans.concat(dirs).every(function(s){
                  return s.hasAttribute('data-tugx-wrapped');
                }),
                // The command line itself is intact — splitting the runs
                // out must not disturb the text around them.
                whole: (host.textContent || ''),
              };
            })())`),
          ) as {
            found: boolean;
            count: number;
            text: string[];
            paths: (string | null)[];
            dirText: string[];
            wrapped: boolean;
            whole: string;
          };
          expect(marks.found).toBe(true);
          expect(marks.count).toBe(1);
          expect(marks.text).toEqual([realPath]);
          expect(marks.paths[0]?.endsWith(`/${FILE_NAME}`)).toBe(true);
          // The `cd` target resolves as a directory, not a file: same
          // reference shape in ink, different gesture, and only the
          // filesystem knows which.
          expect(marks.dirText).toEqual([projectDir]);
          expect(marks.wrapped).toBe(true);
          expect(marks.whole).toBe(commandLine);

          // And it opens, through the same delegated layer every other
          // annotation uses.
          await app.click(`${COMMAND} [data-tug-annotation="file-path"]`);
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
