export interface Tide {
  at: Date;
  height: number;
  kind: "high" | "low";
}

/** The next tide of `kind` after `now`, or null past the table's end. */
export function nextTide(table: Tide[], kind: Tide["kind"], now: Date): Tide | null {
  for (const tide of table) {
    if (tide.kind === kind && tide.at > now) return tide;
  }
  return null;
}

/** Whether the bar has `draft` metres of water at `tide`. */
export function barIsOpen(tide: Tide, draft: number, margin = 0.5): boolean {
  return tide.height - draft >= margin;
}
