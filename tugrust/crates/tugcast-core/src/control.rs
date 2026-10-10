//! The CONTROL request vocabulary: every `action` a client may send on the
//! CONTROL feed that some part of tugcast dispatches on.
//!
//! Three places in tugcast answer a CONTROL request: the router itself
//! (`feed_stats`, `subscribe_feeds`), the agent supervisor's per-family
//! handlers, and the legacy `dispatch_action` pipeline. Each matches on
//! [`ControlAction`] rather than on a string literal, so the set of actions
//! tugcast understands is this one enum. An action string that does not parse
//! is not an error: `dispatch_action` re-broadcasts it on CONTROL, which is how
//! a client reaches another client without tugcast knowing the verb.
//!
//! The deck's side of the same vocabulary is `tugproto/src/control.ts`.

use std::fmt;
use std::str::FromStr;

macro_rules! control_actions {
    ($($variant:ident => $wire:literal,)+) => {
        /// A CONTROL request action tugcast dispatches on.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum ControlAction {
            $($variant,)+
        }

        impl ControlAction {
            /// Every action, in declaration order.
            pub const ALL: &'static [ControlAction] = &[$(ControlAction::$variant,)+];

            /// The action's wire spelling.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(ControlAction::$variant => $wire,)+
                }
            }
        }

        impl FromStr for ControlAction {
            type Err = UnknownControlAction;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($wire => Ok(ControlAction::$variant),)+
                    _ => Err(UnknownControlAction),
                }
            }
        }
    };
}

control_actions! {
    // Router-internal: answered on the connection, never forwarded.
    FeedStats => "feed_stats",
    SubscribeFeeds => "subscribe_feeds",

    // Supervisor: session lifecycle.
    SpawnSession => "spawn_session",
    CloseSession => "close_session",
    ResetSession => "reset_session",
    ListSessions => "list_sessions",
    ListCardBindings => "list_card_bindings",
    ResolveSessions => "resolve_sessions",
    RequestReplay => "request_replay",

    // Supervisor: arcs.
    BindArc => "bind_arc",
    ArcResume => "arc_resume",
    ArcRun => "arc_run",
    ArcStop => "arc_stop",
    UnbindArc => "unbind_arc",

    // Supervisor: changesets, landings and joins.
    ChangesetGitInit => "changeset_git_init",
    ChangesetCommit => "changeset_commit",
    ChangesetPush => "changeset_push",
    ChangesetClaim => "changeset_claim",
    ChangesetDisclaim => "changeset_disclaim",
    ChangesetRefresh => "changeset_refresh",
    ChangesetDraftRequest => "changeset_draft_request",
    ChangesetDraftCancel => "changeset_draft_cancel",
    ChangesetDraftSet => "changeset_draft_set",
    LandingReceipt => "landing_receipt",
    ChangesetJoin => "changeset_join",
    ChangesetJoinResolve => "changeset_join_resolve",
    ChangesetJoinResolveBase => "changeset_join_resolve_base",
    ChangesetJoinResolveBaseUndo => "changeset_join_resolve_base_undo",
    ChangesetJoinQuestionAnswer => "changeset_join_question_answer",
    ChangesetDiscard => "changeset_discard",
    ChangesetDeleteDocuments => "changeset_delete_documents",
    ChangesetReplay => "changeset_replay",

    // Supervisor: deck placement.
    DeckSeatings => "deck_seatings",
    DeckLog => "deck_log",

    // Supervisor: session rows.
    TrashSession => "trash_session",
    RenameSession => "rename_session",
    SetSessionPrivate => "set_session_private",
    TrashProjectDirSessions => "trash_project_dir_sessions",

    // Supervisor: telemetry records and reads.
    RecordTurnTelemetry => "record_turn_telemetry",
    RecordContextBreakdown => "record_context_breakdown",
    RecordSessionStateChange => "record_session_state_change",
    ListSessionStateChanges => "list_session_state_changes",
    ListDigestLines => "list_digest_lines",
    ListOverviewPosts => "list_overview_posts",
    ListShellExchanges => "list_shell_exchanges",
    ListRefs => "list_refs",

    // `dispatch_action`: replies to a `/api/eval` or an ask, settled by id.
    EvalResponse => "eval-response",
    AskResponse => "ask-response",

    // `dispatch_action`: host, auth, and Claude Code installation.
    Relaunch => "relaunch",
    CheckAuth => "check_auth",
    CheckHostTools => "check_host_tools",
    OfferHostTools => "offer_host_tools",
    InstallClaude => "install_claude",
    ClaudeDownloadResume => "claude_download_resume",
    ClaudeDownloadPause => "claude_download_pause",
    ClaudeDownloadCancel => "claude_download_cancel",
    CheckClaudeVersion => "check_claude_version",
    UpdateClaude => "update_claude",
    ClaudeSignIn => "claude_sign_in",
    ClaudeLogout => "claude_logout",
    SharedAgentClassify => "shared_agent_classify",
}

