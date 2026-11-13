/**
 * skeleton-palette.ts — the colours the host draws a workspace's ground and
 * its cards' skeletons in, read from the theme a document wears.
 *
 * The host cannot read CSS, and a theme that is not on screen cannot be read
 * inside a document without flipping it (themes set their tokens on `body`).
 * So every document reports the palette of the theme it already wears: the
 * shell its on-screen theme, each card page its workspace's theme. The host
 * keeps them by theme name.
 *
 * Each colour is read by painting it onto one pixel, so whatever space a
 * token is written in (oklch, a mix, an alpha) comes back as the opaque sRGB
 * the screen shows over the canvas.
 */

/** A theme's ground and skeleton colours, each an opaque `#rrggbb`. */
export interface SkeletonPalette {
  readonly theme: string;
  /** The deck's canvas. */
  readonly canvas: string;
  /** A canvas grid line, as it reads over the canvas. */
  readonly grid: string;
  /** The pane's body fill. */
  readonly surface: string;
  /** The title band's fill. */
  readonly band: string;
  /** The title's ink. */
  readonly ink: string;
  /** The pane's border. */
  readonly border: string;
}

/**
 * The tokens each colour is read from: the ones `#deck-container`
 * (`globals.css`) and the generic pane chrome (`tug-pane.css`, worn by
 * `body-chrome-frame.tsx`) paint with, named at their `--tug7-*` source so a
 * card page, which has no deck container, reads the same values the shell
 * does. The title band and ink are the unfocused pane's: a skeleton stands
 * for a card that does not hold the keyboard.
 */
const TOKENS = {
  canvas: "--tug7-surface-global-primary-normal-canvas-rest",
  grid: "--tug7-surface-global-primary-normal-grid-rest",
  surface: "--tug7-surface-global-primary-normal-content-rest",
  band: "--tug7-surface-card-primary-normal-titlebar-inactive",
  ink: "--tug7-element-card-text-normal-title-inactive",
  border: "--tug7-element-card-border-normal-frame-rest, var(--tug7-element-global-border-normal-default-rest)",
} as const;

/**
 * Read the palette of the theme this document wears now, under `theme`'s
 * name. Null where the document has no body or no 2D canvas, or a token
 * resolves to nothing.
 */
export function readSkeletonPalette(theme: string): SkeletonPalette | null {
  try {
    const host = document.body;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (host === null || ctx === null) return null;
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    host.appendChild(probe);
    const computed: Record<string, string> = {};
    for (const [name, token] of Object.entries(TOKENS)) {
      probe.style.color = "";
      probe.style.color = `var(${token})`;
      computed[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    const read = (): string => {
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    };
    // The canvas first, opaque; every other colour is painted over it, so a
    // translucent token reads as it shows on the ground.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = computed.canvas;
    ctx.fillRect(0, 0, 1, 1);
    const canvas = read();
    const over = (color: string): string => {
      ctx.fillStyle = canvas;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return read();
    };
    return {
      theme,
      canvas,
      grid: over(computed.grid),
      surface: over(computed.surface),
      band: over(computed.band),
      ink: over(computed.ink),
      border: over(computed.border),
    };
  } catch {
    return null;
  }
}
