//! The changeset family of CONTROL actions: the Changes card's commit, push,
//! claim and disclaim; the landing-draft requests; an arc's join, its resolve
//! ladder, discard, document delete and replay; the aggregate refresh nudge;
//! and the deck's `landing_receipt` diagnostic.

use super::super::*;

/// Parsed `changeset_commit` request: project dir, repo-relative file list,
/// commit message (Spec S03). The file list may parse empty — the handler
/// refuses it with a `changeset_commit_err` the card can render, rather than
/// a protocol error.
pub(in crate::feeds::agent_supervisor) struct ChangesetCommitPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) files: Vec<String>,
    pub(in crate::feeds::agent_supervisor) message: String,
    /// Optional session id for the `Tug-Session:` trailer (Spec S01). The
    /// trailer's display name is resolved from the ledger by id — the client
    /// stopped sending a `session_name` beside it.
    pub(in crate::feeds::agent_supervisor) session_id: Option<String>,
    /// Optional per-path hunk election (Spec S03): repo-relative path → the
    /// ids of the hunks to land. Absent means whole-file staging for every
    /// path, which is what every caller sent before hunks existed.
    pub(in crate::feeds::agent_supervisor) hunks: Option<BTreeMap<String, Vec<String>>>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_commit_payload(
    payload: &[u8],
) -> Result<ChangesetCommitPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let files = value
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or(ControlError::Malformed)?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or(ControlError::Malformed)
        })
        .collect::<Result<Vec<String>, ControlError>>()?;
    let message = value
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let session_id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let hunks = parse_hunk_election(&value, &files)?;
    Ok(ChangesetCommitPayload {
        project_dir,
        files,
        message,
        session_id,
        hunks,
    })
}

/// Parsed `changeset_push` request: the project to push and, optionally, the
/// session whose transcript the receipt row belongs to (Spec S03).
///
/// There is nothing to elect — a push sends the branch, and the branch is
/// whatever the checkout is on — so unlike the commit payload there is no file
/// list and no message.
pub(in crate::feeds::agent_supervisor) struct ChangesetPushPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) session_id: Option<String>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_push_payload(
    payload: &[u8],
) -> Result<ChangesetPushPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let session_id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(ChangesetPushPayload {
        project_dir,
        session_id,
    })
}

/// Read the optional `hunks` map (Spec S03) off a `changeset_commit` payload.
///
/// Every key must also appear in `files` — an election naming a path the
/// commit is not landing is a malformed request, not a silent no-op. An
/// absent or empty map reads as `None`, which keeps the whole-file path
/// byte-for-byte what it was.
fn parse_hunk_election(
    value: &serde_json::Value,
    files: &[String],
) -> Result<Option<BTreeMap<String, Vec<String>>>, ControlError> {
    let Some(raw) = value.get("hunks") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let object = raw.as_object().ok_or(ControlError::Malformed)?;
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (path, ids) in object {
        if !files.iter().any(|f| f == path) {
            return Err(ControlError::Malformed);
        }
        let ids = ids
            .as_array()
            .ok_or(ControlError::Malformed)?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or(ControlError::Malformed)
            })
            .collect::<Result<Vec<String>, ControlError>>()?;
        map.insert(path.clone(), ids);
    }
    Ok(if map.is_empty() { None } else { Some(map) })
}

/// A `changeset_claim` CONTROL request: a session claims the listed files
/// outright — the intentional promotion of files it touched but never
/// proof-edited (a `perl`/`sed` edit, a hand save) from "likely" hints into
/// its changeset. `session_id` is required (a claim is by a specific session);
/// `files` are repo-relative, exactly as the changeset surfaces them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::feeds::agent_supervisor) struct ChangesetClaimPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) session_id: String,
    pub(in crate::feeds::agent_supervisor) files: Vec<String>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_claim_payload(
    payload: &[u8],
) -> Result<ChangesetClaimPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let session_id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let files = value
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or(ControlError::Malformed)?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or(ControlError::Malformed)
        })
        .collect::<Result<Vec<String>, ControlError>>()?;
    Ok(ChangesetClaimPayload {
        project_dir,
        session_id,
        files,
    })
}

/// A `changeset_disclaim` CONTROL request: a session renounces the listed
/// files — the inverse of a claim. Same shape as the claim payload; the
/// session's own rows for those paths are deleted, so the file falls to
/// another live owner or to unattributed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::feeds::agent_supervisor) struct ChangesetDisclaimPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) session_id: String,
    pub(in crate::feeds::agent_supervisor) files: Vec<String>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_disclaim_payload(
    payload: &[u8],
) -> Result<ChangesetDisclaimPayload, ControlError> {
    let claim = parse_changeset_claim_payload(payload)?;
    Ok(ChangesetDisclaimPayload {
        project_dir: claim.project_dir,
        session_id: claim.session_id,
        files: claim.files,
    })
}

/// The commit message enriched with the session trailer pair ([P13], Spec
/// S03): `Tug-Session` carrying the human citation `<tag> (<shortid8>)` and
/// `Tug-Session-Id` the full uuid a reader joins against the ledger. Without a
/// session id the message is returned byte-for-byte. Idempotent via
/// `append_trailers`.
///
/// **The citation names the line, the id pins the segment.** A card that has
/// rotated through eight ids has one line of work, and a reader following a
/// commit back wants the conversation rather than whichever segment happened
/// to be seated — so the short id in parentheses is the line's. `Tug-Session-Id`
/// beside it is still the segment's full uuid, which is what opens the exact
/// transcript the commit was made from.
///
/// `tag` and `line_id` are resolved from the ledger by the caller, not taken
/// from the deck's payload — the ledger is the authority on a callsign, and
/// the deck may still be holding the optimistic one it minted at spawn. The
/// citation grammar itself lives in `tugchanges_core::session_citation`,
/// shared with the arc lane so the two can never drift.
pub(in crate::feeds::agent_supervisor) fn changeset_commit_message(
    request: &ChangesetCommitPayload,
    tag: Option<&str>,
    line_id: Option<&str>,
) -> String {
    let Some(id) = request.session_id.as_deref().filter(|s| !s.is_empty()) else {
        return request.message.clone();
    };
    let citation = tugchanges_core::session_citation(tag, line_id.unwrap_or(id));
    tugchanges_core::append_trailers(
        &request.message,
        &[("Tug-Session", &citation), ("Tug-Session-Id", id)],
    )
}

/// Parsed `changeset_draft_request` (Spec S01): the entry identity an on-demand
/// draft is requested for. `owner_id` may be empty (the unattributed pseudo-
/// entry), so it is not filtered non-empty. `force` is the confirmed
/// Regenerate — the only path that overwrites an edited draft ([P03]).
///
/// The project is named by `workspace_key`, the registry's canonical spelling
/// ([L29]) — never a `project_dir`, which is raw and has as many spellings as
/// the checkout has symlinks pointing at it.
pub(in crate::feeds::agent_supervisor) struct ChangesetDraftRequestPayload {
    pub(in crate::feeds::agent_supervisor) workspace_key: String,
    pub(in crate::feeds::agent_supervisor) owner_kind: String,
    pub(in crate::feeds::agent_supervisor) owner_id: String,
    pub(in crate::feeds::agent_supervisor) force: bool,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_draft_request_payload(
    payload: &[u8],
) -> Result<ChangesetDraftRequestPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let workspace_key = value
        .get("workspace_key")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_workspace_key",
        })?
        .to_string();
    let owner_kind = value
        .get("owner_kind")
        .and_then(|v| v.as_str())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let owner_id = value
        .get("owner_id")
        .and_then(|v| v.as_str())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let force = value
        .get("force")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(ChangesetDraftRequestPayload {
        workspace_key,
        owner_kind,
        owner_id,
        force,
    })
}

/// Parsed `changeset_draft_cancel` ([P06]): the entry identity whose in-flight
/// Auto-Message the user cancelled. Same identity shape as the request; no
/// force / message fields.
pub(in crate::feeds::agent_supervisor) struct ChangesetDraftCancelPayload {
    pub(in crate::feeds::agent_supervisor) workspace_key: String,
    pub(in crate::feeds::agent_supervisor) owner_kind: String,
    pub(in crate::feeds::agent_supervisor) owner_id: String,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_draft_cancel_payload(
    payload: &[u8],
) -> Result<ChangesetDraftCancelPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let workspace_key = value
        .get("workspace_key")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_workspace_key",
        })?
        .to_string();
    let owner_kind = value
        .get("owner_kind")
        .and_then(|v| v.as_str())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let owner_id = value
        .get("owner_id")
        .and_then(|v| v.as_str())
        .ok_or(ControlError::Malformed)?
        .to_string();
    Ok(ChangesetDraftCancelPayload {
        workspace_key,
        owner_kind,
        owner_id,
    })
}

/// Parsed `changeset_draft_set` (Spec S01): a partial upsert of one draft
/// row — the composer's debounced message edits, immediate selection-toggle
/// writes, and the post-landing `clear`. Absent fields leave the stored
/// value untouched; `selection: null` clears the overrides; `clear: true`
/// deletes the whole row.
pub(in crate::feeds::agent_supervisor) struct ChangesetDraftSetPayload {
    pub(in crate::feeds::agent_supervisor) workspace_key: String,
    pub(in crate::feeds::agent_supervisor) owner_kind: String,
    pub(in crate::feeds::agent_supervisor) owner_id: String,
    pub(in crate::feeds::agent_supervisor) message: Option<String>,
    /// `None` = field absent (keep); `Some(None)` = explicit null (clear);
    /// `Some(Some(json))` = replace with the serialized overrides.
    pub(in crate::feeds::agent_supervisor) selection: Option<Option<String>>,
    pub(in crate::feeds::agent_supervisor) edited: bool,
    pub(in crate::feeds::agent_supervisor) clear: bool,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_draft_set_payload(
    payload: &[u8],
) -> Result<ChangesetDraftSetPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let workspace_key = value
        .get("workspace_key")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_workspace_key",
        })?
        .to_string();
    let owner_kind = value
        .get("owner_kind")
        .and_then(|v| v.as_str())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let owner_id = value
        .get("owner_id")
        .and_then(|v| v.as_str())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let message = value
        .get("message")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let selection = value.get("selection").map(|v| {
        if v.is_null() {
            None
        } else {
            Some(v.to_string())
        }
    });
    let edited = value
        .get("edited")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let clear = value
        .get("clear")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(ChangesetDraftSetPayload {
        workspace_key,
        owner_kind,
        owner_id,
        message,
        selection,
        edited,
        clear,
    })
}

/// Parsed `changeset_join` request (Spec S03): the project checkout, the arc
/// name, an optional strategy (`squash`|`merge`|`rebase`, default squash), an
/// optional override message, and whether this is an in-memory `--preview`.
pub(in crate::feeds::agent_supervisor) struct ChangesetJoinPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) arc: String,
    pub(in crate::feeds::agent_supervisor) strategy: tugarc_core::JoinStrategy,
    pub(in crate::feeds::agent_supervisor) message: Option<String>,
    pub(in crate::feeds::agent_supervisor) preview: bool,
    /// A pre-resolved candidate commit to land ([P31]/[P32], Spec S12): when
    /// present the join takes its resolved bytes instead of merging the arc
    /// branch, staleness-guarded by ancestry. `strategy` still decides the
    /// shape — a candidate never turns a squash into anything else.
    pub(in crate::feeds::agent_supervisor) candidate: Option<String>,
    /// Resume an interrupted teardown from the journal (Spec S04).
    pub(in crate::feeds::agent_supervisor) continue_join: bool,
    /// The calling card's tug session id, for the receipt's shell-ledger row
    /// ([P06]). Absent, the landing still succeeds and leaves no receipt.
    pub(in crate::feeds::agent_supervisor) session_id: Option<String>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_join_payload(
    payload: &[u8],
) -> Result<ChangesetJoinPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let arc = value
        .get("arc")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let strategy = match value.get("strategy").and_then(|v| v.as_str()) {
        None | Some("squash") => tugarc_core::JoinStrategy::Squash,
        Some("merge") => tugarc_core::JoinStrategy::Merge,
        Some("rebase") => tugarc_core::JoinStrategy::Rebase,
        Some(_) => return Err(ControlError::Malformed),
    };
    let message = value
        .get("message")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let preview = value
        .get("preview")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let candidate = value
        .get("candidate")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let continue_join = value
        .get("continue")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let session_id = parse_optional_session_id(&value);
    Ok(ChangesetJoinPayload {
        project_dir,
        arc,
        strategy,
        message,
        preview,
        candidate,
        continue_join,
        session_id,
    })
}

