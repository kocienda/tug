//! The CONTROL action families [`AgentSupervisor::handle_control`] delegates
//! to, one module per family. Each carries its own `impl AgentSupervisor`
//! block, its payload parsers, and its reply helpers.

mod arc;
mod changeset;
mod deck;
mod rows;
mod session;
mod telemetry;

#[cfg(test)]
pub(super) use arc::{BindArcPayload, parse_bind_arc_payload};
#[cfg(test)]
pub(super) use changeset::{
    ChangesetCommitPayload, changeset_commit_message, parse_changeset_claim_payload,
    parse_changeset_commit_payload, parse_changeset_delete_documents_payload,
    parse_changeset_discard_payload, parse_changeset_disclaim_payload,
    parse_changeset_draft_request_payload, parse_changeset_join_payload,
    parse_changeset_join_question_answer_payload, parse_changeset_join_resolve_payload,
    parse_changeset_replay_payload, parse_landing_receipt_payload,
};
