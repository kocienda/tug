import { describe, expect, test } from "bun:test";

import { clustersOf, historyTag, normalizeLine, signatureOf, type ReportFile } from "./failure-signatures";

const timeout = (selector: string, extra = ""): string =>
  `TimeoutError: waitForCondition exceeded 20000ms${extra}\n script: "document.querySelector(\\"${selector}\\") !== null"`;

describe("normalizeLine", () => {
  test("blanks numbers and quoted literals, keeps the words", () => {
    expect(normalizeLine("expect(received).toBe(expected)\n\nExpected: 3")).toBe("expect(received).toBe(expected)");
    expect(normalizeLine(`no ready body for card "A" within 10000 ms`)).toBe("no ready body for card ‹…› within N ms");
  });
});

describe("signatureOf", () => {
  test("a timeout carries its selector token, and the body cause when the harness named it", () => {
    const plain = signatureOf({ title: "t", message: timeout('[data-card-id=\\"A\\"] [data-testid=\\"overview-card\\"]') });
    expect(plain).toBe("TimeoutError: waitForCondition exceeded N @ testid=overview-card");
    const labelled = signatureOf({
      title: "t",
      message: timeout('[data-card-id=\\"A\\"] [data-slot=\\"tug-text-editor\\"]', ` — evaluated in the shell, but card "A" is a body: its DOM is in its own page`),
    });
    expect(labelled).toBe("TimeoutError: waitForCondition exceeded N [shell reach into a body] @ slot=tug-text-editor");
  });
});

describe("historyTag", () => {
  test("reads the ledger's three answers", () => {
    expect(historyTag({ answer: "last-green", sha: "abc1234" })).toBe("green@abc1234");
    expect(historyTag({ answer: "red-streak", count: 3, lastGreen: { sha: "def5678" } })).toBe("red×3, green@def5678");
    expect(historyTag({ answer: "no-history" })).toBe("no history");
    expect(historyTag(undefined)).toBe("no history");
  });
});

describe("clustersOf", () => {
  test("groups reds by their first failure's signature, biggest first, and skips passes", () => {
    const files: ReportFile[] = [
      { file: "a.test.ts", status: "FAIL", failures: [{ title: "a", message: timeout('[data-slot=\\"x\\"]'), location: "a.test.ts:1:1" }] },
      { file: "b.test.ts", status: "FAIL", failures: [{ title: "b", message: timeout('[data-slot=\\"x\\"]'), location: "b.test.ts:9:1" }] },
      { file: "c.test.ts", status: "FAIL", failures: [{ title: "c", message: "expect(received).toBe(expected)" }] },
      { file: "d.test.ts", status: "WEDGED" },
      { file: "e.test.ts", status: "PASS", failures: [] },
    ];
    const clusters = clustersOf(files);
    expect(clusters.map((c) => c.files.length)).toEqual([2, 1, 1]);
    expect(clusters[0].files.map((f) => f.file)).toEqual(["a.test.ts", "b.test.ts"]);
    expect(clusters.some((c) => c.signature === "[WEDGED] no failure recorded")).toBe(true);
  });
});
