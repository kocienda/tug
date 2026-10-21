/**
 * `mapOptions` — the seam from a pane bulletin's options to Sonner's.
 *
 * `onGone` is how a notice whose fact the shell holds lets it go: it must
 * fire whichever way the bulletin leaves, the user's close or its timeout.
 *
 * @covers tugdeck/src/components/tugways/tug-pane-bulletin.tsx
 */

import { describe, expect, test } from "bun:test";

import { mapOptions } from "../tug-pane-bulletin";

describe("mapOptions", () => {
  test("scopes the id under the pane's toaster", () => {
    expect(mapOptions("t1", { id: "arc-press-stop" }).id).toBe("t1::arc-press-stop");
  });

  test("calls onGone on a close and on a timeout alike", () => {
    let gone = 0;
    const mapped = mapOptions("t1", { onGone: () => (gone += 1) }) as {
      onDismiss: () => void;
      onAutoClose: () => void;
    };
    mapped.onDismiss();
    mapped.onAutoClose();
    expect(gone).toBe(2);
  });

  test("names no dismissal handler when none is asked for", () => {
    const mapped = mapOptions("t1", {});
    expect(mapped.onDismiss).toBeUndefined();
    expect(mapped.onAutoClose).toBeUndefined();
  });
});
