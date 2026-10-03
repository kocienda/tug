/**
 * space-layer-loops.ts — nothing loops in the dark.
 *
 * A hidden workspace keeps its layout and its render state ([B02]), and on
 * this engine that means its CSS animations keep running: `content-visibility:
 * hidden` skips the contents' paint and hit-testing and nothing else, so a
 * breath loop on a card nobody is looking at still ticks its style every
 * frame. On the reference deck that is 67 loops paid for behind a workspace
 * the reader left. `display: none` stilled them for free; this is the rule
 * that does it now.
 *
 * **Why not a stylesheet rule.** The obvious spelling —
 * `.tug-space-layer:not([data-space-shown]) * { animation-play-state: paused }`
 * — was tried and measured: a universal descendant rule keyed on the layer's
 * attribute restyles every element of both layers on every switch, and it cost
 * about 100 ms of post-swap work per switch (`space-switch-timing`'s `paintMs`
 * 256–289 against 145–209 without it). That is the opposite of what the
 * workspace-switch arc is for. So the pause is taken on the loops themselves,
 * which are few, rather than declared over the subtree, which is thousands.
 *
 * **What is stilled, and what is not.** Only INFINITE loops — an animation
 * whose `iterations` is `Infinity`. A finite animation in a hidden layer (a
 * settle's tween, a card's entrance) is left to run out unpainted, because
 * pausing it would strand whoever is awaiting its `finished` promise — the
 * settle's inline residue is owed back on that promise, and a paused settle
 * never pays it. A loop has no completion anyone waits for.
 *
 * **Two moments.** The canvas calls {@link stillLoops} in the effect that owns
 * a workspace switch, so the departing layer's loops are paused in the commit
 * that hides it and the arriving layer's are resumed in the commit that shows
 * it. A loop that STARTS in the dark — a card mounted into a hidden workspace,
 * a component whose loop begins on a store change — is caught by
 * {@link stillLoopOnStart}, a delegated `animationstart` listener on the
 * canvas. Between them every loop under a hidden layer is paused, whenever it
 * began.
 *
 * **Resume touches only what this module paused, and the record is the
 * authority for it.** Every pass walks the record as well as the animations it
 * was handed, because the engine does not report every loop this module
 * paused. A loop demoted to zero iterations — the off-screen mark, the
 * understudy mark, the motion switch, all one knob (`--tug-loop-iterations`)
 * — is absent from `getAnimations()` while the mark stands, and when the mark
 * lifts the engine brings back the SAME animation object, still paused
 * through the API. A pass that read only the engine's list could not see it
 * at the moment its layer was shown, and nothing would ever look at it again:
 * that is how a Session card's wave and an Overview session dot stood still
 * over a working turn (`at0682`). So a loop on the record is resumed when its
 * layer is shown whatever its iteration count reads then — playing a loop
 * demoted to zero moves nothing, and it runs the moment the mark lifts.
 *
 * The record is a `Set` rather than a `WeakSet` because it must be walked,
 * so it must also be pruned: an entry whose element has left the document, or
 * whose animation was cancelled, is forgotten by every pass and by every loop
 * that starts in the dark. The second is what bounds it between switches — a
 * Session card in a parked workspace mounts a fresh wave every turn, and
 * without it each one would be held until the reader next switched.
 *
 * A loop a component's own stylesheet holds — `animation-play-state: paused`
 * — is not resumed over that hold. **A declined resume keeps its record**,
 * because this module is the only thing that can ever hand the loop back: the
 * pause was taken through the API, so the stylesheet letting go does not
 * resume it. The passes that look again are a workspace switch and the motion
 * switch's off edge, which the canvas subscribes to.
 *
 * Nothing here is React state ([L06]): it is the Web Animations API on
 * elements the canvas already owns.
 *
 * @module components/chrome/space-layer-loops
 */

import { SPACE_LAYER_CLASS, SPACE_SHOWN_ATTRIBUTE } from "./space-layer";

/** The part of `Animation` this module reads and drives. */
export interface LoopLike {
  readonly playState: AnimationPlayState;
  readonly effect: AnimationEffect | null;
  pause(): void;
  play(): void;
}

/** Where an animation's target stands: under a hidden layer, a shown one, or outside every layer. */
export type LayerState = "hidden" | "shown" | "none";

/** What {@link reconcileLoop} did to one animation. */
export type LoopVerdict = "stilled" | "resumed" | "left";

/**
 * The loops this module paused — and nothing anybody else did. Walked by every
 * pass ({@link stillLoops}); pruned there and by {@link stillLoopOnStart}.
 */
const stilled = new Set<LoopLike>();

/** Drop every record entry that is past resuming. */
function forgetGone(): void {
  for (const animation of [...stilled]) {
    if (isForgotten(animation)) stilled.delete(animation);
  }
}

/** The element an animation runs on, or `null` when it has none or is not a keyframe effect. */
export function loopTarget(animation: LoopLike): Element | null {
  const effect = animation.effect;
  if (effect === null || typeof effect !== "object") return null;
  const target = (effect as { target?: unknown }).target;
  if (target === null || target === undefined || typeof target !== "object") return null;
  if (typeof (target as Element).closest !== "function") return null;
  return target as Element;
}

