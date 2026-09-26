/**
 * `appModalStore` — the one fact that freezes the deck's card count.
 *
 * Three writers publish into it from layout effects, and one reader (the
 * menuState publisher) subscribes. What matters is that the answer is a
 * union rather than a latch — closing one wizard while another is still up
 * must not unfreeze the deck — and that a writer repeating itself costs the
 * reader nothing, because a layout effect can re-run for reasons that have
 * nothing to do with the modal moving.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { appModalStore, resetAppModalStore } from "../app-modal-store";

afterEach(() => {
  resetAppModalStore();
});

describe("appModalStore", () => {
  test("nothing open by default", () => {
    expect(appModalStore.isOpen()).toBe(false);
  });

  test("open while any owner claims it", () => {
    appModalStore.setOpen("update-tug", true);
    expect(appModalStore.isOpen()).toBe(true);

    appModalStore.setOpen("configure-tug", true);
    appModalStore.setOpen("update-tug", false);
    // The update wizard closed; the setup wizard is still up.
    expect(appModalStore.isOpen()).toBe(true);

    appModalStore.setOpen("configure-tug", false);
    expect(appModalStore.isOpen()).toBe(false);
  });

  test("a repeated write is idempotent and notifies nobody", () => {
    let notifications = 0;
    const unsubscribe = appModalStore.subscribe(() => {
      notifications += 1;
    });

    appModalStore.setOpen("version-gate", true);
    appModalStore.setOpen("version-gate", true);
    appModalStore.setOpen("version-gate", true);
    expect(notifications).toBe(1);
    expect(appModalStore.isOpen()).toBe(true);

    appModalStore.setOpen("version-gate", false);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  test("closing a second owner still notifies, and the deck stays frozen", () => {
    appModalStore.setOpen("configure-tug", true);
    let notifications = 0;
    const unsubscribe = appModalStore.subscribe(() => {
      notifications += 1;
    });

    appModalStore.setOpen("update-tug", true);
    appModalStore.setOpen("update-tug", false);
    // The union never changed — and the union is not the whole published
    // answer. `updateTugOpen` is per-owner, so both writes are real news to
    // the reader even though the deck stayed frozen throughout.
    expect(notifications).toBe(2);
    expect(appModalStore.isOpen()).toBe(true);
    unsubscribe();
  });

  test("isOpenFor names the one that is up", () => {
    appModalStore.setOpen("update-tug", true);
    expect(appModalStore.isOpenFor("update-tug")).toBe(true);
    expect(appModalStore.isOpenFor("configure-tug")).toBe(false);
    expect(appModalStore.isOpenFor("version-gate")).toBe(false);
  });

  test("isOpenExcept ignores the asker and sees everyone else", () => {
    // What a wizard's own door asks before raising itself: a wizard already
    // on screen must not read as the thing standing in its own way.
    appModalStore.setOpen("update-tug", true);
    expect(appModalStore.isOpenExcept("update-tug")).toBe(false);
    expect(appModalStore.isOpenExcept("configure-tug")).toBe(true);

    appModalStore.setOpen("configure-tug", true);
    expect(appModalStore.isOpenExcept("update-tug")).toBe(true);

    appModalStore.setOpen("configure-tug", false);
    expect(appModalStore.isOpenExcept("update-tug")).toBe(false);
  });

  test("the version gate is seen by both wizards' doors", () => {
    // [B04]: the gate outranks both, so a request arriving under it is
    // dropped by whichever wizard would have raised itself.
    appModalStore.setOpen("version-gate", true);
    expect(appModalStore.isOpenExcept("update-tug")).toBe(true);
    expect(appModalStore.isOpenExcept("configure-tug")).toBe(true);
  });

  test("a second modal over the first still reaches the reader", () => {
    // The reader publishes two facts and one of them is per-owner
    // (`updateTugOpen`), so the edge that matters is the owner set rather
    // than the union. A modal opening or closing over another moves no
    // union, and a reader told nothing would go on publishing the old
    // answer for the wizard that is no longer there.
    let notifications = 0;
    const unsubscribe = appModalStore.subscribe(() => {
      notifications += 1;
    });

    appModalStore.setOpen("configure-tug", true);
    expect(notifications).toBe(1);

    appModalStore.setOpen("update-tug", true);
    expect(notifications).toBe(2);
    expect(appModalStore.isOpenFor("update-tug")).toBe(true);

    appModalStore.setOpen("update-tug", false);
    expect(notifications).toBe(3);
    expect(appModalStore.isOpen()).toBe(true);
    expect(appModalStore.isOpenFor("update-tug")).toBe(false);

    unsubscribe();
  });

  test("an unsubscribed reader stops hearing", () => {
    let notifications = 0;
    const unsubscribe = appModalStore.subscribe(() => {
      notifications += 1;
    });
    unsubscribe();

    appModalStore.setOpen("update-tug", true);
    expect(notifications).toBe(0);
  });
});
