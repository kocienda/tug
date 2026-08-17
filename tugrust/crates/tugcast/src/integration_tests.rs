//! Integration tests for tugcast
//!
//! These tests verify end-to-end functionality including auth flow,
//! WebSocket communication, and terminal integration.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::sync::broadcast;
use tower::ServiceExt;

use std::sync::Arc;

use tugbank_core::{DefaultsStore, TugbankClient};

use crate::auth::{self, SESSION_COOKIE_NAME};
use crate::dev;
use crate::router::{BROADCAST_CAPACITY, FeedRouter, LagPolicy};
use crate::server::build_app;
use tugcast_core::FeedId;

/// Helper to build a test app with fresh auth state
fn build_test_app(port: u16) -> (axum::Router, String) {
    let auth = auth::new_shared_auth_state(port);
    let token = auth.lock().unwrap().token().unwrap().to_string();

    let (terminal_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (input_tx, _) = tokio::sync::mpsc::channel(256);

    // Create dummy code channels for testing
    let (code_tx, _) = broadcast::channel(1024);
    let (code_input_tx, _) = tokio::sync::mpsc::channel(256);

    // Create dummy shutdown channel for tests
    let (shutdown_tx, _) = tokio::sync::mpsc::channel::<u8>(1);

    // Create dummy client action channel for tests
    let (client_action_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

    let dev_state = dev::new_shared_dev_state();
    let mut feed_router = FeedRouter::new(
        "test-dummy".to_string(),
        auth.clone(),
        shutdown_tx,
        dev_state.clone(),
    );
    feed_router.register_stream(FeedId::TERMINAL_OUTPUT, terminal_tx, LagPolicy::Bootstrap);
    feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn);
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_tx);

    let app = build_app(feed_router, dev_state, None, None, None);
    (app, token)
}

#[tokio::test]
async fn test_auth_valid_token() {
    let (app, token) = build_test_app(7890);

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/auth?token={}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FOUND);

    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.contains(SESSION_COOKIE_NAME));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Strict"));

    let location = response.headers().get(header::LOCATION).unwrap();
    assert_eq!(location, "/");
}

