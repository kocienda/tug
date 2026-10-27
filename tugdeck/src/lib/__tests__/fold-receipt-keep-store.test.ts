import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetFoldReceiptKeepStoreForTest,
  foldReceiptKeepStore,
} from "@/lib/fold-receipt-keep-store";

afterEach(() => _resetFoldReceiptKeepStoreForTest());

describe("FoldReceiptKeepStore", () => {
  test("keep notifies subscribers once, and isKept reads it back", () => {
    let heard = 0;
    const release = foldReceiptKeepStore.subscribe(() => heard++);
    expect(foldReceiptKeepStore.isKept("arc:x|4")).toBe(false);
    foldReceiptKeepStore.keep("arc:x|4");
    foldReceiptKeepStore.keep("arc:x|4");
    expect(heard).toBe(1);
    expect(foldReceiptKeepStore.isKept("arc:x|4")).toBe(true);
    // A later fold on the same arc is a new receipt.
    expect(foldReceiptKeepStore.isKept("arc:x|5")).toBe(false);
    release();
  });

  test("the reset forgets every kept receipt", () => {
    foldReceiptKeepStore.keep("arc:y|1");
    _resetFoldReceiptKeepStoreForTest();
    expect(foldReceiptKeepStore.isKept("arc:y|1")).toBe(false);
  });
});
