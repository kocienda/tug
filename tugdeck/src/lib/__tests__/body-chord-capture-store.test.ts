import { describe, expect, test } from "bun:test";

import { bodyChordCaptureStore } from "../body-chord-capture-store";

describe("bodyChordCaptureStore", () => {
  test("is armed while any body says so, and notifies only on a change", () => {
    let notices = 0;
    const release = bodyChordCaptureStore.subscribe(() => {
      notices += 1;
    });
    try {
      expect(bodyChordCaptureStore.isArmed()).toBe(false);

      bodyChordCaptureStore.set("A", true);
      expect(bodyChordCaptureStore.isArmed()).toBe(true);
      expect(notices).toBe(1);

      // The same word twice is one change.
      bodyChordCaptureStore.set("A", true);
      expect(notices).toBe(1);

      bodyChordCaptureStore.set("B", true);
      bodyChordCaptureStore.set("A", false);
      expect(bodyChordCaptureStore.isArmed()).toBe(true);
      expect(notices).toBe(3);

      // A body that goes while armed is cleared, and its arming goes with it.
      bodyChordCaptureStore.clear("B");
      expect(bodyChordCaptureStore.isArmed()).toBe(false);
      expect(notices).toBe(4);

      // Clearing a card the store never heard of says nothing.
      bodyChordCaptureStore.clear("B");
      expect(notices).toBe(4);
    } finally {
      release();
    }
  });
});
