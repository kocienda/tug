/**
 * Progress-indicator role → fill token, alone in a leaf module.
 *
 * `TugProgressIndicator` re-exports both the role type and
 * {@link progressRoleFillToken}, and component callers import them from
 * there. Lib modules import from here, because the component sits on a chain
 * (label → copyable text → responder chain → `action-dispatch`) that comes
 * back around to most of `lib`.
 */

/**
 * Semantic role. `inherit` resolves the indicator fill to `currentColor` so
 * the glyph picks up its host's text tone — useful in muted prose contexts
 * where the indicator should read as part of the surrounding copy rather
 * than as a separate accent.
 */
export type TugProgressIndicatorRole =
  | "inherit"
  | "action"
  | "agent"
  | "data"
  | "option"
  | "success"
  | "caution"
  | "danger";

/**
 * Aliases the public role name to the suffix used in the seven-slot token
 * names. `action` resolves to `active` — matches the convention TugProgress
 * established and that `TugLabel` already mirrors so role names line up
 * across primitives.
 */
const ROLE_TO_TOKEN_SUFFIX: Record<Exclude<TugProgressIndicatorRole, "inherit">, string> = {
  action: "active",
  agent: "agent",
  data: "data",
  option: "option",
  success: "success",
  caution: "caution",
  danger: "danger",
};

/**
 * Roles whose fill does NOT come from the toggle family.
 *
 * **`danger` is the system's one status red.** A stopped arc, a stopped
 * step, and a stopped reading are one fact wearing one ink, and that ink is
 * `--tug7-element-tone-icon-normal-danger-rest` — the status-ink slot the arc
 * track, the lifecycle mark, the lifecycle line, the arc fold and the trouble
 * notes already paint from. The indicator used to take `danger` off
 * `--tug7-surface-toggle-primary-normal-danger-rest`, and the only reason was
 * that the toggle family happened to carry a full role set: nothing about a
 * status glyph is a toggle. The cost was visible — the Session card's Z2 ARC
 * cell flanked the word "Stopped" with dots two ramp stops off the pills on
 * the arc track directly above it, two reds for one fact.
 *
 * The stop BUTTON is deliberately not in here. A button is a control and
 * paints from `filled-danger`; that difference is a difference of kind, not
 * drift.
 */
const ROLE_FILL_TOKEN_OVERRIDES: Partial<
  Record<Exclude<TugProgressIndicatorRole, "inherit">, string>
> = {
  danger: "--tug7-element-tone-icon-normal-danger-rest",
};

/**
 * The token name a role's fill resolves from, or `null` for `inherit` — which
 * paints in `currentColor` and so has no token to name.
 *
 * Most roles resolve from one token family —
 * `--tug7-surface-toggle-primary-normal-{role}-rest` — so the role tone reads
 * identically across every indicator variant; `danger` is the one role that
 * leaves it (see {@link ROLE_FILL_TOKEN_OVERRIDES}).
 *
 * Exported for the one renderer that cannot cascade: the editor's atom chip is
 * a Canvas bake inside an `<img>`, so a session atom's dot has to resolve this
 * tone to pixels rather than inherit it.
 */
export function progressRoleFillToken(
  role: TugProgressIndicatorRole,
): string | null {
  if (role === "inherit") return null;
  const override = ROLE_FILL_TOKEN_OVERRIDES[role];
  if (override !== undefined) return override;
  return `--tug7-surface-toggle-primary-normal-${ROLE_TO_TOKEN_SUFFIX[role]}-rest`;
}
