/**
 * TugAlertSheet — a pane-modal alert with TugAlert's look.
 *
 * `TugAlert` (Radix `AlertDialog`) is app-modal: it portals to the canvas
 * overlay and installs a document-global focus trap. Inside a pane that trap
 * would leak across panes (the cross-pane modality hazard the sheet machinery
 * was hardened against). Rather than re-implement pane-modality on
 * `AlertDialog`, `TugAlertSheet` composes the *proven* pane-modal substrate —
 * `TugSheet` (pane-frame portal + pane scrim + `inert`, no global trap [D15])
 * — and renders `TugAlert`'s exact visual (the shared `.tug-alert-*` layout
 * classes, whose tokens are defined globally on `body`).
 *
 * Presented through any card's `showSheet` host with `hideHeader` so the
 * alert owns the whole panel (icon left, title + message right, actions
 * bottom-right — the classic HIG layout). The confirm button is the sheet's
 * default (Enter); Escape dismisses (resolves `false`).
 *
 * Laws: [L19] component authoring guide
 *
 * @module components/tugways/tug-alert-sheet
 */

import "./tug-alert.css";

import React from "react";
import { Info } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import type { TugButtonRole } from "@/components/tugways/tug-push-button";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { MODAL_REST_LINE } from "@/components/tugways/cards/modal-rest-line";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import { useResponderForm } from "@/components/tugways/use-responder-form";

export interface AlertSheetOptions {
  /** Alert title (required). */
  title: string;
  /** Body content. */
  message?: React.ReactNode;
  /** Leading icon. Defaults to an info glyph. Pass `null` to omit. */
  icon?: React.ReactNode;
  /** Confirm button label. @default "OK" */
  confirmLabel?: string;
  /** The confirm button: its semantic role. @default `{ role: "action" }` */
  confirm?: { role?: TugButtonRole };
  /** Cancel button label, or `null` for a single-button alert. @default null */
  cancelLabel?: string | null;
  /**
   * A checkbox under the message, unchecked at open, or `null` for none. It
   * qualifies the confirm rather than adding a choice, so the buttons stay
   * simple actions. Read through {@link presentAlertSheetWithCheckbox}.
   * @default null
   */
  checkboxLabel?: string | null;
}

interface TugAlertSheetViewProps extends AlertSheetOptions {
  /** Called with the checkbox's state; `false` when there is none. */
  onConfirm: (checked: boolean) => void;
  onCancel: () => void;
}

/**
 * The alert's body, rendered inside a `TugSheet` panel. Reuses the
 * `.tug-alert-*` layout classes so it is visually identical to `TugAlert`.
 */
