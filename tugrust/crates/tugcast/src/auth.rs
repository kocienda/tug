//! Authentication module for tugcast
//!
//! Implements single-use token authentication with HttpOnly session cookies.
//! The flow:
//! 1. Server generates a random 32-byte token at startup
//! 2. Client exchanges token once via GET /auth?token=TOKEN
//! 3. Server validates token, creates session, sets HttpOnly cookie, invalidates token
//! 4. All subsequent requests authenticated via session cookie

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tracing::{info, warn};

/// Name of the session cookie
pub const SESSION_COOKIE_NAME: &str = "tugcast_session";

/// Default session TTL (24 hours)
pub const DEFAULT_SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Size of the random token in bytes (hex-encoded to 64 characters)
const TOKEN_BYTES: usize = 32;

/// Query parameters for auth token exchange
#[derive(Deserialize)]
pub struct AuthQuery {
    pub token: String,
}

/// Session information
#[derive(Debug, Clone)]
struct Session {
    expires_at: Instant,
}

/// Authentication state shared across requests
#[derive(Debug)]
pub struct AuthState {
    pending_token: Option<String>,
    sessions: HashMap<String, Session>,
    session_ttl: Duration,
    port: u16,
    /// When dev mode is active, also allow origins from the Vite dev server port.
    dev_port: Option<u16>,
    /// When true, skip all authentication checks (session cookies and origin).
    no_auth: bool,
}

impl AuthState {
    /// Create a new AuthState with a generated token
    pub fn new(port: u16) -> Self {
        let token = Self::generate_token();
        info!("Generated auth token: {}", token);

        Self {
            pending_token: Some(token),
            sessions: HashMap::new(),
            session_ttl: DEFAULT_SESSION_TTL,
            port,
            dev_port: None,
            no_auth: false,
        }
    }

    /// Create an AuthState that skips WebSocket authentication checks.
    /// The token exchange still works normally so the app's auth flow
    /// is unaffected — only WebSocket session/origin validation is skipped.
    pub fn new_no_auth(port: u16) -> Self {
        let token = Self::generate_token();
        info!(
            "Auth token: {} (--no-auth: WebSocket checks disabled)",
            token
        );
        Self {
            pending_token: Some(token),
            sessions: HashMap::new(),
            session_ttl: DEFAULT_SESSION_TTL,
            port,
            dev_port: None,
            no_auth: true,
        }
    }

    /// Get the pending token if available
    pub fn token(&self) -> Option<&str> {
        self.pending_token.as_deref()
    }

    /// Validate the provided token (single use - invalidates on success)
    fn validate_token(&mut self, token: &str) -> bool {
        if let Some(ref pending) = self.pending_token {
            if pending == token {
                self.pending_token = None;
                return true;
            }
        }
        false
    }

    /// Create a new session and return the session ID
    fn create_session(&mut self) -> String {
        let session_id = Self::generate_token();
        let session = Session {
            expires_at: Instant::now() + self.session_ttl,
        };
        self.sessions.insert(session_id.clone(), session);
        session_id
    }

    /// Validate a session ID (returns true if valid and not expired).
    ///
    /// Expiry slides: every successful validation pushes it a full TTL out,
    /// so a deck in use never loses its session, and a cookie nobody has
    /// presented for a TTL still dies. The `/api/*` gate validates on every
    /// page request and the websocket on every heartbeat, so a fixed expiry
    /// would refuse an open deck's requests a day after it loaded.
    pub fn validate_session(&mut self, session_id: &str) -> bool {
        let now = Instant::now();
        if let Some(session) = self.sessions.get_mut(session_id) {
            if now < session.expires_at {
                session.expires_at = now + self.session_ttl;
                return true;
            }
            // Session expired, remove it
            self.sessions.remove(session_id);
        }
        false
    }

    /// Set the dev port (Vite dev server) for origin checking.
    /// Pass the Vite dev server port when dev mode is enabled, `None` when disabled.
    pub fn set_dev_port(&mut self, port: Option<u16>) {
        self.dev_port = port;
    }

    /// Check if the origin header matches allowed origins
    pub fn check_origin(&self, origin: &str) -> bool {
        let mut allowed_origins = vec![
            format!("http://127.0.0.1:{}", self.port),
            format!("http://localhost:{}", self.port),
        ];
        if let Some(dev_port) = self.dev_port {
            allowed_origins.push(format!("http://127.0.0.1:{}", dev_port));
            allowed_origins.push(format!("http://localhost:{}", dev_port));
        }
        allowed_origins.iter().any(|allowed| allowed == origin)
    }

