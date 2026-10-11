/**
 * fixtures.test.ts — the shared helpers do what each file's copy did.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { inputSelectorFor, mkTextFixture, oneTurnSessionJsonl } from "./fixtures";

describe("inputSelectorFor", () => {
  test("names the gallery's small input inside the card", () => {
    expect(inputSelectorFor("A")).toBe(
      '[data-card-id="A"] [data-tug-state-key="gallery-input/size/sm"]',
    );
  });
});

describe("mkTextFixture", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes one file named sample.txt in a fresh directory named from the prefix", () => {
    const { dir, file } = mkTextFixture("fixtures-test-", "one\ntwo\n");
    made.push(dir);
    expect(path.basename(dir).startsWith("fixtures-test-")).toBe(true);
    expect(file).toBe(path.join(dir, "sample.txt"));
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n");
    expect(fs.readdirSync(dir)).toEqual(["sample.txt"]);
  });

  test("takes the file's name", () => {
    const { dir, file } = mkTextFixture("fixtures-test-", "x", { name: "manual.txt" });
    made.push(dir);
    expect(path.basename(file)).toBe("manual.txt");
  });

  test("keeps the tmpdir spelling by default and resolves it on request", () => {
    const plain = mkTextFixture("fixtures-test-", "x");
    const real = mkTextFixture("fixtures-test-", "x", { realpath: true });
    made.push(plain.dir, real.dir);
    expect(plain.dir.startsWith(os.tmpdir())).toBe(true);
    expect(real.dir).toBe(fs.realpathSync(real.dir));
  });
});

describe("oneTurnSessionJsonl", () => {
  test("is a user prompt and its reply, keyed to the session and the project", () => {
    const sid = "c1a0d1ea-0000-4000-8000-000000000481";
    const text = oneTurnSessionJsonl("/tmp/proj", sid);
    expect(text.endsWith("\n")).toBe(true);
    const [user, reply, ...rest] = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(rest).toEqual([]);
    expect(user).toMatchObject({ type: "user", parentUuid: null, cwd: "/tmp/proj", sessionId: sid });
    expect(reply).toMatchObject({ type: "assistant", parentUuid: user.uuid, sessionId: sid });
    expect(reply.message.content).toEqual([{ type: "text", text: "hi there" }]);
  });

  test("derives distinct uuids for distinct sessions", () => {
    const a = JSON.parse(oneTurnSessionJsonl("/p", "c1a0d1ea-0000-4000-8000-000000000481").split("\n")[0]);
    const b = JSON.parse(oneTurnSessionJsonl("/p", "c1a0d1ea-0000-4000-8000-000000000482").split("\n")[0]);
    expect(a.uuid).not.toBe(b.uuid);
  });
});