#[tokio::test]
async fn test_auth_invalid_token() {
    let (app, _token) = build_test_app(7890);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/auth?token=invalid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_auth_token_single_use() {
    let (app, token) = build_test_app(7890);

    // First use should succeed
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/auth?token={}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);

    // Second use should fail (token invalidated)
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/auth?token={}", token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_ws_requires_session() {
    let (app, _token) = build_test_app(7890);

    // Attempt WebSocket upgrade without cookie should fail
    let response = app
        .oneshot(
            Request::builder()
                .uri("/ws")
                .header(header::UPGRADE, "websocket")
                .header(header::CONNECTION, "upgrade")
                .header(header::SEC_WEBSOCKET_VERSION, "13")
                .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // WebSocket upgrade without valid session should fail
    // May return 403 (Forbidden) or 426 (Upgrade Required) depending on handler execution order
    assert!(
        response.status() == StatusCode::FORBIDDEN
            || response.status() == StatusCode::UPGRADE_REQUIRED
    );
}

#[tokio::test]
#[ignore] // Requires tmux
async fn test_tmux_version_check() {
    let result = crate::feeds::terminal::check_tmux_version().await;
    match result {
        Ok(version) => {
            assert!(version.contains("tmux"));
        }
        Err(e) => {
            panic!("tmux version check failed: {}", e);
        }
    }
}

/// Test that FsEvent JSON format matches TypeScript FsEvent interface
#[test]
fn test_fsevent_json_contract() {
    use tugcast_core::types::FsEvent;

    // Created event
    let created = FsEvent::Created {
        path: "src/main.rs".to_string(),
    };
    let json = serde_json::to_string(&created).unwrap();
    assert_eq!(json, r#"{"kind":"Created","path":"src/main.rs"}"#);

    // Modified event
    let modified = FsEvent::Modified {
        path: "README.md".to_string(),
    };
    let json = serde_json::to_string(&modified).unwrap();
    assert_eq!(json, r#"{"kind":"Modified","path":"README.md"}"#);

    // Removed event
    let removed = FsEvent::Removed {
        path: "old.txt".to_string(),
    };
    let json = serde_json::to_string(&removed).unwrap();
    assert_eq!(json, r#"{"kind":"Removed","path":"old.txt"}"#);

    // Renamed event
    let renamed = FsEvent::Renamed {
        from: "old.rs".to_string(),
        to: "new.rs".to_string(),
    };
    let json = serde_json::to_string(&renamed).unwrap();
    assert_eq!(json, r#"{"kind":"Renamed","from":"old.rs","to":"new.rs"}"#);
}

/// Test that GitStatus JSON format matches TypeScript GitStatus interface
#[test]
fn test_git_status_json_contract() {
    use tugcast_core::types::{FileStatus, GitStatus};

    let status = GitStatus {
        branch: "main".to_string(),
        ahead: 2,
        behind: 1,
        staged: vec![FileStatus {
            path: "src/main.rs".to_string(),
            status: "M".to_string(),
        }],
        unstaged: vec![],
        untracked: vec!["temp.txt".to_string()],
        head_sha: "abc123".to_string(),
        head_message: "Initial commit".to_string(),
    };

    let json = serde_json::to_string(&status).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    // Verify all fields are present with correct names (snake_case)
    assert_eq!(parsed["branch"], "main");
    assert_eq!(parsed["ahead"], 2);
    assert_eq!(parsed["behind"], 1);
    assert_eq!(parsed["staged"][0]["path"], "src/main.rs");
    assert_eq!(parsed["staged"][0]["status"], "M");
    assert_eq!(parsed["untracked"][0], "temp.txt");
    assert_eq!(parsed["head_sha"], "abc123");
    assert_eq!(parsed["head_message"], "Initial commit");
}

/// Test that snapshot watch channels provide immediate access to initial value
#[tokio::test]
async fn test_snapshot_watch_initial_value() {
    use tugcast_core::{FeedId, Frame};

    // Create watch channel with pre-loaded data
    let test_payload = b"test data";
    let initial_frame = Frame::new(FeedId::FILESYSTEM, test_payload.to_vec());
    let (tx, rx) = tokio::sync::watch::channel(initial_frame.clone());

    // Clone receiver (simulates what router does per client)
    let mut rx_clone = rx.clone();

    // Borrow initial value (simulates what handle_client does on connect)
    let frame = rx_clone.borrow().clone();
    assert_eq!(frame.feed_id, FeedId::FILESYSTEM);
    assert_eq!(frame.payload, test_payload);

    // Send update
    let update_frame = Frame::new(FeedId::FILESYSTEM, b"updated".to_vec());
    tx.send(update_frame.clone()).unwrap();

    // Wait for change notification
    rx_clone.changed().await.unwrap();
    let updated = rx_clone.borrow_and_update().clone();
    assert_eq!(updated.payload, b"updated");
}

/// Test that stats feeds deliver frames with correct feed IDs and valid JSON payloads
#[tokio::test]
async fn test_stats_feed_delivery() {
    use tugcast_core::{FeedId, Frame};

    // Create watch channels with pre-loaded stats data matching
    let process_info_json = serde_json::json!({
        "name": "process_info",
        "pid": 12345,
        "cpu_percent": 2.5,
        "memory_mb": 45.3,
        "uptime_secs": 120
    });
    let process_info_payload = serde_json::to_vec(&process_info_json).unwrap();

    let token_usage_json = serde_json::json!({
        "name": "token_usage",
        "input_tokens": 1000,
        "output_tokens": 500,
        "total_tokens": 1500,
        "context_window_percent": 12.5
    });
    let token_usage_payload = serde_json::to_vec(&token_usage_json).unwrap();

    let build_status_json = serde_json::json!({
        "name": "build_status",
        "last_build_time": "2026-02-15T12:34:56Z",
        "target_modified_secs_ago": 30,
        "status": "idle"
    });
    let build_status_payload = serde_json::to_vec(&build_status_json).unwrap();

    let stats_agg_json = serde_json::json!({
        "process_info": process_info_json,
        "token_usage": token_usage_json,
        "build_status": build_status_json
    });
    let stats_agg_payload = serde_json::to_vec(&stats_agg_json).unwrap();

    // Create watch channels
    let (_stats_agg_tx, stats_agg_rx) =
        tokio::sync::watch::channel(Frame::new(FeedId::STATS, stats_agg_payload.clone()));
    let (_stats_proc_tx, stats_proc_rx) = tokio::sync::watch::channel(Frame::new(
        FeedId::STATS_PROCESS_INFO,
        process_info_payload.clone(),
    ));
    let (_stats_token_tx, stats_token_rx) = tokio::sync::watch::channel(Frame::new(
        FeedId::STATS_TOKEN_USAGE,
        token_usage_payload.clone(),
    ));
    let (_stats_build_tx, stats_build_rx) = tokio::sync::watch::channel(Frame::new(
        FeedId::STATS_BUILD_STATUS,
        build_status_payload.clone(),
    ));

    // Verify that watch receivers provide immediate access to initial values
    let agg_frame = stats_agg_rx.borrow().clone();
    assert_eq!(agg_frame.feed_id, FeedId::STATS);
    assert_eq!(agg_frame.payload, stats_agg_payload);

    let proc_frame = stats_proc_rx.borrow().clone();
    assert_eq!(proc_frame.feed_id, FeedId::STATS_PROCESS_INFO);
    assert_eq!(proc_frame.payload, process_info_payload);

    let token_frame = stats_token_rx.borrow().clone();
    assert_eq!(token_frame.feed_id, FeedId::STATS_TOKEN_USAGE);
    assert_eq!(token_frame.payload, token_usage_payload);

    let build_frame = stats_build_rx.borrow().clone();
    assert_eq!(build_frame.feed_id, FeedId::STATS_BUILD_STATUS);
    assert_eq!(build_frame.payload, build_status_payload);

    // Verify JSON payloads parse correctly
    let parsed_agg: serde_json::Value = serde_json::from_slice(&agg_frame.payload).unwrap();
    assert_eq!(parsed_agg["process_info"]["name"], "process_info");
    assert_eq!(parsed_agg["process_info"]["pid"], 12345);
    assert_eq!(parsed_agg["token_usage"]["total_tokens"], 1500);
    assert_eq!(parsed_agg["build_status"]["status"], "idle");

    let parsed_proc: serde_json::Value = serde_json::from_slice(&proc_frame.payload).unwrap();
    assert_eq!(parsed_proc["name"], "process_info");
    assert_eq!(parsed_proc["cpu_percent"], 2.5);

    let parsed_token: serde_json::Value = serde_json::from_slice(&token_frame.payload).unwrap();
    assert_eq!(parsed_token["name"], "token_usage");
    assert_eq!(parsed_token["context_window_percent"], 12.5);

    let parsed_build: serde_json::Value = serde_json::from_slice(&build_frame.payload).unwrap();
    assert_eq!(parsed_build["name"], "build_status");
    assert!(parsed_build["status"] == "idle" || parsed_build["status"] == "building");
}

/// Test that reconnection delivers fresh snapshots
#[tokio::test]
async fn test_reconnection_snapshot_delivery() {
    use tugcast_core::{FeedId, Frame};

    // Create watch channel with initial snapshot
    let initial_payload = b"initial snapshot";
    let initial_frame = Frame::new(FeedId::FILESYSTEM, initial_payload.to_vec());
    let (_tx, rx) = tokio::sync::watch::channel(initial_frame.clone());

    // First client connects (simulated by cloning receiver)
    let rx_client1 = rx.clone();
    let frame1 = rx_client1.borrow().clone();
    assert_eq!(frame1.feed_id, FeedId::FILESYSTEM);
    assert_eq!(frame1.payload, initial_payload);

    // Client 1 disconnects (drop receiver - no-op in this test)
    drop(rx_client1);

    // Second client connects (simulates reconnection)
    let rx_client2 = rx.clone();
    let frame2 = rx_client2.borrow().clone();

    // Verify client 2 receives the same snapshot immediately
    assert_eq!(frame2.feed_id, FeedId::FILESYSTEM);
    assert_eq!(frame2.payload, initial_payload);
}

#[tokio::test]
async fn test_tell_client_action() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let (app, _token) = build_test_app(7890);

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tell")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"action":"test-ping"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(body_str.contains(r#""status":"ok""#));
}

#[tokio::test]
async fn test_tell_malformed_json() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let (app, _token) = build_test_app(7890);

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tell")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("not json"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(body_str.contains(r#""status":"error""#));
    assert!(body_str.contains(r#""message":"invalid JSON""#));
}

#[tokio::test]
async fn test_tell_missing_action() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let (app, _token) = build_test_app(7890);

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tell")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"foo":"bar"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(body_str.contains(r#""status":"error""#));
    assert!(body_str.contains(r#""message":"missing action field""#));
}

#[tokio::test]
async fn test_tell_reload() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    // Build test app
    let auth = auth::new_shared_auth_state(7890);
    let (terminal_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (input_tx, _) = tokio::sync::mpsc::channel(256);
    let (code_tx, _) = broadcast::channel(1024);
    let (code_input_tx, _) = tokio::sync::mpsc::channel(256);
    let (shutdown_tx, _) = tokio::sync::mpsc::channel::<u8>(1);
    let (client_action_tx, mut client_action_rx) = broadcast::channel(BROADCAST_CAPACITY);

    let dev_state = dev::new_shared_dev_state();
    let mut feed_router = FeedRouter::new(
        "test-dummy".to_string(),
        auth,
        shutdown_tx,
        dev_state.clone(),
    );
    feed_router.register_stream(FeedId::TERMINAL_OUTPUT, terminal_tx, LagPolicy::Bootstrap);
    feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn);
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_tx);

    let app = build_app(feed_router, dev_state, None, None, None);

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tell")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"action":"reload"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    // Verify client_action_tx was broadcast
    let frame = client_action_rx.try_recv().unwrap();
    assert_eq!(frame.feed_id, FeedId::CONTROL);
}

#[tokio::test]
async fn test_tell_client_action_round_trip() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    // Build test app with client_action_tx subscriber
    let auth = auth::new_shared_auth_state(7890);
    let (terminal_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (input_tx, _) = tokio::sync::mpsc::channel(256);
    let (code_tx, _) = broadcast::channel(1024);
    let (code_input_tx, _) = tokio::sync::mpsc::channel(256);
    let (shutdown_tx, _) = tokio::sync::mpsc::channel::<u8>(1);
    let (client_action_tx, mut client_action_rx) = broadcast::channel(BROADCAST_CAPACITY);

    let dev_state = dev::new_shared_dev_state();
    let mut feed_router = FeedRouter::new(
        "test-dummy".to_string(),
        auth,
        shutdown_tx,
        dev_state.clone(),
    );
    feed_router.register_stream(FeedId::TERMINAL_OUTPUT, terminal_tx, LagPolicy::Bootstrap);
    feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn);
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_tx);

    let app = build_app(feed_router, dev_state, None, None, None);

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    // POST a custom client-only action
    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tell")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"action":"my-custom-action","key":"value"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    // Verify HTTP response is 200
    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(body_str.contains(r#""status":"ok""#));

    // Verify client_action_rx receives the frame
    let frame = client_action_rx.recv().await.unwrap();
    assert_eq!(frame.feed_id, FeedId::CONTROL);

    // Verify payload contains the original JSON body
    let payload_str = String::from_utf8(frame.payload.to_vec()).unwrap();
    assert!(payload_str.contains("my-custom-action"));
    assert!(payload_str.contains(r#""key":"value""#));
}

#[tokio::test]
async fn test_tell_rejects_non_loopback() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let (app, _token) = build_test_app(7890);

    // Use a non-loopback address
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tell")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"action":"test-ping"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    // Verify response is 403 Forbidden
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(body_str.contains(r#""status":"error""#));
    assert!(body_str.contains(r#""message":"forbidden""#));
}

// ── Host facts API integration test ───────────────────────────────────────

/// `GET /api/host` is wired and returns the Spec S01 shape: a 200 with a
/// JSON object carrying string `hostname`, `shell`, and `shellPath` fields.
/// `hostname` is resolved on the test host and is non-empty there.
#[tokio::test]
async fn test_host_endpoint_returns_spec_s01_shape() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let (app, _token) = build_test_app(7890);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/host")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = json_body(response).await;
    let obj = json.as_object().expect("/api/host returns a JSON object");
    assert!(obj.get("hostname").map(|v| v.is_string()).unwrap_or(false));
    assert!(obj.get("shell").map(|v| v.is_string()).unwrap_or(false));
    assert!(obj.get("shellPath").map(|v| v.is_string()).unwrap_or(false));
    assert!(
        !obj["hostname"].as_str().unwrap().is_empty(),
        "hostname resolves to a non-empty value on the test host",
    );
}

/// `GET /api/host` rejects non-loopback connections with 403, like the
/// other `/api` handlers.
#[tokio::test]
async fn test_host_endpoint_rejects_non_loopback() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let (app, _token) = build_test_app(7890);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)), 0);
    let app_with_connect_info = app.layer(MockConnectInfo(addr));

    let response = app_with_connect_info
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/host")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// ── Defaults API integration test helpers ─────────────────────────────────

/// Build a test app wired to a temporary tugbank database.
///
/// Returns the router (with loopback `MockConnectInfo` applied) and the
/// `NamedTempFile` that backs the database. The caller must keep the
/// `NamedTempFile` alive for the duration of the test.
fn build_defaults_test_app() -> (axum::Router, tempfile::NamedTempFile) {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let tmp = tempfile::NamedTempFile::new().expect("temp db file");
    let store = DefaultsStore::open(tmp.path()).expect("open test tugbank db");
    let client = Arc::new(TugbankClient::from_store(store).expect("create TugbankClient"));

    let auth = auth::new_shared_auth_state(7892);
    let (terminal_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (input_tx, _) = tokio::sync::mpsc::channel(256);
    let (code_tx, _) = broadcast::channel(1024);
    let (code_input_tx, _) = tokio::sync::mpsc::channel(256);
    let (shutdown_tx, _) = tokio::sync::mpsc::channel::<u8>(1);
    let (client_action_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

    let dev_state = dev::new_shared_dev_state();
    let mut feed_router = FeedRouter::new(
        "test-dummy".to_string(),
        auth,
        shutdown_tx,
        dev_state.clone(),
    );
    feed_router.register_stream(FeedId::TERMINAL_OUTPUT, terminal_tx, LagPolicy::Bootstrap);
    feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn);
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_tx);

    let app = build_app(feed_router, dev_state, Some(client), None, None);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    (app.layer(MockConnectInfo(addr)), tmp)
}

/// Helper: read the response body as a parsed JSON value.
async fn json_body(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).expect("response body should be valid JSON")
}

// ── Defaults API integration tests ────────────────────────────────────────

/// T18: GET /api/defaults/:domain on a domain that has never been written to
/// returns 200 with an empty JSON object `{}`.
#[tokio::test]
async fn test_defaults_get_empty_domain_returns_empty_object() {
    let (app, _tmp) = build_defaults_test_app();

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/com.example.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = json_body(response).await;
    assert_eq!(json, serde_json::json!({}));
}

/// T19: PUT a string value then GET the single key — verify round-trip.
#[tokio::test]
async fn test_defaults_put_string_then_get_key() {
    let (app, _tmp) = build_defaults_test_app();

    // PUT
    let put_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/com.example.test/theme")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"kind":"string","value":"dark"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put_resp.status(), StatusCode::OK);
    let put_json = json_body(put_resp).await;
    assert_eq!(put_json["status"], "ok");

    // GET key
    let get_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/com.example.test/theme")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_resp.status(), StatusCode::OK);
    let get_json = json_body(get_resp).await;
    assert_eq!(get_json["kind"], "string");
    assert_eq!(get_json["value"], "dark");
}

/// T20: PUT multiple keys then GET domain — verify all keys returned.
#[tokio::test]
async fn test_defaults_put_multiple_then_get_domain() {
    let (app, _tmp) = build_defaults_test_app();

    // PUT theme
    app.clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/com.example.test/theme")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"kind":"string","value":"dark"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    // PUT font-size
    app.clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/com.example.test/font-size")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"kind":"i64","value":14}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    // GET domain
    let get_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/com.example.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_resp.status(), StatusCode::OK);
    let json = json_body(get_resp).await;
    assert_eq!(json["theme"]["kind"], "string");
    assert_eq!(json["theme"]["value"], "dark");
    assert_eq!(json["font-size"]["kind"], "i64");
    assert_eq!(json["font-size"]["value"], 14);
}

/// T21: GET /api/defaults/:domain/:key for a non-existent key returns 404.
#[tokio::test]
async fn test_defaults_get_nonexistent_key_returns_404() {
    let (app, _tmp) = build_defaults_test_app();

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/com.example.test/missing-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let json = json_body(response).await;
    assert_eq!(json["status"], "error");
    assert_eq!(json["message"], "not found");
}

/// T22: DELETE existing key returns 200; subsequent GET returns 404.
#[tokio::test]
async fn test_defaults_delete_existing_key_then_get_returns_404() {
    let (app, _tmp) = build_defaults_test_app();

    // PUT a value first
    app.clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/com.example.test/key-to-delete")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"kind":"bool","value":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    // DELETE
    let del_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/defaults/com.example.test/key-to-delete")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(del_resp.status(), StatusCode::OK);
    let del_json = json_body(del_resp).await;
    assert_eq!(del_json["status"], "ok");

    // GET after delete — should be 404
    let get_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/com.example.test/key-to-delete")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_resp.status(), StatusCode::NOT_FOUND);
}

/// T23: DELETE a key that does not exist returns 404.
#[tokio::test]
async fn test_defaults_delete_nonexistent_key_returns_404() {
    let (app, _tmp) = build_defaults_test_app();

    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/defaults/com.example.test/no-such-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let json = json_body(response).await;
    assert_eq!(json["status"], "error");
    assert_eq!(json["message"], "not found");
}

/// T24: PUT with a body that is not valid JSON returns 400.
#[tokio::test]
async fn test_defaults_put_invalid_json_returns_400() {
    let (app, _tmp) = build_defaults_test_app();

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/com.example.test/key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("not valid json at all"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let json = json_body(response).await;
    assert_eq!(json["status"], "error");
    assert_eq!(json["message"], "invalid JSON");
}

/// T25: PUT with a valid JSON body but an unknown kind string returns 400.
#[tokio::test]
async fn test_defaults_put_unknown_kind_returns_400() {
    let (app, _tmp) = build_defaults_test_app();

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/com.example.test/key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"kind":"bogus","value":42}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let json = json_body(response).await;
    assert_eq!(json["status"], "error");
}

/// T26: Non-loopback connection to GET /api/defaults returns 403.
#[tokio::test]
async fn test_defaults_non_loopback_returns_403() {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let tmp = tempfile::NamedTempFile::new().expect("temp db file");
    let store = DefaultsStore::open(tmp.path()).expect("open test tugbank db");
    let bank_client = Arc::new(TugbankClient::from_store(store).expect("create TugbankClient"));

    let auth = auth::new_shared_auth_state(7893);
    let (terminal_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (input_tx, _) = tokio::sync::mpsc::channel(256);
    let (code_tx, _) = broadcast::channel(1024);
    let (code_input_tx, _) = tokio::sync::mpsc::channel(256);
    let (shutdown_tx, _) = tokio::sync::mpsc::channel::<u8>(1);
    let (client_action_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

    let dev_state = dev::new_shared_dev_state();
    let mut feed_router = FeedRouter::new(
        "test-dummy".to_string(),
        auth,
        shutdown_tx,
        dev_state.clone(),
    );
    feed_router.register_stream(FeedId::TERMINAL_OUTPUT, terminal_tx, LagPolicy::Bootstrap);
    feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn);
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_tx);

    let app = build_app(feed_router, dev_state, Some(bank_client), None, None);
    // Apply a non-loopback address
    let non_loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)), 0);
    let app = app.layer(MockConnectInfo(non_loopback));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/com.example.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let json = json_body(response).await;
    assert_eq!(json["status"], "error");
    assert_eq!(json["message"], "forbidden");
}

