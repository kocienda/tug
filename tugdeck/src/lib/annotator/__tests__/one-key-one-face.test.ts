/**
 * One key, one face — three references to one file wear one verdict, and
 * they change together.
 *
 * ## What this is, and what it deliberately is not
 *
 * The fault this arc closed was two paths in one transcript, written the
 * same way, naming two files that both existed, behaving differently: one
 * carried the file's menu, the other was inert text. Nothing about the
 * spelling or the surface earned the difference — only *when* the ink was
 * first painted relative to when the file was written.
 *
 * The rule that replaces it is one sentence: a path in ink acts like the
 * file it names, as that file is right now, everywhere, at the same time.
 * This file is that rule at the altitude a unit test can hold it. There is
 * no in-process DOM substrate here (`tuglaws/arc-work-doctrine.md`: no
 * jsdom, no happy-dom, no RTL), so the DOM half of the claim — three runs
 * in one container all carrying the mark after one batch — is the app-test's
 * (`tests/app-test/at0521-ink-follows-file.test.ts`), driven against the
 * real app.
 *
 * What is provable here is the half the DOM was never the point of: three
 * *differently shaped* references to one file resolve to **one verdict key**,
 * so one answer moving names one key that all three depend on, and the face
 * every one of them wears is a pure function of that one verdict. A pass
 * that marked one and not another would have to be reading something other
 * than the verdict, and there is nothing else to read.
 *
 * The three shapes are the three the transcript actually produces:
 *
 *  1. an inline `<code>` span that is entirely one path — a whole element,
 *     classified by `classifyInlineCode`;
 *  2. a bare token in prose, found by scanning text (`scanPathReferences`);
 *  3. a path inside a longer command line, which is the same scan run over
 *     a React-rendered element under `useAnnotatedElement`.
 */

import { describe, expect, test } from "bun:test";

import { detectPathReference, scanPathReferences } from "../detect-path-reference";
import { classifyInlineCode, payloadForReference } from "../payloads";
import { PathResolutionStore, type ProbeResult } from "../path-resolution";
import { makeReferenceResolver } from "../resolve-reference";
import { collectVerdictKeys, dependsOnKeys, pathVerdictKey } from "../verdict-keys";

const CWD = "/repo";
const WRITTEN = "notes/plan.md";
const RESOLVED = `${CWD}/${WRITTEN}`;
const KEY = pathVerdictKey(RESOLVED);

const gone: ProbeResult = { exists: { [RESOLVED]: false }, canonical: {}, isDir: {} };
const there: ProbeResult = {
  exists: { [RESOLVED]: true },
  canonical: { [RESOLVED]: RESOLVED },
  isDir: {},
};

/**
 * The reference each of the three surfaces produces for the same file.
 *
 * The command line and the prose sentence go through the text scan, because
 * that is what both surfaces do — the difference between them is which DOM
 * the scan is handed, and this file is below that.
 */
function threeReferences() {
  const inCode = detectPathReference(WRITTEN);

  const prose = scanPathReferences(`I wrote ${WRITTEN} before the tool ran.`);
  const command = scanPathReferences(`cat > ${WRITTEN} <<'EOF'`);

  expect(inCode).not.toBeNull();
  expect(prose.length).toBe(1);
  expect(command.length).toBe(1);
  return [
    { where: "inline code span", reference: inCode! },
    { where: "bare token in prose", reference: prose[0] },
    { where: "path in a command line", reference: command[0] },
  ];
}

describe("three shapes, one key", () => {
  test("every surface's reference spells the same path", () => {
    for (const { where, reference } of threeReferences()) {
      expect(`${where}: ${reference.path}`).toBe(`${where}: ${WRITTEN}`);
    }
  });

  test("and consults exactly one verdict key, which is the file's", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const resolve = makeReferenceResolver({ paths: store, names: null, cwd: CWD });
    for (const { where, reference } of threeReferences()) {
      const keys = collectVerdictKeys(() => {
        resolve(reference);
      });
      expect(`${where}: ${[...keys].join(",")}`).toBe(`${where}: ${KEY}`);
    }
    store.dispose();
  });
});

