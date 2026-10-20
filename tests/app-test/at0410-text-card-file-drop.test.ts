/**
 * at0410-text-card-file-drop.test.ts — dropping a file on a Text card writes a
 * real file into a sibling `assets/` folder and inserts a standard markdown
 * link to it, and ⌘-clicking that link opens the asset.
 *
 * ## What this pins
 *
 * The Text card's editor deliberately excluded drop handling — dropping a file
 * on it did nothing at all, and there was no storage or linkage story for an
 * attachment in a document that has to stay pure markdown. The gesture now
 * means something, and what it means is deliberately boring: the bytes are
 * copied next to the document and the document gets a CommonMark link. There
 * is no sidecar bundle, no database id, no `tug://` scheme — the written
 * markdown renders on GitHub and resolves under `cat`.
 *
 * ## Shape
 *
 *   1. A temp directory holding `doc.md`. A Text card opens it.
 *   2. A real PNG from the tree is dropped on the editor via a synthesized
 *      `drop` DragEvent carrying a `File` — the same event the OS delivers for
 *      a Finder drag, driving `/api/fs/attach` for real.
 *   3. Assertions on **disk**: `assets/dropped.png` exists and is byte-identical
 *      to the source. Assertions on the **document**: it carries
 *      `![dropped](assets/dropped.png)` — the image form, relative
 *      destination, no Tug-specific syntax.
 *   4. A second drop of the same filename lands `assets/dropped-2.png` rather
 *      than clobbering the first — and the link still *reads* `![dropped]`.
 *      The suffix is how this feature keeps two files with one name apart;
 *      the user dropped something called `dropped.png` and that is what their
 *      document should say. Only the destination, which has to name a real
 *      file, carries the suffix.
 *   5. ⌘-click on each link — the `![…]` image form and the plain `[…]` form,
 *      since only one of the two exercises the `!` branch of the grammar —
 *      opens a file-view card on the asset.
 *
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/file-drop.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/anchor-links.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/attachment-upload.ts
 * @covers tugdeck/src/lib/open-attachment.ts
 * @covers tugdeck/src/lib/os-open.ts
 * @covers tugrust/crates/tugcast/src/attachments.rs
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/** A real PNG already in the tree — real bytes a real decoder has to handle. */
const REPO_PNG_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "AppIcon-1024b.png",
);

const EDITOR_HOST_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"]';
const EDITOR_CONTENT_SELECTOR = `${EDITOR_HOST_SELECTOR} .cm-content`;

const DOC_SEED = "# Notes\n\nDrop lands here: \n";

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "doc.md", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Drop a real PNG `File` on the editor under `fileName`, and return the exact
 * bytes that were dropped so the test can compare them against what landed on
 * disk.
 *
 * The image is encoded in-page (canvas → blob), which is what a real drag
 * would deliver anyway, and — unlike shipping a fixture's base64 through the
 * RPC — keeps the script small enough to evaluate. `evalJS` cannot await, so
 * the handler signals through a window flag that the test polls, and stashes
 * the bytes for the caller to read back afterwards.
 */
async function dropPngOnEditor(app: App, fileName: string): Promise<Buffer> {
  await app.body("A").evalJS<void>(
    `(function(){
      window.__at0410Dropped = false;
      window.__at0410Bytes = null;
      var host = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
      var canvas = document.createElement("canvas");
      canvas.width = 80; canvas.height = 48;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#2b3a55"; ctx.fillRect(0, 0, 80, 48);
      ctx.fillStyle = "#e8c07d"; ctx.fillRect(10, 10, 28, 28);
      canvas.toBlob(function(blob){
        blob.arrayBuffer().then(function(buf){
          var bytes = new Uint8Array(buf);
          var binary = "";
          for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          window.__at0410Bytes = btoa(binary);

          var file = new File([bytes], ${JSON.stringify(fileName)}, { type: "image/png" });
          var dt = new DataTransfer();
          dt.items.add(file);
          var r = host.getBoundingClientRect();
          var ev = new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            clientX: r.left + 4,
            clientY: r.bottom - 6,
          });
          Object.defineProperty(ev, "dataTransfer", { value: dt });
          host.dispatchEvent(ev);
          window.__at0410Dropped = true;
        });
      }, "image/png");
    })()`,
  );
  await app.body("A").waitForCondition<boolean>(`window.__at0410Dropped === true`, {
    timeoutMs: 10_000,
  });
  return Buffer.from(await app.body("A").evalJS<string>(`window.__at0410Bytes`), "base64");
}

/** The editor's whole document, read off CM6's rendered lines. */
function docText(app: App): Promise<string> {
  return app.body("A").evalJS<string>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT_SELECTOR} .cm-line`)}))
      .map(function(l){ return l.textContent || ""; })
      .join("\\n")`,
  );
}

