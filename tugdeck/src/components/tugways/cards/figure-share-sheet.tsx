/**
 * figure-share-sheet.tsx — the sheet a chart or a diagram is shared from.
 *
 * One of the share family, beside the Share Turns shade
 * (`session-share-view.tsx`), and made of the same parts so the two read as
 * one thing: the Share icon and the title in the sheet's header, a Format
 * choice, and the family's bottom row (`ShareActionRow`) with Done at its
 * left and, at its right, the Action menu beside the button that wears the
 * chosen action's name and performs it. Where the shade has the transcript
 * above it to choose turns in, this sheet has nothing to choose, so it is an
 * overlay on the card and shows its one subject itself: the figure, drawn as
 * the picture that will leave (`renderChartInto` in picture mode, the call
 * the host's share page makes).
 *
 * The sheet is its own preview, so its actions are Copy, Save… and Share…
 * and the default is Save…. Nothing is rendered until the action button is
 * pressed; a render, once made, is kept for the sheet's life, so a second
 * action on the same format sends the same file.
 *
 * {@link FigureShareHost} is the door. A figure's header is plain DOM with
 * no component in reach, so every card's host mounts one (`card-host.tsx`)
 * and it registers the card's offer with `figure-share-open.ts`; the header
 * asks there and the card holding the figure answers with this sheet.
 *
 * Laws: [L03] the opener is registered in a layout effect; [L06] the figure
 * is written to the DOM by its renderer, never through React state; [L07]
 * the action button reads the chosen format and action live; [L11] the
 * choice group and the menu report through the chain, and this view
 * responds; [L19] the file pair; [L20] composed children keep their tokens.
 *
 * @module components/tugways/cards/figure-share-sheet
 */

import "@/components/tugways/body-kinds/chart-block.css";
import "./figure-share-sheet.css";

import { Share } from "lucide-react";
import React, { useCallback, useContext, useId, useLayoutEffect, useRef, useState } from "react";

import { TugPaneFrameContext } from "@/components/chrome/tug-pane";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useTugSheet } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { useResponder } from "@/components/tugways/use-responder";
import { raiseDeckBulletin } from "@/lib/bulletin-relay";
import { CardIdContext } from "@/lib/card-id-context";
import {
  copyFigureFile,
  pickFigureFile,
  renderFigure,
  saveFigureFile,
  type FigureFormat,
} from "@/lib/chart/figure-export";
import {
  figureShareSheetWidth,
  registerFigureShareOpener,
  type FigureShareRequest,
} from "@/lib/chart/figure-share-open";
import { renderChartInto } from "@/lib/chart/render-chart";
import type { ShareAction } from "@/lib/share-turns-store";
import { ShareActionRow } from "./share-parts";

/** The formats, named as the Share Turns shade names them. */
const FORMAT_ITEMS: TugChoiceItem[] = [
  { value: "pdf", label: "PDF" },
  { value: "png", label: "Image" },
];

/** The sheet's actions, in menu order. It is its own preview, so it offers none. */
export const FIGURE_SHARE_ACTIONS: ReadonlyArray<ShareAction> = ["copy", "save", "share"];

/** The action the sheet opens on. */
export const FIGURE_SHARE_DEFAULT_ACTION: ShareAction = "save";

/** The format the sheet opens on. */
export const FIGURE_SHARE_DEFAULT_FORMAT: FigureFormat = "png";

/** The sheet's controls in Tab order: reading order, top to bottom. */
const ORDER = { format: 0, done: 1, action: 2, go: 3 } as const;

/** The sheet's title for a figure of this kind. */
export function figureShareTitle(diagram: boolean): string {
  return diagram ? "Share Diagram" : "Share Chart";
}

/** The sheet's description for a figure of this kind. */
export function figureShareDescription(diagram: boolean): string {
  return `Choose a format, then copy, save or share the ${diagram ? "diagram" : "chart"} as it appears here.`;
}

function isFormat(value: string): value is FigureFormat {
  return value === "pdf" || value === "png";
}

function isAction(value: string): value is ShareAction {
  return (FIGURE_SHARE_ACTIONS as ReadonlyArray<string>).includes(value);
}

/**
 * Every card's door to the figure share sheet: registers the card's offer
 * to show it and renders the sheet when a figure's header takes the offer.
 * Outside a card it does nothing.
 */
