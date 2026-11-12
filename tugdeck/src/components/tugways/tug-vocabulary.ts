/**
 * tug-vocabulary — the prop vocabulary the tugways primitives share.
 *
 * One spelling per axis, so a reader who has learned one primitive's props
 * has learned the next one's. A component that supports only part of an
 * axis declares its own type as an `Extract<>` of the shared union and keeps
 * its exported name, so call sites read the component's type and the
 * checker reads the shared one.
 *
 * Semantic colour comes in two words, and one test decides which a component
 * takes:
 *
 *  - **`role`** — the component is a control (it emits an action) or carries
 *    an `emphasis` prop. The role names what the control does or which
 *    family its ink comes from: `action`, `danger`, `option`, `agent`, …
 *  - **`tone`** — everything else: passive status surfaces that report a
 *    state rather than offer an act. The tone names the state's colour:
 *    `default`, `caution`, `danger`, `success`, …
 *
 * A prop that colours one part of a component spells the part and the word
 * (`iconTone`, `fillTone`, `busyTone`); the confirm button of a dialog takes
 * its role through `confirm={{ role }}`, so no prop name ends in `Role`.
 *
 * The guide's *Prop Vocabulary* section (`tuglaws/component-authoring.md`)
 * is this module in prose.
 *
 * @module components/tugways/tug-vocabulary
 */

/**
 * Every role a tugways control or emphasis-bearing component takes — the
 * union of the per-component role types.
 */
export type TugRole =
  | "accent"
  | "action"
  | "active"
  | "agent"
  | "caution"
  | "danger"
  | "data"
  | "inherit"
  | "muted"
  | "option"
  | "success";

/**
 * Every tone a passive tugways surface takes — the union of the
 * per-component tone types. `inherit` resolves to the host's text colour;
 * `default` is the surface's own neutral ink.
 *
 * Categorical palettes (a gauge's per-segment data colours) are not semantic
 * colour and keep their own types.
 */
export type TugTone =
  | "accent"
  | "action"
  | "active"
  | "agent"
  | "caution"
  | "danger"
  | "data"
  | "default"
  | "info"
  | "inherit"
  | "muted"
  | "option"
  | "primary"
  | "quiet"
  | "success";

/**
 * The size scale every sized primitive takes. The default is `md`
 * everywhere; a component that supports part of the scale declares an
 * `Extract<TugSize, …>`, and a call site that wants a smaller control says
 * so (`size="sm"`).
 */
export type TugSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

/**
 * Presentation density. `regular` is the component's ordinary layout and the
 * default; `compact` is its tight one.
 */
export type TugDensity = "regular" | "compact";

/**
 * How a scrolling list sizes itself on the block axis. `fill` (default) takes
 * its bounded parent's height and scrolls inside it; `content` stands at the
 * sum of its rows and leaves the scrolling to an ancestor.
 */
export type TugSizing = "fill" | "content";

/**
 * How a list presents itself. `default` is the free-standing list;
 * `rail` is a sidebar card's list, standing at its rows' height inside the
 * card root that scrolls it, edge to edge, with its row hairlines always on.
 */
export type TugPresentation = "default" | "rail";

/**
 * A row's standing among its neighbours. `struck` is spent — legible but
 * crossed out and faded (a discarded message); `dimmed` is quieted a step (a
 * row naming something not on screen). Absent is full strength.
 */
export type TugRowState = "struck" | "dimmed";
