/**
 * The deck's half of the chart measure protocol.
 *
 * The chart compiler lays text out against exact measurements but cannot
 * measure anything itself: it runs in WASM, away from the page's fonts. So
 * a compile is a short conversation. The engine answers a round with the
 * `(role, text)` pairs it still needs; the deck measures them with a
 * canvas set in the role's own computed font and calls again with a larger
 * table. Round one asks for every full string, round two for the
 * truncation candidates of strings that overflow, and a third request is
 * an error — the same limit the engine's native loop enforces.
 *
 * The role's face and size come from one CSS declaration per role
 * (`tgt-<role>`), which the rendered `<text>` and the hidden probe here
 * both carry, so the measured face cannot drift from the drawn one.
 *
 * @module lib/chart/chart-measure
 */

import { faceLoaded, textBoxMeasurer, whenFaceLoaded, type TextBoxMetrics } from "@/lib/font-metrics";
import type { ChartRound, ChartTypeRole, MeasureTableJson } from "@/lib/lazy/load-tuggraphics";

export const CHART_TYPE_ROLES: readonly ChartTypeRole[] = ["title", "label", "value", "mono"];

/** Marks the probes, so a second render finds the ones already there. */
const PROBE_ATTR = "data-tugx-chart-probe";

/** How long a chart waits for its faces before measuring what is present. */
export const FACE_DEADLINE_MS = 3000;

/** The most `compile_round` calls one compile may make. */
export const MAX_COMPILE_CALLS = 3;

export const NOT_CONVERGED = "measurement did not converge";

export type RoleProbes = Record<ChartTypeRole, HTMLElement>;

/**
 * Whether every role's face is already there, read synchronously. A render
 * on a warm page skips the face wait on a true, so a chart that remounts
 * while the reader scrolls is drawn in the same call that mounted it —
 * no pending flash, and nothing for transcript Find to compare mid-way.
 */
export function roleFacesLoaded(probes: RoleProbes, sampleText: string): boolean {
  return CHART_TYPE_ROLES.every((role) => faceLoaded(probes[role], sampleText));
}

/**
 * One hidden, empty `<span class="tgt-<role>">` per type role inside
 * `host`, created once. A probe holds no text: only its computed style is
 * read, and an empty probe can never be a Find match.
 */
export function ensureRoleProbes(host: HTMLElement): RoleProbes {
  const probes = {} as RoleProbes;
  for (const role of CHART_TYPE_ROLES) {
    let probe = host.querySelector<HTMLElement>(`:scope > span.tgt-${role}[${PROBE_ATTR}]`);
    if (probe === null) {
      probe = document.createElement("span");
      probe.className = `tgt-${role}`;
      probe.setAttribute(PROBE_ATTR, "");
      probe.setAttribute("aria-hidden", "true");
      probe.hidden = true;
      host.appendChild(probe);
    }
    probes[role] = probe;
  }
  return probes;
}

/**
 * Waits for every role's face, or for the deadline — whichever is first.
 * Never rejects: a face that is not there by the deadline is measured on
 * whatever face is present, which is better than a chart that never draws.
 */
export function awaitRoleFaces(
  probes: RoleProbes,
  sampleText: string,
  deadlineMs: number = FACE_DEADLINE_MS,
): Promise<"loaded" | "deadline"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const loaded = Promise.all(CHART_TYPE_ROLES.map((role) => whenFaceLoaded(probes[role], sampleText))).then(
    () => "loaded" as const,
  );
  return Promise.race([loaded, deadline]).finally(() => clearTimeout(timer));
}

export type RoleMeasure = (role: ChartTypeRole, text: string) => TextBoxMetrics;

/** A measurer over the probes' computed fonts, or null with no canvas. */
export function probeMeasurer(probes: RoleProbes): RoleMeasure | null {
  const byRole = {} as Record<ChartTypeRole, (s: string) => TextBoxMetrics>;
  for (const role of CHART_TYPE_ROLES) {
    const m = textBoxMeasurer(probes[role]);
    if (m === null) return null;
    byRole[role] = m;
  }
  return (role, text) => byRole[role](text);
}

export type FinishedRound = Exclude<ChartRound, { status: "measure" }>;

/**
 * Drives the protocol to its end: calls `engineRound` with a growing
 * table, measuring exactly the pairs each round asks for, until the engine
 * answers `done` or `invalid`. A round still asking after the last allowed
 * call is reported as `invalid` with the convergence error.
 */
export function runMeasureLoop(
  engineRound: (table: MeasureTableJson) => ChartRound,
  measure: RoleMeasure,
): FinishedRound {
  const table: MeasureTableJson = {};
  for (let call = 1; call <= MAX_COMPILE_CALLS; call++) {
    const round = engineRound(table);
    if (round.status !== "measure") return round;
    if (call === MAX_COMPILE_CALLS) break;
    for (const [role, text] of round.texts) {
      table[`${role}\u0000${text}`] = measure(role, text);
    }
  }
  return { status: "invalid", errors: [{ path: "", message: NOT_CONVERGED }] };
}