    /// Generate a cryptographically random token (hex-encoded)
    fn generate_token() -> String {
        let mut buf = [0u8; TOKEN_BYTES];
        rand::fill(&mut buf);
        buf.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Shared authentication state (thread-safe)
pub type SharedAuthState = Arc<Mutex<AuthState>>;

/// Create a new shared authentication state
pub fn new_shared_auth_state(port: u16) -> SharedAuthState {
    Arc::new(Mutex::new(AuthState::new(port)))
}

/// Create a shared authentication state that skips all checks
pub fn new_shared_auth_state_no_auth(port: u16) -> SharedAuthState {
    Arc::new(Mutex::new(AuthState::new_no_auth(port)))
}

/// Handle auth token exchange
///
/// Validates the provided token and, if valid, creates a session
/// and sets an HttpOnly session cookie.
pub async fn handle_auth(
    Query(params): Query<AuthQuery>,
    State(auth): State<SharedAuthState>,
) -> Response {
    let mut auth_state = auth.lock().unwrap();

    if !auth_state.validate_token(&params.token) {
        warn!("Invalid auth token attempt");
        return (StatusCode::FORBIDDEN, "Invalid or expired token").into_response();
    }

    let session_id = auth_state.create_session();
    info!("Auth token exchanged successfully, session created");

    // Build Set-Cookie header value
    let cookie_value = format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/",
        SESSION_COOKIE_NAME, session_id
    );

    // Return redirect to / with Set-Cookie header
    (
        StatusCode::FOUND,
        [
            (header::SET_COOKIE, cookie_value),
            (header::LOCATION, "/".to_string()),
        ],
    )
        .into_response()
}

/// Extract session cookie from request headers
pub fn extract_session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;

    // Parse Cookie header: "name1=value1; name2=value2; ..."
    for pair in cookie_header.split(';') {
        let pair = pair.trim();
        if let Some((name, value)) = pair.split_once('=') {
            if name == SESSION_COOKIE_NAME {
                return Some(value.to_string());
            }
        }
    }

    None
}

/// Validate that the request has a valid session cookie
pub fn validate_request_session(headers: &HeaderMap, auth: &SharedAuthState) -> bool {
    let mut auth_state = auth.lock().unwrap();
    if auth_state.no_auth {
        return true;
    }

    let session_id = match extract_session_cookie(headers) {
        Some(id) => id,
        None => return false,
    };

    auth_state.validate_session(&session_id)
}

/// Check that the request origin is allowed
pub fn check_request_origin(headers: &HeaderMap, auth: &SharedAuthState) -> bool {
    let auth_state = auth.lock().unwrap();
    if auth_state.no_auth {
        return true;
    }

    let origin = match headers.get(header::ORIGIN) {
        Some(value) => match value.to_str() {
            Ok(s) => s,
            Err(_) => return false,
        },
        None => return false,
    };

    auth_state.check_origin(origin)
}

/// Why the `/api/*` gate refused a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiRefusal {
    /// A page sent it, and its origin is not one of the deck's own.
    ForeignOrigin,
    /// A page sent it from an allowed origin, without a live session cookie.
    NoSession,
}

impl ApiRefusal {
    pub fn message(self) -> &'static str {
        match self {
            ApiRefusal::ForeignOrigin => "Invalid origin",
            ApiRefusal::NoSession => "Invalid or expired session",
        }
    }
}

/// The gate every `/api/*` route passes through.
///
/// Loopback is a network fact, not a trust boundary: any page open in the
/// user's ordinary browser can reach `127.0.0.1`. What tells such a page
/// apart from `tugtool`, the changes forwarder, or the harness is that a
/// browser always marks what it sends — an `Origin` header on every
/// cross-origin or non-GET request, and `Sec-Fetch-Site` on every request
/// at all. A request carrying neither (or only `Sec-Fetch-Site: none`, a
/// navigation the user typed) did not come from a page and passes as it
/// always has; none of those callers holds the deck's cookie.
///
/// A request a page sent must come from the deck's own origin and carry the
/// deck's session, exactly as the websocket handshake requires. With no
/// `Origin` header, only `Sec-Fetch-Site: same-origin` names an origin the
/// gate can trust — the server's own, or the Vite proxy's, which forwards
/// the page's headers unchanged.
pub fn check_api_request(headers: &HeaderMap, auth: &SharedAuthState) -> Result<(), ApiRefusal> {
    let mut auth_state = auth.lock().unwrap();
    if auth_state.no_auth {
        return Ok(());
    }

    let origin = headers.get(header::ORIGIN);
    let fetch_site = headers.get("sec-fetch-site").map(|v| v.as_bytes());
    let from_page = origin.is_some() || fetch_site.is_some_and(|site| site != b"none");
    if !from_page {
        return Ok(());
    }

    let origin_ok = match origin {
        Some(value) => value
            .to_str()
            .is_ok_and(|origin| auth_state.check_origin(origin)),
        None => fetch_site == Some(b"same-origin".as_slice()),
    };
    if !origin_ok {
        return Err(ApiRefusal::ForeignOrigin);
    }

    match extract_session_cookie(headers) {
        Some(session_id) if auth_state.validate_session(&session_id) => Ok(()),
        _ => Err(ApiRefusal::NoSession),
    }
}

