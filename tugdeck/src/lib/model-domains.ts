/**
 * model-domains.ts — the tugbank domain/key constants for model persistence,
 * as a dependency-free leaf.
 *
 * These live apart from [model.ts] because `settings-api.ts` needs the domain
 * names (the card-keyed orphan sweep) while `model.ts` needs `settings-api`
 * transitively (through [model-catalog.ts]'s PUT). Holding the constants in a
 * module that imports nothing keeps that from closing into an import cycle,
 * where whichever module loaded second saw the other's constants still in
 * their temporal dead zone.
 *
 * `model.ts` re-exports every name here, so it remains the one place callers
 * import model persistence from.
 *
 * @module lib/model-domains
 */

/** tugbank domain for per-card model persistence per [D07]. */
export const MODEL_DOMAIN = "dev.model";

/**
 * tugbank domain/key for the *global* default model selector — the model a
 * brand-new card (one with nothing persisted under {@link MODEL_DOMAIN}) adopts
 * on mount. Set from the Settings card's "Session Card" tab; distinct from the
 * per-card domain so changing the global default never disturbs an open card
 * that already carries its own remembered model. Mirrors the permission-mode
 * default domain.
 */
export const MODEL_DEFAULT_DOMAIN = "dev.tugtool.model";
export const MODEL_DEFAULT_KEY = "default";

/** The selector new cards adopt when nothing else is configured — the account
 *  default, which forces no particular model. */
export const DEFAULT_MODEL_SELECTOR = "default";

/**
 * tugbank domain for the plan each card last reviewed, keyed by card id.
 *
 * Bare `/dash-review` resolves through this first: the gesture's moment is a
 * plan just devised and edited, when the card is usually *not* bound to a dash
 * yet — and when it is, it is frequently bound to a dash implementing a
 * different plan. Card-keyed, so it joins the startup orphan sweep.
 *
 * A path, and only a path. There is no companion domain holding a review model:
 * a review runs on whatever the user has selected, and choosing it is their act.
 */
export const PLAN_REVIEW_LAST_DOMAIN = "dev.dash-review-last";