/// The optional `session_id` the landing verbs carry for their receipt row
/// ([P06]). Missing or empty is not an error — the receipt is simply skipped.
fn parse_optional_session_id(value: &serde_json::Value) -> Option<String> {
    value
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// Parsed `changeset_join_resolve` request (Spec S12): the project checkout and
/// the arc name.
pub(in crate::feeds::agent_supervisor) struct ChangesetJoinResolvePayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) arc: String,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_join_resolve_payload(
    payload: &[u8],
) -> Result<ChangesetJoinResolvePayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let arc = value
        .get("arc")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    Ok(ChangesetJoinResolvePayload { project_dir, arc })
}

/// Parsed `changeset_join_question_answer` request ([P06]): the user's answer
/// to a resolver escalation.
///
/// The `request_id` is what makes the answer safe: a resolve that already
/// expired, or a second one raised since, must not be resolved by an answer to
/// a different question.
pub(in crate::feeds::agent_supervisor) struct ChangesetJoinQuestionAnswerPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) arc: String,
    pub(in crate::feeds::agent_supervisor) request_id: String,
    /// An option label or free text — handed to the resolver verbatim.
    pub(in crate::feeds::agent_supervisor) answer: String,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_join_question_answer_payload(
    payload: &[u8],
) -> Result<ChangesetJoinQuestionAnswerPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let field = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or(ControlError::Malformed)
    };
    Ok(ChangesetJoinQuestionAnswerPayload {
        project_dir,
        arc: field("arc")?,
        request_id: field("request_id")?,
        answer: field("answer")?,
    })
}

/// Parsed `changeset_discard` request: the project checkout and the arc name.
pub(in crate::feeds::agent_supervisor) struct ChangesetDiscardPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) arc: String,
    /// The calling card's tug session id, for the receipt's row ([P06]).
    pub(in crate::feeds::agent_supervisor) session_id: Option<String>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_discard_payload(
    payload: &[u8],
) -> Result<ChangesetDiscardPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let arc = value
        .get("arc")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let session_id = parse_optional_session_id(&value);
    Ok(ChangesetDiscardPayload {
        project_dir,
        arc,
        session_id,
    })
}

/// Parsed `changeset_delete_documents` request: the project checkout and the
/// arc whose paperwork is to go. Shaped exactly like the discard's, because
/// the two are the same round trip over a different verb — and deliberately
/// *not* routed through it ([B05]).
pub(in crate::feeds::agent_supervisor) struct ChangesetDeleteDocumentsPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) arc: String,
    /// The calling card's tug session id, for the receipt's row ([P06]).
    pub(in crate::feeds::agent_supervisor) session_id: Option<String>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_delete_documents_payload(
    payload: &[u8],
) -> Result<ChangesetDeleteDocumentsPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let arc = value
        .get("arc")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let session_id = parse_optional_session_id(&value);
    Ok(ChangesetDeleteDocumentsPayload {
        project_dir,
        arc,
        session_id,
    })
}

/// Parsed `changeset_replay` request: the project checkout and the arc name.
pub(in crate::feeds::agent_supervisor) struct ChangesetReplayPayload {
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) arc: String,
    /// The calling card's tug session id, for the outcome's notice.
    pub(in crate::feeds::agent_supervisor) session_id: Option<String>,
}

pub(in crate::feeds::agent_supervisor) fn parse_changeset_replay_payload(
    payload: &[u8],
) -> Result<ChangesetReplayPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let arc = value
        .get("arc")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let session_id = parse_optional_session_id(&value);
    Ok(ChangesetReplayPayload {
        project_dir,
        arc,
        session_id,
    })
}

/// One land press, as the deck reported it, ready to be written down.
///
/// The deck's own log dies with a reload, and the 2026-08-17 incident contained
/// one — so the only durable record an instance has of a landing gesture is
/// this crate's log. What lands here is what the deck's land gate actually
/// judged: the press, its verdict, and the inputs behind it.
pub(in crate::feeds::agent_supervisor) struct LandingReceiptPayload {
    pub(in crate::feeds::agent_supervisor) kind: String,
    pub(in crate::feeds::agent_supervisor) verdict: String,
    pub(in crate::feeds::agent_supervisor) reason: String,
    pub(in crate::feeds::agent_supervisor) gate: String,
}

/// Read a receipt without ever refusing one.
///
/// Every field is optional and a missing one logs as `-`. A receipt that could
/// be rejected would be a diagnostic with a failure mode of its own, and the
/// press it describes has already happened either way.
pub(in crate::feeds::agent_supervisor) fn parse_landing_receipt_payload(
    payload: &[u8],
) -> LandingReceiptPayload {
    let value: serde_json::Value =
        serde_json::from_slice(payload).unwrap_or(serde_json::Value::Null);
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("-")
            .to_string()
    };
    let gate = value
        .get("gate")
        .map(|g| g.to_string())
        .unwrap_or_else(|| "-".to_string());
    LandingReceiptPayload {
        kind: field("kind"),
        verdict: field("verdict"),
        reason: field("reason"),
        gate,
    }
}

