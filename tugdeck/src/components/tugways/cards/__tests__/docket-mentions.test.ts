/**
 * The docket mention provider's rows: each searched docket mints the docket
 * atom, labelled by its name, owned by the checkout that holds it.
 */

import { describe, expect, test } from "bun:test";

import { docketMentionItem } from "../completion-providers/docket-mentions";
import type { SearchedDocket } from "@/protocol";

const ROW: SearchedDocket = {
  id: "0a1b2c3d",
  name: "GPU wedge",
  projectDir: "/u/src/tug",
  retired: false,
};

describe("the docket provider's rows", () => {
  test("a row mints a docket atom labelled by its name", () => {
    const item = docketMentionItem(ROW, "");
    expect(item.label).toBe("GPU wedge");
    expect(item.description).toBe("docket:0a1b2c3d");
    expect(item.atom).toEqual({
      kind: "atom",
      type: "docket",
      label: "GPU wedge",
      value: "0a1b2c3d",
      docket: { projectDir: "/u/src/tug" },
    });
  });

  test("a docket with no name is labelled by its id", () => {
    expect(docketMentionItem({ ...ROW, name: "" }, "").label).toBe("docket:0a1b2c3d");
  });
});
