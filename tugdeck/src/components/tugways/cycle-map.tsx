/**
 * CycleMap — a cycle's entries as tiles and its sketches as seals, wired by
 * what each waits on, at a surface's size or a sidebar's.
 *
 * The map is presentational. A host gives it each entry's number, waits,
 * sketches, state and sentence, and each sketch's letter and want; the map
 * lays them out with `layoutCycleMap`, sizes them with `cycleMapGeometry`,
 * and draws. It reads no store and derives no state. A wire is met when the
 * tile it leaves has joined.
 *
 * The map owns its horizontal overflow and its ground; the host owns the
 * chrome around it (padding, well, hairline, radius) through its own class.
 * Selection is the host's: the map reports a press on a tile or seal, with
 * whether Shift was held, and a press on the ground. `pickOnMap` is the rule
 * a host applies to those reports.
 *
 * Laws: [L06] hover lights wires by writing `data-hot` on the DOM, never
 *       through React state; state, size and selection are `data-*` the CSS
 *       paints; [L19] component authoring guide; [L20] composes `TugTooltip`
 *       and owns `--tugx-cycle-map-*`
 *
 * @module components/tugways/cycle-map
 */

import "./cycle-map.css";

import React, { useLayoutEffect, useMemo, useRef } from "react";
import { Check, Play } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  cycleMapGeometry,
  entryKey,
  layoutCycleMap,
  sealCycleMap,
  sketchKey,
  tileProgress,
  type CycleMapSize,
} from "./cycle-map-layout";
import { TugTooltip } from "./tug-tooltip";

/** How an entry stands: the cycle record's four words. */
export type CycleMapTileState = "joined" | "running" | "ready" | "waiting";

/** One entry of the cycle, as the map draws it. */
export interface CycleMapTile {
  n: number;
  /** The entries this one waits on, by number. */
  waits: readonly number[];
  /** The letters of every sketch this entry came from. */
  from: readonly string[];
  /** @selector .tug-cycle-map-tile[data-state="joined" | "running" | "ready" | "waiting"] */
  state: CycleMapTileState;
  /**
   * Running in another session: a dot on the tile's corner.
   * @selector .tug-cycle-map-tile[data-elsewhere]
   */
  elsewhere?: boolean;
  /** How far a running entry has got: pips that share the tile's room, or one bar when they would not fit. */
  steps?: { done: number; total: number };
  /** The sentence that is the tile's tooltip and, after its number, its accessible name. */
  label: string;
}

/** One sketch the cycle came from. */
export interface CycleMapSketch {
  letter: string;
  /** What the sketch wants: the seal's tooltip. */
  want: string;
}

export interface CycleMapProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onClick"> {
  tiles: readonly CycleMapTile[];
  sketches: readonly CycleMapSketch[];
  /**
   * The measures the map is drawn at.
   * @selector .tug-cycle-map[data-size="full" | "compact"]
   * @default "full"
   */
  size?: CycleMapSize;
  /**
   * The selected assets' keys (`entryKey`, `sketchKey`). With more than one,
   * the rest of the map draws back.
   * @selector .tug-cycle-map-tile[data-chosen] | .tug-cycle-map-seal[data-chosen] | .tug-cycle-map-plane[data-filtering]
   */
  chosen: ReadonlySet<string>;
  /** A press on a tile or a seal; `shift` is whether Shift was held. */
  onPress: (key: string, shift: boolean) => void;
  /** A press on the map's ground. */
  onClear: () => void;
}

