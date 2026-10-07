/**
 * TugComboBox — a text field that is also a menu.
 *
 * A controlled input with a floating result list (the `tug-completion-menu`
 * look, portaled into the canvas overlay tier so it's never clipped and
 * reserves no layout space). The list is fed by two providers the caller
 * supplies:
 *
 *   - `seed(query)` — a synchronous source (the combo box's own item set,
 *     e.g. recent paths). Filtered + rendered by the caller; shown in full on
 *     a menu-mode open with an empty query. This is the "seed data" that makes
 *     the field behave like a dropdown menu.
 *   - `asyncItems(query)` — an optional asynchronous source (e.g. filesystem
 *     completion) whose results are **merged below** the seed items, de-duped
 *     by `value`. Debounced.
 *
 * Interaction model (mirrors the prompt-entry `@`-mention menu):
 *   - typing filters the seed + fetches `asyncItems` (debounced) and opens the
 *     list when there are matches;
 *   - in `menuMode`, a pointer click, the chevron, or ArrowDown on the closed
 *     field opens the list as a menu (showing the seed for the current query,
 *     empty query = all) — this is what makes it a *combo box* rather than a
 *     plain completing field;
 *   - ↑/↓ move the highlight, the mouse follows it (single highlight);
 *   - Enter accepts the highlighted item AND closes; Tab accepts, and a
 *     `descendable` item (a directory) stays open on its children so the user
 *     can keep navigating;
 *   - Escape closes the list (and only the list — it stops there);
 *   - Enter with the list closed calls `onSubmit` (the consumer's commit).
 *
 * `onChange` reports every value the input passes through; `onSettle` reports
 * the ones it comes to *rest* on. A consumer whose value is durable writes on
 * `onSettle` — see its doc.
 *
 * A caller-supplied `accessory` slots a trailing control beside the field (the
 * "escape hatch" — e.g. a native folder picker button). Each item may carry a
 * `trailing` accessory (e.g. a per-row delete), whose clicks neither commit the
 * row nor blur the field.
 *
 * Compositional component — composes `TugInput`; its overlay borrows
 * `tug-completion-menu.css`. Laws: [L02] (n/a — local UI state), [L06]
 * appearance via CSS, [L20] composed children keep their own tokens.
 *
 * @module components/tugways/tug-combo-box
 */

import "./tug-completion-menu.css";
import "./tug-combo-box.css";

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

import { TugInput } from "./tug-input";
import { useFocusable, useFocusManager } from "./use-focusable";
import { ATTACHED_LIST_ATTRIBUTE, TAB_CONSUME_ATTRIBUTE } from "./focus-manager";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { layoutRectOf } from "@/lib/page-zoom-store";

/** One combo-box row: what to commit, how to render it, and how it behaves. */
export interface TugComboBoxItem {
  /** The value committed when this item is chosen (and set into the input). */
  readonly value: string;
  /** Display node for the row's primary label. */
  readonly label: React.ReactNode;
  /**
   * When true, accepting the item *descends* (sets the value and keeps the
   * list open on the newly-fetched children) instead of committing + closing.
   * The filesystem preset sets this for directories.
   */
  readonly descendable?: boolean;
  /** Optional trailing accessory (e.g. a delete button). Never commits the row. */
  readonly trailing?: React.ReactNode;
  /**
   * Keyboard removal for this row: invoked when the row is highlighted and the
   * user presses Shift+Delete (the browser-autofill convention). Wire it to the
   * same remove flow as the {@link trailing} delete button so mouse and keyboard
   * agree. Omit for rows that can't be removed.
   */
  readonly onRemove?: () => void;
  /** Extra `data-*` attributes spread onto the row `<li>` (styling hooks). */
  readonly rowData?: Record<string, string | undefined>;
}

