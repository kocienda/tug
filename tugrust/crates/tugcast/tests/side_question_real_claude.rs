//! `/btw` side questions against a real Claude Code.
//!
//! # Runtime gating
//!
//! Every test here is `#[ignore]`-gated AND `TUG_REAL_CLAUDE`-gated, the
//! same belt-and-suspenders as `multi_session_real_claude.rs`. To run:
//!
//! ```sh
//! cd tugrust
//! TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --run-ignored only \
//!     --test side_question_real_claude --test-threads 1
//! ```
//!
//! `--test-threads 1` because every spawned tugcast opens the same test
//! instance's `sessions.db`, and a second one starting alongside fails with
//! `database is locked` before it ever reaches claude.
//!
//! # What these tests pin
//!
//! The whole path a `/btw` ask takes below the Session card: the
//! `side_question` CODE_INPUT frame the card sends → tugcast's router →
//! tugcode's `handleSideQuestion` → claude's `side_question` control request
//! → the `control_response` claude answers with → tugcode's
//! `trySideQuestionControlResponse` → the `side_question_answer` CODE_OUTPUT
//! frame the card reads. Nothing is mocked; the answer is claude's.
//!
//! The answer's nesting in claude's `control_response` is the part that can
//! drift quietly — tugcode reads `response.response.{response,synthetic}`,
//! and a reshaped payload degrades to `answer: null` rather than an error.
//! Asserting a real, correct answer is what catches that.
//!
//! - Idle: after a finished turn, a side question is answered, the answer
//!   is right, and it adds nothing to the transcript.
//! - Mid-turn: a side question asked while a turn is streaming is answered
//!   before that turn completes.

#![allow(dead_code)]

use std::time::Duration;

use tempfile::NamedTempFile;

mod common;

use common::{TestTugcast, TestWs, fresh_session_id, real_claude_enabled};

macro_rules! require_real_claude {
    () => {
        if !real_claude_enabled() {
            return;
        }
    };
}

/// Budget for one real turn or one side answer. A cold session on the
/// default model can take tens of seconds to first token.
const TURN_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to listen for transcript events after an idle answer. A side
/// question that leaked into the conversation would start a turn well
/// inside this.
const LEAK_WINDOW: Duration = Duration::from_secs(5);

async fn spawn_tugcast() -> TestTugcast {
    let temp_bank = NamedTempFile::new().expect("temp bank file");
    let bank_path = temp_bank.path().to_path_buf();
    drop(temp_bank);
    let project_dir = std::env::current_dir().expect("cwd");
    TestTugcast::spawn(&project_dir, bank_path).await
}

/// Spawn a session. claude itself starts on the first prompt, and each test
/// sends one before its side question — tugcode answers `null` when there is
/// no claude process to ask.
async fn live_session(ws: &mut TestWs, tc: &TestTugcast, card_id: &str, sess: &str) {
    ws.send_spawn_session(card_id, sess, &tc.project_dir).await;
    ws.await_session_state(sess, "pending", TURN_TIMEOUT)
        .await
        .expect("pending");
}

/// The `side_question_answer` for `request_id`, with its fields checked
/// against the frame the card parses (`parseSideQuestionAnswerPayload`).
async fn await_answer(ws: &mut TestWs, sess: &str, request_id: &str) -> String {
    let frame = ws
        .await_code_output_event(sess, "side_question_answer", TURN_TIMEOUT)
        .await
        .expect("side_question_answer frame");
    assert_eq!(
        frame["request_id"].as_str(),
        Some(request_id),
        "answer must carry the ask's request_id: {frame}"
    );
    assert_eq!(
        frame["synthetic"].as_bool(),
        Some(false),
        "answer must be claude's, not synthesized: {frame}"
    );
    let answer = frame["answer"]
        .as_str()
        .unwrap_or_else(|| panic!("answer must be a string, got: {frame}"));
    assert!(!answer.trim().is_empty(), "answer must not be empty: {frame}");
    answer.to_string()
}

#[tokio::test]
#[ignore = "requires TUG_REAL_CLAUDE=1 and a live claude binary"]
async fn test_side_question_answered_when_idle() {
    require_real_claude!();
    let tc = spawn_tugcast().await;
    let mut ws = TestWs::connect(tc.port).await;
    let sess = fresh_session_id();
    let sess = sess.as_str();

    live_session(&mut ws, &tc, "card-btw-idle", sess).await;
    ws.send_code_input(sess, "Reply with just the word: ready").await;
    ws.collect_code_output(sess, TURN_TIMEOUT)
        .await
        .expect("first turn completes");

    ws.send_side_question(
        sess,
        "btw-1",
        "What is 17 times 3? Answer with only the number.",
    )
    .await;
    let answer = await_answer(&mut ws, sess, "btw-1").await;
    assert!(answer.contains("51"), "expected 51 in the answer, got: {answer:?}");

    // A side question is overlay-only: it must not start a turn.
    for event in ["assistant_text", "turn_complete"] {
        let leaked = ws.await_code_output_event(sess, event, LEAK_WINDOW).await;
        assert!(
            leaked.is_err(),
            "side question leaked a transcript `{event}`: {leaked:?}"
        );
    }
}

#[tokio::test]
#[ignore = "requires TUG_REAL_CLAUDE=1 and a live claude binary"]
async fn test_side_question_answered_mid_turn() {
    require_real_claude!();
    let tc = spawn_tugcast().await;
    let mut ws = TestWs::connect(tc.port).await;
    let sess = fresh_session_id();
    let sess = sess.as_str();

    live_session(&mut ws, &tc, "card-btw-mid", sess).await;
    ws.send_code_input(
        sess,
        "Write the whole numbers from 1 to 600, one per line, with no other text.",
    )
    .await;
    // The turn is streaming once its first text arrives.
    ws.peek_code_output_event(sess, "assistant_text", TURN_TIMEOUT)
        .await
        .expect("long turn starts streaming");
    assert!(
        !ws.has_buffered_code_output(sess, "turn_complete"),
        "the long turn finished before the side question could be asked"
    );

    ws.send_side_question(
        sess,
        "btw-1",
        "What is the capital of France? Answer with one word.",
    )
    .await;
    let answer = await_answer(&mut ws, sess, "btw-1").await;
    assert!(
        answer.to_lowercase().contains("paris"),
        "expected Paris in the answer, got: {answer:?}"
    );
    assert!(
        !ws.has_buffered_code_output(sess, "turn_complete"),
        "the side answer waited for the turn to end — it was not answered mid-turn"
    );

    ws.collect_code_output(sess, TURN_TIMEOUT)
        .await
        .expect("the long turn still completes");
}
