/**
 * The terminal body's retained-line cap, alone in a leaf module.
 *
 * `TerminalBlock` truncates at it and re-exports it; the transcript search
 * index caps the lines it indexes at the same number, so a search never finds
 * a line the block has already dropped.
 *
 * @module lib/terminal-line-cap
 */

/**
 * Maximum retained-line count before the earliest lines are dropped
 * and replaced with a "… N earlier lines truncated" indicator
 * ([Q04]).
 */
export const RETAINED_LINE_CAP = 10_000;