/** Props for {@link TugComboBox}. */
export interface TugComboBoxProps {
  /** Controlled input value. */
  value: string;
  /** Called when the value changes — typing, accepting an item, or a descend. */
  onChange: (value: string) => void;
  /**
   * Synchronous seed source, called with the current input value. The caller
   * filters + renders (labels, highlights, per-row trailing). In `menuMode` an
   * empty query should return the full seed so the field opens like a menu.
   */
  seed?: (query: string) => TugComboBoxItem[];
  /**
   * Asynchronous source merged *below* the seed items (de-duped by `value`),
   * debounced. Absent ⇒ the seed is the only source.
   */
  asyncItems?: (query: string) => Promise<TugComboBoxItem[]>;
  /**
   * Enable dropdown-menu affordances: a pointer click, the trailing chevron,
   * or ArrowDown on the closed field opens the list showing the seed. Off ⇒ the
   * list opens only as a result of typing (a plain completing field).
   */
  menuMode?: boolean;
  /** Trailing "escape" control beside the field (e.g. a Browse button). */
  accessory?: React.ReactNode;
  /** Leading control beside the field, rendered before the input (e.g. a Browse button). */
  leadingAccessory?: React.ReactNode;
  /**
   * Normalize the resting value when the list closes (e.g. strip a directory's
   * trailing slash). Applied only on the open→closed transition.
   */
  normalizeOnClose?: (value: string) => string;
  /** Fired on Enter when the list is closed — the consumer's commit. */
  onSubmit?: () => void;
  /**
   * Fired with the resting value every time the field comes to rest — an item
   * accepted (by Enter, Tab, or click), Enter on the closed list, or focus
   * leaving. The value has already been through {@link normalizeOnClose}.
   *
   * This is the callback for a field whose value IS something durable (a
   * setting, a stored path): typing is an in-flight edit, and `onSettle` is
   * where that edit stops being in-flight and has to be written. Without it a
   * consumer has to guess which of `onChange`'s many reasons ended the edit,
   * and a finished-looking field can hold a value nothing ever stored.
   *
   * A descend does not settle — the user is still navigating. May fire more
   * than once for the same resting value (accept then blur), so consumers must
   * be idempotent.
   */
  onSettle?: (value: string) => void;
  /** Fired when the list opens / closes. */
  onOpenChange?: (open: boolean) => void;
  placeholder?: string;
  "aria-label"?: string;
  /** Input + accessory size. Defaults to `sm`. */
  size?: "sm" | "md" | "lg";
  autoFocus?: boolean;
  className?: string;
  /** Extra class on the `<input>` (e.g. a monospace family for paths). */
  inputClassName?: string;
  /** `data-slot` on the overlay `<ul>` (a per-consumer styling hook). */
  overlaySlot?: string;
  /**
   * Where the dropdown portals. Absent ⇒ the canvas overlay root, which is
   * right for a combo box on a pane or an ordinary sheet.
   *
   * A host inside an app-modal Radix surface names its own content element
   * instead: a modal `Dialog.Content` sets `pointer-events: none` on the body
   * and restores it only on registered dismissable layers, so a dropdown in
   * the canvas overlay root would render but be unclickable. The container
   * must not be a containing block for `position: fixed` (no transform,
   * filter, or `contain: paint`) — the dropdown positions against the
   * viewport.
   */
  portalContainer?: HTMLElement | null;
  disabled?: boolean;
  spellCheck?: boolean;
  /**
   * Author the field into a focus group ([P02]) — the standard `useFocusable`
   * opt-in. The focusable IS the `<input>` caret. The field consumes Tab only
   * while its list is open (Tab then accepts the highlight); closed, Tab leaves.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0. */
  focusOrder?: number;
  /**
   * Author the menu-mode chevron into {@link focusGroup} as its own focus stop
   * ([P02]), at this order. Omitted ⇒ the chevron stays a pointer-only
   * affordance outside the walk — which reads as "Tab skips it", so a host
   * that authors the field should author the chevron too. Only honored when
   * {@link focusGroup} is also set and {@link menuMode} renders the chevron.
   */
  chevronFocusOrder?: number;
}

const DEBOUNCE_MS = 120;

/**
 * A text field that is also a menu. See the module doc for the full
 * interaction model.
 */