/// Actions tugcast dispatches that the deck never sends, each with the reason
/// it stays. The CONTROL drift test reads this beside [`ControlAction::ALL`].
pub const RUST_ONLY_ACTIONS: &[(ControlAction, &str)] = &[
    (
        ControlAction::Relaunch,
        "sent by app-tests and the UDS tell to restart the dev host; no deck control sends it",
    ),
    (
        ControlAction::FeedStats,
        "a router telemetry read for diagnostics; nothing in the deck asks for it",
    ),
    (
        ControlAction::SharedAgentClassify,
        "the shared agent's classify entry point, reached by tell; no deck control sends it",
    ),
];

/// Actions the deck sends that tugcast dispatches on nothing, each with the
/// reason it stays. Such an action falls through `dispatch_action`'s catch-all
/// and is re-broadcast on CONTROL. Empty: every deck action has a handler.
pub const DECK_ONLY_ACTIONS: &[(&str, &str)] = &[];

/// The error from parsing a string that names no [`ControlAction`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownControlAction;

impl fmt::Display for UnknownControlAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("unknown CONTROL action")
    }
}

impl std::error::Error for UnknownControlAction {}

impl fmt::Display for ControlAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashSet};
    use std::path::Path;

    #[test]
    fn every_action_round_trips_through_its_wire_spelling() {
        for &action in ControlAction::ALL {
            assert_eq!(action.as_str().parse::<ControlAction>(), Ok(action));
        }
    }

    #[test]
    fn wire_spellings_are_distinct() {
        let spellings: HashSet<&str> = ControlAction::ALL.iter().map(|a| a.as_str()).collect();
        assert_eq!(spellings.len(), ControlAction::ALL.len());
    }

    #[test]
    fn an_unknown_string_does_not_parse() {
        assert_eq!(
            "no_such_action".parse::<ControlAction>(),
            Err(UnknownControlAction)
        );
        assert_eq!(
            "spawn_session_ok".parse::<ControlAction>(),
            Err(UnknownControlAction)
        );
    }

    #[test]
    fn rust_only_actions_are_listed_once_with_a_reason() {
        let mut seen = HashSet::new();
        for (action, reason) in RUST_ONLY_ACTIONS {
            assert!(seen.insert(*action), "{action} listed twice");
            assert!(!reason.is_empty(), "{action} has no reason");
        }
    }

    /// The literals of `CONTROL_ACTIONS` in `tugproto/src/control.ts`, read as
    /// text: one `"action",` per line between the array's open and close.
    fn deck_actions() -> BTreeSet<String> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tugproto/src/control.ts");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let start = source
            .find("export const CONTROL_ACTIONS = [")
            .expect("control.ts declares CONTROL_ACTIONS");
        let body = &source[start..];
        let end = body
            .find("] as const;")
            .expect("CONTROL_ACTIONS closes with `] as const;`");
        body[..end]
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let inner = line.strip_prefix('"')?.strip_suffix("\",")?;
                Some(inner.to_owned())
            })
            .collect()
    }

    #[test]
    fn deck_and_tugcast_agree_on_the_control_vocabulary() {
        let deck = deck_actions();
        assert!(!deck.is_empty(), "no literals read from CONTROL_ACTIONS");
        let rust_only: BTreeSet<&str> = RUST_ONLY_ACTIONS.iter().map(|(a, _)| a.as_str()).collect();
        let deck_only: BTreeSet<&str> = DECK_ONLY_ACTIONS.iter().map(|(a, _)| *a).collect();
        let tugcast: BTreeSet<&str> = ControlAction::ALL.iter().map(|a| a.as_str()).collect();

        let unhandled: Vec<&str> = deck
            .iter()
            .map(String::as_str)
            .filter(|a| !tugcast.contains(a) && !deck_only.contains(a))
            .collect();
        let unsent: Vec<&str> = tugcast
            .iter()
            .copied()
            .filter(|a| !deck.contains(*a) && !rust_only.contains(a))
            .collect();
        assert!(
            unhandled.is_empty() && unsent.is_empty(),
            "CONTROL vocabulary drift.\n  deck sends, tugcast has no arm (add a ControlAction or a DECK_ONLY_ACTIONS reason): {unhandled:?}\n  tugcast dispatches, deck never sends (add to control.ts or a RUST_ONLY_ACTIONS reason): {unsent:?}"
        );

        // An allow-list entry the other side already covers is stale.
        let stale_rust_only: Vec<&str> = rust_only
            .iter()
            .copied()
            .filter(|a| deck.contains(*a))
            .collect();
        let stale_deck_only: Vec<&str> = deck_only
            .iter()
            .copied()
            .filter(|a| tugcast.contains(a) || !deck.contains(*a))
            .collect();
        assert!(
            stale_rust_only.is_empty() && stale_deck_only.is_empty(),
            "stale allow-list entries: RUST_ONLY {stale_rust_only:?}, DECK_ONLY {stale_deck_only:?}"
        );
    }
}