/// T16: PUT a layout JSON then GET it back — verify tagged-value round-trip
/// using the deck layout domain and key.
#[tokio::test]
async fn test_defaults_layout_put_then_get() {
    let (app, _tmp) = build_defaults_test_app();

    let layout_body = r#"{"kind":"json","value":{"version":5,"cards":[{"id":"c1"}]}}"#;

    let put_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/dev.tugtool.deck.layout/layout")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(layout_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put_resp.status(), StatusCode::OK);
    let put_json = json_body(put_resp).await;
    assert_eq!(put_json["status"], "ok");

    let get_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/dev.tugtool.deck.layout/layout")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_resp.status(), StatusCode::OK);
    let got = json_body(get_resp).await;
    assert_eq!(got["kind"], "json");
    assert_eq!(got["value"]["version"], 5);
    assert_eq!(got["value"]["cards"][0]["id"], "c1");
}

/// T17: PUT a theme string then GET it back — verify tagged-value round-trip
/// using the app theme domain and key.
#[tokio::test]
async fn test_defaults_theme_put_then_get() {
    let (app, _tmp) = build_defaults_test_app();

    let theme_body = r#"{"kind":"string","value":"bluenote"}"#;

    let put_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/defaults/dev.tugtool.app/theme")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(theme_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put_resp.status(), StatusCode::OK);
    let put_json = json_body(put_resp).await;
    assert_eq!(put_json["status"], "ok");

    let get_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/defaults/dev.tugtool.app/theme")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_resp.status(), StatusCode::OK);
    let got = json_body(get_resp).await;
    assert_eq!(got["kind"], "string");
    assert_eq!(got["value"], "bluenote");
}

