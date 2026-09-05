**Status:** superseded — this sketch became the brief and task list of the `atom-selections` arc (`.tug/arcs/atom-selections/`), which walked it; the rule now lives in `tuglaws/menus.md` and the press in `tugdeck/src/lib/whole-entity-press.ts`.

# One press, one rule: every menu about an entity selects that entity

**Status:** sketch, scope settled. Ready for `/arc`. One open question — [What
the press names when the claim is wider than the entity](#what-the-press-names)
— has a recommendation and needs a yes.

The fault, from the right-click on the commit atom in a `/commit` receipt: the
menu that opened is the commit's four-item menu, and the highlight under it
says `56c4820f`. The atom says `commit:56c4820f`. WebKit smart-selected the hex
run inside the pill, nothing overwrote it, and the pill's node, word, padding
and border stayed at rest — the exact fragment-under-a-whole-menu mismatch
`2f9f0d23` was written to end, on a surface that mismatch never reached.

## Why it survived the fix

`2f9f0d23` did not state a rule about presses. It added a **parameter** —
`wholeEntityTarget` — to **one** menu-opening hook, and threaded it through the
three surfaces that use that hook. Everything else that opens a menu about an
entity kept its own press.

There are four menu-opening paths today, and they are all *correct* about what
the menu **says** — every one of them builds its items from
`lib/annotator/registry.ts`, which is the single place a kind's item list and
order are written ([menus.md](../tuglaws/menus.md#the-registry-states-the-items-the-surface-states-its-facts)).
The registry unified what a menu says. Nothing ever unified what a press does:

| Path | Surfaces | Settles the selection |
|---|---|---|
| `useTextSurfaceContextMenu` | transcript cells, Changes list, text editor | **yes** — `wholeEntityTarget` → settle + paint |
| `useCommitIdentityMenu` | `/commit` receipt, `/arc-join` receipt, History rows | no |
| `useSessionIdentityMenu` | session chips and identity rows | no |
| `useCopyableText` | the atom's own one-item Copy, every badge and label | no |

So the same pill, drawn by the same `TugCommitAtom`, under a menu built from the
same registry entry, selects itself whole in the transcript's prose and selects
eight hex characters two inches above it in a receipt header. That is the thing
that must stop: not this one bug, the *shape* that let one surface learn the
rule and three not.

## The rule

> **A press that opens a menu about an entity selects that entity — whole —
> and paints it. Not the surface's choice, not a parameter a call site may
> omit: the press cannot open the menu without doing it.**

`useTextSurfaceContextMenu` already implements the rule correctly. It just owns
it privately, and it takes it as an option rather than as a consequence.

## What is already true, and needs no building

- **`settleWholeEntitySelection`** (`use-text-surface-context-menu.tsx:392`) is
  the whole behaviour: pre-click snapshot, keep a user selection that reaches
  past the element, otherwise select the node whole and
  `paintEntitySelected` it. It is a module-scope function taking
  `(element, preClick)` — nothing about it is bound to that hook.
- **`lib/entity-selection-paint.ts`** is already global and self-retiring: one
  mark at a time, cleared by `selectionchange`. Any caller may use it.
- **The paint already covers the commit pill.** `tug-annotation.css:175` keys on
  `.tug-session-identity[data-tier="chip"]`, and `TugCommitAtom` renders exactly
  that class and tier (`tug-commit-atom.tsx:154`). The receipt's pill would have
  painted correctly the whole time. Nobody ever told it it was selected.

So this is a **move and a compose**, not a feature. No new CSS, no new registry
entry, no new law — an amendment to one that already reads almost right.

## The shape

`lib/whole-entity-press.ts` — the press, extracted whole:

```ts
/** Bind to the element that IS the entity; returns the two native handlers. */
export function useWholeEntityPress(
  entity: () => HTMLElement | null,
): { attach: (host: HTMLElement | null) => void };
```

Two halves, and **the mousedown half is not optional**: WebKit smart-selects
inside `sendContextMenuEvent`, ahead of the `contextmenu` event we receive, so
by the time the menu opens the user's own selection is already gone. The
snapshot has to be taken on mousedown or the "a selection reaching past the
entity stays theirs" clause cannot be honoured. None of the three bespoke hooks
wires a mousedown today.

**The primitive attaches native listeners on the host element, not React props**
— and that is load-bearing, not fastidiousness. `CommitShaText` stops React
propagation for `onMouseDown`, `onMouseUp`, `onClick` and `onPointerDown` so a
gesture on a hash can't fold the History row out from under its own menu. A
React `onMouseDown` on the claiming ancestor would therefore never fire. Native
listeners on that ancestor *do* fire, because React 18 dispatches from the root
container — the native event has already bubbled past the ancestor by the time
React's synthetic `stopPropagation` runs. **The arc must prove this with a test
rather than trust the paragraph**; if it does not hold, the fallback is to move
the claim down onto the atom itself.

Then: `useTextSurfaceContextMenu` composes the primitive instead of housing it
(behaviour unchanged, `wholeEntityTarget` stays its way of naming the element),
and the three bespoke hooks each gain one line naming their entity element.

## What the press names

The one question. `useCommitIdentityMenu` is claimed by different elements on
different surfaces: in the receipt it is the atom's own wrapper
(`.commit-receipt-sha` — the block deliberately claims the atom alone and
leaves the subject beside it to the standard editing block), but a History row
claims the **whole row**, message and file roster included.

Selecting a whole History row on a right-click is not what anyone wants. So the
**entity element is named separately from the claim element**: a caller says
what the menu is *about*, which may be narrower than what it claimed. For a
History row that is the commit atom in its identity line — press the subject,
press the stamp, press a file, and the atom lights up, because the atom is the
commit's visible name and the commit is what all four items act on.

**Recommendation: ship that.** A highlight that names the entity from anywhere
on the row is honest about the menu; the alternative — no highlight at all
where the press missed the atom — is the state we are fixing. Say so and the
arc proceeds.

## Steps

1. Extract `lib/whole-entity-press.ts` from `use-text-surface-context-menu.tsx`;
   that hook composes it. No behaviour change — at0346 stays green untouched.
2. Compose it in `useCommitIdentityMenu` (entity: the row's commit atom),
   `useSessionIdentityMenu` (the identity chip), `useCopyableText` (the copyable
   itself; a `user-select: none` copyable settles to nothing and takes no paint,
   which the primitive must handle rather than assume away).
3. Extend at0346 into a table over all four paths, asserting the same two facts
   per surface: the DOM selection is the entity's whole text, and the entity
   carries `data-tug-entity-selected`. One test, parameterized — a per-surface
   test file is how the next copy drifts.
4. Guard the shape: a unit test over `tugdeck/src` requiring that any module
   importing `TugEditorContextMenu` and opening on a `contextmenu` also imports
   `whole-entity-press`. Crude, and it is the only mechanical thing standing
   between us and a fifth path.
5. Amend [menus.md](../tuglaws/menus.md) — "A secondary click selects the whole
   entity" currently reads as a fact about `useTextSurfaceContextMenu`. Restate
   it as the rule above, and name the primitive as where it lives.
