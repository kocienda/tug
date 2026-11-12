/**
 * TugFileChooser — a path field with filesystem completion + a native picker.
 *
 * The path-specific preset of {@link TugComboBox}: it wires the generic combo
 * box's async source to tugcast's `/api/fs/complete` (so typing completes
 * filesystem paths), slots a square "Browse…" button that opens the macOS
 * `NSOpenPanel` as the leading escape accessory, descends into directories,
 * and strips a directory's transient trailing slash on close. Behavior mirrors
 * the prompt-entry `@`-mention menu:
 *   - typing fetches completions (debounced) from `/api/fs/complete`;
 *   - ↑/↓ move the highlight, the mouse follows it;
 *   - Enter accepts the highlighted match; Tab accepts, and a directory then
 *     descends (the list stays open on its children);
 *   - Escape closes the list; Enter with the list closed dispatches `submit`;
 *   - the field settles (`set-value`, phase `commit`) on a path the user
 *     finished choosing — a completion accepted, Enter, focus leaving, or the
 *     picker returning.
 *
 * Everything the field reports goes to its parent responder through the chain
 * ([L11]); a host answers it with {@link useFileChooserHost}.
 *
 * `kind` selects what's offered + what the picker returns: `directory` (default)
 * lists only directories; `file` lists files too (directories still appear so
 * the user can descend toward a file).
 *
 * A caller may pass `seed` + `menuMode` to make the field a full combo box over
 * a caller-owned item set (the session picker seeds it with recent projects) —
 * those items merge *above* the filesystem completions. Without them the field
 * is a plain completing path input, unchanged from before.
 *
 * Compositional component — composes {@link TugComboBox} + `TugPushButton`; its
 * mono overlay borrows `tug-completion-menu.css`. Laws: [L02] (n/a — local UI
 * state), [L06] appearance via CSS, [L19] component authoring guide, [L20]
 * composed children keep their own tokens.
 *
 * @module components/tugways/tug-file-chooser
 */

import "./tug-file-chooser.css";

import React, { useCallback, useId, useMemo, useRef } from "react";
import { FolderOpen } from "lucide-react";

import { TugComboBox, type TugComboBoxItem, type TugComboFieldProps } from "./tug-combo-box";
import { TugPushButton } from "./tug-push-button";
import { TUG_ACTIONS } from "./action-vocabulary";
import type { ActionEvent } from "./responder-chain";
import { useControlDispatch } from "./use-control-dispatch";
import { useOptionalResponder } from "./use-responder";
import {
  fetchPathCompletions,
  type CompletionKind,
} from "@/lib/fs-complete";
import { isPathPickerAvailable, pickPath } from "@/lib/native-path-picker";
import { cn } from "@/lib/utils";

/**
 * Props for {@link TugFileChooser}: the shared field props — `value` is the
 * path text, and the native picker's choice reports through `senderId` the
 * same way typing does (a `change`, then a `commit`) — plus what a path field
 * adds. A `seed` here (e.g. recent project paths) merges ABOVE the
 * filesystem completions; the overlay's `data-slot` defaults to
 * `"tug-file-chooser-overlay"`.
 */
export interface TugFileChooserProps extends TugComboFieldProps {
  /** Working directory that relative completions + the picker resolve under. */
  base: string;
  /** What to choose: `directory` (default) or `file` (files + descendable dirs). */
  kind?: CompletionKind;
  /** Show the native "Browse…" picker button (default true; auto-hidden off-host). */
  showBrowse?: boolean;
  /**
   * Author the native "Browse…" button into {@link focusGroup} as its own focus
   * stop ([P02]), at this order. Omitted ⇒ the button stays outside the walk.
   * Only honored when {@link focusGroup} is also set.
   */
  browseFocusOrder?: number;
}

