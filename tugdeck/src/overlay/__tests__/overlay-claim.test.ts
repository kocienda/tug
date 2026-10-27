/**
 * The overlay's claim on the pointer is read from what the page shows, posted
 * only when it changes, and stamped on the document after each post.
 *
 * The stamp is what a reader of the page — the harness's `restoreGateGone` —
 * waits on before making a gesture meant for a card: a dialog's element
 * leaving the page is a frame ahead of the post that frees the window, and a
 * gesture made in that frame still lands on the overlay.
 *
 * @covers tugdeck/src/overlay/overlay-claim.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { installJsdom } from "../../__tests__/jsdom-deck";
import type { OverlayClaim } from "../../host/declarations/overlay";
import {
  OVERLAY_CLAIM_ATTRIBUTE,
  OVERLAY_CLAIM_STATE_ATTRIBUTE,
  installOverlayClaim,
  overlayClaimKind,
  readOverlayClaim,
} from "../overlay-claim";

const substrate = installJsdom();
afterAll(() => substrate.restore());

/** Let the mutation observer's microtask run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the overlay's claim", () => {
  test("names a claim by its kind", () => {
    expect(overlayClaimKind({ all: true })).toBe("all");
    expect(overlayClaimKind({ rects: [] })).toBe("none");
    expect(overlayClaimKind({ rects: [{ x: 0, y: 0, width: 1, height: 1 }] })).toBe("rects");
  });

  test("is the whole window while a dialog stands, else what is marked", () => {
    document.body.innerHTML = "";
    expect(readOverlayClaim(document)).toEqual({ rects: [] });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    expect(readOverlayClaim(document)).toEqual({ all: true });
    dialog.remove();
    const marked = document.createElement("div");
    marked.setAttribute(OVERLAY_CLAIM_ATTRIBUTE, "");
    document.body.append(marked);
    // jsdom lays nothing out, so a marked element has no area and claims nothing.
    expect(readOverlayClaim(document)).toEqual({ rects: [] });
    document.body.innerHTML = "";
  });

  test("takes in a deck bulletin, which Sonner draws with no mark of ours", () => {
    document.body.innerHTML = "";
    const toast = document.createElement("li");
    toast.setAttribute("data-sonner-toast", "");
    toast.getBoundingClientRect = () => ({ x: 900.5, y: 24, width: 400, height: 72.25 }) as DOMRect;
    document.body.append(toast);
    // Grown outward to whole points, so the close button at its corner is in.
    expect(readOverlayClaim(document)).toEqual({ rects: [{ x: 900, y: 24, width: 401, height: 73 }] });
    document.body.innerHTML = "";
  });

  test("is read again when a transition ends, where a bulletin slid in comes to rest", async () => {
    document.body.innerHTML = "";
    const posted: OverlayClaim[] = [];
    const release = installOverlayClaim(
      document,
      (claim) => posted.push(claim),
      (step) => {
        step();
        return 0;
      },
    );
    try {
      const toast = document.createElement("li");
      toast.setAttribute("data-sonner-toast", "");
      let y = -72;
      toast.getBoundingClientRect = () => ({ x: 900, y, width: 400, height: 72 }) as DOMRect;
      document.body.append(toast);
      await settle();
      // The reading at the mount sees the toast mid-slide.
      expect(posted[posted.length - 1]).toEqual({ rects: [{ x: 900, y: -72, width: 400, height: 72 }] });
      // The slide ends with no mutation of the page: only the transition says so.
      y = 24;
      toast.dispatchEvent(new Event("transitionend", { bubbles: true }));
      expect(posted[posted.length - 1]).toEqual({ rects: [{ x: 900, y: 24, width: 400, height: 72 }] });
    } finally {
      release();
      document.body.innerHTML = "";
      document.documentElement.removeAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE);
    }
  });

  test("is posted when it changes and stamped on the document after the post", async () => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE);
    const posted: Array<{ claim: OverlayClaim; stampedAtPost: string | null }> = [];
    const release = installOverlayClaim(
      document,
      (claim) => posted.push({ claim, stampedAtPost: document.documentElement.getAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE) }),
      (step) => {
        step();
        return 0;
      },
    );
    try {
      // The first reading is posted at install, and the stamp follows the post.
      expect(posted.map((p) => p.claim)).toEqual([{ rects: [] }]);
      expect(posted[0]?.stampedAtPost).toBeNull();
      expect(document.documentElement.getAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE)).toBe("none");

      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
      await settle();
      expect(posted.map((p) => p.claim)).toEqual([{ rects: [] }, { all: true }]);
      // At the post the stamp still said the claim before it: the stamp is written after.
      expect(posted[1]?.stampedAtPost).toBe("none");
      expect(document.documentElement.getAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE)).toBe("all");

      // A mutation that changes nothing posts nothing.
      dialog.setAttribute("data-anything", "1");
      await settle();
      expect(posted.length).toBe(2);

      dialog.remove();
      await settle();
      expect(posted.map((p) => p.claim)).toEqual([{ rects: [] }, { all: true }, { rects: [] }]);
      expect(document.documentElement.getAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE)).toBe("none");
    } finally {
      release();
      document.body.innerHTML = "";
      document.documentElement.removeAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE);
    }
  });
});
