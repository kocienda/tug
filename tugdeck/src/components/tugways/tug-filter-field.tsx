/**
 * TugFilterField — the filter affordance for a long list.
 *
 * A small text field that trims the list beside it: every keystroke narrows,
 * the ✕ (or Escape) restores. It is a *trimming* control, not a search box —
 * it never jumps to a result, it only removes what the user is plainly not
 * looking for. Pair it with a list whose data source applies
 * `filterQueryMatch` to the query it reports.
 *
 * ## The delegate
 *
 * Behavior flows through a {@link TugFilterFieldDelegate}, the house delegate
 * shape (`tuglaws/lifecycle-delegates.md`): one object, optional methods are
 * no-ops, the field fires each moment unconditionally.
 * `filterFieldDidChangeQuery` is REQUIRED — a filter field with no change
 * consumer means nothing. Calls are synchronous; a keystroke filter has none
 * of the timing hazards the card-lifecycle drain queue exists to solve.
 *
 * Two sanctioned wirings, both in the tree today:
 *  - **React-state adapter** — the host holds the query in `useState` and its
 *    delegate's `filterFieldDidChangeQuery` calls the setter, which flows back
 *    into the list's data source as an input (the session picker, `/resume`).
 *  - **Module-store adapter** — the field and the list are siblings that
 *    cannot see each other, so the delegate writes a module store the list
 *    body reads through `useSyncExternalStore` (the rail cards, via
 *    `attached-filter.ts`).
 *
 * ## Nothing to filter
 *
 * `disabled` is for a list that is EMPTY, not one that has been filtered empty
 * — see the prop. The distinction is the whole safety of the feature: the
 * filtered-to-zero state is the one where the field is the only way back, so it
 * must stay live there, while a list with no items at all has no query worth
 * offering. A disabled field goes gray, refuses the caret, and registers no
 * focus stop, so the Tab walk passes a dead control by.
 *
 * ## Value authority and resets
 *
 * The `<input>` is uncontrolled: the DOM owns the text, `defaultValue` seeds
 * it, and the ✕'s visibility is a `data-empty` attribute flipped in the input
 * handler — no React state, no re-render per keystroke ([L06]). Reset the
 * field from outside by remounting it with a React `key` (the picker keys its
 * field on the project path).
 *
 * ## Escape, and why it is not a `stopPropagation`
 *
 * Escape must clear a non-empty filter *without* dismissing the sheet or
 * section around it, and must fall through to that surface's own ladder when
 * the field is already empty. Two arbiters decide Escape before a React
 * handler ever runs, so the field declines/claims at both:
 *
 *  - In a **focus mode** (a sheet, a trapped surface) the engine's Escape
 *    ladder runs first. Its first rung is the key view's `captures`
 *    predicate — so the field declares, live, that it captures `Escape` while
 *    its query is non-empty. The ladder yields and the field's own keydown
 *    clears it.
 *  - In the **base focus mode** (the rail) a bare Escape resolves through the
 *    static keybinding map to `CANCEL_DIALOG` and dispatches into the
 *    responder chain. The field registers a `CANCEL_DIALOG` handler that
 *    exists *only while the query is non-empty* (an accessor on the actions
 *    map, which the chain reads live per dispatch) — so an empty field is not
 *    a handler at all and the walk continues to the surface above.
 *
 * Both paths read the same DOM value, so there is one source of truth for
 * "is there a filter to clear".
 *
 * Laws: [L06] appearance via DOM attributes + CSS, never React state;
 *       [L03] responder registration in a layout effect (via `useResponder`);
 *       [L11] the ✕ is a control that emits, the field handles;
 *       [L17]/[L20] one-hop component-tier aliases, composed children keep
 *       their own tokens; [L19] file pair + `data-slot`.
 *
 * @module components/tugways/tug-filter-field
 */

import "./tug-filter-field.css";

import React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { TUG_ACTIONS } from "./action-vocabulary";
import type { AttachedFilterBinding } from "./attached-filter";
import { ATTACHED_LIST_ATTRIBUTE } from "./focus-manager";
import type { FocusPolicy, KeyViewBehavior } from "./focus-manager";
import { TugIconButton } from "./tug-icon-button";
import { TugInput, type TugInputSize } from "./tug-input";
import { useResponderChain } from "./responder-chain-provider";
import { useOptionalResponder } from "./use-responder";