/** The basename prefix being completed — the text after the last `/`. */
function queryPrefix(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

/**
 * Render a completion label with its matched leading prefix bolded (completion
 * is prefix-based, so the first `prefixLen` chars matched).
 */
function MatchedLabel({ label, prefixLen }: { label: string; prefixLen: number }): React.ReactElement {
  if (prefixLen <= 0 || prefixLen > label.length) {
    return <>{label}</>;
  }
  return (
    <>
      <span className="tug-completion-match">{label.slice(0, prefixLen)}</span>
      {label.slice(prefixLen)}
    </>
  );
}

/**
 * A path field with filesystem completion + a native picker. See the module doc
 * for the full interaction model.
 */
export const TugFileChooser = React.forwardRef<HTMLDivElement, TugFileChooserProps>(
  function TugFileChooser(
    {
      value,
      senderId,
      base,
      kind = "directory",
      onOpenChange,
      placeholder,
      "aria-label": ariaLabel,
      size = "md",
      showBrowse = true,
      autoFocus,
      className,
      disabled,
      seed,
      menuMode,
      focusGroup,
      focusOrder = 0,
      browseFocusOrder,
      chevronFocusOrder,
      overlaySlot = "tug-file-chooser-overlay",
      portalContainer,
      inputRef,
      ...rest
    },
    forwardedRef,
  ) {
    const showPicker = showBrowse && isPathPickerAvailable();

    // Async source: filesystem completions, mapped to combo-box items with the
    // matched prefix bolded. Directories are descendable; files commit + close.
    const asyncItems = useCallback(
      async (query: string): Promise<TugComboBoxItem[]> => {
        const prefixLen = queryPrefix(query).length;
        const matches = await fetchPathCompletions(base, query, kind);
        return matches.map((m) => ({
          value: m.value,
          label: <MatchedLabel label={m.label} prefixLen={prefixLen} />,
          descendable: m.isDir,
        }));
      },
      [base, kind],
    );

    // A trailing slash is a transient navigation aid (it lets you descend into a
    // directory); once the list is dismissed the value should be canonical so
    // `/x/` and `/x` are treated as the same. Root "/" is preserved.
    const normalizeOnClose = useCallback((v: string): string => {
      if (v.length > 1 && v.endsWith("/")) return v.replace(/\/+$/, "") || "/";
      return v;
    }, []);

    const { dispatch } = useControlDispatch();
    const fallbackSenderId = useId();
    const sender = senderId ?? fallbackSenderId;
    const browse = useCallback(() => {
      const hint = value.trim() !== "" ? value.trim() : base;
      void pickPath(kind, hint).then((path) => {
        if (path === null) return;
        // Choosing in the native panel is a finished act, not a keystroke: the
        // panel closes on a path the user picked deliberately, and focus comes
        // back to a field that is already done. It settles on the spot — there
        // is no later gesture that would.
        dispatch({ action: TUG_ACTIONS.SET_VALUE, value: path, sender, phase: "change" });
        dispatch({ action: TUG_ACTIONS.SET_VALUE, value: path, sender, phase: "commit" });
      });
    }, [value, base, kind, dispatch, sender]);

    const browseButton = showPicker ? (
      <TugPushButton
        size={size}
        emphasis="ghost"
        aria-label={kind === "file" ? "Browse for a file" : "Browse for a directory"}
        data-slot="tug-file-chooser-browse"
        disabled={disabled}
        onClick={browse}
        // A leaf focus stop when the host authors a browse order ([P02]); the
        // engine lands the key view on the button and Return / Space fires the
        // native picker through the button's own click path.
        focusGroup={browseFocusOrder !== undefined ? focusGroup : undefined}
        focusOrder={browseFocusOrder}
      >
        <FolderOpen aria-hidden="true" size={14} />
      </TugPushButton>
    ) : undefined;

    return (
      <TugComboBox
        {...rest}
        ref={forwardedRef}
        data-slot="tug-file-chooser"
        value={value}
        senderId={sender}
        seed={seed}
        asyncItems={asyncItems}
        menuMode={menuMode}
        leadingAccessory={browseButton}
        normalizeOnClose={normalizeOnClose}
        onOpenChange={onOpenChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        size={size}
        autoFocus={autoFocus}
        disabled={disabled}
        // The size modifier rides the class list; the square Browse button's
        // box is restated per size in the CSS.
        className={cn("tug-file-chooser", `tug-file-chooser-size-${size}`, className)}
        inputClassName="tug-file-chooser-input"
        overlaySlot={overlaySlot}
        portalContainer={portalContainer}
        focusGroup={focusGroup}
        focusOrder={focusOrder}
        chevronFocusOrder={chevronFocusOrder}
        inputRef={inputRef}
      />
    );
  },
);

/** What a host does with a {@link TugFileChooser}'s reports. */
export interface TugFileChooserHostHandlers {
  /** `set-value`, phase `change`: the path text changed. Set `value` from it. */
  onChange: (value: string) => void;
  /** `set-value`, phase `commit`: the field came to rest on this path. */
  onSettle?: (value: string) => void;
  /** `submit`: Enter with the completion list closed. */
  onSubmit?: () => void;
}

/**
 * The host side of a {@link TugFileChooser}: returns a scope component to
 * render the one chooser inside, which registers a responder that answers the
 * field's `set-value` and `submit` with `handlers` ([L11]). The scope
 * registers where it is RENDERED, so its parent is the responder around the
 * chooser — a host that is itself a responder stays on the field's chain. The
 * component is stable for the host's lifetime, and the handlers are read
 * through a ref, so they may change identity every render ([L07]).
 *
 * ```tsx
 * const ChooserHost = useFileChooserHost({ onChange: setPath, onSubmit: open });
 * return <ChooserHost><TugFileChooser value={path} … /></ChooserHost>;
 * ```
 */
export function useFileChooserHost(
  handlers: TugFileChooserHostHandlers,
): React.FC<{ children: React.ReactNode }> {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  return useMemo(
    () =>
      function FileChooserHost({ children }: { children: React.ReactNode }): React.ReactElement {
        const id = useId();
        const { ResponderScope } = useOptionalResponder({
          id,
          actions: {
            [TUG_ACTIONS.SET_VALUE]: (event: ActionEvent) => {
              if (typeof event.value !== "string") return;
              if (event.phase === "commit") handlersRef.current.onSettle?.(event.value);
              else handlersRef.current.onChange(event.value);
            },
            [TUG_ACTIONS.SUBMIT]: () => {
              handlersRef.current.onSubmit?.();
            },
          },
        });
        return <ResponderScope>{children}</ResponderScope>;
      },
    [],
  );
}