/**
 * ⌘-click the first character of `needle` in the document.
 *
 * The click is a synthesized `mousedown` at the character's own screen
 * position, which is what the extension's `posAtCoords` reads — clicking by
 * coordinate rather than by element is the only way to address a position
 * inside a text node.
 */
async function accelClickText(app: App, needle: string): Promise<boolean> {
  return app.body("A").evalJS<boolean>(
    `(function(){
      var content = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
      if (content === null) return false;
      var needle = ${JSON.stringify(needle)};
      // The needle is located against a LINE's text, then mapped back through
      // that line's text nodes. Markdown highlighting splits a link across
      // several spans, so searching node by node would miss a needle that
      // straddles a span boundary — which "![shown]" does.
      var lines = content.querySelectorAll(".cm-line");
      var node = null, offset = -1;
      for (var i = 0; i < lines.length && node === null; i++) {
        var at = (lines[i].textContent || "").indexOf(needle);
        if (at === -1) continue;
        var walker = document.createTreeWalker(lines[i], NodeFilter.SHOW_TEXT);
        var seen = 0, n = null;
        while ((n = walker.nextNode()) !== null) {
          var len = (n.nodeValue || "").length;
          if (at < seen + len) { node = n; offset = at - seen; break; }
          seen += len;
        }
      }
      if (node === null || offset === -1) return false;
      var range = document.createRange();
      // A one-character range so the rect is the glyph's, not the line's.
      range.setStart(node, offset);
      range.setEnd(node, Math.min(offset + 1, (node.nodeValue || "").length));
      var rect = range.getBoundingClientRect();
      content.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        metaKey: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
      return true;
    })()`,
  );
}

/**
 * The card ids of every body of `componentId` the host holds a page for. A
 * card the editor opens — a viewer, a second Text card — is minted by the
 * deck under an id this file never names, so it is found by kind.
 */
async function bodyIdsOfKind(app: App, componentId: string): Promise<string[]> {
  return (await app.bodies())
    .filter((b) => b.componentId === componentId && b.cardId !== null && (b.state === "bound" || b.state === "ready"))
    .map((b) => b.cardId as string);
}

/** Every body the host holds, for an error message. */
async function heldBodies(app: App): Promise<string> {
  return (await app.bodies()).map((b) => `${b.cardId}:${b.componentId}:${b.state}`).join(", ") || "none";
}

/**
 * The paths every open file-view card is showing.
 *
 * A viewer card points an `<img>` at `/api/fs/blob?path=…`, so its `src` is
 * where the path it opened on is legible from the DOM — each viewer's own
 * page, read in turn.
 */
async function viewerPaths(app: App): Promise<string[]> {
  const paths: string[] = [];
  for (const id of await bodyIdsOfKind(app, "file-view")) {
    try {
      paths.push(
        ...(await app.body(id).evalJS<string[]>(
          `Array.from(document.querySelectorAll('[data-slot="file-view-card"] img'))
            .map(function(img){
              var m = /[?&]path=([^&]+)/.exec(img.getAttribute("src") || "");
              return m === null ? "" : decodeURIComponent(m[1]);
            })
            .filter(function(p){ return p.length > 0; })`,
        )),
      );
    } catch {
      // A body still arriving answers nothing yet; the next poll reads it.
    }
  }
  return paths;
}

/** Wait until some viewer card is showing `target`. */
async function waitForViewerShowing(app: App, target: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await viewerPaths(app)).includes(target)) return;
    if (Date.now() >= deadline) {
      throw new Error(`[at0410] no viewer shows ${target} within ${timeoutMs}ms (the host holds ${await heldBodies(app)})`);
    }
    await Bun.sleep(100);
  }
}

/** Wait until some Text card's editor renders `marker`. */
async function waitForTextCardShowing(app: App, marker: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const id of await bodyIdsOfKind(app, "text")) {
      try {
        if (await app.body(id).evalJS<boolean>(textCardShowing(marker))) return;
      } catch {
        // A body still arriving answers nothing yet; the next poll reads it.
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`[at0410] no Text card shows ${JSON.stringify(marker)} within ${timeoutMs}ms (the host holds ${await heldBodies(app)})`);
    }
    await Bun.sleep(100);
  }
}

/**
 * Intercept the host's `openPath` bridge in the Text card's own page — the
 * page `openPathInOS` runs in — and record what is posted to it, WITHOUT
 * calling through.
 *
 * Swallowing is the point, not a shortcut: calling through would open a real
 * Finder window on the machine running the tests and steal the focus the
 * harness depends on. What the deck asks the host for is the whole contract
 * here — the host's side of `reveal` is `activateFileViewerSelecting`, which no
 * test can observe anyway.
 */