/**
 * What a {@link TugFilterField} tells its host. Only
 * `filterFieldDidChangeQuery` is required; every other moment is optional and
 * a no-op when unimplemented.
 */
export interface TugFilterFieldDelegate {
  /** REQUIRED. Every input change, and `""` on a clear. */
  filterFieldDidChangeQuery(query: string): void;
  /** The ✕ or Escape-on-non-empty, AFTER the `""` change notification. */
  filterFieldDidClear?(): void;
  /**
   * Enter in the field. Unimplemented, Enter defers to the surface's
   * pane-scoped default button instead — a filter with no submit of its own
   * must not swallow the Return its surface's ringed default promises.
   */
  filterFieldDidSubmit?(query: string): void;
  /**
   * ArrowDown — the host moves the key view onto its list, leaving the field.
   *
   * Superseded by {@link attachedListMoveCursor} for any list with a row cursor
   * to drive, and consulted only when that is absent. One consumer remains:
   * the session-history view renders a `TugHistoryList`, a plain mapped list
   * with no cursor model and no per-row focus stops, so there is nothing to
   * cursor and handing the key view to the list container is the right and only
   * behavior there. Reach for the attached-list contract first; this is the
   * fallback for a list that cannot answer it.
   */
  filterFieldDidRequestAdvance?(): void;
  /**
   * Move the cursor of the list this field is attached to ([P08], Spec S02).
   *
   * Implementing it declares the **attached-list contract**: while the caret is
   * in this field, ↑/↓ drive that list's cursor and never leave the field — in
   * both KBF modes, and regardless of whether the query is empty. The field
   * stamps `data-tug-attached-list` on its wrapper so the document's arrow
   * stages yield, and calls this instead.
   *
   * Return `false` when there is nothing to move to (an empty list, an edge the
   * list does not wrap): the key then falls through to the caret, which is what
   * an arrow means in a text field with no list to drive.
   *
   * Commit stays the field's own ([Q01]) — this contract carries cursor
   * movement only, and what Return does at the cursored row is per-site.
   */
  attachedListMoveCursor?(direction: "up" | "down"): boolean;
  /**
   * The caret has left the field, so the attached list's highlight is no longer
   * anybody's statement about anything — drop it. Paired with
   * {@link attachedListMoveCursor}; a site spreading an
   * `AttachedFilterBinding`'s `delegate` gets both.
   */
  attachedListDidRelease?(): void;
  /** Escape while already empty — the host may yield focus up its ladder. */
  filterFieldDidRequestDismiss?(): void;
}

export interface TugFilterFieldProps {
  /** The behavior contract. See {@link TugFilterFieldDelegate}. */
  delegate: TugFilterFieldDelegate;
  /**
   * The pairing with the list this field trims ([P08]) — the same binding the
   * list receives as `attachedFilter`. Passing it publishes this field as the
   * list's deputy text stop, so a character typed with the ring on the list
   * lands here. See `attached-filter.ts`.
   *
   * The downward half (↑/↓ from the caret drive the list) still rides the
   * delegate; `useAttachedFilter().delegate` supplies it.
   */
  attachment?: AttachedFilterBinding;
  /** Placeholder text — the house form is `Filter <section>`. */
  placeholder: string;
  /** Initial text. The field is uncontrolled; reset it by `key` remount. */
  defaultValue?: string;
  /**
   * Fill the row instead of taking the standard width
   * (`--tugx-filter-field-width`). For a field that IS its row — a sheet's
   * lead control, a narrow inspector column — where a short box would strand
   * itself against the surface's edge. A field riding a section band never
   * fills: it shares that line with a title and a chevron.
   * @default false
   */
  fill?: boolean;
  /**
   * Field size, forwarded to `TugInput`.
   * @default "sm"
   */
  size?: TugInputSize;
  /**
   * Inert: there is nothing to filter. A list with no items at all makes its
   * filter a control with no work to do, so the field goes gray and drops out
   * of the Tab walk (`TugInput` declines to register a disabled stop) rather
   * than standing there inviting a query that could only ever return nothing.
   *
   * This is the UNFILTERED emptiness, never the filtered one: a query that
   * matches nothing must leave the field live, or it disables itself the
   * instant it succeeds at narrowing and the user cannot clear it ([R02]).
   * @default false
   */
  disabled?: boolean;
  /** Author the field into a focus group ([P02]); forwarded to `TugInput`. */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
  /** Walk policy for the registered stop. */
  focusPolicy?: FocusPolicy;
  /** Accessible name for the field. Defaults to the placeholder. */
  "aria-label"?: string;
  /** Test hook on the wrapper. */
  "data-testid"?: string;
  /** Additional class names on the wrapper. */
  className?: string;
}

