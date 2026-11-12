/**
 * TugEntryShell — the shared structural shell behind bottom-docked entry
 * surfaces: the prompt entry (`PromptEntry`) and the find bar
 * (`TugFindBar`).
 *
 * The shell owns the *layout positions* and their surface treatment; every
 * occupant stays host-owned:
 *
 *   - the panel root (entry surface + `:focus-within` tint),
 *   - an optional status row above the input area,
 *   - the input area wrapping the host's editor substrate (`children`),
 *   - an optional accessory row between the input area and the toolbar
 *     (the prompt entry's compose-phase attachment strip),
 *   - the toolbar: a leading-fixed slot, two equal flex spacers flanking a
 *     centred-floating slot ([D05] — the centre lands at the midpoint of the
 *     leading–trailing gap; with no leading occupant, of the full row), and
 *     a fixed-trailing slot. The toolbar is chrome: it carries
 *     `data-tug-focus="refuse"` so a click on a badge, a spacer, or an empty
 *     gap never steals first-responder from the editor.
 *
 * **Hosting rule — both classes on the same element.** Hosts pass their own
 * legacy class per zone (`className`, `inputAreaClassName`,
 * `toolbarClassName`); the shell's `.tug-entry-shell*` classes carry the
 * shared layout/appearance CSS while host-specific rules (and app-test
 * selectors) keep matching on the host classes, which live on the very same
 * elements. The shared CSS custom properties (`--tugx-entry-shell-surface`,
 * `--tugx-entry-shell-rest`, `--tugx-entry-shell-focus`) are
 * defined in `tug-entry-shell.css` and are host-referenceable the same way.
 *
 * The shell claims no focus and owns no responder. It does keep ONE derived
 * appearance bit: `data-entry-keyboard` on the root, set while the engine's
 * key view sits inside this shell's input area — "this shell's field holds the
 * keyboard". The stylesheet reads it to decide which of the deck's entry
 * shells lights its default button, since with a find bar open two are on
 * screen and only the one holding the keyboard may read as live.
 *
 * It is mirrored onto the root rather than read in place with
 * `:has(.tug-entry-shell-input-area [data-key-view])`, which is the selector
 * this obviously wants to be: **WebKit does not invalidate `:has()` when a
 * descendant's attribute changes.** The selector matches correctly under
 * `element.matches()` and the computed style still does not update — re-insert
 * the subtree and the correct style appears. So a `:has()` keyed on an engine
 * mark silently renders the state the DOM had when the subtree was last
 * built. Never key appearance on `:has()` over a projected engine attribute;
 * mirror the bit onto an ancestor, as here.
 *
 * The forwarded ref lands on the root `div` — the prompt entry composes its
 * `rootRef + responderRef` there (the substrate's `data-empty` bridge writes
 * through that root ref per [L22], and the responder-chain registration rides
 * the same element).
 *
 * Laws: [L19] component authoring, [L20] the shell styles only its own box —
 * occupants keep their own tokens, [L06] the derived bit is a DOM attribute
 * written from a mutation observer, never React state.
 *
 * @module components/tugways/tug-entry-shell
 */

import "./tug-entry-shell.css";