describe("one verdict, one face, and they turn together", () => {
  test("missing leaves all three plain; confirmed marks all three; missing again clears them", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const resolve = makeReferenceResolver({ paths: store, names: null, cwd: CWD });

    // The Bash header asked before the command that writes the file ran.
    store.applyProbeResult([RESOLVED], gone);

    // Every one of the three is painted under that `missing`, and every one
    // records the key it was painted under.
    const ledgers = threeReferences().map(({ where, reference }) => {
      let payload: ReturnType<typeof payloadForReference> = null;
      const keys = collectVerdictKeys(() => {
        payload = payloadForReference(reference, resolve(reference));
      });
      expect(`${where}: ${payload === null ? "plain" : "marked"}`).toBe(
        `${where}: plain`,
      );
      return { where, keys };
    });

    // The file arrives. One key moves.
    const moved: string[] = [];
    const off = store.subscribe((keys) => moved.push(...keys));
    store.applyProbeResult([RESOLVED], there);
    expect(moved).toEqual([KEY]);

    // Every one of the three depended on it, so every one is re-walked...
    for (const { where, keys } of ledgers) {
      expect(`${where}: ${dependsOnKeys(keys, moved)}`).toBe(`${where}: true`);
    }

    // ...and every one now carries the mark, pointing at the same file.
    for (const { where, reference } of threeReferences()) {
      const payload = payloadForReference(reference, resolve(reference));
      expect(`${where}: ${payload?.kind}/${payload?.path}`).toBe(
        `${where}: file-path/${RESOLVED}`,
      );
    }

    // The file is deleted. The same key moves the other way, and the same
    // three go plain — a `confirmed` is a dependency exactly as a `missing`
    // is, which is the half a "waiting" flag could never record.
    moved.length = 0;
    store.applyProbeResult([RESOLVED], gone);
    expect(moved).toEqual([KEY]);
    for (const { where, keys } of ledgers) {
      expect(`${where}: ${dependsOnKeys(keys, moved)}`).toBe(`${where}: true`);
    }
    for (const { where, reference } of threeReferences()) {
      expect(`${where}: ${payloadForReference(reference, resolve(reference))}`).toBe(
        `${where}: null`,
      );
    }

    off();
    store.dispose();
  });

  test("a line citation rides along without splitting the key", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const resolve = makeReferenceResolver({ paths: store, names: null, cwd: CWD });
    store.applyProbeResult([RESOLVED], there);

    const cited = scanPathReferences(`see ${WRITTEN}:12 for the rule`)[0];
    const bare = detectPathReference(WRITTEN)!;

    const citedKeys = collectVerdictKeys(() => {
      resolve(cited);
    });
    const bareKeys = collectVerdictKeys(() => {
      resolve(bare);
    });
    expect([...citedKeys]).toEqual([KEY]);
    expect([...bareKeys]).toEqual([KEY]);

    // One key, one face — the citation only decides where the file opens.
    expect(payloadForReference(cited, resolve(cited))).toEqual({
      kind: "file-path",
      path: RESOLVED,
      line: 12,
    });
    expect(payloadForReference(bare, resolve(bare))).toEqual({
      kind: "file-path",
      path: RESOLVED,
    });
    store.dispose();
  });

  test("the inline-code surface reaches the same gate, not a second one", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const resolve = makeReferenceResolver({ paths: store, names: null, cwd: CWD });
    store.applyProbeResult([RESOLVED], there);

    // `classifyInlineCode` is the whole-element path: a span that is
    // entirely one path routes through the same reference and the same
    // resolver every scanned run does, which is why the two can never
    // disagree about one file.
    const reference = detectPathReference(WRITTEN)!;
    const span = classifyInlineCode(WRITTEN, () => false, resolve);
    expect(span).toEqual(payloadForReference(reference, resolve(reference)));
    expect(span).toEqual({ kind: "file-path", path: RESOLVED });
    store.dispose();
  });
});