/// Whether CORS may answer `origin`: the same list the gate and the
/// websocket check, so the three cannot drift. `--no-auth` opens it, as it
/// opens the other two.
pub fn cors_allows_origin(origin: &str, auth: &SharedAuthState) -> bool {
    let auth_state = auth.lock().unwrap();
    auth_state.no_auth || auth_state.check_origin(origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_generation_length() {
        let auth = AuthState::new(7890);
        assert_eq!(auth.token().unwrap().len(), 64);
    }

    #[test]
    fn test_token_generation_hex() {
        let auth = AuthState::new(7890);
        let token = auth.token().unwrap();
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_token_single_use() {
        let mut auth = AuthState::new(7890);
        let token = auth.token().unwrap().to_string();

        // First use succeeds
        assert!(auth.validate_token(&token));

        // Token is now invalidated
        assert!(auth.token().is_none());

        // Second use fails
        assert!(!auth.validate_token(&token));
    }

    #[test]
    fn test_session_creation_and_validation() {
        let mut auth = AuthState::new(7890);
        let session_id = auth.create_session();

        assert!(auth.validate_session(&session_id));
    }

    #[test]
    fn test_expired_session_rejected() {
        let mut auth = AuthState {
            pending_token: None,
            sessions: HashMap::new(),
            session_ttl: Duration::from_millis(1),
            port: 7890,
            dev_port: None,
            no_auth: false,
        };

        let session_id = auth.create_session();

        // Sleep to ensure expiry
        std::thread::sleep(Duration::from_millis(10));

        // Session should be expired and rejected
        assert!(!auth.validate_session(&session_id));

        // Session should be removed from map
        assert!(!auth.sessions.contains_key(&session_id));
    }

    #[test]
    fn test_session_in_use_slides_past_its_ttl() {
        let mut auth = AuthState {
            pending_token: None,
            sessions: HashMap::new(),
            session_ttl: Duration::from_millis(200),
            port: 7890,
            dev_port: None,
            no_auth: false,
        };

        let session_id = auth.create_session();
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(100));
            assert!(auth.validate_session(&session_id));
        }
    }

    #[test]
    fn test_origin_check_valid() {
        let auth = AuthState::new(7890);

        assert!(auth.check_origin("http://127.0.0.1:7890"));
        assert!(auth.check_origin("http://localhost:7890"));
    }

    #[test]
    fn test_origin_check_invalid() {
        let auth = AuthState::new(7890);

        // Wrong host
        assert!(!auth.check_origin("http://evil.com:7890"));

        // Wrong port
        assert!(!auth.check_origin("http://127.0.0.1:9999"));
        assert!(!auth.check_origin("http://localhost:8080"));

        // Wrong scheme
        assert!(!auth.check_origin("https://127.0.0.1:7890"));
        assert!(!auth.check_origin("https://localhost:7890"));
    }

    #[test]
    fn test_extract_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!(
                "other=value; {}=test-session-id; another=val",
                SESSION_COOKIE_NAME
            )
            .parse()
            .unwrap(),
        );

        let session_id = extract_session_cookie(&headers);
        assert_eq!(session_id, Some("test-session-id".to_string()));
    }

    #[test]
    fn test_no_auth_validate_session_always_true() {
        let auth = new_shared_auth_state_no_auth(7890);
        // No cookie at all — should still pass with no_auth
        let headers = HeaderMap::new();
        assert!(validate_request_session(&headers, &auth));
    }

    #[test]
    fn test_no_auth_check_origin_always_true() {
        let auth = new_shared_auth_state_no_auth(7890);
        // Wrong origin — should still pass with no_auth
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://evil.com:9999".parse().unwrap());
        assert!(check_request_origin(&headers, &auth));

        // No origin header — should still pass
        let empty_headers = HeaderMap::new();
        assert!(check_request_origin(&empty_headers, &auth));
    }

    #[test]
    fn test_no_auth_does_not_affect_token_exchange() {
        let mut auth = AuthState::new_no_auth(7890);
        let token = auth.token().unwrap().to_string();

        // Token exchange still works normally (not bypassed)
        assert!(auth.validate_token(&token));
        assert!(auth.token().is_none());
        assert!(!auth.validate_token(&token));
    }

    #[test]
    fn test_extract_session_cookie_missing() {
        let headers = HeaderMap::new();
        assert_eq!(extract_session_cookie(&headers), None);

        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "other=value".parse().unwrap());
        assert_eq!(extract_session_cookie(&headers), None);
    }

    /// An auth state with one live session, and that session's cookie.
    fn gated() -> (SharedAuthState, String) {
        let auth = new_shared_auth_state(7890);
        let session_id = auth.lock().unwrap().create_session();
        (auth, format!("{SESSION_COOKIE_NAME}={session_id}"))
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        headers
    }

    #[test]
    fn api_gate_admits_the_deck_with_its_cookie() {
        let (auth, cookie) = gated();
        let request = headers(&[("origin", "http://127.0.0.1:7890"), ("cookie", &cookie)]);
        assert_eq!(check_api_request(&request, &auth), Ok(()));
    }

    #[test]
    fn api_gate_refuses_an_allowed_origin_without_a_cookie() {
        let (auth, _) = gated();
        let request = headers(&[("origin", "http://localhost:7890")]);
        assert_eq!(
            check_api_request(&request, &auth),
            Err(ApiRefusal::NoSession)
        );
    }

    #[test]
    fn api_gate_refuses_a_foreign_origin_even_with_a_cookie() {
        let (auth, cookie) = gated();
        let request = headers(&[("origin", "https://evil.example"), ("cookie", &cookie)]);
        assert_eq!(
            check_api_request(&request, &auth),
            Err(ApiRefusal::ForeignOrigin)
        );
    }

    /// `tugtool`, the changes forwarder, and the harness send no browser
    /// marks and hold no cookie; they pass as they always have.
    #[test]
    fn api_gate_admits_a_local_process_with_no_browser_marks() {
        let (auth, _) = gated();
        assert_eq!(check_api_request(&HeaderMap::new(), &auth), Ok(()));
        let typed = headers(&[("sec-fetch-site", "none")]);
        assert_eq!(check_api_request(&typed, &auth), Ok(()));
    }

    /// A no-cors subresource load (`<img src>`, `<script src>`) carries no
    /// `Origin`, but the browser still says where it came from.
    #[test]
    fn api_gate_refuses_a_cross_site_request_with_no_origin() {
        let (auth, cookie) = gated();
        for site in ["cross-site", "same-site"] {
            let request = headers(&[("sec-fetch-site", site), ("cookie", &cookie)]);
            assert_eq!(
                check_api_request(&request, &auth),
                Err(ApiRefusal::ForeignOrigin),
                "{site}"
            );
        }
    }

    /// The deck's own same-origin GETs carry no `Origin`; the cookie is
    /// what admits them.
    #[test]
    fn api_gate_admits_a_same_origin_get_only_with_its_cookie() {
        let (auth, cookie) = gated();
        let with = headers(&[("sec-fetch-site", "same-origin"), ("cookie", &cookie)]);
        assert_eq!(check_api_request(&with, &auth), Ok(()));
        let without = headers(&[("sec-fetch-site", "same-origin")]);
        assert_eq!(
            check_api_request(&without, &auth),
            Err(ApiRefusal::NoSession)
        );
    }

    #[test]
    fn api_gate_and_cors_open_under_no_auth() {
        let auth = new_shared_auth_state_no_auth(7890);
        let request = headers(&[("origin", "https://evil.example")]);
        assert_eq!(check_api_request(&request, &auth), Ok(()));
        assert!(cors_allows_origin("https://evil.example", &auth));
    }

    #[test]
    fn cors_follows_the_dev_port() {
        let (auth, _) = gated();
        assert!(cors_allows_origin("http://127.0.0.1:7890", &auth));
        assert!(!cors_allows_origin("http://localhost:55155", &auth));
        auth.lock().unwrap().set_dev_port(Some(55155));
        assert!(cors_allows_origin("http://localhost:55155", &auth));
        assert!(!cors_allows_origin("https://evil.example", &auth));
    }

    #[test]
    fn test_cookie_header_format() {
        let cookie = format!(
            "{}=test-id; HttpOnly; SameSite=Strict; Path=/",
            SESSION_COOKIE_NAME
        );

        // Verify required attributes are present
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Path=/"));
        assert!(cookie.contains(&format!("{}=", SESSION_COOKIE_NAME)));
    }
}