async function captureOpenPathRequests(app: App): Promise<void> {
  // `window.webkit` cannot be replaced (an unconfigurable property), and the
  // bridge's wrapper objects — the namespace, its `messageHandlers`, the
  // `openPath` handler — are only kept while something in the page holds
  // them: once collected, the next access hands out fresh ones, and an own
  // property set on the old one is gone with it. The shell page never ran
  // long enough between the capture and the click to notice; the card's own
  // page does. So every wrapper the capture touches is pinned on `window`
  // for the page's life, the namespace's `messageHandlers` is redefined to
  // answer `openPath` with the recorder and every other name from the real
  // bridge, and the real handler's `postMessage` is replaced too, for a
  // bridge whose namespace refuses the redefinition. The install is read
  // back through `window.webkit` before it is trusted.
  const installed = await app.body("A").evalJS<boolean>(
    `(function(){
      window.__at0410OpenPath = [];
      var recorder = function(payload){ window.__at0410OpenPath.push(typeof payload === "string" ? JSON.parse(payload) : payload); };
      var ns = window.webkit;
      var real = ns.messageHandlers;
      var handler = real.openPath;
      window.__at0410Pins = { ns: ns, real: real, handler: handler };
      var reads = function(){
        try { return window.webkit.messageHandlers.openPath.postMessage === recorder; } catch (e) { return false; }
      };
      try {
        var handlers = new Proxy({}, { get: function(_t, name){ return name === "openPath" ? { postMessage: recorder } : real[name]; } });
        Object.defineProperty(ns, "messageHandlers", { configurable: true, value: handlers });
      } catch (e) {}
      try { handler.postMessage = recorder; } catch (e) {}
      return reads();
    })()`,
  );
  if (!installed) throw new Error("[at0410] the openPath capture did not take in the Text card's page");
}

/** Everything posted to `openPath` since the capture was installed. */
function openPathRequests(
  app: App,
): Promise<Array<{ path: string; kind: string }>> {
  return app.body("A").evalJS<Array<{ path: string; kind: string }>>(
    `window.__at0410OpenPath`,
  );
}

/**
 * A condition that holds once some Text card is showing `marker` — which is
 * how the test names the document that had to open, without depending on how
 * a card advertises its path.
 */
function textCardShowing(marker: string): string {
  return `Array.from(document.querySelectorAll(
    '[data-slot="tug-text-card-editor"] .cm-content'
  )).some(function(el){ return (el.innerText || "").indexOf(${JSON.stringify(
    marker,
  )}) !== -1; })`;
}

