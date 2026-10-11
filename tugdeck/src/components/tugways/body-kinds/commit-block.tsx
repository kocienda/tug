/**
 * commit-block.tsx — the "commit receipt" body kind.
 *
 * A purpose-built body for a `git commit`. It is a body kind in the
 * `BashToolBlock` sense: the wrapper owns the chrome (the lifecycle dot
 * + "Git Commit" name + collapse chevron, matching every other tool block),
 * and this renders the receipt *inside* that frame — the summary set as
 * a title, a branch `TugBadge` + a click-to-copy short-hash
 * `TugCopyBadge`, three borderless stat `TugBadge`s (neutral `+N` / `−M`
 * deltas + a file-count `action` badge), the message body in the shared
 * `CommitMessage` well — the `/commit` receipt's own message layout, so the
 * two blocks that name one act lay it out alike — and a `BlockDisclosure`
 * for an optional per-file breakdown.
 *
 * Routing intent (not yet wired): `BashToolBlock` swaps this in for a
 * `git commit` command the same way it swaps `DiffBlock` in for
 * `git diff` / `git show`, passing `toolName="Git Commit"` to the chrome.
 * The data it needs is parseable from the Bash call alone —
 * `parseGitCommit(command, stdout)` pulls the full message from the
 * `-m` argument and the branch / hash / diffstat from the commit's
 * stdout. A per-file breakdown is an optional enrichment (it needs a
 * `git show --stat`-shaped source) and degrades to the aggregate bar
 * when absent.
 *
 * This module's gallery fixtures live in `gallery-commit-surfaces.tsx`,
 * which mounts it inside a real `BlockChrome` alongside the other commit
 * surfaces.
 *
 * **The one deck surface that reads git's own text.** Everywhere else a path
 * reaches the deck as a typed field the Rust side read through a `-z` listing,
 * so nothing is ever quoted. Here the source is a foreign transcript's `git
 * commit` stdout, which Tug neither runs nor can ask for in another shape, so
 * the C-quoted display form has to be read back — see {@link unquoteGitPath},
 * whose result is painted and never handed to git.
 *
 * Laws:
 *  - [L06] disclosures are `BlockDisclosure` (native `<details>`) —
 *    appearance toggles through the DOM, no React state.
 *  - [L17] every painted value resolves to a `--tug7-*` / `--tug-*`
 *    base token in one hop via the `--tugx-block-*` aliases.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="commit-block"`.
 *  - [L20] reuses the shared `--tugx-block-*` tone-band colors and the
 *    `TugBadge` / `BlockDisclosure` primitives; the only local
 *    geometry is the diffstat bar.
 *
 * @module components/tugways/body-kinds/commit-block
 */

import "./commit-block.css";

import React from "react";
import { GitBranch } from "lucide-react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugCopyBadge } from "@/components/tugways/tug-copy-badge";
import { TugLabel } from "@/components/tugways/tug-label";
import { MiddleEllipsisPath } from "@/components/tugways/blocks/middle-ellipsis-path";
import { BlockDisclosure } from "@/components/tugways/blocks/block-bits/block-disclosure";
import { CommitMessage } from "@/components/tugways/commit-presentation";
import {
  parseGitCommit,
  unquoteGitPath,
  type CommitData,
  type CommitFile,
} from "@/lib/git-commit-parse";

// The receipt's data shape and the `git commit` stdout parser live in
// `lib/git-commit-parse.ts`, so the transcript search index can parse a
// commit without importing this renderer. Re-exported for every caller.
export { parseGitCommit, unquoteGitPath, type CommitData, type CommitFile };

// ---------------------------------------------------------------------------
// CommitBlock
// ---------------------------------------------------------------------------

export interface CommitHeaderTargetProps {
  commit: CommitData;
}

/**
 * The commit's header-line content — the summary message (ellipsizing to
 * one line) with the branch `TugBadge` and click-to-copy hash
 * `TugCopyBadge` pinned to the right. The wrapper hands this to
 * `BlockChrome` as the header `identity`, so it sits on the tool-call
 * header row beside the "Git Commit" name, exactly where a Bash block's
 * command sits.
 */
export function CommitHeaderTarget({
  commit,
}: CommitHeaderTargetProps): React.ReactElement {
  const { summary, branch, hash } = commit;
  return (
    <span className="tugx-commit-header">
      <span className="tugx-commit-header-summary">{summary}</span>
      <span className="tugx-commit-chips">
        <TugBadge
          emphasis="ghost"
          role="inherit"
          size="sm"
          icon={<GitBranch />}
          copyText={branch}
        >
          {branch}
        </TugBadge>
        <TugCopyBadge
          className="tugx-commit-hash-badge"
          emphasis="ghost"
          role="inherit"
          size="sm"
          value={hash}
        />
      </span>
    </span>
  );
}

export interface CommitBlockProps {
  commit: CommitData;
}

/**
 * The commit receipt body — rendered inside a `BlockChrome` whose
 * header carries the lifecycle dot + "Git Commit" name and the
 * {@link CommitHeaderTarget} (summary + branch / hash badges). The body
 * holds the three stat `TugBadge`s, the message in the `/commit` receipt's
 * `.tugx-commit-message` well, and the file disclosure. The root wears the
 * receipt face, so the message reads as prose there too.
 */
export function CommitBlock({ commit }: CommitBlockProps): React.ReactElement {
  const { body, filesChanged, insertions, deletions, files } = commit;
  const hasBody = body.length > 0;
  const hasFiles = files !== undefined && files.length > 0;

  return (
    <div className="tugx-commit tugx-commit-receipt" data-slot="commit-block">
      <div className="tugx-commit-stat">
        <TugBadge
          emphasis="ghost"
          role="inherit"
          size="sm"
        >{`+${insertions}`}</TugBadge>
        <TugBadge emphasis="ghost" role="inherit" size="sm">
          {`−${deletions}`}
        </TugBadge>
        <TugBadge emphasis="ghost" role="inherit" size="sm">
          {`${filesChanged} ${filesChanged === 1 ? "file" : "files"}`}
        </TugBadge>
      </div>

      {/* The message reads as the `/commit` receipt's does — the shared well,
          open, and ABOVE the file list, which can run arbitrarily long. */}
      {hasBody && (
        <CommitMessage body={body.join("\n")} dataSlot="commit-block-message" />
      )}

      {hasFiles && (
        <BlockDisclosure
          className="tugx-commit-disclosure"
          summary={
            <TugLabel emphasis="proposal" size="2xs">
              {`${files!.length} ${files!.length === 1 ? "file" : "files"} changed`}
            </TugLabel>
          }
        >
          <ul className="tugx-commit-files">
            {files!.map((f) => (
              <li key={f.path} className="tugx-commit-file">
                <span
                  className={`tugx-commit-file-status tugx-commit-file-status--${f.status.toLowerCase()}`}
                  title={f.status}
                >
                  {f.status}
                </span>
                <span className="tugx-commit-file-path">
                  <MiddleEllipsisPath path={f.path} />
                </span>
                <span className="tugx-commit-file-delta">
                  {f.added > 0 && (
                    <span className="tugx-commit-stat-num--add">
                      +{f.added}
                    </span>
                  )}
                  {f.removed > 0 && (
                    <span className="tugx-commit-stat-num--del">
                      −{f.removed}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </BlockDisclosure>
      )}
    </div>
  );
}