impl AgentSupervisor {
    pub(in crate::feeds::agent_supervisor) async fn handle_changeset_control(
        &self,
        action: &str,
        payload: &[u8],
    ) -> ControlOutcome {
        let result: Result<(), ControlError> = match action {
            "changeset_git_init" => match parse_project_dir_payload(payload) {
                Ok(project_dir) => {
                    self.do_changeset_git_init(&project_dir).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "changeset_commit" => match parse_changeset_commit_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_commit(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "changeset_push" => match parse_changeset_push_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_push(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            // Claim and disclaim return their reply body: the WebSocket
            // ingress ignores it (the body was already broadcast on CONTROL),
            // and the `/api/tell` bridge hands it back over HTTP so the CLI
            // reports the actual outcome rather than inferring one from 200.
            "changeset_claim" => match parse_changeset_claim_payload(payload) {
                Ok(parsed) => {
                    let reply = self.do_changeset_claim(&parsed).await;
                    return ControlOutcome::HandledWith(reply);
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "changeset_disclaim" => match parse_changeset_disclaim_payload(payload) {
                Ok(parsed) => {
                    let reply = self.do_changeset_disclaim(&parsed).await;
                    return ControlOutcome::HandledWith(reply);
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            // Side-effect-free recompute nudge: fire the aggregate bump so an
            // open project re-scans its working tree. Emission is diff-
            // suppressed, so this is observable only when the tree actually
            // drifted from the cached snapshot (an orphan created while no FS
            // event landed) — the Changes shade fires it on open so looking is
            // always fresh. No payload, no reply.
            "changeset_refresh" => {
                self.registry.changeset_all_bump().notify_one();
                Ok(())
            }
            "changeset_draft_request" => match parse_changeset_draft_request_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_draft_request(&parsed);
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "changeset_draft_cancel" => match parse_changeset_draft_cancel_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_draft_cancel(&parsed);
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "changeset_draft_set" => match parse_changeset_draft_set_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_draft_set(&parsed);
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "landing_receipt" => {
                let receipt = parse_landing_receipt_payload(payload);
                tracing::info!(
                    kind = %receipt.kind,
                    verdict = %receipt.verdict,
                    reason = %receipt.reason,
                    gate = %receipt.gate,
                    "landing-receipt"
                );
                Ok(())
            }
            "changeset_join" => match parse_changeset_join_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_join(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "changeset_join_resolve" => match parse_changeset_join_resolve_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_join_resolve(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            // The base-side resolve, which is a different act from the one
            // above: that reconciles a conflicted merge, this clears the
            // uncommitted base work refusing the merge in the first place.
            // They share a payload shape and nothing else.
            "changeset_join_resolve_base" => match parse_changeset_join_resolve_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_join_resolve_base(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            // And its reversal, offered beside the fold's own receipt. It
            // shares the payload shape for the same reason: one act, one arc,
            // named the same way.
            "changeset_join_resolve_base_undo" => {
                match parse_changeset_join_resolve_payload(payload) {
                    Ok(parsed) => {
                        self.do_changeset_join_resolve_base_undo(&parsed).await;
                        Ok(())
                    }
                    Err(e) => return ControlOutcome::Error(e),
                }
            }
            "changeset_join_question_answer" => {
                match parse_changeset_join_question_answer_payload(payload) {
                    Ok(parsed) => {
                        self.do_changeset_join_question_answer(&parsed);
                        Ok(())
                    }
                    Err(e) => return ControlOutcome::Error(e),
                }
            }
            "changeset_discard" => match parse_changeset_discard_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_discard(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "changeset_delete_documents" => {
                match parse_changeset_delete_documents_payload(payload) {
                    Ok(parsed) => {
                        self.do_changeset_delete_documents(&parsed).await;
                        Ok(())
                    }
                    Err(e) => return ControlOutcome::Error(e),
                }
            }
            "changeset_replay" => match parse_changeset_replay_payload(payload) {
                Ok(parsed) => {
                    self.do_changeset_replay(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            _ => return ControlOutcome::PassThrough,
        };

        match result {
            Ok(()) => ControlOutcome::Handled,
            Err(e) => ControlOutcome::Error(e),
        }
    }

    /// Handle a `changeset_git_init` CONTROL request (Spec S07): `git init
    /// -b main` a non-repo project the changeset card offered to initialize.
    ///
    /// Guards, in order: `project_dir` must match a current
    /// `WorkspaceRegistry` entry (never init an arbitrary path off the wire),
    /// and it must not already be inside a git working tree. On success the
    /// process-global aggregate bump is fired so the card's section
    /// self-heals to a clean repo on the next recompute — there is no
    /// client-side state transition. Broadcasts `changeset_git_init_ok` /
    /// `changeset_git_init_err {detail}`.
    async fn do_changeset_git_init(&self, project_dir: &str) {
        let dir = std::path::Path::new(project_dir);

        // Guard 1: only an open workspace may be initialized.
        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_git_init_err(&self.control_tx, project_dir, "not an open project");
            return;
        }

        // Guard 2: refuse a directory already inside a git working tree.
        if crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_git_init_err(
                &self.control_tx,
                project_dir,
                "already a git repository",
            );
            return;
        }

        let output = tokio::process::Command::from(tugcore::git_command())
            .arg("-C")
            .arg(dir)
            .args(["init", "-b", "main"])
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                // The next aggregate recompute sees a repo and the section
                // flips to a clean changeset — self-healing, no client flip.
                self.registry.changeset_all_bump().notify_one();
                Self::send_changeset_git_init_ok(&self.control_tx, project_dir);
            }
            Ok(out) => {
                let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Self::send_changeset_git_init_err(
                    &self.control_tx,
                    project_dir,
                    if detail.is_empty() {
                        "git init failed"
                    } else {
                        &detail
                    },
                );
            }
            Err(e) => {
                Self::send_changeset_git_init_err(&self.control_tx, project_dir, &e.to_string());
            }
        }
    }

    /// A `tug_session_id` → `claude_session_id` lookup over the in-memory
    /// ledger, for anything that needs to find a session's JSONL.
    ///
    /// Sync over the tokio async mutex: `try_lock` never blocks — under rare
    /// contention it degrades to "no claude id", which callers treat as missing
    /// context rather than as an error.
    pub fn session_resolver(&self) -> crate::feeds::draft_engine::SessionResolver {
        let inmem = Arc::clone(&self.ledger);
        Arc::new(move |tug_id: &str| {
            let map = inmem.try_lock().ok()?;
            let entry = map.get(&TugSessionId(tug_id.to_string()))?;
            let entry = entry.try_lock().ok()?;
            entry.claude_session_id.clone()
        })
    }

    /// Handle a `changeset_draft_request` CONTROL request ([P03], Spec S01): an
    /// explicit, on-demand commit-message draft for one changeset entry.
    ///
    /// Resolves the entry against the latest CHANGESET_ALL aggregate frame (the
    /// stored watch receiver) and spawns its generation on a detached task —
    /// this method NEVER awaits the scribe run, so the router's per-client
    /// socket loop stays live to deliver the streamed deltas (R02). It does
    /// nothing when the scribe, the read-side ledger, or the aggregate watch
    /// isn't wired (tests without the draft path) — but never *silently*:
    /// every exit from this method broadcasts a `changeset_draft_state
    /// { state: "error" }` naming what went wrong ([Q02], [L31]). The
    /// unmatched-owner case is the engine's own answer, which names the owner
    /// it could not place ([B04]).
    fn do_changeset_draft_request(&self, request: &ChangesetDraftRequestPayload) {
        // Every guard below answers before it returns ([L31]). A draft request
        // that falls out of this function in silence leaves the shade's
        // Auto-Message button idle forever with nothing anywhere saying why —
        // no frame for the deck, no line in the log — which is the failure
        // this arc exists to close, and the four bare `return`s that used to
        // stand here were the likeliest source of it.
        let Some(scribe) = self.scribe.clone() else {
            warn!("changeset draft request: no scribe configured");
            Self::send_changeset_draft_error(
                &self.control_tx,
                request,
                "Couldn't reach the scribe: this instance has none configured.",
            );
            return;
        };
        let Some(ledger) = self.session_ledger.clone() else {
            warn!("changeset draft request: no session ledger");
            Self::send_changeset_draft_error(
                &self.control_tx,
                request,
                "Couldn't reach the scribe: this instance has no session ledger.",
            );
            return;
        };
        let Some(watch_rx) = self.changeset_watch.get() else {
            warn!("changeset draft request: changeset watch not yet armed");
            Self::send_changeset_draft_error(
                &self.control_tx,
                request,
                "The changeset hasn't been composed yet — try again in a moment.",
            );
            return;
        };
        let frame = watch_rx.borrow().clone();
        let Ok(snapshot) = serde_json::from_slice::<tugcast_core::types::WorkspacesChangesetSnapshot>(
            &frame.payload,
        ) else {
            // The initial empty frame, or a decode miss.
            warn!("changeset draft request: changeset snapshot did not decode");
            Self::send_changeset_draft_error(
                &self.control_tx,
                request,
                "The changeset hasn't been composed yet — try again in a moment.",
            );
            return;
        };

        let resolver = self.session_resolver();

        // The engine answers its own miss, naming the owner it could not place
        // ([B04]) — so there is nothing to add here and a second frame would
        // only overwrite the better sentence with a vaguer one.
        crate::feeds::draft_engine::spawn_on_demand_draft(
            self.control_tx.clone(),
            ledger,
            Arc::clone(&self.registry),
            scribe,
            resolver,
            &self.draft_tasks,
            snapshot,
            &request.workspace_key,
            &request.owner_kind,
            &request.owner_id,
            request.force,
        );
    }

    /// Handle a `changeset_draft_cancel` CONTROL request ([P06]): the user
    /// cancelled an in-flight Auto-Message (the Z5 cancel button, Escape, or
    /// Cmd-.). Aborts the entry's live generation task — killing only its
    /// headless scribe child — and broadcasts a terminal `cancelled` state so
    /// the composer drops the wave caret and re-opens for typing.
    ///
    /// The `cancelled` broadcast is unconditional. Cancel is idempotent: a
    /// client whose overlay says `drafting` after this registry lost the task
    /// (a crashed generation, a terminal frame the deck never received) has no
    /// other exit, and answering only when a task existed leaves that client's
    /// composer read-only forever. A late cancel racing a just-landed `ready`
    /// folds the overlay to idle, which reads the persisted draft — harmless.
    fn do_changeset_draft_cancel(&self, request: &ChangesetDraftCancelPayload) {
        crate::feeds::draft_engine::cancel_draft(
            &self.draft_tasks,
            &request.workspace_key,
            &request.owner_kind,
            &request.owner_id,
        );
        crate::feeds::draft_engine::send_draft_cancelled(
            &self.control_tx,
            &request.workspace_key,
            &request.owner_kind,
            &request.owner_id,
        );
    }

    /// Handle a `changeset_draft_set` CONTROL request (Spec S01): a partial
    /// upsert of one draft row — message edits, selection dispositions, or
    /// the post-landing `clear`. The row is keyed by the request's canonical
    /// `workspace_key`, which is what every draft row is keyed by; the global
    /// aggregate bump fires so the next frame carries the change.
    fn do_changeset_draft_set(&self, request: &ChangesetDraftSetPayload) {
        let Some(ledger) = self.session_ledger.clone() else {
            return;
        };
        if request.clear {
            log_ledger_err(
                "delete_changeset_draft",
                &format!(
                    "{}:{} in {}",
                    request.owner_kind, request.owner_id, request.workspace_key
                ),
                ledger.delete_changeset_draft(
                    &request.owner_kind,
                    &request.owner_id,
                    &request.workspace_key,
                ),
            );
            self.registry.changeset_all_bump().notify_one();
            return;
        }
        let existing = crate::feeds::draft_engine::read_draft(
            &ledger,
            &request.owner_kind,
            &request.owner_id,
            &request.workspace_key,
        );
        let (fingerprint, prior_message, prior_edited, prior_selection) = existing
            .map(|e| (e.fingerprint, e.message, e.edited, e.selection))
            .unwrap_or_default();
        let row = crate::session_ledger::ChangesetDraftRow {
            owner_kind: request.owner_kind.clone(),
            owner_id: request.owner_id.clone(),
            project_dir: request.workspace_key.clone(),
            fingerprint,
            message: request.message.clone().unwrap_or(prior_message),
            updated_at: crate::feeds::draft_engine::now_millis(),
            // Monotonic through this verb: a human touch pins the draft;
            // only a confirmed forced regenerate resets it ([P03]).
            edited: request.edited || prior_edited,
            selection: match &request.selection {
                Some(replacement) => replacement.clone(),
                None => prior_selection,
            },
        };
        if let Err(err) = ledger.upsert_changeset_draft(&row) {
            warn!(error = %err, "changeset_draft_set: persist failed");
            return;
        }
        self.registry.changeset_all_bump().notify_one();
    }

    /// Broadcast a `changeset_draft_state` error for a request that matched no
    /// eligible entry ([Q02]) — the same wire shape the generation task's
    /// `send_state` emits, down to the `workspace_key` identity, so the client
    /// overlay renders it identically and, crucially, receives it at all.
    fn send_changeset_draft_error(
        control_tx: &broadcast::Sender<Frame>,
        request: &ChangesetDraftRequestPayload,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_draft_state",
            "workspace_key": request.workspace_key,
            "owner_kind": request.owner_kind,
            "owner_id": request.owner_id,
            "state": "error",
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_draft_state serializes"),
        ));
    }

    /// Handle a `changeset_commit` CONTROL request (Spec S03, [P15]):
    /// commit exactly the listed files in an open project's checkout.
    ///
    /// Guards, in order: `project_dir` must match a current
    /// `WorkspaceRegistry` entry (never run git against an arbitrary path
    /// off the wire) and must lie inside a git working tree. The git work —
    /// pathspec-exact staging + commit, empty-list/blank-message refusal —
    /// lives in `run_changeset_commit`. On success the process-global
    /// aggregate bump fires so the card's entries drop the committed files
    /// on the next recompute, and `changeset_commit_ok {sha, receipt}` goes
    /// out; failures broadcast `changeset_commit_err {detail}`.
    pub(in crate::feeds::agent_supervisor) async fn do_changeset_commit(
        &self,
        request: &ChangesetCommitPayload,
    ) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_commit_err(&self.control_tx, project_dir, "not an open project");
            return;
        }
        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_commit_err(&self.control_tx, project_dir, "not a git repository");
            return;
        }

        // The callsign comes from the ledger, never from the payload — the
        // deck may still be holding the optimistic tag it minted at spawn.
        // The row's callsign and `line_id` are the line's ([P02]), so a commit
        // made inside an arc stage cites the line of work rather than the
        // segment; `Tug-Session-Id` beside it still pins the exact transcript.
        let identity = request
            .session_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|id| self.session_ledger.as_ref().map(|l| (l, id)))
            .and_then(|(ledger, id)| match ledger.get(id) {
                Ok(row) => row.map(|r| (r.tag, r.line_id)),
                Err(err) => {
                    warn!(error = %err, session_id = id, "ledger read for commit trailer failed");
                    None
                }
            });
        let tag = identity.as_ref().and_then(|(tag, _)| tag.as_deref());
        let line_id = identity
            .as_ref()
            .map(|(_, line_id)| line_id.as_str())
            .filter(|s| !s.is_empty());
        let message = changeset_commit_message(request, tag, line_id);
        match crate::feeds::changeset::run_changeset_commit(
            dir,
            &request.files,
            &message,
            request.hunks.clone(),
        )
        .await
        {
            Ok(receipt) => {
                self.registry.changeset_all_bump().notify_one();
                let summary = crate::feeds::changeset::format_commit_summary(
                    &receipt.sha,
                    &message,
                    &receipt.files,
                );
                // Persist the landing to the shell ledger so the transcript's
                // commit row survives Maker ▸ Reload and cold boot (restored via
                // `list_shell_exchanges`, [P07]). Only when the deck passed a
                // `session_id` to key the row; a ledger error warns but never
                // fails the commit (R02). No live SHELL frame is emitted — the
                // initiating client paints the live row from `summary` on the
                // `_ok`; other decks converge on their next restore.
                let receipt_id = Self::record_landing_receipt(
                    self.shell_ledger.as_ref(),
                    self.session_ledger.as_ref(),
                    request.session_id.as_deref(),
                    "/commit",
                    &summary,
                    project_dir,
                );
                // The landing's file list, projected once: the fact write and
                // the fact send below both want it, and the receipt is
                // thrown away after the broadcast ([P03]).
                let files: Vec<String> = receipt.files.iter().map(|f| f.path.clone()).collect();
                // The commit as a fact ([P08]). This is the one durable moment
                // that knows the sha, the message, and the file list together
                // without re-running git — today the receipt is built here and
                // thrown away after the broadcast. It is also the whole of
                // what any fact reader sees: recording the fact is the
                // whole of it, so there is no second send.
                if let Some(sessions) = self.session_ledger.as_ref() {
                    let fact = crate::feeds::facts_library::commit_fact(
                        crate::session_ledger::now_millis(),
                        request.session_id.as_deref().filter(|s| !s.is_empty()),
                        &receipt.sha,
                        &message,
                        &files,
                        Some(&receipt.numstat),
                        tugarc_core::ops::current_branch(dir).ok().as_deref(),
                    );
                    if let Err(e) = sessions.record_fact(&fact) {
                        warn!(error = %e, "commit fact write failed");
                    }
                }
                let body = serde_json::json!({
                    "action": "changeset_commit_ok",
                    "project_dir": project_dir,
                    "sha": receipt.sha,
                    "receipt": receipt.numstat,
                    "summary": summary,
                    "receipt_id": receipt_id,
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("changeset_commit_ok serializes"),
                ));
            }
            Err(detail) => {
                Self::send_changeset_commit_err(&self.control_tx, project_dir, &detail);
            }
        }
    }

    fn send_changeset_commit_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_commit_err",
            "project_dir": project_dir,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_commit_err serializes"),
        ));
    }

    /// Handle a `changeset_push` CONTROL request (Spec S03): push the open
    /// project's current branch to `origin` and leave a durable receipt.
    ///
    /// The same two guards as the commit path, in the same order and for the
    /// same reason — never run git against an arbitrary path off the wire, and
    /// never against something that is not a working tree. The git work, and
    /// every refusal that can be read before the network is touched, lives in
    /// `run_changeset_push`. On success the aggregate bump fires so the next
    /// recompute reads `ahead: 0`, the receipt is persisted to the shell
    /// ledger so the transcript row survives a reload, and
    /// `changeset_push_ok` goes out; failures broadcast `changeset_push_err`.
    ///
    /// No fact is recorded. A commit is a fact because it is a thing that now
    /// exists and can be cited; a push moved commits that were already facts,
    /// and the receipt is the whole of what it has to say.
    async fn do_changeset_push(&self, request: &ChangesetPushPayload) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_push_err(&self.control_tx, project_dir, "not an open project");
            return;
        }
        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_push_err(&self.control_tx, project_dir, "not a git repository");
            return;
        }

