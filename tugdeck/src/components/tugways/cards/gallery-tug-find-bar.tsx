/**
 * gallery-tug-find-bar.tsx — `TugFindBar` demo tab for the Component
 * Gallery.
 *
 * The bar finds through a host-owned `FindSession`, so the demo is a host:
 * it builds one session over the shared editor find engine and points the
 * engine at a `TugCodeView`. Type in the bar and the snippet's matches
 * light; the second bar adds the replace row.
 *
 * Each demo is also the bar's host the way a real one is: it renders the bar
 * inside `useFindBarHost`'s scope and answers `close-find` by hiding it, so
 * Escape in the field and the close button both close the bar. A `Show Find
 * Bar` button brings it back.
 *
 * @module components/tugways/cards/gallery-tug-find-bar
 */

import React, { useCallback, useRef, useState } from "react";

import { TugFindBar, useFindBarHost } from "@/components/tugways/tug-find-bar";
import { TugCodeView, type TugCodeViewDelegate } from "@/components/tugways/tug-code-view";
import { createEditorFindEngine } from "@/components/tugways/editor-find-engine";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { createFindSession } from "@/lib/create-find-session";
import type { FindSession } from "@/lib/find-session";

const TEXT = [
  "The find bar searches whatever its host's engine reads.",
  "Here the engine reads this code view, so a search for 'find'",
  "marks every find in these lines, and Return steps to the next find.",
].join("\n");

/** One host: a code view, its session, and a bar over both that it can close. */
function FindHost({ replace, label }: { replace: boolean; label: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<TugCodeViewDelegate | null>(null);
  const sessionRef = useRef<FindSession | null>(null);
  // Whether the bar is mounted: structure, not appearance.
  const [open, setOpen] = useState(true);
  const hide = useCallback(() => setOpen(false), []);
  const FindBarHost = useFindBarHost(hide);
  if (sessionRef.current === null) {
    const engine = createEditorFindEngine(() => viewRef.current?.view() ?? null, "text");
    const session = createFindSession({ replace });
    session.setDelegate(engine);
    sessionRef.current = session;
  }
  return (
    <div ref={rootRef} style={{ maxWidth: "520px", display: "flex", flexDirection: "column", gap: "6px" }}>
      {open ? (
        <FindBarHost>
          <TugFindBar session={sessionRef.current} cardRootRef={rootRef} placeholder={label} replace={replace} />
        </FindBarHost>
      ) : (
        <div>
          <TugPushButton emphasis="outlined" size="sm" data-testid="gallery-find-bar-show" onClick={() => setOpen(true)}>
            Show Find Bar
          </TugPushButton>
        </div>
      )}
      <TugCodeView ref={viewRef} value={TEXT} lineNumbers={false} />
    </div>
  );
}

export function GalleryTugFindBar() {
  return (
    <div className="cg-content" data-testid="gallery-tug-find-bar">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Find</TugLabel>
        <FindHost replace={false} label="Find in snippet" />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Find and replace</TugLabel>
        <FindHost replace label="Find in snippet" />
      </div>
    </div>
  );
}