export function FigureShareHost(): React.ReactElement | null {
  const cardId = useContext(CardIdContext);
  const frameEl = useContext(TugPaneFrameContext);
  const frameRef = useRef(frameEl);
  frameRef.current = frameEl;
  const { showSheet, renderSheet } = useTugSheet();

  useLayoutEffect(() => {
    if (cardId === null) return;
    return registerFigureShareOpener({
      cardId,
      frame: () => frameRef.current,
      open: (request) => {
        void showSheet({
          title: figureShareTitle(request.diagram),
          description: figureShareDescription(request.diagram),
          icon: <Share />,
          iconTone: "active",
          hideHeaderRule: true,
          displayWidth: figureShareSheetWidth(request.naturalWidth),
          content: (close) => <FigureShareBody request={request} onDone={() => close()} />,
        });
      },
    });
  }, [cardId, showSheet]);

  return <>{renderSheet()}</>;
}

interface FigureShareBodyProps {
  request: FigureShareRequest;
  onDone: () => void;
}

function FigureShareBody({ request, onDone }: FigureShareBodyProps): React.ReactElement {
  const [format, setFormat] = useState<FigureFormat>(FIGURE_SHARE_DEFAULT_FORMAT);
  const [action, setAction] = useState<ShareAction>(FIGURE_SHARE_DEFAULT_ACTION);
  const [rendering, setRendering] = useState(false);
  // Read live at the press ([L07]).
  const chosen = useRef({ format, action });
  chosen.current = { format, action };
  // The renders made so far, by format: a second action sends the same file.
  const rendered = useRef<Partial<Record<FigureFormat, string>>>({});

  const formatSenderId = useId();
  const actionSenderId = useId();
  const responderId = useId();
  const focusGroup = useId();
  useSeedKeyView(`${focusGroup}:${ORDER.format}`);

  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const value = event.value;
        if (typeof value !== "string") return;
        if (event.sender === formatSenderId && isFormat(value)) setFormat(value);
        else if (event.sender === actionSenderId && isAction(value)) setAction(value);
      },
    },
  });

  // The picture, drawn by the one renderer as the share page draws it.
  const pictureRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = pictureRef.current;
    if (el === null) return;
    void renderChartInto(el, request.source, { layers: request.layers, picture: true });
  }, [request.source, request.layers]);

  const goRef = useRef<HTMLButtonElement | null>(null);
  const busy = useRef(false);
  const go = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const { format: fmt, action: act } = chosen.current;
    try {
      let path = rendered.current[fmt] ?? null;
      if (path === null) {
        setRendering(true);
        try {
          path = await renderFigure(request, fmt);
        } finally {
          setRendering(false);
        }
        if (path === null) return;
        rendered.current[fmt] = path;
      }
      if (act === "copy") {
        if (await copyFigureFile(path, request.source)) raiseDeckBulletin("success", "Copied");
      } else if (act === "save") {
        if (await saveFigureFile(path, fmt, request.baseName)) raiseDeckBulletin("success", "Saved");
      } else if (act === "share") {
        const rect = goRef.current?.getBoundingClientRect();
        if (rect !== undefined) await pickFigureFile(path, fmt, { x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      }
    } finally {
      busy.current = false;
    }
  }, [request]);

  return (
    <ResponderScope>
      <TugSheetScaffold
        ref={responderRef as (el: HTMLDivElement | null) => void}
        className="figure-share-sheet"
        data-slot="figure-share-sheet"
        data-testid="figure-share-sheet"
        data-rendering={rendering ? "true" : undefined}
        footer={
          <>
            <div className="figure-share-sheet__form" data-testid="figure-share-form">
              <span className="share-parts__label">Format</span>
              <span className="share-parts__control">
                <TugChoiceGroup
                  items={FORMAT_ITEMS}
                  value={format}
                  senderId={formatSenderId}
                  size="sm"
                  commit="live"
                  focusGroup={focusGroup}
                  focusOrder={ORDER.format}
                  aria-label="Format"
                  data-testid="figure-share-format"
                />
              </span>
            </div>
            <ShareActionRow
              actions={FIGURE_SHARE_ACTIONS}
              action={action}
              actionSenderId={actionSenderId}
              canAct={!rendering}
              rendering={rendering}
              onDone={onDone}
              onGo={() => void go()}
              goRef={goRef}
              focusGroup={focusGroup}
              focusOrder={ORDER}
              testId="figure-share"
            />
          </>
        }
      >
        <div className="figure-share-sheet__picture" data-testid="figure-share-picture">
          <div ref={pictureRef} />
        </div>
      </TugSheetScaffold>
    </ResponderScope>
  );
}
