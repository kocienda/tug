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
 * **Resume touches only what this module paused**, kept in a `WeakSet` so a
 * loop whose element is gone is forgotten with it. A loop CSS is holding — the
 * motion switch's demotion (`data-tug-motion-demoted` on `<html>`, which
 * resolves its iteration count to zero, so it is not a loop while it stands),
 * or a component's own `animation-play-state: paused` — is not resumed over
 * that hold. **A declined resume keeps its record**, because this module is
 * the only thing that can ever hand the loop back: the pause was taken through
 * the API, so the stylesheet letting go does not resume it, and a loop dropped
 * from the set on the one pass that declined it is one no later pass will look
 * at again. The passes that look again are a workspace switch and the motion
 * switch's off edge, which the canvas subscribes to for exactly this.
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

/** The loops this module paused — and nothing anybody else did. */
const stilled = new WeakSet<LoopLike>();

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
 * `cssPaused` is whether the element's computed `animation-play-state` says
 * paused — the switch's demotion, or a component's own rule — and it is only
 * consulted on the resume side: a hidden loop is paused whatever CSS says, and
 * a shown one is resumed only if CSS is not holding it.
 *
 * A declined resume LEAVES THE RECORD STANDING, so the next pass over a shown
 * layer tries again. Dropping it there would be final: the loop is paused
 * through the Web Animations API, which outranks `animation-play-state`, so
 * the switch being thrown back does not resume it and nothing else ever would.
 */
export function reconcileLoop(
  animation: LoopLike,
  state: LayerState,
  cssPaused: () => boolean,
): LoopVerdict {
  if (!isLoop(animation)) return "left";
  if (state === "hidden") {
    if (animation.playState !== "running") return "left";
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
 * One pass over a set of animations: pause every loop under a hidden layer,
 * resume every loop this module paused whose layer is now shown.
 *
 * The canvas passes `root.getAnimations({ subtree: true })`; a test passes
 * whatever it likes.
 */
export function stillLoops(
  animations: Iterable<LoopLike>,
  cssPausedOf: (target: Element) => boolean,
): StillReading {
  const reading: StillReading = { stilled: 0, resumed: 0 };
  for (const animation of animations) {
    const target = loopTarget(animation);
    if (target === null) continue;
    const verdict = reconcileLoop(animation, layerStateOf(target), () =>
      cssPausedOf(target),
    );
    if (verdict === "stilled") reading.stilled += 1;
    else if (verdict === "resumed") reading.resumed += 1;
  }
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
  for (const animation of target.getAnimations()) {
    const named = animation as Animation & { animationName?: string };
    if (named.animationName !== event.animationName) continue;
    reconcileLoop(animation, "hidden", () => false);
  }
}