export const CycleMap = React.forwardRef<HTMLDivElement, CycleMapProps>(function CycleMap(
  { tiles, sketches, size = "full", chosen, onPress, onClear, className, ...rest },
  ref,
) {
  const { layout, letters } = useMemo(() => {
    const sealed = sealCycleMap(
      tiles,
      sketches.map((s) => s.letter),
    );
    return { layout: layoutCycleMap(sealed.entries), letters: sealed.letters };
  }, [tiles, sketches]);
  const geometry = useMemo(() => cycleMapGeometry(layout, size), [layout, size]);
  const byN = useMemo(() => new Map(tiles.map((t) => [t.n, t])), [tiles]);
  const wantOf = useMemo(() => new Map(sketches.map((s) => [s.letter, s.want])), [sketches]);

  // The wires into one tile are lit: the tile under the pointer, or else the
  // single chosen tile. Which tile the pointer is on is appearance, so it
  // lives in a ref and reaches the wires as a DOM write.
  const planeRef = useRef<HTMLDivElement>(null);
  const pointedRef = useRef<number | null>(null);
  const chosenTile = chosen.size === 1 ? (tiles.find((t) => chosen.has(entryKey(t.n)))?.n ?? null) : null;
  const chosenRef = useRef(chosenTile);
  chosenRef.current = chosenTile;

  const light = (): void => {
    const plane = planeRef.current;
    if (plane === null) return;
    const hot = pointedRef.current ?? chosenRef.current;
    for (const wire of plane.querySelectorAll<SVGGElement>(".tug-cycle-map-wire")) {
      if (hot !== null && wire.dataset.to === String(hot)) wire.setAttribute("data-hot", "");
      else wire.removeAttribute("data-hot");
    }
  };

  // After every render, so wires drawn afresh and a changed selection are lit
  // before paint.
  useLayoutEffect(light);

  return (
    <div
      ref={ref}
      data-slot="tug-cycle-map"
      className={cn("tug-cycle-map", className)}
      {...rest}
      data-size={size}
      onClick={(e) => {
        // The ground only: a press on a tile or a seal has its own meaning.
        if (!(e.target as Element).closest("button")) onClear();
      }}
    >
      <div
        ref={planeRef}
        className="tug-cycle-map-plane"
        data-filtering={chosen.size > 1 || undefined}
        style={{ width: geometry.width, height: geometry.height }}
      >
        <svg className="tug-cycle-map-wires" width={geometry.width} height={geometry.height} aria-hidden>
          {geometry.strokes.map((stroke) => (
            <g
              key={`${stroke.from}-${stroke.to}`}
              className="tug-cycle-map-wire"
              data-to={stroke.to}
              data-sketch={stroke.from < 0 || undefined}
              data-met={byN.get(stroke.from)?.state === "joined" || undefined}
            >
              <path className="tug-cycle-map-wire-line" d={stroke.path} />
              <path className="tug-cycle-map-wire-head" d={stroke.head} />
            </g>
          ))}
        </svg>
        {geometry.boxes.map((box) => {
          const place = { left: box.left, top: box.top, width: box.width, height: box.height };
          if (box.seal) {
            const letter = letters.get(box.n)!;
            const key = sketchKey(letter);
            return (
              <TugTooltip key={box.n} content={wantOf.get(letter) ?? `Sketch ${letter}`}>
                <button
                  type="button"
                  className="tug-cycle-map-seal"
                  data-chosen={chosen.has(key) || undefined}
                  aria-label={`Sketch ${letter}`}
                  style={place}
                  onClick={(e) => onPress(key, e.shiftKey)}
                >
                  {letter}
                </button>
              </TugTooltip>
            );
          }
          const tile = byN.get(box.n)!;
          const key = entryKey(tile.n);
          return (
            <TugTooltip key={box.n} content={tile.label}>
              <button
                type="button"
                className="tug-cycle-map-tile"
                data-state={tile.state}
                data-chosen={chosen.has(key) || undefined}
                data-elsewhere={tile.elsewhere === true || undefined}
                aria-label={`${tile.n}, ${tile.label}`}
                style={place}
                onClick={(e) => onPress(key, e.shiftKey)}
                onPointerEnter={() => {
                  pointedRef.current = tile.n;
                  light();
                }}
                onPointerLeave={() => {
                  pointedRef.current = null;
                  light();
                }}
              >
                <span className="tug-cycle-map-tile-number">{tile.n}</span>
                <span className="tug-cycle-map-tile-mark">
                  <TileMark tile={tile} size={size} />
                </span>
              </button>
            </TugTooltip>
          );
        })}
      </div>
    </div>
  );
});

/* ---------------------------------------------------------------------------
 * TileMark
 * ---------------------------------------------------------------------------*/

/**
 * Beside a tile's number: a check once joined, a play mark when ready, and
 * while running, a pip a step in the room the number leaves, or one bar
 * filled to the same fraction when the pips would pass the tile's edge.
 */
function TileMark({ tile, size }: { tile: CycleMapTile; size: CycleMapSize }): React.ReactElement | null {
  if (tile.state === "joined") return <Check size={14} aria-hidden />;
  if (tile.state === "ready") return <Play size={12} aria-hidden />;
  if (tile.state === "running" && tile.steps !== undefined) {
    const { done, total } = tile.steps;
    const progress = tileProgress(size, tile.n, total);
    if (progress === "bar") {
      const fill = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
      return (
        <span className="tug-cycle-map-bar" aria-hidden>
          <span style={{ width: `${(fill * 100).toFixed(1)}%` }} />
        </span>
      );
    }
    return (
      <span className="tug-cycle-map-pips" data-dense={progress === "dense" || undefined} aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} data-pip={i < done ? "done" : i === done ? "now" : "todo"} />
        ))}
      </span>
    );
  }
  return null;
}