export function TugAlertSheetView({
  title,
  message,
  icon,
  confirmLabel = "OK",
  confirm,
  cancelLabel = null,
  checkboxLabel = null,
  onConfirm,
  onCancel,
}: TugAlertSheetViewProps): React.ReactElement {
  const confirmButtonRole = confirm?.role ?? "action";
  const iconNode =
    icon === undefined ? <Info aria-hidden="true" /> : icon;
  // Author the actions into the sheet's trapped focus mode: Tab walks Cancel →
  // confirm, with the confirm button seeded as the live default so it opens
  // filled+ring (an action confirm promotes its `primary` tint to the role
  // fill). Danger keeps Return safe by seeding Cancel when present — same
  // rule as TugAlert — so Return can't fire a destructive confirm; the
  // danger fill stays on the confirm as role signaling. Single-button
  // alerts seed the lone confirm.
  const focusGroup = React.useId();
  // The checkbox, when there is one, is the first Tab stop: it sits above
  // the actions, in the text column.
  const CHECKBOX_ORDER = 0;
  const CANCEL_ORDER = 1;
  const CONFIRM_ORDER = 2;
  const seedOrder =
    confirmButtonRole === "danger" && cancelLabel !== null ? CANCEL_ORDER : CONFIRM_ORDER;
  useSeedKeyView(`${focusGroup}:${seedOrder}`);
  // The checkbox reports through the chain ([L11]); the form scope catches
  // its toggle and keeps the state the confirm reads.
  const [checked, setChecked] = React.useState(false);
  const checkboxId = React.useId();
  const { ResponderScope, responderRef } = useResponderForm({
    toggle: { [checkboxId]: setChecked },
  });
  return (
    <ResponderScope>
    <div className="tug-alert-sheet" ref={responderRef as React.Ref<HTMLDivElement>}>
      <div
        className="tug-alert-body"
        data-scale="alert"
        data-has-message={
          message !== undefined && message !== null ? "true" : undefined
        }
      >
        {iconNode !== null ? (
          <div className="tug-alert-icon" aria-hidden="true">
            {iconNode}
          </div>
        ) : null}
        <div className="tug-alert-text">
          <h2 className="tug-alert-title">{title}</h2>
          {message !== undefined && message !== null ? (
            <p className="tug-alert-message">{message}</p>
          ) : null}
          {checkboxLabel !== null ? (
            <div className="tug-alert-checkbox">
              <TugCheckbox
                size="sm"
                checked={checked}
                senderId={checkboxId}
                label={checkboxLabel}
                data-testid="alert-checkbox"
                focusGroup={focusGroup}
                focusOrder={CHECKBOX_ORDER}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="tug-alert-actions">
        {cancelLabel !== null ? (
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            onClick={onCancel}
            data-testid="alert-cancel"
            focusGroup={focusGroup}
            focusOrder={CANCEL_ORDER}
          >
            {cancelLabel}
          </TugPushButton>
        ) : null}
        <TugPushButton
          size="sm"
          emphasis={confirmButtonRole === "action" ? "primary" : "filled"}
          role={confirmButtonRole}
          onClick={() => onConfirm(checked)}
          data-testid="alert-confirm"
          focusGroup={focusGroup}
          focusOrder={CONFIRM_ORDER}
        >
          {confirmLabel}
        </TugPushButton>
      </div>
    </div>
    </ResponderScope>
  );
}

/**
 * Present a pane-modal alert through a card's `showSheet` host. Resolves
 * `true` if confirmed, `false` if cancelled or dismissed (Escape / Cmd+.).
 *
 * The sheet opens at `sm` width with `hideHeader` so the alert layout owns
 * the panel. The confirm path closes with `"ok"`; everything else resolves
 * `false`.
 *
 * It rests on the host card's modal rest line and settles up onto it like
 * every other modal surface there ([B01], `tuglaws/modal-rest-line.md`) — the
 * pane-modal twin of what `TugAlert` does for the app-modal case. A host with
 * no view slot (a text card, an image card) matches nothing and keeps the
 * default top anchor, which is the right answer there.
 */
export function presentAlertSheet(
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>,
  options: AlertSheetOptions,
): Promise<boolean> {
  return showSheet({
    title: options.title,
    displayWidth: "sm",
    hideHeader: true,
    presentation: "rise",
    bottomAnchorSelector: MODAL_REST_LINE,
    content: (close) => (
      <TugAlertSheetView
        {...options}
        onConfirm={() => close("ok")}
        onCancel={() => close()}
      />
    ),
  }).then((result) => result === "ok");
}

/**
 * Present a pane-modal alert with a checkbox under its message, and resolve
 * `{ checked }` when confirmed, or `null` when cancelled or dismissed.
 * Presented as {@link presentAlertSheet} is, at `md` width so a long
 * checkbox label sits on one line.
 */
export function presentAlertSheetWithCheckbox(
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>,
  options: AlertSheetOptions & { checkboxLabel: string },
): Promise<{ checked: boolean } | null> {
  return showSheet({
    title: options.title,
    displayWidth: "md",
    hideHeader: true,
    presentation: "rise",
    bottomAnchorSelector: MODAL_REST_LINE,
    content: (close) => (
      <TugAlertSheetView
        {...options}
        onConfirm={(checked) => close(checked ? "checked" : "unchecked")}
        onCancel={() => close()}
      />
    ),
  }).then((result) =>
    result === "checked" || result === "unchecked" ? { checked: result === "checked" } : null,
  );
}
