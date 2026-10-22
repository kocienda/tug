/**
 * The overlay draws exactly what the shell's indication says, at the
 * viewport points it says, and takes each part down when the answer says
 * none ([B08]).
 *
 * jsdom lays nothing out, so the overlay root stands at the viewport's
 * origin and the page is at 100 %: a viewport point is a layout px.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { NO_INDICATION, type OverlayIndication } from "../../bus/declarations/overlay";
import { installJsdom } from "../../__tests__/jsdom-deck";

const substrate = installJsdom();
afterAll(() => substrate.restore());

const { paintIndication, zoneClipOf, ZONE_CLASS, BAND_CLASS, READOUT_CLASS } = await import("../overlay-indication");

function box(el: Element | null) {
  const style = (el as HTMLElement).style;
  return { left: style.left, top: style.top, width: style.width, height: style.height };
}

describe("paintIndication", () => {
  test("draws the zone, the band, both guides and the ghost, and takes each down alone", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const all: OverlayIndication = {
      zone: { x: 10, y: 20, width: 300, height: 200, under: [] },
      band: { x: 400, y: 40, width: 200, height: 28 },
      guides: { x: 120, y: 80 },
      ghost: { x: 500, y: 60, width: 90, height: 28, label: "Session" },
      readout: null,
    };
    paintIndication(root, all);
    expect(box(root.querySelector(`.${ZONE_CLASS}`))).toEqual({ left: "10px", top: "20px", width: "300px", height: "200px" });
    expect(box(root.querySelector(`.${BAND_CLASS}`))).toEqual({ left: "400px", top: "40px", width: "200px", height: "28px" });
    expect(root.querySelector<HTMLElement>(".snap-guide-line-x")?.style.left).toBe("120px");
    expect(root.querySelector<HTMLElement>(".snap-guide-line-y")?.style.top).toBe("80px");
    const ghost = root.querySelector<HTMLElement>(".tug-tab-ghost");
    expect(box(ghost)).toEqual({ left: "500px", top: "60px", width: "90px", height: "28px" });
    expect(ghost?.textContent).toBe("Session");
    // The band is its own element: a reader of the zone never finds it.
    expect(root.querySelectorAll(`.${ZONE_CLASS}`).length).toBe(1);

    // One element per kind, moved rather than made again.
    const zone = root.querySelector(`.${ZONE_CLASS}`);
    paintIndication(root, { ...all, zone: { x: 30, y: 20, width: 300, height: 200, under: [] } });
    expect(root.querySelector(`.${ZONE_CLASS}`)).toBe(zone);
    expect(box(zone).left).toBe("30px");

    paintIndication(root, { ...all, band: null, guides: { x: null, y: 80 } });
    expect(root.querySelector(`.${BAND_CLASS}`)).toBeNull();
    expect(root.querySelector(".snap-guide-line-x")).toBeNull();
    expect(root.querySelector(".snap-guide-line-y")).not.toBeNull();

    paintIndication(root, NO_INDICATION);
    expect(root.children.length).toBe(0);
    root.remove();
  });

  test("the readout rides beside the pointer, wears its limit, and fades when it goes", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const at = (x: number, text: string, limit: string | null): OverlayIndication => ({
      ...NO_INDICATION,
      readout: { x, y: 200, text, limit },
    });
    paintIndication(root, at(100, "500 px", null));
    const pill = root.querySelector<HTMLElement>(`.${READOUT_CLASS}`);
    expect(pill?.textContent).toBe("500 px");
    // Beside the pointer and above it.
    expect({ left: pill?.style.left, top: pill?.style.top }).toEqual({ left: "114px", top: "166px" });
    expect(pill?.hasAttribute("data-limit")).toBe(false);

    paintIndication(root, at(300, "675 px", "ceiling"));
    expect(root.querySelector(`.${READOUT_CLASS}`)).toBe(pill);
    expect(pill?.style.left).toBe("314px");
    expect(pill?.textContent).toBe("675 px");
    expect(pill?.getAttribute("data-limit")).toBe("ceiling");

    // Gone from the answer: the pill stays to fade, its limit's ink dropped.
    paintIndication(root, NO_INDICATION);
    expect(pill?.isConnected).toBe(true);
    expect(pill?.hasAttribute("data-leaving")).toBe(true);
    expect(pill?.hasAttribute("data-limit")).toBe(false);
    expect(pill?.textContent).toBe("675 px");

    // A drag that starts during the fade gets a pill of its own.
    paintIndication(root, at(50, "400 px", null));
    const next = root.querySelectorAll<HTMLElement>(`.${READOUT_CLASS}:not([data-leaving])`);
    expect(next.length).toBe(1);
    expect(next[0]).not.toBe(pill);
    root.remove();
  });

  test("a rail standing over the outline is cut out of it, and nothing beside it is", () => {
    // A tile running 60 px on behind a right rail that starts at x = 250.
    const zone = { x: 10, y: 20, width: 300, height: 200, under: [{ x: 250, y: 0, width: 200, height: 900 }] };
    expect(zoneClipOf(zone)).toBe(
      "polygon(evenodd, 0px 0px, 300px 0px, 300px 200px, 0px 200px, 0px 0px, 240px 0px, 240px 200px, 300px 200px, 300px 0px, 240px 0px, 0px 0px)",
    );
    // A cap that does not reach the tile cuts nothing.
    expect(zoneClipOf({ ...zone, under: [{ x: 600, y: 0, width: 20, height: 900 }] })).toBe("");
    expect(zoneClipOf({ ...zone, under: [] })).toBe("");
  });
});
