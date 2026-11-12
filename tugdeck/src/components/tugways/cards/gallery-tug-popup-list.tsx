/**
 * gallery-tug-popup-list.tsx — the popup-list parts as a Component Gallery
 * tab.
 *
 * Draws the frame in place, with no popover around it, in each `kind`: an
 * item list with indicators and trailing slots, a log that sticks to the
 * bottom, and a key/value grid with a summary.
 *
 * @module components/tugways/cards/gallery-tug-popup-list
 */

import React from "react";
import { Circle, CircleCheck, FileText } from "lucide-react";

import {
  TugPopupListFrame,
  TugPopupListGrid,
  TugPopupListItem,
  TugPopupListItemText,
  TugPopupListRow,
  TugPopupListScroller,
} from "@/components/tugways/tug-popup-list";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const ITEMS = [
  { name: "brief.md", meta: "2 minutes ago", done: true },
  { name: "plan.md", meta: "an hour ago", done: true },
  { name: "baseline.md", meta: "yesterday", done: false },
];

const LOG = Array.from({ length: 14 }, (_, i) => `12:0${i % 10} step ${i + 1} reported`);

const GRID_ROWS = [
  <TugPopupListRow key="model" label="Model" value="opus" />,
  <TugPopupListRow key="effort" label="Effort" value="high" hint="set by the arc" />,
  <TugPopupListRow key="tokens" label="Tokens" value="32.5k" />,
];
const GRID_SUMMARY = [<TugPopupListRow key="total" label="Window" value="200k" />];

const frameBox: React.CSSProperties = { maxWidth: "360px" };

export function GalleryTugPopupList() {
  return (
    <div className="cg-content" data-testid="gallery-tug-popup-list">
      <div className="cg-section">
        <TugLabel className="cg-section-title">kind="item"</TugLabel>
        <div style={frameBox}>
          <TugPopupListFrame kind="item" title="Documents" icon={<FileText size={14} />}>
            <TugPopupListScroller>
              {ITEMS.map((item) => (
                <TugPopupListItem
                  key={item.name}
                  indicator={item.done ? <CircleCheck size={12} /> : <Circle size={12} />}
                  trailing={<TugLabel size="2xs" emphasis="calm">open</TugLabel>}
                >
                  <TugPopupListItemText primary={item.name} meta={item.meta} />
                </TugPopupListItem>
              ))}
            </TugPopupListScroller>
          </TugPopupListFrame>
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">kind="log", sticking to the bottom</TugLabel>
        <div style={frameBox}>
          <TugPopupListFrame kind="log" title="Activity">
            <TugPopupListScroller stickToBottom>
              {LOG.map((line) => (
                <TugPopupListItem key={line}>
                  <TugPopupListItemText primary={line} />
                </TugPopupListItem>
              ))}
            </TugPopupListScroller>
          </TugPopupListFrame>
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">kind="state", a grid with a summary</TugLabel>
        <div style={frameBox}>
          <TugPopupListFrame kind="state" title="Session" footer={<TugLabel size="2xs" emphasis="calm">footer</TugLabel>}>
            <TugPopupListGrid rows={GRID_ROWS} summary={GRID_SUMMARY} />
          </TugPopupListFrame>
        </div>
      </div>
    </div>
  );
}