/** Whether an animation is an infinite loop — the only kind this module stills. */
export function isLoop(animation: LoopLike): boolean {
  const effect = animation.effect;
  if (effect === null || typeof (effect as AnimationEffect).getTiming !== "function") return false;
  return effect.getTiming().iterations === Infinity;
}

/** Which layer, if any, an element stands in. */
export function layerStateOf(target: Element): LayerState {
  const layer = target.closest(`.${SPACE_LAYER_CLASS}`);
  if (layer === null) return "none";
  return layer.hasAttribute(SPACE_SHOWN_ATTRIBUTE) ? "shown" : "hidden";
}

/**
 * Bring one animation into line with where its element stands.
 *
 * Under a hidden layer, a running infinite loop is paused and recorded. Out
 * from under one — shown, or outside every layer — a loop on the record is
 * resumed, and the iteration count is NOT consulted on that side: a loop
 * demoted to zero iterations when its layer is shown is still this module's
 * pause, and playing it is what lets it run once the demotion lifts.
 *
 * `cssPaused` is whether the element's computed `animation-play-state` says
 * paused — a component's own rule — and it is only consulted on the resume
 * side. A resume it declines LEAVES THE RECORD STANDING, so the next pass
 * tries again. Dropping it there would be final: the loop is paused through
 * the Web Animations API, which outranks `animation-play-state`, so the
 * stylesheet letting go does not resume it and nothing else ever would.
 */
export function reconcileLoop(
  animation: LoopLike,
  state: LayerState,
  cssPaused: () => boolean,
): LoopVerdict {
  if (state === "hidden") {
    if (!isLoop(animation) || animation.playState !== "running") return "left";
    animation.pause();
    stilled.add(animation);
    return "stilled";
  }
  if (!stilled.has(animation)) return "left";
  if (cssPaused()) return "left";
  stilled.delete(animation);
  animation.play();
  return "resumed";
}

/** What one pass over the animations did, for a trace or a test. */
export interface StillReading {
  stilled: number;
  resumed: number;
}

/**
 * Whether a record entry is past resuming: its animation was cancelled, or its
 * element has left the document.
 */
function isForgotten(animation: LoopLike): boolean {
  if (animation.playState === "idle") return true;
  const target = loopTarget(animation);
  if (target === null) return true;
  return (target as { isConnected?: boolean }).isConnected === false;
}

/**
 * One pass: pause every loop under a hidden layer, resume every loop this
 * module paused whose layer is no longer hidden.
 *
 * The canvas passes `root.getAnimations({ subtree: true })`; a test passes
 * whatever it likes. The record is walked after them, whatever was passed,
 * because the engine's list leaves out a paused loop that is demoted to zero
 * iterations — and that loop is exactly the one a pass reading only the list
 * would strand. Each animation is reconciled once per pass.
 */
export function stillLoops(
  animations: Iterable<LoopLike>,
  cssPausedOf: (target: Element) => boolean,
): StillReading {
  const reading: StillReading = { stilled: 0, resumed: 0 };
  forgetGone();
  const seen = new Set<LoopLike>();
  const visit = (animation: LoopLike): void => {
    if (seen.has(animation)) return;
    seen.add(animation);
    const target = loopTarget(animation);
    if (target === null) return;
    const verdict = reconcileLoop(animation, layerStateOf(target), () =>
      cssPausedOf(target),
    );
    if (verdict === "stilled") reading.stilled += 1;
    else if (verdict === "resumed") reading.resumed += 1;
  };
  for (const animation of animations) visit(animation);
  for (const animation of [...stilled]) visit(animation);
  return reading;
}

/** Whether an element's own stylesheet holds its animations paused. */
function computedPaused(target: Element): boolean {
  const view = target.ownerDocument.defaultView;
  if (view === null) return false;
  return view.getComputedStyle(target).animationPlayState === "paused";
}

/**
 * The canvas's pass: every animation under `root`, reconciled with its layer.
 *
 * Run in the commit that switches workspaces, after the shown attribute has
 * moved — which is where the canvas's own switch effect runs it.
 */
export function stillHiddenLayerLoops(root: Element): StillReading {
  if (typeof root.getAnimations !== "function") return { stilled: 0, resumed: 0 };
  return stillLoops(root.getAnimations({ subtree: true }), computedPaused);
}

/**
 * A loop that starts in the dark is paused as it starts.
 *
 * Delegated `animationstart` listener for the canvas: CSS animation events
 * bubble, and the event names the animation, so the one that just began can be
 * found on its target and reconciled like any other. A loop starting under the
 * shown layer, or outside every layer, is left alone.
 */
export function stillLoopOnStart(event: AnimationEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (layerStateOf(target) !== "hidden") return;
  if (typeof target.getAnimations !== "function") return;
  forgetGone();
  for (const animation of target.getAnimations()) {
    const named = animation as Animation & { animationName?: string };
    if (named.animationName !== event.animationName) continue;
    reconcileLoop(animation, "hidden", () => false);
  }
}