describe.skipIf(!SHOULD_RUN)(
  "at0410: Text card file drops write assets and insert markdown links",
  () => {
    test(
      "a dropped image becomes a sibling asset and a relative markdown link",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0410-"));
        const docPath = path.join(dir, "doc.md");
        fs.writeFileSync(docPath, DOC_SEED, "utf8");

        try {
          const app = await launchTugApp({ testName: "at0410-text-card-file-drop" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: { path: docPath, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
                },
              },
              focusCardId: "A",
            });
            await app.body("A").waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
                return el !== null && el.innerText.indexOf("Drop lands here") !== -1;
              })()`,
              { timeoutMs: 15_000 },
            );

            // ── First drop ────────────────────────────────────────────────
            const dropped = await dropPngOnEditor(app, "dropped.png");
            const assetPath = path.join(dir, "assets", "dropped.png");
            await app.body("A").waitForCondition<boolean>(
              `(function(){
                var lines = document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT_SELECTOR} .cm-line`)});
                return Array.from(lines).some(function(l){
                  return (l.textContent || "").indexOf("assets/dropped.png") !== -1;
                });
              })()`,
              { timeoutMs: 20_000 },
            );

            // On disk: byte-identical to the source, in a sibling folder.
            expect(fs.existsSync(assetPath)).toBe(true);
            expect(fs.readFileSync(assetPath).equals(dropped)).toBe(true);

            // In the document: the image form, a relative destination, and
            // nothing a non-Tug markdown renderer would not understand.
            expect(await docText(app)).toContain("![dropped](assets/dropped.png)");

            // ── Second drop of the same name ──────────────────────────────
            await dropPngOnEditor(app, "dropped.png");
            await app.body("A").waitForCondition<boolean>(
              `(function(){
                var lines = document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT_SELECTOR} .cm-line`)});
                return Array.from(lines).some(function(l){
                  return (l.textContent || "").indexOf("assets/dropped-2.png") !== -1;
                });
              })()`,
              { timeoutMs: 20_000 },
            );
            expect(fs.existsSync(path.join(dir, "assets", "dropped-2.png"))).toBe(true);
            // The first asset was not clobbered.
            expect(fs.readFileSync(assetPath).equals(dropped)).toBe(true);
            // The label is still `dropped` — the name the user dragged. The
            // suffix is this feature's bookkeeping for keeping two files with
            // one name apart, and it belongs in the destination only; a
            // document that suddenly says `dropped-2` about a picture the
            // user knows as `dropped` is that bookkeeping leaking out.
            expect(await docText(app)).toContain("![dropped](assets/dropped-2.png)");
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "cmd-click on an asset link opens the asset, in both link forms",
      async () => {
        // Resolved, because the paths this test compares against are the
        // ones the app reports — and everything the app touches has passed
        // the canonicalization gateway, where `/var` becomes `/private/var`.
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0410-click-")),
        );
        const docPath = path.join(dir, "doc.md");
        const assetsDir = path.join(dir, "assets");
        fs.mkdirSync(assetsDir);
        fs.copyFileSync(REPO_PNG_FIXTURE, path.join(assetsDir, "shown.png"));
        fs.copyFileSync(REPO_PNG_FIXTURE, path.join(assetsDir, "plain.png"));
        // Both forms, one per line: the image embed a drop writes for an
        // image, and the plain link it writes for everything else.
        fs.writeFileSync(
          docPath,
          "IMAGEFORM ![shown](assets/shown.png)\n\nPLAINFORM [plain.png](assets/plain.png)\n",
          "utf8",
        );

        try {
          const app = await launchTugApp({ testName: "at0410-asset-link-click" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: { path: docPath, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
                },
              },
              focusCardId: "A",
            });
            await app.body("A").waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
                return el !== null && el.innerText.indexOf("IMAGEFORM") !== -1;
              })()`,
              { timeoutMs: 15_000 },
            );

            // The image form. The click lands on the `!`, which the grammar
            // has to include in the token's extent for the two to line up.
            expect(await accelClickText(app, "![shown]")).toBe(true);
            await waitForViewerShowing(app, path.join(assetsDir, "shown.png"));

            // The plain form — the branch the `!` test cannot reach.
            expect(await accelClickText(app, "[plain.png]")).toBe(true);
            await waitForViewerShowing(app, path.join(assetsDir, "plain.png"));

            // Both, not one card retargeted.
            const paths = await viewerPaths(app);
            expect(paths).toContain(path.join(assetsDir, "shown.png"));
            expect(paths).toContain(path.join(assetsDir, "plain.png"));
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a link to a non-viewable file opens it, or reveals it when it cannot",
      async () => {
        // The gesture used to be gated on `isViewableFile`, so a `.md` sitting
        // next to a `.png` was simply dead. What a link does is now decided
        // from the file's own bytes, and every link does something.
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0410-open-")),
        );
        const docPath = path.join(dir, "doc.md");
        const assetsDir = path.join(dir, "assets");
        fs.mkdirSync(assetsDir);

        // Textual, and nothing in its name says so — `classifyFileKind` calls
        // a `.md` and a `.zip` both "text", which is exactly why the name
        // cannot be what decides this.
        fs.writeFileSync(
          path.join(assetsDir, "brief.md"),
          "# Brief\n\nOPENEDBRIEF\n",
          "utf8",
        );
        // Real binary: a zip's PK header and a NUL early on.
        fs.writeFileSync(
          path.join(assetsDir, "bundle.zip"),
          Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x08, 0xff]),
        );
        fs.writeFileSync(
          docPath,
          "TEXTFORM [brief.md](assets/brief.md)\n\nBINARYFORM [bundle.zip](assets/bundle.zip)\n",
          "utf8",
        );

        try {
          const app = await launchTugApp({ testName: "at0410-asset-link-open" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: { path: docPath, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
                },
              },
              focusCardId: "A",
            });
            await app.body("A").waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
                return el !== null && el.innerText.indexOf("TEXTFORM") !== -1;
              })()`,
              { timeoutMs: 15_000 },
            );
            await captureOpenPathRequests(app);

            // ── Textual → a Text card ──────────────────────────────────────
            expect(await accelClickText(app, "[brief.md]")).toBe(true);
            await waitForTextCardShowing(app, "OPENEDBRIEF");
            // Opened in the app, not handed to the OS.
            expect(await openPathRequests(app)).toEqual([]);

            // ── Binary → the Finder ────────────────────────────────────────
            expect(await accelClickText(app, "[bundle.zip]")).toBe(true);
            await app.body("A").waitForCondition<boolean>(
              `window.__at0410OpenPath.length > 0`,
              { timeoutMs: 15_000 },
            );
            expect(await openPathRequests(app)).toEqual([
              {
                path: path.join(assetsDir, "bundle.zip"),
                // `reveal`, not `folder`: the file selected inside its folder,
                // which is what reveal means everywhere else on the system.
                kind: "reveal",
              },
            ]);

            // And emphatically NOT opened as text — a zip in an editor paints
            // its bytes as mojibake, which is the failure this replaces.
            expect((await bodyIdsOfKind(app, "text")).length).toBe(2);
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
