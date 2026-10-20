import { afterEach, describe, expect, it } from "bun:test";

import {
  adoptOpenQuicklyOpen,
  closeOpenQuickly,
  getOpenQuicklyOpen,
  getOpenQuicklySeq,
  openOpenQuickly,
  setOpenQuicklyCloseSink,
  subscribeOpenQuickly,
  subscribeOpenQuicklyRequests,
} from "@/lib/open-quickly-store";

afterEach(() => {
  setOpenQuicklyCloseSink(null);
  closeOpenQuickly();
});

describe("open-quickly-store", () => {
  it("starts closed", () => {
    expect(getOpenQuicklyOpen()).toBe(false);
  });

  it("opens and closes, notifying subscribers on each transition", () => {
    let ticks = 0;
    const unsub = subscribeOpenQuickly(() => ticks++);

    openOpenQuickly();
    expect(getOpenQuicklyOpen()).toBe(true);
    expect(ticks).toBe(1);

    // Re-opening while open is a no-op (no extra notify).
    openOpenQuickly();
    expect(ticks).toBe(1);

    closeOpenQuickly();
    expect(getOpenQuicklyOpen()).toBe(false);
    expect(ticks).toBe(2);

    // Re-closing while closed is a no-op.
    closeOpenQuickly();
    expect(ticks).toBe(2);

    unsub();
  });

  it("stops notifying after unsubscribe", () => {
    let ticks = 0;
    const unsub = subscribeOpenQuickly(() => ticks++);
    unsub();
    openOpenQuickly();
    expect(ticks).toBe(0);
  });

  it("numbers every open request, a re-raise while open included", () => {
    let transitions = 0;
    let requests = 0;
    const unsubOpen = subscribeOpenQuickly(() => transitions++);
    const unsubRequests = subscribeOpenQuicklyRequests(() => requests++);
    const before = getOpenQuicklySeq();
    openOpenQuickly();
    openOpenQuickly();
    expect(getOpenQuicklySeq()).toBe(before + 2);
    expect(requests).toBe(2);
    expect(transitions, "the re-raise is no transition").toBe(1);
    unsubOpen();
    unsubRequests();
  });

  it("a close names the open it closed, as the page drawing the popup adopted it", () => {
    const closed: number[] = [];
    setOpenQuicklyCloseSink((seq) => closed.push(seq));
    adoptOpenQuicklyOpen(true, 7);
    expect(getOpenQuicklyOpen()).toBe(true);
    closeOpenQuickly();
    expect(closed).toEqual([7]);
    // An adopted close is the shell's word, and goes back nowhere.
    adoptOpenQuicklyOpen(true, 8);
    adoptOpenQuicklyOpen(false, 8);
    expect(closed).toEqual([7]);
  });
});
