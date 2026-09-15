/**
 * session-picker-notice-content — the picker notice's human copy.
 *
 * A pure mapper, in its own module so the picker form's module stays a
 * component-only Fast Refresh boundary: a `.tsx` exporting a function
 * alongside its components is mixed and non-accepting, which is why
 * `session-card-registration.tsx` exists and why this does.
 *
 * @module components/tugways/cards/session-picker-notice-content
 */

import type { TugInlineAlertTone } from "../tug-inline-alert";
import type { PickerNotice } from "@/lib/picker-notice-store";

/** Title + message + icon a picker notice renders as, for {@link TugInlineAlert}. */
export interface NoticeContent {
  title: string;
  message?: string;
  tone: TugInlineAlertTone;
  /** Lucide icon name. */
  icon: string;
}

/**
 * Map a picker notice to a human-centric title / message split for the inline
 * alert. `resume_failed` surfaces the *real* reason carried on `notice.message`
 * (from tugcode's `resume_failed` IPC) as the secondary line rather than
 * guessing a cause — the old copy asserted "deleted or in use elsewhere", which
 * was routinely false (the 2026-07-22 commit-xp session had a 40 MB transcript
 * sitting on disk). `restore_canceled` and `restore_timed_out` name the project
 * path from `staleProjectDir` so the user sees which card was affected. Falls
 * back to the raw `notice.message` as the title on unexpected shapes.
 */
export function noticeContent(notice: PickerNotice): NoticeContent {
  switch (notice.category) {
    case "resume_failed": {
      const reason = notice.message.trim();
      const hasReason =
        reason.length > 0 && reason.toLowerCase() !== "resume failed";
      return {
        title: "Couldn’t resume the previous session",
        message: hasReason
          ? `${reason}. Retry, or start a new session below.`
          : "Retry, or start a new session below.",
        tone: "caution",
        icon: "TriangleAlert",
      };
    }
    case "restore_canceled":
      return {
        title: "Resume canceled",
        message:
          notice.staleProjectDir !== undefined
            ? `You stopped restoring the session for ${notice.staleProjectDir}.`
            : notice.message,
        tone: "muted",
        icon: "Info",
      };
    case "restore_timed_out":
      return {
        title: "Couldn’t resume the previous session",
        message:
          "Restoring it took too long. The server may be unreachable — Retry, or start a new session below.",
        tone: "caution",
        icon: "TriangleAlert",
      };
    case "signed_out":
      return notice.message === "claude_missing"
        ? {
            title: "Claude Code isn’t available",
            message: "Finish setup, then pick a session below.",
            tone: "caution",
            icon: "TriangleAlert",
          }
        : {
            title: "You were signed out of Claude",
            message: "Log back in, then resume or start a session below.",
            tone: "caution",
            icon: "LogOut",
          };
    case "spawn_failed":
      // `message` already carries the human reason (from `spawnErrorMessage`).
      // The picker itself is the recovery — pick a directory that exists and
      // Open — so there's no separate action here.
      return {
        title: "Can’t open this project",
        message: `${notice.message} Choose a directory that exists below, then Open.`,
        tone: "danger",
        icon: "FolderX",
      };
    case "spawn_budget":
      // Deliberately does NOT steer at the picker. The host refused on its
      // own budget, so the project directory is fine and "choose a directory
      // that exists" — what `spawn_failed` says — would be false advice.
      // `message` carries which budget it was and what clears it.
      return {
        title: "Can’t start another session",
        message: notice.message,
        tone: "caution",
        icon: "TriangleAlert",
      };
    default:
      return { title: notice.message, tone: "muted", icon: "Info" };
  }
}