        match crate::feeds::changeset::run_changeset_push(dir).await {
            Ok(receipt) => {
                // The push moved the upstream, so `ahead` is now 0 and every
                // consumer of it — the shade's badge, the commit receipt's
                // offer — should stop showing a push to make.
                self.registry.changeset_all_bump().notify_one();
                let summary = crate::feeds::changeset::format_push_summary(&receipt);
                let receipt_id = Self::record_landing_receipt(
                    self.shell_ledger.as_ref(),
                    self.session_ledger.as_ref(),
                    request.session_id.as_deref(),
                    "/push",
                    &summary,
                    project_dir,
                );
                let body = serde_json::json!({
                    "action": "changeset_push_ok",
                    "project_dir": project_dir,
                    "summary": summary,
                    "receipt_id": receipt_id,
                    "branch": receipt.branch,
                    "upstream": receipt.upstream,
                    "commits": receipt.commits,
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("changeset_push_ok serializes"),
                ));
            }
            Err(detail) => {
                Self::send_changeset_push_err(&self.control_tx, project_dir, &detail);
            }
        }
    }

    fn send_changeset_push_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_push_err",
            "project_dir": project_dir,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_push_err serializes"),
        ));
    }

    /// Handle a `changeset_claim` CONTROL request: a session claims the listed
    /// files outright, promoting them from "likely" hints (a `perl`/`sed` edit
    /// or a hand save that only left a bracket correlation) into its changeset.
    /// Writes one proof-grade `claim` file event per path, then fires the
    /// process-global aggregate bump so the rows move into the session's entry
    /// on the next recompute. `changeset_claim_ok {claimed}` goes out on
    /// success; `changeset_claim_err {detail}` on a failed guard.
    ///
    /// Guards mirror the other changeset verbs: `project_dir` must be a current
    /// `WorkspaceRegistry` entry. Idempotent — re-claiming writes another proof
    /// row, which composes identically.
    async fn do_changeset_claim(&self, request: &ChangesetClaimPayload) -> serde_json::Value {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            return Self::send_changeset_claim_err(
                &self.control_tx,
                project_dir,
                "not an open project",
            );
        }
        let Some(ledger) = self.session_ledger.as_ref() else {
            return Self::send_changeset_claim_err(&self.control_tx, project_dir, "no ledger");
        };

        let canonical = crate::path_resolver::CanonicalPath::from_raw(dir);
        // The card claims files by their repo-relative key, which passes
        // straight through; the root is what an absolute spelling is measured
        // against, so a claim can no more name a file outside the repo than a
        // captured tool call can.
        let repo_root = crate::feeds::attribution::repo_root_for(dir).await;
        let at = crate::session_ledger::now_millis();
        // A claim is a user gesture in this session — proof of activity.
        // Revive a row the startup demote closed, or the fresh claim rows
        // land under a "dead" owner and the next recompose lifts every one
        // of them straight back into `orphaned` — the treadmill this verb
        // exists to end.
        if let Err(err) = ledger.revive_on_activity(&request.session_id, at) {
            warn!(
                error = %err,
                session_id = %request.session_id,
                "changeset_claim revive_on_activity failed"
            );
        }
        // The claimant is a **line** of work ([P01]), not the one segment id
        // the request arrived under: the fresh rows are written under the
        // line's seat segment (the id everything else answers for the line
        // with), and the sever below keeps every id the line has ever worn,
        // so a claim never severs the claimant's own older rows. A session
        // this ledger has never lined stays keyed by its raw id.
        let line = ledger
            .line_of(&request.session_id)
            .and_then(|line_id| ledger.line_ownership(&line_id).ok().flatten());
        let write_id = line
            .as_ref()
            .map(|l| l.seat_id.clone())
            .unwrap_or_else(|| request.session_id.clone());
        let mut keep_ids: Vec<String> = vec![write_id.clone()];
        if let Some(l) = &line {
            keep_ids.extend(l.segment_ids.iter().filter(|id| **id != l.seat_id).cloned());
        }
        if !keep_ids.contains(&request.session_id) {
            keep_ids.push(request.session_id.clone());
        }
        // One synthetic tool_use_id groups the batch, mirroring how a Bash
        // call's N rows share an id.
        let tool_use_id = format!("claim:{at}");
        let mut rows = Vec::with_capacity(request.files.len());
        for path in &request.files {
            let Some(file_path) = crate::feeds::attribution::repo_relative_key(
                repo_root.as_deref(),
                std::path::Path::new(path),
            ) else {
                warn!(
                    project_dir,
                    path, "changeset_claim path outside the repo; skipped"
                );
                continue;
            };
            rows.push(crate::session_ledger::FileEventRow {
                tug_session_id: write_id.clone(),
                tool_use_id: tool_use_id.clone(),
                file_path,
                tool_name: "Claim".to_string(),
                op: "claimed".to_string(),
                origin: "claim".to_string(),
                ambiguous: false,
                parent_tool_use_id: None,
                project_dir: canonical.as_str().to_string(),
                at,
            });
        }
        // A claim is a whole-file assertion by hand — the user is saying the
        // file is theirs, not which regions of it are — so every claimed row
        // carries a `whole` span, which widens its owner to the whole file at
        // read time ([P12]).
        let spans: Vec<Vec<crate::session_ledger::FileEventSpan>> = rows
            .iter()
            .map(|_| vec![crate::feeds::attribution::whole_span()])
            .collect();
        // The whole gesture is one journaled, transactional batch: `claimed`
        // is the mapped row count or zero, never a partial tally the deck
        // has to interpret.
        let claimed = match ledger.record_file_events_with_spans(&rows, &spans) {
            Ok(()) => rows.len(),
            Err(err) => {
                warn!(error = %err, project_dir, "changeset_claim batch failed");
                0
            }
        };

        // Sever any prior owner ([D120]): a claim asserts sole ownership, so
        // remove other sessions' rows for these paths — a dead originator can't
        // silently re-own the file on re-open, and it leaves the orphaned
        // bucket. The kept set is the claimant's whole line — its fresh rows
        // AND everything written under ids it has since rotated away from.
        // A batch that did not land claims nothing, so it severs nothing.
        if claimed > 0 {
            if let Err(err) =
                ledger.sever_file_ownership_except(canonical.as_str(), &request.files, &keep_ids)
            {
                warn!(error = %err, project_dir, "changeset_claim sever failed");
            }
        }

        self.registry.changeset_all_bump().notify_one();
        // Honesty check: a claim whose claimant this instance's ledger has
        // never seen (a cross-instance or mistyped `--session`) will read as
        // a dead owner on the very next recompose and its files re-orphan.
        // The rows are still written — `changes.db` is machine-global and
        // another instance may hold the session — but the reply must say so
        // rather than hand back a green count that undoes itself ([D120]).
        // The judgment is the line's: any segment live, or any segment
        // seated on an open card, and the claim will hold on the next
        // recompose — even when the id the request arrived under is itself
        // a demoted older segment.
        let claimant = ledger.get(&request.session_id).ok().flatten();
        let claimant_live = line.as_ref().map(|l| l.any_live).unwrap_or(false)
            || claimant
                .as_ref()
                .is_some_and(|r| r.state == crate::session_ledger::SessionState::Live);
        let seated = crate::feeds::deck_seatings::seated_session_ids();
        let claimant_seated = keep_ids.iter().any(|id| seated.contains(id));
        let warning = if claimed == 0 {
            None
        } else if claimant.is_none() && line.is_none() && !claimant_seated {
            Some(format!(
                "session {} is unknown to this instance's ledger; \
                 the claimed files may surface as orphaned here",
                request.session_id
            ))
        } else if !claimant_live && !claimant_seated {
            Some(format!(
                "session {} is closed and seated on no card; \
                 the claimed files will surface as orphaned until it reopens",
                request.session_id
            ))
        } else {
            None
        };
        let body = serde_json::json!({
            "action": "changeset_claim_ok",
            "project_dir": project_dir,
            "claimed": claimed,
            "warning": warning,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_claim_ok serializes"),
        ));
        body
    }

    /// Broadcast a claim error on CONTROL and return the body, so the
    /// `/api/tell` bridge can hand the same reply to an HTTP caller.
    fn send_changeset_claim_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        detail: &str,
    ) -> serde_json::Value {
        let body = serde_json::json!({
            "action": "changeset_claim_err",
            "project_dir": project_dir,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_claim_err serializes"),
        ));
        body
    }

    /// Handle a `changeset_disclaim` CONTROL request: a session renounces the
    /// listed files, the inverse of a claim. Every row the session holds for
    /// those paths — proof and bracket alike — is deleted in one journaled
    /// record, then the aggregate bump fires so the file re-buckets on the next
    /// recompute: to the other live owner if there is one (which also clears
    /// the SHARED marking), otherwise to unattributed.
    ///
    /// Guards mirror claim: `project_dir` must be a current `WorkspaceRegistry`
    /// entry, a ledger must be present, and each path maps through
    /// `repo_relative_key` with skip-and-warn. Idempotent — disclaiming a file
    /// the session no longer holds deletes nothing and still replies ok.
    async fn do_changeset_disclaim(&self, request: &ChangesetDisclaimPayload) -> serde_json::Value {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            return Self::send_changeset_disclaim_err(
                &self.control_tx,
                project_dir,
                "not an open project",
            );
        }
        let Some(ledger) = self.session_ledger.as_ref() else {
            return Self::send_changeset_disclaim_err(&self.control_tx, project_dir, "no ledger");
        };

        let canonical = crate::path_resolver::CanonicalPath::from_raw(dir);
        let repo_root = crate::feeds::attribution::repo_root_for(dir).await;
        // A disclaim is a user gesture in this session, same as a claim —
        // revive a demoted row so the session's remaining files keep a live
        // owner on the recompose this gesture triggers.
        if let Err(err) =
            ledger.revive_on_activity(&request.session_id, crate::session_ledger::now_millis())
        {
            warn!(
                error = %err,
                session_id = %request.session_id,
                "changeset_disclaim revive_on_activity failed"
            );
        }
        let mut paths = Vec::with_capacity(request.files.len());
        for path in &request.files {
            let Some(file_path) = crate::feeds::attribution::repo_relative_key(
                repo_root.as_deref(),
                std::path::Path::new(path),
            ) else {
                warn!(
                    project_dir,
                    path, "changeset_disclaim path outside the repo; skipped"
                );
                continue;
            };
            paths.push(file_path);
        }

        // The renouncing owner is a line ([P01]): expand the incoming id to
        // every segment the line has worn, so a disclaim empties the whole
        // line's hold on the paths — not just the slice written under the
        // current id, which would leave an older segment silently re-owning
        // the file on the next recompose.
        let mut renouncing_ids: Vec<String> = vec![request.session_id.clone()];
        if let Some(l) = ledger
            .line_of(&request.session_id)
            .and_then(|line_id| ledger.line_ownership(&line_id).ok().flatten())
        {
            renouncing_ids.extend(
                l.segment_ids
                    .into_iter()
                    .filter(|id| *id != request.session_id),
            );
        }
        let disclaimed =
            match ledger.disclaim_file_ownership(canonical.as_str(), &paths, &renouncing_ids) {
                Ok(deleted) => deleted,
                Err(err) => {
                    warn!(error = %err, project_dir, "changeset_disclaim failed");
                    return Self::send_changeset_disclaim_err(
                        &self.control_tx,
                        project_dir,
                        &err.to_string(),
                    );
                }
            };

        self.registry.changeset_all_bump().notify_one();
        let body = serde_json::json!({
            "action": "changeset_disclaim_ok",
            "project_dir": project_dir,
            "disclaimed": disclaimed,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_disclaim_ok serializes"),
        ));
        body
    }

    /// Broadcast a disclaim error on CONTROL and return the body, so the
    /// `/api/tell` bridge can hand the same reply to an HTTP caller.
    fn send_changeset_disclaim_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        detail: &str,
    ) -> serde_json::Value {
        let body = serde_json::json!({
            "action": "changeset_disclaim_err",
            "project_dir": project_dir,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_disclaim_err serializes"),
        ));
        body
    }

    /// Handle a `changeset_join` CONTROL request (Spec S03, [P14]): preview or
    /// execute an arc join via `tugarc-core`.
    ///
    /// Guards match the other changeset verbs: `project_dir` must be a current
    /// `WorkspaceRegistry` entry (never touch an arbitrary path off the wire)
    /// and must be a git working tree. The join itself runs on a blocking
    /// thread (synchronous git subprocesses). A `--preview` mutates nothing and
    /// reports conflicts in memory; a real join that lands a commit fires the
    /// process-global aggregate bump so the arc entry drops from the card on
    /// the next recompute. Broadcasts `changeset_join_ok {…JoinOutcome}` /
    /// `changeset_join_err {detail}`.
    ///
    /// Returns whether a commit actually landed, which is a different fact
    /// from "the request was answered": a preview and a conflict-aborted join
    /// both report `ok` and land nothing. The prompt-answer path reads it to
    /// decide whether the ask it consumed should stay consumed ([P07]).
    async fn do_changeset_join(&self, request: &ChangesetJoinPayload) -> bool {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_join_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not an open project",
            );
            return false;
        }
        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_join_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not a git repository",
            );
            return false;
        }

        // The first word of the run, spoken the moment the handler accepts the
        // press (Spec S01). Everything between here and `join_in`'s own
        // `squash` beat — two synchronous git reads, occupancy, and the whole
        // of the join's preflight inside `spawn_blocking` — took real seconds
        // and narrated none of them. A preview narrates nothing at all, which
        // is the contract `join_in_with_progress` already keeps.
        if !request.preview {
            Self::send_changeset_join_land_delta(
                &self.control_tx,
                project_dir,
                &request.arc,
                "preflight",
                "start",
            );
        }

        // Resolve the arc's identity BEFORE the join runs. `join_in` ends in
        // `git branch -D`, which deletes `branch.tugarc/<name>.tugid` along
        // with the branch — a key read afterwards is the legacy one and names
        // none of the id-keyed rows this landing has to sweep ([L23], [P05],
        // Risk R02).
        let owner_key = tugarc_core::ops::arc_owner_key(dir, &request.arc);
        // The round count belongs to the receipt, and a landed join deletes the
        // branch it is counted from — so it is read here, for the same reason
        // the owner key is.
        let rounds = tugarc_core::arc_detail_entries_in(dir)
            .into_iter()
            .find(|d| d.name == request.arc)
            .map(|d| d.rounds)
            .unwrap_or(0);
        // And the arc's record, for the same reason and at the same moment:
        // the receipt folds the document, the stages and the plan behind the
        // `Joined` boundary ([B02], [B03]), and `read_arc` applies the log's
        // generation reset — so a read taken after the join, whose own
        // terminal line is already appended, comes back with nothing.
        let arc_record = tugarc_core::read_arc(dir, &request.arc);

        // A join tears the workshop down and deletes the branch under it, so it
        // cannot share the arc with a resolve or a verification (Spec S01). A
        // **preview** touches nothing and never takes the arc — it is the one
        // join shape that is safe to ask for mid-run, and the face asks for it
        // constantly.
        let _occupancy = if request.preview {
            None
        } else {
            match crate::feeds::join_occupancy::acquire(
                &owner_key,
                crate::feeds::join_occupancy::JoinRunKind::Join,
                None,
            ) {
                Ok(guard) => Some(guard),
                Err(detail) => {
                    Self::send_changeset_join_err(
                        &self.control_tx,
                        project_dir,
                        &request.arc,
                        &detail,
                    );
                    return false;
                }
            }
        };

        let dir_owned = dir.to_path_buf();
        let arc = request.arc.clone();
        let opts = tugarc_core::JoinOptions {
            strategy: request.strategy,
            message: request.message.clone(),
            preview: request.preview,
            continue_join: request.continue_join,
            candidate: request.candidate.clone(),
            origin: Some("card".to_string()),
            // Who landed it. tugcast is nobody's session, so the pressing
            // card's id is the only way the squash commit can name the session
            // beside the arc — the two pills a joined commit's History row
            // shows ([P10], Spec S03).
            session_id: request.session_id.clone(),
            // The card has no gesture for breaking a lease, and tugcast's own
            // guard is exact: a card join that reaches the lease refusal is by
            // definition a resolve in another process ([P04], [P05]).
            break_lease: false,
        };
        // The join's own narration ([P03]). It takes real seconds and used to
        // say nothing for all of them — the press landed and the next word was
        // the durable commit message, however long later. These frames are a
        // **liveness hint only**: the `changeset_all_bump()` below stays the
        // carrier of truth, exactly as it already is on the resolve path, so a
        // dropped beat costs the progress line and nothing else.
        let beat_tx = self.control_tx.clone();
        let beat_project_dir = project_dir.to_string();
        let beat_arc = request.arc.clone();
        let result = tokio::task::spawn_blocking(move || {
            tugarc_core::join_in_with_progress(&dir_owned, &arc, opts, |beat, status| {
                Self::send_changeset_join_land_delta(
                    &beat_tx,
                    &beat_project_dir,
                    &beat_arc,
                    beat,
                    status,
                );
            })
        })
        .await;

        match result {
            Ok(Ok(outcome)) => {
                // One line per landing, so a join is attributable afterwards
                // without archaeology. The two joins of 2026-08-15 left no
                // trace in any log, which is why the next incident report was
                // an investigation rather than a read.
                tracing::info!(
                    arc = %outcome.name,
                    base = %outcome.base_branch,
                    previewed = outcome.previewed,
                    commit = outcome.commit_hash.as_deref().unwrap_or("-"),
                    conflicts = outcome.conflicts.len(),
                    blockers = %outcome
                        .blockers
                        .iter()
                        .map(|b| b.kind.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                    "arc-join: completed"
                );
                // A real join that landed a commit shrinks the changeset set —
                // refresh the card. A preview (or a conflict-aborted join)
                // mutated nothing, so no bump. The landed arc's join draft
                // dies with it ([P14]).
                let landed = !outcome.previewed && outcome.commit_hash.is_some();
                if landed {
                    if let Some(ledger) = self.session_ledger.as_deref() {
                        Self::clear_arc_draft(ledger, project_dir, &owner_key);
                        // The arc the sessions were mated to no longer
                        // exists ([P05]) — release every binding to it.
                        log_ledger_err(
                            "clear_arc_bindings_for_arc",
                            &owner_key,
                            ledger.clear_arc_bindings_for_arc(&owner_key),
                        );
                    }
                    self.registry.changeset_all_bump().notify_one();
                }
                // The landing's receipt (Spec S01) — server-formatted, so the
                // durable row and the live one are the same bytes.
                let mut receipt_id: Option<i64> = None;
                let summary = match (&outcome.commit_hash, outcome.previewed) {
                    (Some(sha), false) => {
                        // The file list is the landing commit against its first
                        // parent, which is only the whole join under `squash`.
                        // A merge landing sha is a merge commit (git suppresses
                        // its diff) and a rebase landing sha is the tip of a
                        // replayed chain — one round. Either would put a list
                        // on the receipt that reads as complete while being
                        // partial, so those strategies carry no list at all.
                        let files = if outcome.strategy == "squash" {
                            crate::feeds::changeset::landing_file_stats(
                                std::path::Path::new(project_dir),
                                sha,
                            )
                            .await
                        } else {
                            Vec::new()
                        };
                        // The join's commit as a fact, exactly as the commit
                        // path records its own: a join is a commit made through
                        // Tug, and recording the fact is the whole of what a
                        // fact reader sees — one that saw `/commit` and not
                        // `/arc-join` would be watching half the landings. The
                        // initiating session is the fact's session; the branch is
                        // the base the join landed on. No numstat here — the
                        // list above is `--stat` shaped, and under any strategy
                        // but `squash` it is empty for the reason given there.
                        if let Some(sessions) = self.session_ledger.as_ref() {
                            let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
                            let fact = crate::feeds::facts_library::commit_fact(
                                crate::session_ledger::now_millis(),
                                request.session_id.as_deref().filter(|s| !s.is_empty()),
                                sha,
                                outcome.message.as_deref().unwrap_or(""),
                                &paths,
                                None,
                                Some(&outcome.base_branch),
                            );
                            if let Err(e) = sessions.record_fact(&fact) {
                                warn!(error = %e, "join commit fact write failed");
                            }
                        }
                        let summary = crate::feeds::changeset::format_join_summary(
                            &crate::feeds::changeset::JoinSummary {
                                sha,
                                arc: &outcome.name,
                                base: &outcome.base_branch,
                                rounds,
                                message: outcome.message.as_deref().unwrap_or(""),
                                files: &files,
                                fit: outcome.fit.as_ref(),
                                record: arc_record.as_ref(),
                            },
                        );
                        receipt_id = Self::record_landing_receipt(
                            self.shell_ledger.as_ref(),
                            self.session_ledger.as_ref(),
                            request.session_id.as_deref(),
                            "/arc-join",
                            &summary,
                            project_dir,
                        );
                        Some(summary)
                    }
                    _ => None,
                };
                let mut body = serde_json::json!({
                    "action": "changeset_join_ok",
                    "project_dir": project_dir,
                    "arc": request.arc,
                    "name": outcome.name,
                    "base_branch": outcome.base_branch,
                    "strategy": outcome.strategy,
                    "commit_hash": outcome.commit_hash,
                    "conflicts": outcome.conflicts,
                    "previewed": outcome.previewed,
                    "summary": summary,
                    // The ledger row the summary was persisted as ([P06]) —
                    // the identity the initiating deck paints its live receipt
                    // under, so a later restore settles that row instead of
                    // seating a second copy of the same landing.
                    "receipt_id": receipt_id,
                    "warnings": outcome.warnings,
                });
                // Additive, exactly as `JoinOutcome` serializes it: the key is
                // absent rather than `[]` when nothing blocks (Spec S03).
                if !outcome.blockers.is_empty()
                    && let Ok(blockers) = serde_json::to_value(&outcome.blockers)
                {
                    body["blockers"] = blockers;
                }
                // Same additive shape: the base-side history behind each
                // conflicted path, present only on a conflicted preview.
                if !outcome.archaeology.is_empty()
                    && let Ok(archaeology) = serde_json::to_value(&outcome.archaeology)
                {
                    body["archaeology"] = archaeology;
                }
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("changeset_join_ok serializes"),
                ));
                landed
            }
            Ok(Err(detail)) => {
                tracing::info!(arc = %request.arc, detail = %detail, "arc-join: refused");
                Self::send_changeset_join_err(&self.control_tx, project_dir, &request.arc, &detail);
                false
            }
            Err(join_err) => {
                Self::send_changeset_join_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &format!("join task failed: {join_err}"),
                );
                false
            }
        }
    }

    /// Persist a landing receipt to the shell ledger ([P06]), the same way the
    /// commit landing does: the row is what makes the transcript's receipt
    /// survive Maker ▸ Reload and cold boot. A missing `session_id` or a
    /// missing ledger skips it — the receipt records the verb, it never gates
    /// it — and a ledger error warns rather than failing the landing.
    ///
    /// Returns the ledger row's `id` when one was written. It rides the `_ok`
    /// frame back to the initiating deck, which paints its live copy of the
    /// receipt under that identity — so the live row and the row a later
    /// restore replays are the same transcript turn, not two copies of one
    /// landing. `None` means nothing was persisted and the deck falls back to
    /// a local identity.
    /// `sessions` is what keys the row to the *line of work* rather than to a
    /// session id that a later rewind-fork will supersede. The deck stays bound
    /// to a forked session's parent until the next relaunch, so without this
    /// resolution a landing recorded in that window lands under an id nothing
    /// will ever ask about again.
    pub(in crate::feeds::agent_supervisor) fn record_landing_receipt(
        ledger: Option<&Arc<crate::shell_ledger::ShellLedger>>,
        sessions: Option<&Arc<crate::session_ledger::SessionLedger>>,
        session_id: Option<&str>,
        command: &str,
        summary: &str,
        cwd: &str,
    ) -> Option<i64> {
        let (Some(session_id), Some(ledger)) = (session_id.filter(|s| !s.is_empty()), ledger)
        else {
            return None;
        };
        // The receipt is the **line's** ([P09]); a line-less session keys
        // under its own id.
        let line_id = sessions
            .and_then(|sessions| sessions.line_of(session_id))
            .unwrap_or_else(|| session_id.to_string());
        let session_id = session_id.to_string();
        // The anchor is the turn this receipt follows in the transcript the
        // deck will replay. `session_id` here is the card's own id — the
        // line's *first* segment once the Wheel has rotated it — and the
        // ledger resolves it to the line's live head before reading a file,
        // so a join landed after three rotations seats after the audit's last
        // word and not after the door's. `cwd` is the landing's project dir,
        // which locates that file.
        let anchor_msg_id =
            sessions.and_then(|s| s.latest_assistant_msg_id(&session_id, Some(cwd)));
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        match ledger.record_exchange(&crate::shell_ledger::NewShellExchange {
            tug_session_id: session_id.clone(),
            line_id,
            command: command.to_string(),
            output: summary.to_string(),
            exit_code: Some(0),
            cwd: cwd.to_string(),
            cwd_after: None,
            started_at_ms: now,
            settled_at_ms: now,
            anchor_msg_id,
        }) {
            Ok(id) => Some(id),
            Err(e) => {
                warn!(error = %e, command, "failed to persist a landing to the shell ledger");
                None
            }
        }
    }

    fn send_changeset_join_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_join_err",
            "project_dir": project_dir,
            "arc": arc,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_join_err serializes"),
        ));
    }

    /// Broadcast one join progress beat. A liveness hint only: the
    /// `changeset_all_bump()` a landing ends with stays the carrier of truth,
    /// so a dropped beat costs the progress line and nothing else. The
    /// `project_dir` is echoed verbatim as the request sent it, which is what
    /// keeps the frame correlated to the cell the press opened with no
    /// spelling to reconcile ([L29]).
    fn send_changeset_join_land_delta(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        beat: &str,
        status: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_join_land_delta",
            "project_dir": project_dir,
            "arc": arc,
            "beat": beat,
            "status": status,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_join_land_delta serializes"),
        ));
    }

    /// Handle a `changeset_join_resolve` CONTROL request (Spec S12, [P31]/[P32]):
    /// run the tugarc-core resolution ladder with the scribe AI rung injected,
    /// streaming per-file progress. The ladder builds a candidate commit off to
    /// the side; the card reviews it and lands it via a follow-up
    /// `changeset_join {candidate}`. Broadcasts the terminal
    /// `changeset_join_resolve_ok {…ResolveOutcome}` /
    /// `changeset_join_resolve_err {detail}`.
    async fn do_changeset_join_resolve(&self, request: &ChangesetJoinResolvePayload) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_join_resolve_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not an open project",
            );
            return;
        }
        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_join_resolve_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not a git repository",
            );
            return;
        }

        // Take the arc before anything git-shaped happens (Spec S01). A second
        // Resolve press — the shape the false error face used to invite — would
        // otherwise start a second `finish_join` doing `reset --hard` on the
        // workshop the first one's resolver is editing.
        let owner_key = tugarc_core::ops::arc_owner_key(dir, &request.arc);
        // Snapshotted here so a question this run raises stays matched to the
        // head it was raised against, even if a round lands on the arc while
        // the resolver waits for the answer.
        let arc_head = tugarc_core::ops::arc_detail_entry_in(dir, &request.arc)
            .and_then(|detail| tugarc_core::ops::rev_parse(dir, &detail.branch).ok());
        let occupancy = match crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::Resolve,
            arc_head,
        ) {
            Ok(guard) => guard,
            Err(detail) => {
                Self::send_changeset_join_admission_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &detail,
                );
                return;
            }
        };

        self.run_resolve_ladder(project_dir, &request.arc, occupancy)
            .await;
    }

    /// The resolution ladder itself, from the scribe rung through the
    /// resolver's audit, ending at an anchored candidate.
    ///
    /// Shared by the `changeset_join_resolve` CONTROL handler and the join
    /// pilot ([P01]), so a reconcile the machine started and one the user
    /// started are literally the same run — the same scribe rung, the same
    /// audit, the same verdict. A second implementation for the pilot would be
    /// two ladders drifting apart, which is exactly what the arc cannot afford:
    /// the whole promise is that what the machine did unprompted is what the
    /// user would have got by pressing.
    ///
    /// **Admission belongs to the caller.** By the time control arrives here
    /// the project has been validated and the arc has been taken through
    /// `join_occupancy`; the guard is handed in and the hold travels with the
    /// work from this point, releasing on every exit including a panic.
    pub(in crate::feeds::agent_supervisor) async fn run_resolve_ladder(
        &self,
        project_dir: &str,
        arc_name: &str,
        occupancy: crate::feeds::join_occupancy::JoinOccupancy,
    ) {
        let dir = std::path::Path::new(project_dir);

        // Build the AI rung from the scribe context when one is configured;
        // without it the ladder runs its algorithmic rungs only.
        let merger =
            self.scribe
                .as_ref()
                .map(|scribe| crate::feeds::join_resolve::ScribeFileMerger {
                    spawner: scribe.spawner.clone(),
                    model: scribe.model.clone(),
                    handle: tokio::runtime::Handle::current(),
                    control_tx: self.control_tx.clone(),
                    project_dir: project_dir.to_string(),
                    arc: arc_name.to_string(),
                });

        // The `run` fact is what makes a reload mid-resolve land on a face that
        // still says the resolve is running, so it goes out before the work.
        self.registry.changeset_all_bump().notify_one();

        let dir_owned = dir.to_path_buf();
        let arc = arc_name.to_string();
        let result = tokio::task::spawn_blocking(move || {
            // Last attempt's refusal stops applying the moment this one starts;
            // leaving it standing would render a running resolve under the
            // sentence that ended the one before it.
            tugarc_core::resolve::clear_stuck(&dir_owned, &arc);
            let merger_ref = merger.as_ref().map(|m| m as &dyn tugarc_core::FileMerger);
            tugarc_core::resolve_conflicts(&dir_owned, &arc, merger_ref)
        })
        .await;

        // The ladder's git effects — the candidate ref and its marks — are
        // written by now on every arm, win or lose. Firing the recompute here
        // rather than only on success is what makes the CONTROL reply below a
        // liveness hint instead of the only carrier of the result: CONTROL is
        // droppable by design, and a dropped `_ok` used to lose a real
        // candidate forever. Now it costs the spinner and nothing else.
        self.registry.changeset_all_bump().notify_one();

        match result {
            Ok(Ok(outcome)) => {
                tracing::info!(
                    arc = %arc_name,
                    shape = ?outcome.shape,
                    resolved = outcome.resolved.len(),
                    unresolved = outcome.unresolved.len(),
                    candidate = outcome.candidate_commit.as_deref().unwrap_or("-"),
                    "arc-join: ladder ran"
                );

                // The resolver finishes what the ladder left **and audits what
                // it decided** ([P10]) — so it runs whenever the machine
                // decided anything, including on a ladder that resolved
                // everything. A machine resolution nobody read is the failure
                // class the retired review gate existed for; skipping the audit
                // when the ladder happened to succeed would drop that guarantee
                // rather than relocate it.
                //
                // The trigger is the **audit set** — the paths the squash would
                // have conflicted over, plus whatever the ladder resolved or
                // left — rather than the ladder's exit shape. An arc whose
                // squash conflicts but whose rounds replay cleanly returns both
                // lists empty with a candidate in hand, which is precisely the
                // 2026-08-15 incident shape: a wholesale machine decision that
                // builds green, passing unread.
                let audit_set = crate::feeds::join_resolver::audit_set(&outcome);
                if !audit_set.is_empty() {
                    let ctx = crate::feeds::join_resolver::ResolverContext {
                        repo: dir.to_path_buf(),
                        arc: arc_name.to_string(),
                        project_dir: project_dir.to_string(),
                        model: match &self.scribe {
                            Some(scribe) => scribe.model.clone(),
                            None => Arc::new(|| "sonnet".to_string()),
                        },
                        control_tx: self.control_tx.clone(),
                        bump: self.registry.changeset_all_bump(),
                        // A build with a scribe wired is a build with a real
                        // model available; one without has no business
                        // spawning one, and says so rather than reaching.
                        production: self.scribe.as_ref().map(|_| {
                            Arc::new(crate::feeds::join_resolver::ClaudeJoinResolverSpawner)
                                as Arc<dyn crate::feeds::join_resolver::JoinResolverSpawner>
                        }),
                    };

                    // **Detached, and that is not an optimization.** The
                    // resolver may block on an escalation for as long as the
                    // user takes to answer it, and the answer arrives as
                    // another CONTROL request — so awaiting the flow here would
                    // hold the control path against the very message that
                    // unblocks it. A join waiting on a question would wait
                    // forever, by construction.
                    //
                    // Nothing is lost by returning early, because nothing here
                    // was the result: the candidate, the report, and the
                    // verdict are git facts the feed recomputes from, and the
                    // deltas keep the face moving meanwhile ([P09]).
                    let control_tx = self.control_tx.clone();
                    let bump = self.registry.changeset_all_bump();
                    let dir_owned = dir.to_path_buf();
                    let arc = arc_name.to_string();
                    let project_dir_owned = project_dir.to_string();
                    let outcome_owned = outcome.clone();
                    tokio::spawn(async move {
                        // The hold travels with the work, not with this
                        // handler: the resolve is only over when the detached
                        // task is, and it releases on every exit including a
                        // panic.
                        let _occupancy = occupancy;
                        match crate::feeds::join_resolver::finish_join(&ctx, &outcome_owned).await {
                            Ok(()) => {
                                bump.notify_one();
                                // The resolver finished what the ladder left,
                                // so the ladder's `unresolved` list is no
                                // longer true of anything — and the client
                                // reads a non-empty one as the ladder's dead
                                // end ("still conflicting — resolve by hand").
                                // Reporting the outcome unamended would name
                                // files the resolve just settled.
                                let mut settled = outcome_owned.clone();
                                settled.unresolved.clear();
                                Self::send_changeset_join_resolve_ok(
                                    &control_tx,
                                    &project_dir_owned,
                                    &arc,
                                    &settled,
                                );
                            }
                            Err(detail) => {
                                Self::record_join_stuck(&dir_owned, &arc, &detail);
                                bump.notify_one();
                                tracing::info!(arc = %arc, detail = %detail, "arc-join: resolver stuck");
                                Self::send_changeset_join_resolve_err(
                                    &control_tx,
                                    &project_dir_owned,
                                    &arc,
                                    &detail,
                                );
                            }
                        }
                    });
                    return;
                }

                Self::send_changeset_join_resolve_ok(
                    &self.control_tx,
                    project_dir,
                    arc_name,
                    &outcome,
                );

                // A clean ladder pass ends here. The candidate it produced used
                // to be handed straight to the project's checks, on the theory
                // that a merge with no conflicting file can still fail to
                // build. It can — but the run's ending is where that is asked
                // now, against the tree that will actually land, so the
                // reconcile's job is done the moment the candidate stands.
                drop(occupancy);
            }
            Ok(Err(detail)) => {
                tracing::info!(arc = %arc_name, detail = %detail, "arc-join: ladder refused");
                Self::send_changeset_join_resolve_err(
                    &self.control_tx,
                    project_dir,
                    arc_name,
                    &detail,
                );
            }
            Err(join_err) => {
                Self::send_changeset_join_resolve_err(
                    &self.control_tx,
                    project_dir,
                    arc_name,
                    &format!("resolve task failed: {join_err}"),
                );
            }
        }
    }

    /// Handle a `changeset_join_question_answer` CONTROL request ([P06]):
    /// hand the user's answer to whichever resolve is blocked on it.
    ///
    /// Synchronous, and deliberately: the answer's whole job is to unblock a
    /// task already waiting, and the reply says only whether it reached one.
    /// An answer that reaches nobody — the question expired, the resolve died
    /// — is reported as a refusal with its reason, never swallowed ([L31]).
    fn do_changeset_join_question_answer(&self, request: &ChangesetJoinQuestionAnswerPayload) {
        let delivered = crate::feeds::join_resolver::answer_question(
            &request.request_id,
            request.answer.clone(),
        );
        let body = if delivered {
            serde_json::json!({
                "action": "changeset_join_question_answer_ok",
                "project_dir": request.project_dir,
                "arc": request.arc,
                "request_id": request.request_id,
            })
        } else {
            serde_json::json!({
                "action": "changeset_join_question_answer_err",
                "project_dir": request.project_dir,
                "arc": request.arc,
                "request_id": request.request_id,
                "detail": "that question is no longer waiting for an answer — resolve the join again",
            })
        };
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_join_question_answer reply serializes"),
        ));
        self.registry.changeset_all_bump().notify_one();
    }

    /// The run's terminal frame: the ladder's outcome, plus who it is about.
    ///
    /// The outcome is serialized whole rather than summarized, which is what
    /// keeps the card's overlay able to say "still conflicting on b.rs" — the
    /// one terminal fact the feed genuinely cannot state, because the arc's
    /// conflicts look identical whether or not a run just tried them.
    fn send_changeset_join_resolve_ok(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        outcome: &tugarc_core::ResolveOutcome,
    ) {
        let mut body = serde_json::to_value(outcome).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(map) = body.as_object_mut() {
            map.insert(
                "action".into(),
                serde_json::Value::String("changeset_join_resolve_ok".into()),
            );
            map.insert(
                "project_dir".into(),
                serde_json::Value::String(project_dir.to_string()),
            );
            map.insert("arc".into(), serde_json::Value::String(arc.to_string()));
        }
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_join_resolve_ok serializes"),
        ));
    }

    /// Record why a resolve stopped, against the arc head it ran on.
    ///
    /// CONTROL carries the same sentence back as `_err`, but CONTROL is
    /// droppable by design — a dropped frame would leave the face with a join
    /// that will not proceed and no account of why. The durable fact is what
    /// the board renders; the frame is the liveness hint.
    fn record_join_stuck(dir: &std::path::Path, arc: &str, detail: &str) {
        let Ok(head) = tugarc_core::ops::rev_parse(dir, &format!("tugarc/{arc}")) else {
            return;
        };
        tugarc_core::resolve::write_stuck(dir, arc, &head, detail);
    }

    /// Refuse a resolve **before it started**, without disturbing the run that
    /// is the reason for the refusal (Spec S01).
    ///
    /// The distinction is the `admission` flag, and it is load-bearing: this
    /// reply arrives on the same `(project_dir, arc)` cell the live run is
    /// streaming into, so a client that read it as an ordinary failure would
    /// paint the healthy run it was refused *in favour of* as dead — turning a
    /// harmless double press into the false error face this round removes.
    fn send_changeset_join_admission_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_join_resolve_err",
            "project_dir": project_dir,
            "arc": arc,
            "detail": detail,
            "admission": true,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_join_resolve_err serializes"),
        ));
    }

    /// Clear the base-side work refusing an arc's join ([`resolve_base_in`]).
    ///
    /// It reports on the same two frames the ladder's resolve uses, because
    /// the card is showing one register and a second vocabulary for "the
    /// resolve finished" would be a second thing to keep in step. The bump is
    /// what makes the outcome visible: the blockers are never cached, so one
    /// recompute is the whole of the update.
    async fn do_changeset_join_resolve_base(&self, request: &ChangesetJoinResolvePayload) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_join_resolve_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not an open project",
            );
            return;
        }

        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_join_resolve_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not a git repository",
            );
            return;
        }

        // Take the arc before anything git-shaped happens (Spec S01). The fold
        // commits on the base and rewrites the paths it folded; a second press
        // landing under the first would fold a tree mid-commit.
        let owner_key = tugarc_core::ops::arc_owner_key(dir, &request.arc);
        let occupancy = match crate::feeds::join_occupancy::acquire(
            &owner_key,
            crate::feeds::join_occupancy::JoinRunKind::ResolveBase,
            None,
        ) {
            Ok(guard) => guard,
            Err(detail) => {
                Self::send_changeset_join_admission_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &detail,
                );
                return;
            }
        };

        // A hold nobody samples is a hold nobody has. `run_kind` is an
        // in-process registry read that only a recompute reaches, and this
        // handler's own bump fires *after* the fold — so with nothing here
        // `join.run` would go from absent to absent and no surface would ever
        // see `resolve-base`. `run_resolve_ladder` says it for its own hold and
        // it is the same reason: the `run` fact is what makes a reload mid-act
        // land on a face that still says the act is running, so it goes out
        // before the work.
        self.registry.changeset_all_bump().notify_one();

        // The attribution the blockers were composed from, read again here
        // rather than trusted from the press: the card's copy is as old as its
        // last recompute, and a session that has since put its hand on the
        // path must still be named in the fold and told about it.
        let live = crate::feeds::changeset::live_base_dirt_for(
            dir,
            &request.arc,
            self.session_ledger.as_deref(),
        )
        .await;
        let live_dirt: std::collections::BTreeMap<String, String> = live
            .iter()
            .map(|(path, (_, name))| (path.clone(), name.clone()))
            .collect();

        let dir_owned = dir.to_path_buf();
        let arc = request.arc.clone();
        let result = tokio::task::spawn_blocking(move || {
            // The hold travels with the work and is released when the fold
            // returns, whichever way it returns — including a panic, which is
            // why it is a guard rather than a pair of calls. It has to be gone
            // before the bump below: that recompute is the one that removes the
            // blocker, and a run still held at that moment would put
            // `run: "resolve-base"` on an entry with nothing running (R02).
            let _held = occupancy;
            tugarc_core::ops::resolve_base_in(&dir_owned, &arc, &live_dirt)
        })
        .await;

        match result {
            Ok(Ok(outcome)) => {
                tracing::info!(
                    arc = %outcome.name,
                    folded = outcome.folded.len(),
                    dropped = outcome.dropped.len(),
                    "arc-resolve-base: cleared"
                );
                self.registry.changeset_all_bump().notify_one();
                // Tell each session whose work rode in the fold ([L31]'s
                // other half): the act happened to *their* files, so the
                // report goes to their transcript, not only to the presser's
                // card. The frame is the same `tug_notice` base-motion's
                // injections announce with — a quiet system row, no turn.
                let mut by_session: std::collections::BTreeMap<&str, Vec<&str>> =
                    std::collections::BTreeMap::new();
                for path in outcome.folded_from.keys() {
                    if let Some((owner_id, _)) = live.get(path) {
                        by_session.entry(owner_id).or_default().push(path);
                    }
                }
                for (session, paths) in by_session {
                    let text = Self::resolve_base_notice_text(
                        &outcome.name,
                        &outcome.base_branch,
                        paths.len(),
                        outcome.committed.as_deref(),
                    );
                    self.code_output.publish_tagged(Frame::new(
                        FeedId::CODE_OUTPUT,
                        crate::feeds::base_motion::bulletin_payload(session, "arc-resolve", &text),
                    ));
                }
                let body =
                    Self::changeset_join_resolve_base_ok_body(project_dir, &outcome.name, &outcome);
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("changeset_join_resolve_base_ok serializes"),
                ));
            }
            Ok(Err(detail)) => {
                Self::send_changeset_join_resolve_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &detail,
                );
            }
            Err(e) => {
                Self::send_changeset_join_resolve_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &format!("the resolve did not run: {e}"),
                );
            }
        }
    }

    /// What the holder of a folded file is told (Spec S04).
    ///
    /// **Tug speaking as Tug**, so it names no command: the act happened on a
    /// surface the reader has, and the way back is a control on that same
    /// surface. The old sentence pointed at `tugtool arc undo` from inside a
    /// row wearing the model's avatar, which got the voice and the remedy
    /// wrong in one line.
    ///
    /// It says the four facts a reader needs to stop worrying: which arc, how
    /// many of *their* files, where they went, and that the disk is untouched.
    /// The count is per-session — the paths this holder owned, not the fold's
    /// whole set — because the sentence says "your".
    pub(in crate::feeds::agent_supervisor) fn resolve_base_notice_text(
        arc: &str,
        base: &str,
        files: usize,
        commit: Option<&str>,
    ) -> String {
        let noun = if files == 1 { "file" } else { "files" };
        match commit {
            Some(sha) => format!(
                "Resolve on arc `{arc}` committed your uncommitted edits to {files} {noun} onto {base} as `{}`. Nothing changed on disk. Undo is in your Changes shade.",
                &sha[..sha.len().min(9)]
            ),
            // Nothing was committed, so there is no sha to name and no undo to
            // offer: the paths were the arc's own bytes and dropping them took
            // nothing away.
            None => format!(
                "Resolve on arc `{arc}` dropped your {files} identical {noun} from the base checkout — the arc already carries them. Nothing changed on disk."
            ),
        }
    }

    /// The `changeset_join_resolve_base_ok` frame, built key by key.
    ///
    /// Every field is written by name rather than serialized off
    /// [`ResolveBaseOutcome`], because the outcome's arc field is spelled
    /// `name` while the deck correlates a reply to its cell by `arc` — a frame
    /// serialized whole carried no `arc` at all, and the deck dropped it in
    /// silence on arrival (the 2026-09-03 incident). Naming each key is what
    /// makes the wire contract something a test can read, and the fixture the
    /// test reads it against is shared with the tugdeck suite, so drift on
    /// either side of the mirror fails one of the two.
    ///
    /// `committed` is present only when the fold made a commit. `folded`,
    /// `dropped` and `folded_from` are always present, empty when empty, so
    /// the deck reads counts without guards.
    pub(in crate::feeds::agent_supervisor) fn changeset_join_resolve_base_ok_body(
        project_dir: &str,
        arc: &str,
        outcome: &tugarc_core::ops::ResolveBaseOutcome,
    ) -> serde_json::Value {
        let mut body = serde_json::json!({
            "action": "changeset_join_resolve_base_ok",
            "project_dir": project_dir,
            "arc": arc,
            "folded": outcome.folded,
            "dropped": outcome.dropped,
            "folded_from": outcome.folded_from,
            "warnings": outcome.warnings,
        });
        if let Some(commit) = outcome.committed.as_deref() {
            body["committed"] = serde_json::Value::String(commit.to_string());
        }
        body
    }

    fn send_changeset_join_resolve_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_join_resolve_err",
            "project_dir": project_dir,
            "arc": arc,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_join_resolve_err serializes"),
        ));
    }

    /// Handle a `changeset_join_resolve_base_undo` CONTROL request: put back
    /// the uncommitted base work a fold committed, via
    /// [`tugarc_core::undo_resolve_base_in`].
    ///
    /// It takes no occupancy hold, and that is deliberate rather than an
    /// omission. The fold is a run — it streams, it has a face, and a second
    /// press landing under it would fold a tree mid-commit. An undo is a
    /// compare-and-swap against tips the operation recorded: a second one
    /// finds the op already reversed and refuses by name, which is the same
    /// answer a hold would have produced and one fewer thing to release.
    ///
    /// What it does share with the fold is the bump. Everything it moved is in
    /// git, the blockers are never cached, and the receipt it retires is read
    /// off the op log by the recompute — so the recompute is the whole of the
    /// update, and it fires on the refusal too, since a refusal is proof the
    /// caller's copy of the world was stale.
    async fn do_changeset_join_resolve_base_undo(&self, request: &ChangesetJoinResolvePayload) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_join_resolve_base_undo_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not an open project",
            );
            return;
        }

        let dir_owned = dir.to_path_buf();
        let arc = request.arc.clone();
        let result = tokio::task::spawn_blocking(move || {
            tugarc_core::undo_resolve_base_in(&dir_owned, &arc)
        })
        .await;

        match result {
            Ok(Ok(outcome)) => {
                tracing::info!(
                    arc = %outcome.arc,
                    reversed = outcome.seq,
                    "arc-resolve-base: undone"
                );
                self.registry.changeset_all_bump().notify_one();
                let mut body = serde_json::json!({
                    "action": "changeset_join_resolve_base_undo_ok",
                    "project_dir": project_dir,
                    "arc": outcome.arc,
                });
                if let Some(tip) = outcome.base_tip.as_deref() {
                    body["base_tip"] = serde_json::Value::String(tip.to_string());
                }
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body)
                        .expect("changeset_join_resolve_base_undo_ok serializes"),
                ));
            }
            Ok(Err(detail)) => {
                self.registry.changeset_all_bump().notify_one();
                Self::send_changeset_join_resolve_base_undo_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &detail,
                );
            }
            Err(e) => {
                Self::send_changeset_join_resolve_base_undo_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &format!("the undo did not run: {e}"),
                );
            }
        }
    }

    /// The undo's own refusal frame, separate from
    /// `changeset_join_resolve_err` because the two say different things about
    /// the same arc: that one reports a resolve that failed and fails the
    /// cell, this one reports a press that changed nothing while whatever the
    /// cell is doing carries on untouched.
    fn send_changeset_join_resolve_base_undo_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_join_resolve_base_undo_err",
            "project_dir": project_dir,
            "arc": arc,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_join_resolve_base_undo_err serializes"),
        ));
    }

    /// Handle a `changeset_discard` CONTROL request: discard an arc (worktree +
    /// branch) without merging, via `tugarc-core`. Same guards as the join
    /// verb; fires the aggregate bump so the arc entry disappears from the
    /// card. Broadcasts `changeset_discard_ok {…}` / `changeset_discard_err`.
    async fn do_changeset_discard(&self, request: &ChangesetDiscardPayload) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_discard_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not an open project",
            );
            return;
        }
        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_discard_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not a git repository",
            );
            return;
        }

        // Resolved before the teardown, for the reason `do_changeset_join`
        // states: `discard_in` deletes the branch and its config with it
        // ([L23], [P05], Risk R02).
        let owner_key = tugarc_core::ops::arc_owner_key(dir, &request.arc);
        // What the discard is about to destroy, read while it still exists —
        // `arc_detail_entries_in` is the only accessor and after the teardown
        // the branch is gone and the subjects are unrecoverable (Spec S02).
        let detail = tugarc_core::arc_detail_entries_in(dir)
            .into_iter()
            .find(|d| d.name == request.arc);
        let discarded_rounds = detail.as_ref().map(|d| d.rounds).unwrap_or(0);
        let discarded_files = detail.as_ref().map(|d| d.files.len() as u32).unwrap_or(0);
        let round_subjects = detail.map(|d| d.round_subjects).unwrap_or_default();

        let dir_owned = dir.to_path_buf();
        let arc = request.arc.clone();
        let result = tokio::task::spawn_blocking(move || {
            tugarc_core::discard_in(&dir_owned, &arc, Some("card"), false)
        })
        .await;

        match result {
            Ok(Ok(outcome)) => {
                tracing::info!(
                    arc = %outcome.name,
                    rounds = discarded_rounds,
                    files = discarded_files,
                    documents_kept = outcome.documents_kept.is_some(),
                    "arc-discard: completed"
                );
                // The discarded arc's join draft dies with it ([P14]) — a
                // reused name must never inherit the dead arc's message.
                if let Some(ledger) = self.session_ledger.as_deref() {
                    Self::clear_arc_draft(ledger, project_dir, &owner_key);
                    // As on the join path: the arc is gone, so its bindings
                    // go with it ([P05]).
                    log_ledger_err(
                        "clear_arc_bindings_for_arc",
                        &owner_key,
                        ledger.clear_arc_bindings_for_arc(&owner_key),
                    );
                }
                self.registry.changeset_all_bump().notify_one();
                // The discard's receipt (Spec S02): the header names what was
                // destroyed, the body lists the subjects the preflight showed.
                let summary = crate::feeds::changeset::format_discard_summary(
                    &outcome.name,
                    discarded_rounds,
                    discarded_files,
                    &round_subjects,
                    outcome.documents_kept.as_deref(),
                );
                let receipt_id = Self::record_landing_receipt(
                    self.shell_ledger.as_ref(),
                    self.session_ledger.as_ref(),
                    request.session_id.as_deref(),
                    "/arc-discard",
                    &summary,
                    project_dir,
                );
                let body = serde_json::json!({
                    "action": "changeset_discard_ok",
                    "project_dir": project_dir,
                    "arc": request.arc,
                    "name": outcome.name,
                    "summary": summary,
                    "receipt_id": receipt_id,
                    "warnings": outcome.warnings,
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("changeset_discard_ok serializes"),
                ));
            }
            Ok(Err(detail)) => {
                Self::send_changeset_discard_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &detail,
                );
            }
            Err(join_err) => {
                Self::send_changeset_discard_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &format!("discard task failed: {join_err}"),
                );
            }
        }
    }

    fn send_changeset_discard_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_discard_err",
            "project_dir": project_dir,
            "arc": arc,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_discard_err serializes"),
        ));
    }

    /// Handle a `changeset_delete_documents` CONTROL request: delete
    /// `.tug/arcs/<arc>/` and nothing else, via `tugarc-core`.
    ///
    /// The same two guards the discard verb takes, and the same aggregate bump
    /// so the paperwork row leaves the card — but none of the discard's
    /// teardown: no draft cleared, no bindings cleared, no arc-log line. The
    /// arc's record is untouched, because deleting a brief is not ending an
    /// arc ([B05]); `delete_documents_in` refuses outright for a name that
    /// still has a branch or a worktree, which is the case `arc discard` owns.
    ///
    /// Broadcasts `changeset_delete_documents_ok {…}` /
    /// `changeset_delete_documents_err`.
    async fn do_changeset_delete_documents(&self, request: &ChangesetDeleteDocumentsPayload) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_delete_documents_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not an open project",
            );
            return;
        }
        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_delete_documents_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                "not a git repository",
            );
            return;
        }

        let dir_owned = dir.to_path_buf();
        let arc = request.arc.clone();
        let result =
            tokio::task::spawn_blocking(move || tugarc_core::delete_documents_in(&dir_owned, &arc))
                .await;

        match result {
            Ok(Ok(outcome)) => {
                tracing::info!(
                    arc = %outcome.name,
                    removed = outcome.removed.is_some(),
                    files = outcome.files.len(),
                    "arc-delete-documents: completed"
                );
                self.registry.changeset_all_bump().notify_one();
                let summary = crate::feeds::changeset::format_delete_documents_summary(
                    &outcome.name,
                    &outcome.files,
                );
                let receipt_id = Self::record_landing_receipt(
                    self.shell_ledger.as_ref(),
                    self.session_ledger.as_ref(),
                    request.session_id.as_deref(),
                    "/arc-delete-documents",
                    &summary,
                    project_dir,
                );
                let body = serde_json::json!({
                    "action": "changeset_delete_documents_ok",
                    "project_dir": project_dir,
                    "arc": request.arc,
                    "name": outcome.name,
                    "removed": outcome.removed,
                    "files": outcome.files,
                    "summary": summary,
                    "receipt_id": receipt_id,
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("changeset_delete_documents_ok serializes"),
                ));
            }
            Ok(Err(detail)) => {
                Self::send_changeset_delete_documents_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &detail,
                );
            }
            Err(join_err) => {
                Self::send_changeset_delete_documents_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    &format!("delete task failed: {join_err}"),
                );
            }
        }
    }

    fn send_changeset_delete_documents_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_delete_documents_err",
            "project_dir": project_dir,
            "arc": arc,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_delete_documents_err serializes"),
        ));
    }

    /// Handle a `changeset_replay` CONTROL request: replay an arc's rounds onto
    /// its base branch's current tip, via `tugarc-core`. Same two guards as the
    /// discard verb; fires the aggregate bump so the row's divergence facts
    /// recompute. Broadcasts `changeset_replay_ok {…}` / `changeset_replay_err`.
    ///
    /// Nothing is written to the ledger and no draft or binding is cleared: a
    /// replay destroys nothing and owns no draft, so the discard's cleanup has
    /// no analogue here. `replay_onto` is a compare-and-swap over the worktree's
    /// cleanliness and HEAD, so a press that races the base-motion engine
    /// touches nothing and reports `deferred` or `current`.
    ///
    /// A `conflicted` outcome is still an `_ok`: the replay ran and reported,
    /// and the conflict is the arc's state rather than the verb's failure.
    /// `_err` carries the two guards and an `Err` from the op, which
    /// `replay_onto` returns only for an arc that does not exist.
    async fn do_changeset_replay(&self, request: &ChangesetReplayPayload) {
        let project_dir = request.project_dir.as_str();
        let dir = std::path::Path::new(project_dir);

        if self.registry.find_entry_by_path(dir).is_none() {
            Self::send_changeset_replay_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                request.session_id.as_deref(),
                "not an open project",
            );
            return;
        }
        if !crate::feeds::git::is_within_git_worktree(dir).await {
            Self::send_changeset_replay_err(
                &self.control_tx,
                project_dir,
                &request.arc,
                request.session_id.as_deref(),
                "not a git repository",
            );
            return;
        }

        let dir_owned = dir.to_path_buf();
        let arc = request.arc.clone();
        let result =
            tokio::task::spawn_blocking(move || tugarc_core::replay_onto(&dir_owned, &arc)).await;

        match result {
            Ok(Ok(outcome)) => {
                self.registry.changeset_all_bump().notify_one();
                let mut body = serde_json::json!({
                    "action": "changeset_replay_ok",
                    "project_dir": project_dir,
                    "arc": request.arc,
                    "session_id": request.session_id,
                });
                // The outcome serializes itself — its own `#[serde(tag =
                // "outcome")]` supplies the word, and the variant's fields carry
                // the only text a refusal can be read from.
                let serialized = serde_json::to_value(&outcome).expect("replay outcome serializes");
                if let (Some(target), Some(fields)) = (body.as_object_mut(), serialized.as_object())
                {
                    for (key, value) in fields {
                        target.insert(key.clone(), value.clone());
                    }
                }
                tracing::info!(
                    arc = %request.arc,
                    outcome = %serialized.get("outcome").and_then(|v| v.as_str()).unwrap_or("-"),
                    "arc-replay: completed"
                );
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("changeset_replay_ok serializes"),
                ));
            }
            Ok(Err(detail)) => {
                Self::send_changeset_replay_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    request.session_id.as_deref(),
                    &detail,
                );
            }
            Err(join_err) => {
                Self::send_changeset_replay_err(
                    &self.control_tx,
                    project_dir,
                    &request.arc,
                    request.session_id.as_deref(),
                    &format!("replay task failed: {join_err}"),
                );
            }
        }
    }

    fn send_changeset_replay_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        arc: &str,
        session_id: Option<&str>,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_replay_err",
            "project_dir": project_dir,
            "arc": arc,
            "session_id": session_id,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_replay_err serializes"),
        ));
    }

    fn send_changeset_git_init_ok(control_tx: &broadcast::Sender<Frame>, project_dir: &str) {
        let body = serde_json::json!({
            "action": "changeset_git_init_ok",
            "project_dir": project_dir,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_git_init_ok serializes"),
        ));
    }

    fn send_changeset_git_init_err(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        detail: &str,
    ) {
        let body = serde_json::json!({
            "action": "changeset_git_init_err",
            "project_dir": project_dir,
            "detail": detail,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("changeset_git_init_err serializes"),
        ));
    }
}