export const TugComboBox = React.forwardRef<HTMLInputElement, TugComboBoxProps>(
  function TugComboBox(
    {
      value,
      onChange,
      seed,
      asyncItems,
      menuMode = false,
      accessory,
      leadingAccessory,
      normalizeOnClose,
      onSubmit,
      onSettle,
      onOpenChange,
      placeholder,
      "aria-label": ariaLabel,
      size = "sm",
      autoFocus,
      className,
      inputClassName,
      overlaySlot,
      portalContainer,
      disabled,
      spellCheck = false,
      focusGroup,
      focusOrder = 0,
      chevronFocusOrder,
    },
    forwardedRef,
  ) {
    const [asyncList, setAsyncList] = useState<readonly TugComboBoxItem[]>([]);
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
    // Bumped to force an `asyncItems` refetch when the value itself hasn't
    // changed (a menu-mode open on an unchanged query).
    const [fetchNonce, setFetchNonce] = useState(0);
    // True from a menu-mode open until the user next types: the seed shows its
    // FULL set (queried with "") so the field opens like a menu even when it
    // already holds a value — "click it open to browse everything". Typing
    // flips it off so the seed filters by what's typed.
    const [menuShowAll, setMenuShowAll] = useState(false);

    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLUListElement | null>(null);
    const focusedRef = useRef(false);
    // The list opens only as a result of a user gesture (typing, a menu-mode
    // open, or a descend) — never on a programmatic value/focus change. Without
    // this a pre-filled field (e.g. the session picker's seeded path) would pop
    // the list on mount, before the input is positioned, rendering it adrift.
    const armedRef = useRef(false);
    // Bumped per fetch so a slow earlier response can't overwrite a newer one.
    const reqSeqRef = useRef(0);

    const canvasOverlay = useCanvasOverlay();
    const overlayRoot = portalContainer ?? canvasOverlay;

    // The seed for the current query (caller renders it), merged with the
    // async results below it, de-duped by value.
    const seedItems = useMemo<readonly TugComboBoxItem[]>(
      () => (seed !== undefined ? seed(menuShowAll ? "" : value) : []),
      [seed, value, menuShowAll],
    );
    const items = useMemo<readonly TugComboBoxItem[]>(() => {
      if (asyncList.length === 0) return seedItems;
      const seen = new Set(seedItems.map((i) => i.value));
      return [...seedItems, ...asyncList.filter((i) => !seen.has(i.value))];
    }, [seedItems, asyncList]);
    const itemsRef = useRef(items);
    itemsRef.current = items;
    // Signature of the current item SET (its values). The highlight resets only
    // when this changes — an add/remove/reorder/filter — not on every rebuild
    // (e.g. a row re-rendering to mark itself pending-delete keeps its values,
    // so the highlight stays put on the row being acted on).
    const itemsKey = useMemo(() => items.map((i) => i.value).join("\x00"), [items]);

    // Standard focus-stop opt-in ([P02]). The focusable is the `<input>`, so
    // the engine lands the key view on the real caret. The field owns Tab iff
    // its list is open (Tab then accepts the highlighted item).
    const focusableId = useId();
    const { focusableRef } = useFocusable({
      id: focusableId,
      group: focusGroup ?? "",
      order: focusOrder,
      register: focusGroup !== undefined,
      consumesTab: () => open,
    });

    // The chevron as its own stop, when the host authors it. A bare-native
    // leaf: the engine lands the key view on the button and delivers Return /
    // Space as a synthesized click, which the chevron's keyboard `onClick`
    // below answers.
    const chevronFocusableId = useId();
    const { focusableRef: chevronFocusableRef } = useFocusable({
      id: chevronFocusableId,
      group: focusGroup ?? "",
      order: chevronFocusOrder ?? 0,
      register:
        focusGroup !== undefined && chevronFocusOrder !== undefined && menuMode,
    });

    // Promote this field to the engine key view on a pointer press. The
    // document-level pointer promotion ([placeFromPointer]) resolves the target
    // card via `closest([data-card-id])` and bails when the click lands in a
    // sheet portaled OUTSIDE the card subtree (the session picker) — so without
    // this, clicking the field takes DOM focus while the ring stays on whatever
    // the engine last placed (e.g. the sessions list), splitting focus across two
    // elements. Placing by our own registered id needs no card ancestor.
    const focusManager = useFocusManager();
    const promoteSelf = useCallback(() => {
      if (focusGroup === undefined) return;
      focusManager?.place(null, { kind: "focusable", id: focusableId }, { modality: "pointer" });
    }, [focusManager, focusGroup, focusableId]);

    const setInputRef = useCallback(
      (el: HTMLInputElement | null) => {
        inputRef.current = el;
        focusableRef(el);
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      },
      [forwardedRef, focusableRef],
    );

    // Tab-consumption marker ([Q02], the editor's pattern). While the list is
    // open the field owns Tab; the marker rides the `<input>` so the document
    // focus walk's `closest([data-tug-tab-consume])` check yields. Appearance-
    // zone DOM write ([L06]), never React state.
    useLayoutEffect(() => {
      const el = inputRef.current;
      if (el === null) return;
      if (open) el.setAttribute(TAB_CONSUME_ATTRIBUTE, "true");
      else el.removeAttribute(TAB_CONSUME_ATTRIBUTE);
    }, [open]);

    // Measure the input so the portaled overlay can anchor under it.
    const measure = useCallback(() => {
      const el = inputRef.current;
      if (el === null) return;
      // Layout px: the list is fixed in the canvas overlay root, inside the
      // zoomed deck.
      const r = layoutRectOf(el);
      setPos({ top: r.bottom, left: r.left, width: r.width });
    }, []);

    // Open the list when armed + focused + non-empty; otherwise (still armed)
    // close it. A no-op when disarmed — explicit closes go through `closeMenu`.
    const syncOpen = useCallback(() => {
      if (!armedRef.current) return;
      if (focusedRef.current && itemsRef.current.length > 0) {
        measure();
        setOpen(true);
      } else if (itemsRef.current.length === 0) {
        setOpen(false);
      }
    }, [measure]);

    // The item set changed (add/remove/reorder/filter) — reset the highlight to
    // the top and clamp it in range.
    useLayoutEffect(() => {
      setActiveIndex(0);
    }, [itemsKey]);

    // Seed changed — reflect it into the open state immediately, so filtering
    // feels instant before the async results arrive.
    useLayoutEffect(() => {
      syncOpen();
    }, [seedItems, syncOpen]);

    // Debounced async fetch on value / nonce change. `reqSeqRef` guards against
    // an out-of-order response.
    useEffect(() => {
      if (asyncItems === undefined) {
        setAsyncList([]);
        return;
      }
      const handle = setTimeout(() => {
        const seq = (reqSeqRef.current += 1);
        void asyncItems(value).then((next) => {
          if (seq !== reqSeqRef.current) return;
          setAsyncList(next);
        });
      }, DEBOUNCE_MS);
      return () => clearTimeout(handle);
    }, [value, fetchNonce, asyncItems]);

    // Async results landed — re-evaluate open now that the merged set changed.
    useEffect(() => {
      syncOpen();
    }, [asyncList, syncOpen]);

    // Keep the overlay anchored while it's open (the sheet/page can scroll).
    useLayoutEffect(() => {
      if (!open) return;
      measure();
      const onScrollOrResize = (): void => measure();
      window.addEventListener("scroll", onScrollOrResize, true);
      window.addEventListener("resize", onScrollOrResize);
      return () => {
        window.removeEventListener("scroll", onScrollOrResize, true);
        window.removeEventListener("resize", onScrollOrResize);
      };
    }, [open, measure]);

    // Keep the highlighted row in view during keyboard navigation.
    useEffect(() => {
      if (!open) return;
      const row = listRef.current?.children[activeIndex] as HTMLElement | undefined;
      row?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex]);

    const closeMenu = useCallback(() => {
      setOpen(false);
      armedRef.current = false;
      reqSeqRef.current += 1; // drop any in-flight fetch's open
    }, []);

    // The field has come to rest on `next` — report it in the same shape the
    // close normalizer produces, so a consumer that stores the value stores
    // what the field will be showing rather than a transient spelling.
    const settle = useCallback(
      (next: string) => {
        onSettle?.(normalizeOnClose !== undefined ? normalizeOnClose(next) : next);
      },
      [onSettle, normalizeOnClose],
    );

    const acceptItem = useCallback(
      (item: TugComboBoxItem) => {
        if (item.descendable === true) {
          // Stay armed so the value-change effect refetches + re-opens; keep
          // focus for navigation. Not a settle — still navigating.
          armedRef.current = true;
          onChange(item.value);
          inputRef.current?.focus();
        } else {
          armedRef.current = false;
          onChange(item.value);
          closeMenu();
          settle(item.value);
        }
      },
      [onChange, closeMenu, settle],
    );

    // Notify the consumer when the list opens/closes.
    useEffect(() => {
      onOpenChange?.(open);
    }, [open, onOpenChange]);

    // Normalize the resting value on close (e.g. strip a directory's trailing
    // slash) so a transient navigation aid doesn't leak into the committed
    // value. Runs only on the open→closed transition.
    const prevOpenRef = useRef(open);
    useEffect(() => {
      const wasOpen = prevOpenRef.current;
      prevOpenRef.current = open;
      if (wasOpen && !open && normalizeOnClose !== undefined) {
        const normalized = normalizeOnClose(value);
        if (normalized !== value) onChange(normalized);
      }
    }, [open, value, onChange, normalizeOnClose]);

    // While the list is open, swallow Escape at the window capture phase so it
    // closes ONLY the list — ahead of a sheet/dialog's own Escape handler,
    // which would otherwise dismiss the whole surface. A window-capture
    // listener fires first in the event path; bubble-phase can't beat it.
    useEffect(() => {
      if (!open) return;
      const onCaptureKeyDown = (e: KeyboardEvent): void => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeMenu();
      };
      window.addEventListener("keydown", onCaptureKeyDown, true);
      return () => window.removeEventListener("keydown", onCaptureKeyDown, true);
    }, [open, closeMenu]);

    // Open the list as a menu (menu-mode gesture): arm, focus, force a refetch,
    // and show the current seed immediately.
    const openMenu = useCallback(() => {
      if (!menuMode || disabled === true) return;
      armedRef.current = true;
      focusedRef.current = true;
      setMenuShowAll(true); // browse the whole seed, not just what's typed
      inputRef.current?.focus();
      setFetchNonce((n) => n + 1);
      measure();
      if (itemsRef.current.length > 0) setOpen(true);
    }, [menuMode, disabled, measure]);

    const toggleMenu = useCallback(() => {
      if (open) closeMenu();
      else openMenu();
    }, [open, closeMenu, openMenu]);

    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (open && items.length > 0) {
          // Shift+Delete removes the highlighted row (the browser-autofill
          // convention) — keyboard parity with the row's trailing delete.
          if (event.key === "Delete" && event.shiftKey) {
            const item = items[activeIndex];
            if (item?.onRemove !== undefined) {
              event.preventDefault();
              item.onRemove();
            }
            return;
          }
          switch (event.key) {
            case "ArrowDown":
              event.preventDefault();
              setActiveIndex((i) => (i + 1) % items.length);
              return;
            case "ArrowUp":
              event.preventDefault();
              setActiveIndex((i) => (i - 1 + items.length) % items.length);
              return;
            case "Enter": {
              // Accept the highlighted item AND close (the close-normalizer
              // runs) — distinct from Tab, which descends to keep navigating.
              const item = items[activeIndex];
              if (item !== undefined) {
                event.preventDefault();
                onChange(item.value);
                closeMenu();
                settle(item.value);
              }
              return;
            }
            case "Tab": {
              const item = items[activeIndex];
              if (item !== undefined) {
                event.preventDefault();
                acceptItem(item);
              }
              return;
            }
            default:
              return;
          }
        }
        // List closed: ArrowDown opens the menu (menu mode), else Enter commits.
        if (menuMode && event.key === "ArrowDown") {
          event.preventDefault();
          openMenu();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit?.();
          settle(value);
        }
      },
      [
        open,
        items,
        activeIndex,
        acceptItem,
        closeMenu,
        onChange,
        onSubmit,
        menuMode,
        openMenu,
        settle,
        value,
      ],
    );

    const onFocus = useCallback(() => {
      focusedRef.current = true;
    }, []);

    const onBlur = useCallback(() => {
      // A blur means focus genuinely left the field (a row-anchored modal that
      // steals focus is anchored to the STABLE field element, so letting the
      // list close here never strands its anchor) — close the list, and the
      // value the user walked away from is the resting one.
      focusedRef.current = false;
      armedRef.current = false;
      setOpen(false);
      settle(value);
    }, [settle, value]);

    // User typed — arm so the seed/fetch effects open the list, and switch the
    // seed from "show all" to filtering by what's now typed.
    const handleType = useCallback(
      (next: string) => {
        armedRef.current = true;
        setMenuShowAll(false);
        onChange(next);
      },
      [onChange],
    );

    return (
      <div
        className={`tug-combo-box${className !== undefined ? ` ${className}` : ""}`}
        // The attached-list contract: while the caret is in the field, ↑/↓ drive
        // THIS list's highlight and never leave the field. Without the
        // declaration the engine's spatial stage claims a bare arrow whenever
        // the mode is engaged — and a combo box inside a sheet is always
        // engaged, because the sheet's trap engages it — so the highlight would
        // sit still while the ring walked out of the field. The list's own
        // `onKeyDown` does the moving, as it always has; this only says whose
        // arrows they are.
        //
        // Declared while the list is OPEN, and in `menuMode` while it is closed
        // too: there the closed-field ArrowDown is the gesture that opens the
        // menu, which the same stage would otherwise eat. A completing combo box
        // with a closed list yields its arrows to the plane, which is right —
        // there is no list to drive.
        {...(open || menuMode ? { [ATTACHED_LIST_ATTRIBUTE]: "" } : {})}
      >
        {leadingAccessory}
        <TugInput
          ref={setInputRef}
          size={size}
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          className={inputClassName}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus={autoFocus}
          spellCheck={spellCheck}
          onChange={(event) => handleType(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          onMouseDown={() => {
            // Move the engine key view to this field (the portaled-sheet pointer
            // promotion can't), then open the menu in menu mode.
            promoteSelf();
            if (menuMode) openMenu();
          }}
        />
        {menuMode && (
          <button
            ref={chevronFocusableRef}
            type="button"
            className="tug-combo-box-chevron"
            data-slot="tug-combo-box-chevron"
            aria-label={open ? "Close list" : "Open list"}
            aria-expanded={open}
            tabIndex={-1}
            disabled={disabled}
            // mousedown (not click) preventDefault keeps focus in the input so
            // the toggle doesn't blur-close the list under itself.
            onMouseDown={(event) => {
              event.preventDefault();
              promoteSelf();
              toggleMenu();
            }}
            // Keyboard activation: with the key view on the chevron, the
            // engine delivers Return / Space as a synthesized click (detail
            // 0). A pointer press already ran on mousedown above and must not
            // toggle twice, so real clicks (detail ≥ 1) are ignored here.
            onClick={(event) => {
              if (event.detail !== 0) return;
              promoteSelf();
              toggleMenu();
            }}
          >
            <ChevronDown aria-hidden="true" size={14} />
          </button>
        )}
        {accessory}
        {open &&
          pos !== null &&
          items.length > 0 &&
          createPortal(
            <ul
              ref={listRef}
              className="tug-completion-menu tug-combo-box-menu"
              data-slot={overlaySlot}
              role="listbox"
              style={{
                position: "fixed",
                top: `${pos.top}px`,
                left: `${pos.left}px`,
                minWidth: `${pos.width}px`,
              }}
            >
              {items.map((item, i) => (
                <li
                  key={item.value}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={
                    i === activeIndex
                      ? "tug-completion-menu-item tug-combo-box-item tug-completion-menu-item-selected"
                      : "tug-completion-menu-item tug-combo-box-item"
                  }
                  {...(item.rowData as React.LiHTMLAttributes<HTMLLIElement>)}
                  // mousedown (not click) so the input never blurs out from
                  // under the selection — keeps focus + the list alive to descend.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptItem(item);
                  }}
                  onMouseMove={() => setActiveIndex(i)}
                >
                  <span className="tug-completion-menu-label">{item.label}</span>
                  {item.trailing !== undefined && (
                    <span
                      className="tug-combo-box-item-trailing"
                      // Keep the trailing action out of the row's commit path
                      // and don't blur the input (so the list stays anchored).
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {item.trailing}
                    </span>
                  )}
                </li>
              ))}
            </ul>,
            overlayRoot,
          )}
      </div>
    );
  },
);
