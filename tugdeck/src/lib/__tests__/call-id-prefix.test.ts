import { describe, expect, test } from "bun:test";

import { CALL_MARK, stripCallIdPrefix } from "../call-id-prefix";

describe("stripCallIdPrefix — the block shows what the model wrote", () => {
  test("the hook's mark of this call's id is elided, and the command stands bare", () => {
    expect(stripCallIdPrefix(`${CALL_MARK}toolu_01A\ncargo nextest run -p x`, "toolu_01A")).toBe(
      "cargo nextest run -p x",
    );
    expect(stripCallIdPrefix(`${CALL_MARK}toolu_01A\ncd tugdeck && bun test`, "toolu_01A")).toBe(
      "cd tugdeck && bun test",
    );
    expect(stripCallIdPrefix(`${CALL_MARK}toolu_01A\nfor f in a b; do\n  echo $f\ndone`, "toolu_01A")).toBe(
      "for f in a b; do\n  echo $f\ndone",
    );
  });

  test("another id's mark, a bare command, and a comment the model wrote are left as typed", () => {
    const other = `${CALL_MARK}toolu_09Z\ncargo test`;
    expect(stripCallIdPrefix(other, "toolu_01A")).toBe(other);
    expect(stripCallIdPrefix("cargo test", "toolu_01A")).toBe("cargo test");
    expect(stripCallIdPrefix("# build first\ncargo test", "toolu_01A")).toBe("# build first\ncargo test");
  });
});
