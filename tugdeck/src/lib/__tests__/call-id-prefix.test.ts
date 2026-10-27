import { describe, expect, test } from "bun:test";

import { CALL_ID_EXPORT, stripCallIdPrefix } from "../call-id-prefix";

describe("stripCallIdPrefix — the block shows what the model wrote", () => {
  test("the hook's export of this call's id is elided, and the command stands bare", () => {
    expect(stripCallIdPrefix(`${CALL_ID_EXPORT}toolu_01A; cargo nextest run -p x`, "toolu_01A")).toBe(
      "cargo nextest run -p x",
    );
    expect(stripCallIdPrefix(`${CALL_ID_EXPORT}toolu_01A; cd tugdeck && bun test`, "toolu_01A")).toBe(
      "cd tugdeck && bun test",
    );
    expect(stripCallIdPrefix(`${CALL_ID_EXPORT}toolu_01A;cargo test`, "toolu_01A")).toBe("cargo test");
  });

  test("another id's export, a bare command, and an export the model wrote are left as typed", () => {
    const other = `${CALL_ID_EXPORT}toolu_09Z; cargo test`;
    expect(stripCallIdPrefix(other, "toolu_01A")).toBe(other);
    expect(stripCallIdPrefix("cargo test", "toolu_01A")).toBe("cargo test");
    expect(stripCallIdPrefix("export FOO=1; cargo test", "toolu_01A")).toBe("export FOO=1; cargo test");
  });
});
