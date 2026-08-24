# Errata — Retroactive Fixes

*Issues noted during ongoing work that need cleanup. Each item is independent — fix in any order, ideally before or during the next group build.*

---

## E01: Stale petals/pole CSS in gallery.css

**File:** `tugdeck/src/components/tugways/cards/gallery.css` (lines 487+)

**Issue:** `.tug-petals` and related keyframes (`tug-petals-rotate`, `tug-petals-fade`, `tug-petals-scale`) are legacy decorative CSS from an earlier gallery iteration. No component references them. Dead code.

**Fix:** Delete the `.tug-petals` block and associated keyframes from gallery.css.

**Noted:** Prior session (Group B work).

---

## E02: Duplicate --tugx-tooltip-* aliases in tug-menu.css

**File:** `tugdeck/src/components/tugways/tug-menu.css` (lines 79-81)

**Issue:** Three `--tugx-tooltip-*` aliases are defined in `tug-menu.css`:
```css
--tugx-tooltip-bg: var(--tug7-surface-global-primary-normal-screen-rest);
--tugx-tooltip-fg: var(--tug7-element-global-text-normal-default-rest);
--tugx-tooltip-border: var(--tug7-element-global-border-normal-default-rest);
```

These duplicate the authoritative definitions in `tug-tooltip.css` (lines 21-27), which owns the full set of seven `--tugx-tooltip-*` aliases. The menu file should not define tooltip aliases — it violates token sovereignty [L20].

**Fix:** Remove the three `--tugx-tooltip-*` lines from tug-menu.css. Verify no menu CSS rule references them (they shouldn't — menu uses `--tugx-menu-*`).

**Noted:** Group B tooltip dash.

---

## E03: sendToTarget should forward to nextResponder when target doesn't handle action

**Files:** `tugdeck/src/components/tugways/responder-chain.ts` (lines 256-266), `tugdeck/src/components/tugways/internal/tug-button.tsx` (lines 314-322)

**Issue:** When a button/component specifies an explicit target for an action via `sendToTarget()`, and that target is registered but does not handle the action (i.e., the action key is not in its actions map), the current implementation returns `false` and stops. TugButton then logs a dev-mode warning. No chain walking occurs.

This is incorrect per UIKit's responder chain model. In UIKit, when a control sends an action to a specific target and that target does not handle it, the action is forwarded up the responder chain starting from the target's `nextResponder`. A direct target is a *preferred* first stop, not a hard boundary — the chain is still the fallback. Only when no responder in the chain handles the action does dispatch truly fail.

Our current behavior treats an explicit target as a dead end: if the target can't handle the action, dispatch fails silently. This means a component can't set a target for "try this responder first" semantics — it's all-or-nothing.

**Fix:** Modify `sendToTarget()` so that when the named target does not handle the action, it walks up from the target's `parentId` (our equivalent of `nextResponder`) using the same chain-walk logic as `sendToFirstResponder()`. Return `false` only if no responder from the target upward handles the action. Update the TugButton warning accordingly — a `false` return would then mean no responder in the chain from the target upward could handle the action, not just that the target itself couldn't.

Update tests in `tugdeck/src/__tests__/responder-chain.test.ts` to cover the new forwarding behavior.

**Reference:** [Apple — Using Responders and the Responder Chain to Handle Events](https://developer.apple.com/documentation/uikit/using-responders-and-the-responder-chain-to-handle-events)

**Noted:** Current session review of responder chain implementation.

---

## E04: Rename `parentId` to `nextResponder` on ResponderNode

**Files:** `tugdeck/src/components/tugways/responder-chain.ts`, `tugdeck/src/components/tugways/use-responder.tsx`, `tugdeck/src/__tests__/responder-chain.test.ts`, `tugdeck/src/__tests__/e2e-responder-chain.test.tsx`

**Issue:** The `ResponderNode` type uses `parentId` for the field that points to the next node in the responder chain. This name leaks the implementation mechanism (React component tree parentage) into what is a domain concept (responder chain traversal). The field's job is to answer "who handles this next if I can't?" — that's `nextResponder`, the same name UIKit has used since the beginning. Our responder chain is explicitly modeled on UIKit; using a different name for the same concept adds unnecessary cognitive friction.

Note: `ResponderParentContext` in `use-responder.tsx` can keep its name — it *is* describing the React parent relationship. But once that value lands on the `ResponderNode`, it becomes the node's `nextResponder`.

**Fix:** Rename the `parentId` field to `nextResponder` on `ResponderNode` and update all references across the implementation and tests. Update the doc comment on `ResponderNode` to clarify the semantics.

**Noted:** Current session review of responder chain implementation.

---

## E05: TugPushButton should support stable minimum width to prevent layout jumps

**Component:** `tugdeck/src/components/tugways/tug-push-button.tsx`

**Issue:** When a button's label changes (e.g., "Start Stream" → "Stop"), the button resizes to fit the new text, causing a layout jump that shifts adjacent elements. This is a common problem with toggle-style buttons where the two labels have different widths.

**Design idea:** TugPushButton should support a mechanism to size itself to the widest of its possible labels. Options:
- A `minWidth` prop that the caller sets explicitly.
- A `labels` prop (array of strings) — the button measures all labels at mount and sets `min-width` to the widest. The visible label is controlled separately.
- An invisible "shadow" span containing the longest label, with the button's min-width derived from it.

The current workaround (wrapping in a `<div style={{ minWidth }}>`) works but is a layout hack that belongs in the component itself.

**Fix:** Design and implement a proper solution in TugPushButton. Consider which approach best fits the component authoring guide [L19] and token system [L15].

**Noted:** Phase 3A.5 gallery card rework — streaming Start/Stop button layout jump.
