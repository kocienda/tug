/**
 * gallery-file-chooser.tsx — TugFileChooser demo tab for the Component Gallery.
 *
 * Shows the path field + completion overlay in both `kind` modes (directory and
 * file), completing against the filesystem root. Inside Tug.app each field also
 * shows the native "Browse…" picker button; in a plain browser it's hidden.
 *
 * Rules of Tugways compliance: the chooser is controlled, so `value` is data
 * state (a `useState`) — not appearance state [L06].
 *
 * @module components/tugways/cards/gallery-file-chooser
 */

import React, { useState } from "react";
import { TugFileChooser, useFileChooserHost } from "@/components/tugways/tug-file-chooser";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

export function GalleryFileChooser() {
  const [dir, setDir] = useState("");
  const [file, setFile] = useState("");
  const DirHost = useFileChooserHost({ onChange: setDir });
  const FileHost = useFileChooserHost({ onChange: setFile });

  return (
    <div className="cg-content" data-testid="gallery-file-chooser">
      {/* ---- Directory mode ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Directory chooser</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxWidth: "420px" }}>
          <DirHost>
          <TugFileChooser size="sm"
            value={dir}
            base="/"
            kind="directory"
            placeholder="Type a path, e.g. /Users — ↑/↓ to pick, Enter/Tab to descend"
            aria-label="Directory chooser demo"
          />
          </DirHost>
          <TugLabel size="xs" emphasis="calm">{`value: ${dir === "" ? "(empty)" : dir}`}</TugLabel>
        </div>
      </div>

      <TugSeparator />

      {/* ---- File mode ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">File chooser</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxWidth: "420px" }}>
          <FileHost>
          <TugFileChooser size="sm"
            value={file}
            base="/"
            kind="file"
            placeholder="Descend directories, pick a file"
            aria-label="File chooser demo"
          />
          </FileHost>
          <TugLabel size="xs" emphasis="calm">{`value: ${file === "" ? "(empty)" : file}`}</TugLabel>
        </div>
      </div>
    </div>
  );
}