/// T27: All seven Value variants round-trip through PUT then GET.
#[tokio::test]
async fn test_defaults_all_seven_variants_roundtrip() {
    let (app, _tmp) = build_defaults_test_app();

    let cases: &[(&str, &str)] = &[
        ("null-key", r#"{"kind":"null"}"#),
        ("bool-key", r#"{"kind":"bool","value":true}"#),
        ("i64-key", r#"{"kind":"i64","value":42}"#),
        ("f64-key", r#"{"kind":"f64","value":3.14}"#),
        ("string-key", r#"{"kind":"string","value":"hello"}"#),
        ("bytes-key", r#"{"kind":"bytes","value":"AQID"}"#),
        ("json-key", r#"{"kind":"json","value":{"a":1}}"#),
    ];

    for (key, body_str) in cases {
        // PUT
        let put_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/defaults/com.example.test/{key}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body_str.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            put_resp.status(),
            StatusCode::OK,
            "PUT {key} should return 200"
        );

        // GET key
        let get_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/defaults/com.example.test/{key}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            get_resp.status(),
            StatusCode::OK,
            "GET {key} should return 200"
        );

        let got_json = json_body(get_resp).await;
        let expected: serde_json::Value = serde_json::from_str(body_str).unwrap();
        assert_eq!(
            got_json, expected,
            "round-trip mismatch for key {key}: got {got_json}, expected {expected}"
        );
    }
}

// ── Jots API integration tests ────────────────────────────────────────

/// Build a test app wired to a temp `jots.json` path (the file itself is
/// not created — a missing file reads as the empty document). Returns the
/// router (loopback `MockConnectInfo` applied) and the `TempDir` backing it,
/// which the caller must keep alive.
fn build_jots_test_app() -> (axum::Router, tempfile::TempDir, std::path::PathBuf) {
    use axum::extract::connect_info::MockConnectInfo;
    use std::net::{IpAddr, Ipv4Addr};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let path = dir.path().join("jots.json");
    let state = crate::jots::JotsState::new(path.clone(), Arc::new(tokio::sync::Notify::new()));

    let auth = auth::new_shared_auth_state(7893);
    let (terminal_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (input_tx, _) = tokio::sync::mpsc::channel(256);
    let (code_tx, _) = broadcast::channel(1024);
    let (code_input_tx, _) = tokio::sync::mpsc::channel(256);
    let (shutdown_tx, _) = tokio::sync::mpsc::channel::<u8>(1);
    let (client_action_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

    let dev_state = dev::new_shared_dev_state();
    let mut feed_router = FeedRouter::new(
        "test-dummy".to_string(),
        auth,
        shutdown_tx,
        dev_state.clone(),
    );
    feed_router.register_stream(FeedId::TERMINAL_OUTPUT, terminal_tx, LagPolicy::Bootstrap);
    feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn);
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_tx);

    let app = build_app(feed_router, dev_state, None, Some(state), None);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    (app.layer(MockConnectInfo(addr)), dir, path)
}

/// GET on a missing file returns 200 with the empty document, a hash, no error.
#[tokio::test]
async fn test_jots_get_missing_returns_empty() {
    let (app, _dir, _path) = build_jots_test_app();

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/jots")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = json_body(resp).await;
    assert_eq!(json["doc"]["version"], 1);
    assert_eq!(json["doc"]["jots"], serde_json::json!([]));
    assert!(json["hash"].is_string());
    assert!(json["error"].is_null());
}

/// PUT a document, then GET it back — round-trip, and the PUT hash matches the
/// GET hash (the echo-suppression contract).
#[tokio::test]
async fn test_jots_put_then_get_round_trip() {
    let (app, _dir, _path) = build_jots_test_app();

    let doc = r#"{"doc":{"version":1,"jots":[{"id":"sn_a","text":"body"}]}}"#;
    let put_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/jots")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(doc))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put_resp.status(), StatusCode::OK);
    let put_json = json_body(put_resp).await;
    let put_hash = put_json["hash"].as_str().expect("hash string").to_owned();

    let get_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/jots")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_resp.status(), StatusCode::OK);
    let get_json = json_body(get_resp).await;
    assert_eq!(get_json["doc"]["jots"][0]["id"], "sn_a");
    assert_eq!(get_json["hash"].as_str(), Some(put_hash.as_str()));
}

/// PUT with duplicate ids is rejected at the boundary with 400.
#[tokio::test]
async fn test_jots_put_duplicate_ids_rejected() {
    let (app, _dir, _path) = build_jots_test_app();

    let doc = r#"{"doc":{"version":1,"jots":[{"id":"x"},{"id":"x"}]}}"#;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/jots")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(doc))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

/// PUT refuses (409) to clobber an on-disk file that is corrupt.
#[tokio::test]
async fn test_jots_put_refuses_to_clobber_corrupt_file() {
    let (app, _dir, path) = build_jots_test_app();
    std::fs::write(&path, b"{ not valid json").unwrap();

    let doc = r#"{"doc":{"version":1,"jots":[{"id":"sn_a"}]}}"#;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/jots")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(doc))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

// ── Prompt-history API integration tests ──────────────────────────────────

/// Build a test app wired to an in-memory prompt ledger, reachable from
/// `client_ip`. The ledger comes back alongside the router so a test can read
/// the rows the routes wrote without going through the routes again.
fn build_prompt_history_test_app(
    client_ip: IpAddr,
) -> (axum::Router, Arc<crate::prompt_ledger::PromptLedger>) {
    use axum::extract::connect_info::MockConnectInfo;

    let ledger = Arc::new(crate::prompt_ledger::PromptLedger::open_in_memory().expect("ledger"));

    let auth = auth::new_shared_auth_state(7894);
    let (terminal_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (input_tx, _) = tokio::sync::mpsc::channel(256);
    let (code_tx, _) = broadcast::channel(1024);
    let (code_input_tx, _) = tokio::sync::mpsc::channel(256);
    let (shutdown_tx, _) = tokio::sync::mpsc::channel::<u8>(1);
    let (client_action_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

    let dev_state = dev::new_shared_dev_state();
    let mut feed_router = FeedRouter::new(
        "test-dummy".to_string(),
        auth,
        shutdown_tx,
        dev_state.clone(),
    );
    feed_router.register_stream(FeedId::TERMINAL_OUTPUT, terminal_tx, LagPolicy::Bootstrap);
    feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn);
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_tx);

    let app = build_app(feed_router, dev_state, None, None, Some(ledger.clone()));
    let addr = SocketAddr::new(client_ip, 0);
    (app.layer(MockConnectInfo(addr)), ledger)
}

fn loopback_prompt_history_app() -> (axum::Router, Arc<crate::prompt_ledger::PromptLedger>) {
    build_prompt_history_test_app(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)))
}

fn append_request(client_entry_id: &str, text: &str) -> Request<Body> {
    let body = serde_json::json!({
        "session_id": "sess-1",
        "route": "❯",
        "text": text,
        "atoms": [],
        "project_path": "",
        "submitted_at_ms": 1_700_000_000_000i64,
        "client_entry_id": client_entry_id,
    });
    Request::builder()
        .method("POST")
        .uri("/api/prompt-history")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// A submitted prompt lands as a row and the response carries its ledger id.
#[tokio::test]
async fn test_prompt_history_append_returns_the_row_id() {
    let (app, ledger) = loopback_prompt_history_app();

    let resp = app
        .oneshot(append_request("e1", "first prompt"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = json_body(resp).await;
    let id = json["id"].as_i64().expect("an id");

    let (rows, has_more) = ledger.list_page("sess-1", None, 10).unwrap();
    assert!(!has_more);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, id);
    assert_eq!(rows[0].text, "first prompt");
}

/// The whole durability contract in one test: a submitted corpus reads back
/// complete and in submit order, with no cap anywhere in the path.
#[tokio::test]
async fn test_prompt_history_page_returns_the_corpus_in_order() {
    let (app, _ledger) = loopback_prompt_history_app();

    for n in 1..=5 {
        let resp = app
            .clone()
            .oneshot(append_request(&format!("e{n}"), &format!("prompt {n}")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/prompt-history?session=sess-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = json_body(resp).await;
    assert_eq!(json["has_more"], false);
    assert!(json["before"].is_null());
    let texts: Vec<&str> = json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        ["prompt 1", "prompt 2", "prompt 3", "prompt 4", "prompt 5"],
    );

    // A short page hands back the newest rows and says older ones remain.
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/prompt-history?session=sess-1&limit=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = json_body(resp).await;
    assert_eq!(json["has_more"], true);
    let texts: Vec<&str> = json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["prompt 4", "prompt 5"]);
}

/// The retry contract over the wire: the same `client_entry_id` twice is a
/// success carrying the same id, and leaves one row.
#[tokio::test]
async fn test_prompt_history_append_is_idempotent_on_client_entry_id() {
    let (app, ledger) = loopback_prompt_history_app();

    let first = json_body(
        app.clone()
            .oneshot(append_request("e1", "once"))
            .await
            .unwrap(),
    )
    .await;
    let resp = app.oneshot(append_request("e1", "twice")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let second = json_body(resp).await;

    assert_eq!(first["id"], second["id"]);
    let (rows, _) = ledger.list_page("sess-1", None, 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].text, "once", "the landed row is not rewritten");
}

/// The atom-path completion route patches the stored reference in place.
#[tokio::test]
async fn test_prompt_history_atom_path_completes_the_row() {
    let (app, ledger) = loopback_prompt_history_app();

    let body = serde_json::json!({
        "session_id": "sess-1",
        "route": "❯",
        "text": "look at this",
        "atoms": [{"id": "atom-a", "position": 0, "type": "image", "label": "shot.png"}],
        "project_path": "",
        "submitted_at_ms": 1_700_000_000_000i64,
        "client_entry_id": "e1",
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/prompt-history")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let patch = serde_json::json!({
        "client_entry_id": "e1",
        "atom_id": "atom-a",
        "path": "/tmp/draft-attachments/uuid.png",
    });
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/prompt-history/atom-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(patch.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(json_body(resp).await["ok"], true);

    let (rows, _) = ledger.list_page("sess-1", None, 10).unwrap();
    assert_eq!(rows[0].atoms[0]["path"], "/tmp/draft-attachments/uuid.png");
}

/// A malformed body is a 400 and writes nothing.
#[tokio::test]
async fn test_prompt_history_append_rejects_a_malformed_body() {
    let (app, ledger) = loopback_prompt_history_app();

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/prompt-history")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{ not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let (rows, _) = ledger.list_page("sess-1", None, 10).unwrap();
    assert!(rows.is_empty());
}

/// The prompt corpus is loopback-only, like every other local storage route.
#[tokio::test]
async fn test_prompt_history_refuses_a_non_loopback_client() {
    let (app, ledger) = build_prompt_history_test_app(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)));

    let resp = app
        .clone()
        .oneshot(append_request("e1", "from elsewhere"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/prompt-history?session=sess-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    let (rows, _) = ledger.list_page("sess-1", None, 10).unwrap();
    assert!(rows.is_empty());
}

/// With no ledger the routes are absent rather than panicking on a missing
/// `Extension`, and the append fails visibly — which is what the composer's
/// failure notice is built on.
///
/// The exact status is the static fallback's to choose (405 when a built
/// `tugdeck/dist` is being served, 404 when it is not), so the assertion is on
/// the part that is this module's contract: the request does not succeed, and
/// serving it does not bring the process down.
#[tokio::test]
async fn test_prompt_history_routes_are_absent_without_a_ledger() {
    let (app, _token) = build_test_app(7895);

    let resp = app
        .oneshot(append_request("e1", "nowhere to go"))
        .await
        .unwrap();
    assert!(
        resp.status().is_client_error(),
        "unregistered append should fail, got {}",
        resp.status(),
    );
}
