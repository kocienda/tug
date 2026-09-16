/**
 * The face a departing pane leaves behind — the clone, and the two lists that
 * make it answer to nothing and place itself nowhere.
 *
 * A closing frame cannot be animated out: React unmounts it inside the removal
 * commit, so by the time there is an animation to run there is no element to
 * run it on. The canvas plants a `.tug-pane-exit-ghost` at the frame's last
 * measured rect instead and fades that ([P07]). The ghost has the pane's
 * ground, border and radius; the FACE is what puts the card's own contents
 * inside it, so a close reads as the card leaving rather than as its contents
 * vanishing a beat before its frame does.
 *
 * It lives in its own module rather than beside the settle that plants it
 * because both lists below are a CONTRACT — the two ways a still can leak back
 * into a live document — and a contract is worth naming, exporting, and
 * testing directly rather than reading out of a four-thousand-line canvas.
 *
 * The contract, in one line each:
 *
 * - **The face answers to nothing.** {@link FACE_IDENTITY_ATTRS}.
 * - **The face carries no geometry of its own.** {@link FACE_GEOMETRY_PROPS}.
 *
 * The ghost owns position and size; the face is a picture that fills it, and
 * `.tug-pane-exit-ghost > .tug-pane-exit-face` is the only thing that places
 * it. `at0582` reads both rects against the departing frame's on every frame
 * of the fade.
 */

/**
 * Every attribute by which something addresses a LIVE node, stripped from a
 * departure face and from every node under it.
 *
 * A face that answered any of them would be a card the document still says is
 * there, for the whole beat the ghost stands — and the queries below are
 * document-wide, so a still is not merely reachable but reachable FIRST when
 * it sorts before the live card in document order.
 *
 * The first six name a THING: `id` and `data-pane-id` keep the settle's own
 * walks off the still; `data-card-id` is how the deck, the harness and every
 * app-test name a card; `data-testid` is how a test names anything;
 * `data-tug-focus-key` is how the focus machinery names a target; `data-slot`
 * is how both a stylesheet and a test name a part.
 *
 * The rest were found by the census in `at0583` rather than by reasoning, and
 * each is a query that would have ACTED on what it found: `data-responder-id`
 * and `data-tug-focusable` are what `focus-manager` and `focus-transfer`
 * resolve a focus target through (nine and eight nodes inside one Session
 * card's still); `data-tug-scroll-key` is what `card-host` restores scroll
 * through; `data-tug-state-key` is what `focus-transfer` finds a component's
 * preserved state by; `data-card-host` is what the gesture interpreter
 * classifies a press with; `data-tug-list-cell-index` is how `tug-list-view`
 * addresses a row; `data-item-action` is how the editor context menu finds an
 * item to click; `data-tug-annotation` is what the commit and file tip portals
 * MOUNT ONTO, which would put a live tooltip on a fading picture.
 *
 * **The price is appearance, and it is paid on purpose.** Appearance rides on
 * classes and survives, but a few rules key on these: the `data-slot` handful
 * tune details a 240ms fade does not show, and `data-tug-annotation` is the
 * expensive one — about thirty rules style commit chips and path rows by it,
 * so a departing transcript's chips flatten for the length of the fade. That
 * is the cost of the rule being a rule ([B04]), and the alternative — teaching
 * every document-wide query to exclude the ghost — puts the contract in every
 * caller instead of in one list.
 */
export const FACE_IDENTITY_ATTRS = [
  "id",
  "data-pane-id",
  "data-card-id",
  "data-testid",
  "data-tug-focus-key",
  "data-slot",
  "data-responder-id",
  "data-tug-focusable",
  "data-tug-scroll-key",
  "data-tug-state-key",
  "data-card-host",
  "data-tug-list-cell-index",
  "data-item-action",
  "data-tug-annotation",
] as const;

/**
 * Every inline style property that would PLACE the face, stripped from the
 * clone's root.
 *
 * The live frame's `style` attribute carries `position: absolute` and the
 * imposer's `left`/`top` (`tug-pane.tsx`), and `cloneNode(true)` keeps the
 * attribute whole. Inline geometry outranks any class rule, so a face that
 * kept it is laid out INSIDE the ghost at the pane's own canvas coordinates —
 * the strip gap plus the border — and the reader watches a copy of the card
 * fade a few pixels from where the card stood. That was the defect; this list
 * is why it cannot come back.
 *
 * It is a LIST rather than the one property the defect happened to use,
 * because the leak is the class and not the instance: anything the clone
 * carries that positions, sizes, transforms, hides or stacks it is the same
 * bug wearing a different property name. The face's whole box comes from
 * `.tug-pane-exit-ghost > .tug-pane-exit-face`, and this list is what makes
 * that rule win by construction rather than by specificity ([B02], [B07]).
 *
 * `visibility` and `opacity` are here for the second half of that: the fade is
 * the GHOST's, and a face that brought its own opacity would fade twice.
 */
export const FACE_GEOMETRY_PROPS = [
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "transform",
  "transform-origin",
  "inset",
  "visibility",
  "opacity",
  "z-index",
] as const;

/**
 * Take a departing frame's face: a deep clone that answers to nothing, places
 * itself nowhere, and takes no input.
 *
 * The caller holds it until the settle's Last pass plants it in the ghost.
 * The clone is the expensive part, and it is taken on the close gesture itself
 * — `cardWillBeginDestruction` is the one notification that fires while the
 * frame is still mounted.
 */
export function takeDepartureFace(frame: HTMLElement): HTMLElement {
  const face = frame.cloneNode(true) as HTMLElement;
  for (const attr of FACE_IDENTITY_ATTRS) {
    face.removeAttribute(attr);
    for (const node of face.querySelectorAll(`[${attr}]`)) {
      node.removeAttribute(attr);
    }
  }
  // The geometry strip, on the root alone: the ghost places the face, and only
  // the root is placed by the ghost's rule. A descendant's inline geometry is
  // the card's own interior layout, which is exactly what the still is a
  // picture OF.
  for (const prop of FACE_GEOMETRY_PROPS) {
    face.style.removeProperty(prop);
  }
  face.setAttribute("aria-hidden", "true");
  // A picture answers to nothing, and focus is the other way a node answers.
  // `aria-hidden` takes it out of the accessibility tree but leaves its
  // buttons and fields in the tab order, so a Tab pressed during the fade
  // could land the ring inside a card that has already closed. `inert` is what
  // takes the whole subtree out of both.
  face.setAttribute("inert", "");
  face.classList.add("tug-pane-exit-face");
  return face;
}
