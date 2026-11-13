/**
 * mentions.ts — the `@` provider a composer installs.
 *
 * A composer already has its file provider. This adds the two searched kinds
 * beside it and returns the merge, with the one release that lets go of what
 * the searched kinds hold on the wire ([L27]). The file provider is the
 * caller's and is not released here.
 *
 * @module components/tugways/cards/completion-providers/mentions
 */

import type { CompletionProvider } from "@/lib/tug-text-types";
import { createCommitMentionProvider } from "./commit-mentions";
import { mergeMentionProviders } from "./mention-merge";
import { createSessionMentionProvider } from "./session-mentions";

export interface MentionProviderOptions {
  /** The composer's own `@` file provider. */
  files: CompletionProvider;
  /**
   * The composer's project dir, read fresh on every query. An empty string
   * is a composer with no project of its own: commits are then the bootstrap
   * workspace's, and no session ranks ahead of another by project.
   */
  projectDir: () => string;
  /** The session the composer belongs to, or `null` when it has none. */
  ownSessionId: () => string | null;
}

export interface MentionProvider {
  provider: CompletionProvider;
  dispose(): void;
}

export function createMentionProvider(options: MentionProviderOptions): MentionProvider {
  const sessions = createSessionMentionProvider({
    projectDir: options.projectDir,
    ownSessionId: options.ownSessionId,
  });
  const commits = createCommitMentionProvider({ projectDir: options.projectDir });
  return {
    provider: mergeMentionProviders({
      files: options.files,
      sessions: sessions.provider,
      commits: commits.provider,
    }),
    dispose(): void {
      sessions.dispose();
      commits.dispose();
    },
  };
}
