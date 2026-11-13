/**
 * `ReauditRows` — one row per surface of the engine's re-audit.
 *
 * Presentational: it draws the surfaces a {@link ReauditModel} carries and
 * reads nothing else. The transcript's re-audit block and the ARC cell's
 * popover both wear it, so a surface reads the same wherever it is met.
 *
 * Each row carries its status on `data-status`, and the status's colour and
 * glyph are the stylesheet's ([L06]): nothing here holds appearance in React
 * state. A running row's mark is the progress indicator's own running pose,
 * and its elapsed text is the one place a clock is read — through
 * `useLiveTick` ([L02]), in a leaf that mounts only while a row is running,
 * so a settled re-audit holds no interval open.
 *
 * @module components/tugways/reaudit-rows
 */

import type React from "react";

import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { useLiveTick } from "@/lib/live-tick";
import { surfaceTime, type ReauditSurface } from "@/lib/reaudit-row";
import "./reaudit-rows.css";

/** The glyph a settled row leads with, by status. */
const STATUS_GLYPH: Readonly<Record<string, string>> = {
  pending: "·",
  pass: "✓",
  fail: "✗",
  skipped: "–",
};

/** `passed/total`, when the row knows both. */
export function surfaceCounts(surface: ReauditSurface): string | null {
  if (surface.passed === null || surface.total === null) return null;
  return `${surface.passed}/${surface.total}`;
}

/** A running row's elapsed time, ticking. */
function RunningTime({ surface }: { surface: ReauditSurface }): React.ReactElement {
  const now = useLiveTick();
  return <span className="reaudit-row-time">{surfaceTime(surface, now) ?? ""}</span>;
}

/** One surface. */
function ReauditRow({ surface }: { surface: ReauditSurface }): React.ReactElement {
  const running = surface.status === "running";
  const counts = surfaceCounts(surface);
  const failed = surface.status === "fail";
  return (
    <li className="reaudit-row" data-status={surface.status}>
      <span className="reaudit-row-mark" aria-hidden="true">
        {running ? (
          <TugProgressIndicator variant="pulsing-dot" state="running" size={8} />
        ) : (
          (STATUS_GLYPH[surface.status] ?? "·")
        )}
      </span>
      <span className="reaudit-row-name" data-tugx-findable="">
        {surface.name}
      </span>
      <span className="reaudit-row-counts">{counts ?? ""}</span>
      {running ? (
        <RunningTime surface={surface} />
      ) : (
        <span className="reaudit-row-time">{surfaceTime(surface, 0) ?? ""}</span>
      )}
      {failed && (surface.title !== null || surface.message !== null) ? (
        <span className="reaudit-row-failure" data-tugx-findable="">
          {[surface.title, surface.message].filter((part) => part !== null).join(" — ")}
        </span>
      ) : null}
    </li>
  );
}

/** The surfaces, in plan order. Nothing at all when there are none. */
export function ReauditRows({
  surfaces,
}: {
  surfaces: readonly ReauditSurface[];
}): React.ReactElement | null {
  if (surfaces.length === 0) return null;
  return (
    <ul className="reaudit-rows" data-slot="reaudit-rows">
      {surfaces.map((surface) => (
        <ReauditRow key={surface.name} surface={surface} />
      ))}
    </ul>
  );
}