/**
 * A list's filter field. See the module docstring for the delegate contract,
 * the value-authority model, and the two Escape arbiters.
 */
export function TugFilterField({
  delegate,
  attachment,
  placeholder,
  defaultValue,
  fill = false,
  size = "sm",
  disabled = false,
  focusGroup,
  focusOrder,
  focusPolicy,
  "aria-label": ariaLabel,
  "data-testid": dataTestid,
  className,
}: TugFilterFieldProps): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  // WebKit collapses a programmatic `select()` on the mouseup that ends the
  // focusing click; one guarded `preventDefault` keeps the selection.
  const pendingFocusClickRef = React.useRef(false);

  // The delegate is read at call time, never captured, so a host may pass a
  // fresh object each render without stale notifications.
  const delegateRef = React.useRef(delegate);
  delegateRef.current = delegate;

  const currentQuery = React.useCallback(
    (): string => inputRef.current?.value ?? "",
    [],
  );

  /** Reflect emptiness onto the wrapper so CSS reveals the ✕ ([L06]). */
  const syncEmptyAttribute = React.useCallback((): void => {
    wrapperRef.current?.setAttribute(
      "data-empty",
      currentQuery() === "" ? "true" : "false",
    );
  }, [currentQuery]);

  const clear = React.useCallback((): void => {
    const input = inputRef.current;
    if (input === null) return;
    input.value = "";
    syncEmptyAttribute();
    delegateRef.current.filterFieldDidChangeQuery("");
    delegateRef.current.filterFieldDidClear?.();
    input.focus();
  }, [syncEmptyAttribute]);

  // Chain rung: a bare Escape in the base focus mode arrives here as
  // CANCEL_DIALOG. The handler is an accessor so an EMPTY field exposes no
  // handler at all and the walk continues to the surface above — the chain
  // reads the actions map live on every dispatch, so this needs no re-render.
  const responderId = React.useId();
  const actions = React.useMemo(
    () => ({
      get [TUG_ACTIONS.CANCEL_DIALOG](): (() => void) | undefined {
        return currentQuery() === "" ? undefined : clear;
      },
    }),
    [clear, currentQuery],
  );
  const { ResponderScope, responderRef } = useOptionalResponder({
    id: responderId,
    actions,
  });

  // Engine rung: while the query is non-empty the field owns Escape, so the
  // Escape ladder yields instead of dismissing the surrounding surface.
  const focusBehavior = React.useCallback(
    (): KeyViewBehavior => ({
      container: "none",
      captures: (key) => key.key === "Escape" && currentQuery() !== "",
    }),
    [currentQuery],
  );

  const onChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      syncEmptyAttribute();
      delegateRef.current.filterFieldDidChangeQuery(event.target.value);
    },
    [syncEmptyAttribute],
  );

  // ---- The shadowed half of the attached-list contract ([P08]) ----
  //
  // The list writes the query through these while KEEPING the keyboard —
  // type-select, not a focus handoff. Each mutator drives the field's own
  // value + change notification, the same path `onChange` takes, so a
  // forwarded character and a typed one are indistinguishable downstream and
  // the `<input>` stays the single value authority.
  //
  // Published in a layout effect so the field is writable before any key can
  // arrive ([L03]).
  const writeQuery = React.useCallback(
    (next: string): void => {
      const input = inputRef.current;
      if (input === null) return;
      input.value = next;
      syncEmptyAttribute();
      delegateRef.current.filterFieldDidChangeQuery(next);
    },
    [syncEmptyAttribute],
  );
  React.useLayoutEffect(() => {
    if (attachment === undefined) return;
    return attachment.publishField({
      hasQuery: () => currentQuery() !== "",
      appendChar: (ch) => {
        writeQuery(currentQuery() + ch);
      },
      deleteBackward: () => {
        const query = currentQuery();
        if (query === "") return false;
        writeQuery(query.slice(0, -1));
        return true;
      },
      clearQuery: () => {
        if (currentQuery() === "") return false;
        writeQuery("");
        delegateRef.current.filterFieldDidClear?.();
        return true;
      },
    });
  }, [attachment, currentQuery, writeQuery]);

  const onFocus = React.useCallback((): void => {
    inputRef.current?.select();
  }, []);

  // The attached list's highlight belongs to this caret ([P08]); when the caret
  // goes, so does the highlight — otherwise a list left behind keeps marking a
  // row nothing is about to act on.
  const onBlur = React.useCallback((): void => {
    delegateRef.current.attachedListDidRelease?.();
  }, []);

  const onMouseDown = React.useCallback((): void => {
    pendingFocusClickRef.current =
      document.activeElement !== inputRef.current;
  }, []);

  const onMouseUp = React.useCallback((event: React.MouseEvent): void => {
    if (!pendingFocusClickRef.current) return;
    pendingFocusClickRef.current = false;
    event.preventDefault();
  }, []);

  // Default-button defer, the same contract `TugTextEditor` keeps
  // (`deferToDefaultButton`): a field is a text surface, so the bubble
  // pipeline's Enter stage skips it outright (`skipActivation` on an INPUT) and
  // this handler's `stopPropagation` would keep it away regardless. A filter
  // field that declares no `filterFieldDidSubmit` has nothing of its own to do
  // with Return — so it must hand Return to the surface's default button rather
  // than eat it, or the ring on that button is a promise nothing keeps (the
  // History shade's Done: ringed, and Return did nothing).
  //
  // Pane-scoped for the same reason the editor scopes it: the default-button
  // stack is process-global, and a Return here must never press a button
  // registered by a sheet in ANOTHER pane ([D15] pane modality). No pane
  // context (gallery / standalone) falls back to the global top.
  const responderChainManager = useResponderChain();
  const peekDefaultButton = React.useCallback((): HTMLButtonElement | null => {
    if (responderChainManager === null) return null;
    const pane = wrapperRef.current?.closest(".tug-pane") ?? null;
    return pane !== null
      ? responderChainManager.peekDefaultButtonInScope(pane)
      : responderChainManager.peekDefaultButton();
  }, [responderChainManager]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        if (currentQuery() !== "") {
          event.preventDefault();
          event.stopPropagation();
          clear();
          return;
        }
        delegateRef.current.filterFieldDidRequestDismiss?.();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (delegateRef.current.filterFieldDidSubmit !== undefined) {
          delegateRef.current.filterFieldDidSubmit(currentQuery());
          return;
        }
        peekDefaultButton()?.click();
        return;
      }
      // The attached list ([P08]): ↑/↓ drive its cursor and stay in the field.
      // Unconditional on emptiness — that is the whole point of the contract,
      // and the reason the field can stop leaning on an ambient release rule.
      // A `false` return means the list had nowhere to go, so the key falls
      // through to the caret.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const move = delegateRef.current.attachedListMoveCursor;
        if (move !== undefined) {
          const moved = move(event.key === "ArrowDown" ? "down" : "up");
          if (moved) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
      }
      if (event.key === "ArrowDown") {
        if (delegateRef.current.filterFieldDidRequestAdvance === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        delegateRef.current.filterFieldDidRequestAdvance();
      }
    },
    [clear, currentQuery, peekDefaultButton],
  );

  const setWrapperRef = React.useCallback(
    (el: HTMLDivElement | null): void => {
      wrapperRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );

  return (
    <div
      ref={setWrapperRef}
      data-slot="tug-filter-field"
      data-empty={defaultValue === undefined || defaultValue === "" ? "true" : "false"}
      data-fill={fill ? "true" : undefined}
      // Declares the attached-list contract to the document arrow stages, which
      // test containment from the focused input ([P08], Spec S02).
      {...(delegate.attachedListMoveCursor !== undefined
        ? { [ATTACHED_LIST_ATTRIBUTE]: "" }
        : {})}
      data-testid={dataTestid}
      className={cn("tug-filter-field", className)}
    >
      <ResponderScope>
        <TugInput
          ref={inputRef}
          type="text"
          size={size}
          disabled={disabled}
          className="tug-filter-field-input"
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          defaultValue={defaultValue}
          spellCheck={false}
          autoComplete="off"
          focusGroup={focusGroup}
          focusOrder={focusOrder}
          focusPolicy={focusPolicy}
          focusBehavior={focusBehavior}
          onChange={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onKeyDown={onKeyDown}
        />
        <span className="tug-filter-field-clear">
          <TugIconButton
            icon={<X />}
            aria-label="Clear filter"
            size="2xs"
            disabled={disabled}
            onClick={clear}
          />
        </span>
      </ResponderScope>
    </div>
  );
}
