/**
 * An open sketch's body in the cycle shade: a cycle's or an arc's record of
 * where the work came from, as written — what is wanted, then the shape the
 * work will take.
 *
 * Styled by the cycle shade's sheet (`.session-arc-record-text`); this module
 * adds none.
 *
 * Laws: [L19] component authoring guide, [L20] composes `TugEmptyLine`, which
 *       keeps its own tokens
 */

import React from "react";

import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import { parseArcRecord } from "@/lib/arc-record-text";

/**
 * A record's body: its opening paragraph, what is wanted, then the approach
 * and the list under it; or, for a record that holds no text, the one
 * centred word every empty list in the app says.
 */
export function recordBody(text: string | undefined): React.ReactElement {
  if (text === undefined || text.trim() === "") return <TugEmptyLine>None</TugEmptyLine>;
  return (
    <div className="session-arc-record-text" data-slot="session-arc-record-text">
      {parseArcRecord(text).map((block, index) =>
        block.kind === "paragraph" ? (
          <p key={index}>{block.text}</p>
        ) : (
          <ul key={index}>
            {block.items.map((item, at) => (
              <li key={at}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
