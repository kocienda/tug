import { describe, it, expect } from "bun:test";

import {
  pickerNoticeStore,
  shouldShowStandingNotice,
  type PickerNotice,
} from "../picker-notice-store";

const notice: PickerNotice = {
  category: "spawn_budget",
  message: "Every session slot is in use. Close a session, then try again.",
};

describe("pickerNoticeStore", () => {
  it("consume reads and clears", () => {
    pickerNoticeStore.set("card-a", notice);
    expect(pickerNoticeStore.consume("card-a")).toEqual(notice);
    expect(pickerNoticeStore.consume("card-a")).toBeNull();
  });

  it("consume returns null for a card that never had a notice", () => {
    expect(pickerNoticeStore.consume("card-none")).toBeNull();
  });
});

describe("shouldShowStandingNotice", () => {
  it("shows the notice on a card whose sheet has never presented", () => {
    // The blank-card case: a spawn refused while the card sat inactive. The
    // sheet waits for first-responder activation that may never come, so
    // without this the card renders an empty backdrop and no reason at all.
    expect(shouldShowStandingNotice(notice, false)).toBe(true);
  });

  it("retires once the sheet has presented, so the two never both mount", () => {
    // The sheet carries the same notice through `activeNoticeRef` and owns
    // every later rejection via the re-present effect. Two surfaces showing
    // one rejection is the collision the inline-alert channel replaced.
    expect(shouldShowStandingNotice(notice, true)).toBe(false);
  });

  it("shows nothing when there is no notice", () => {
    expect(shouldShowStandingNotice(null, false)).toBe(false);
    expect(shouldShowStandingNotice(null, true)).toBe(false);
  });
});