import React, { useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { KEY_VIEW_ATTRIBUTE } from "./focus-manager";

/** Set on the shell root while the engine's key view is inside its input area. */
const ENTRY_KEYBOARD_ATTRIBUTE = "data-entry-keyboard";

export interface TugEntryShellProps
  extends React.ComponentPropsWithoutRef<"div"> {
  /** Optional status strip rendered above the input area (host markup). */
  statusRow?: React.ReactNode;
  /**
   * Optional accessory row between the input area and the toolbar (the
   * prompt entry's compose-phase attachment strip). Host markup, rendered
   * as a flow sibling so it grows the entry's height like added text rows.
   */
  accessoryRow?: React.ReactNode;
  /**
   * Leading-fixed toolbar slot. Omitted ⇒ nothing renders there; the
   * flanking spacers then centre the middle slot in the full row width.
   */
  toolbarLeading?: React.ReactNode;
  /** Centred-floating toolbar slot ([D05]). */
  toolbarCenter?: React.ReactNode;
  /** Fixed-trailing toolbar slot (one or more buttons). */
  toolbarTrailing?: React.ReactNode;
  /** Host class for the input-area wrapper (legacy selector hook). */
  inputAreaClassName?: string;
  /**
   * Ref forwarded to the input-area wrapper — the prompt entry authors it
   * as a keyboard-focus-cycle stop.
   */
  inputAreaRef?: React.Ref<HTMLDivElement>;
  /** `tabIndex` for the input-area wrapper (paired with `inputAreaRef`). */
  inputAreaTabIndex?: number;
  /** Host class for the toolbar row (legacy selector hook). */
  toolbarClassName?: string;
  /** The editor substrate. */
  children: React.ReactNode;
}

export const TugEntryShell = React.forwardRef<HTMLDivElement, TugEntryShellProps>(
  function TugEntryShell(
    {
      statusRow,
      accessoryRow,
      toolbarLeading,
      toolbarCenter,
      toolbarTrailing,
      inputAreaClassName,
      inputAreaRef,
      inputAreaTabIndex,
      toolbarClassName,
      className,
      children,
      ...rest
    }: TugEntryShellProps,
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const areaRef = useRef<HTMLDivElement | null>(null);

    // Mirror "the keyboard is in this shell's field" onto the root, driven by a
    // MutationObserver on the input area rather than by a focus-manager
    // subscription. The engine's notify and its DOM converge are two steps, and
    // a subscriber that reads the DOM sees the PREVIOUS projection — which
    // showed up as the two shells' default buttons lit exactly backwards. An
    // observer fires on the write itself, so there is no ordering to get right.
    useLayoutEffect(() => {
      const root = rootRef.current;
      const area = areaRef.current;
      if (root === null || area === null) return;
      const sync = (): void => {
        const held =
          area.hasAttribute(KEY_VIEW_ATTRIBUTE) ||
          area.querySelector(`[${KEY_VIEW_ATTRIBUTE}]`) !== null;
        if (held) root.setAttribute(ENTRY_KEYBOARD_ATTRIBUTE, "");
        else root.removeAttribute(ENTRY_KEYBOARD_ATTRIBUTE);
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(area, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [KEY_VIEW_ATTRIBUTE],
      });
      return () => observer.disconnect();
    }, []);

    const composedRootRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        rootRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref !== null) ref.current = el;
      },
      [ref],
    );
    const composedAreaRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        areaRef.current = el;
        if (typeof inputAreaRef === "function") inputAreaRef(el);
        else if (inputAreaRef !== null && inputAreaRef !== undefined) {
          (inputAreaRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }
      },
      [inputAreaRef],
    );

    return (
      <div ref={composedRootRef} data-slot="tug-entry-shell" className={cn("tug-entry-shell", className)} {...rest}>
        {statusRow}
        <div
          className={cn("tug-entry-shell-input-area", inputAreaClassName)}
          ref={composedAreaRef}
          tabIndex={inputAreaTabIndex}
        >
          {children}
        </div>
        {accessoryRow}
        <div
          className={cn("tug-entry-shell-toolbar", toolbarClassName)}
          // The toolbar is chrome: clicking anywhere in it — a badge, a
          // toggle, the spacers, the empty gaps — must not steal
          // first-responder or DOM focus from the editor. `data-tug-focus`
          // is ancestor-matched (`closest`), so marking the row refuses
          // focus for every descendant that doesn't already claim it.
          // [L11 / responder-chain-provider focus-refusal]
          data-tug-focus="refuse"
        >
          {toolbarLeading}
          <div className="tug-entry-shell-toolbar-spacer" aria-hidden="true" />
          <div
            className="tug-entry-shell-indicators"
            data-slot="entry-shell-indicators"
          >
            {toolbarCenter}
          </div>
          <div className="tug-entry-shell-toolbar-spacer" aria-hidden="true" />
          {toolbarTrailing}
        </div>
      </div>
    );
  },
);
