//! The Claude Code download, run by Tug rather than by the official script.
//!
//! `claude_auth::install()` pipes `https://claude.ai/install.sh` into `bash`
//! and learns nothing until it exits: no byte total, no progress, and no way
//! to stop it and pick it up again. The wizard's row showed a spinner and a
//! sentence because that was all there was to show.
//!
//! This module reproduces the script's fetch sequence — `latest`, then
//! `<version>/manifest.json`, then the platform's `size` and SHA-256
//! `checksum`, then `<version>/<platform>/claude` — and streams the binary to
//! a partial file of its own, reporting bytes as they arrive. Everything after
//! the bytes are verified is still Anthropic's: `chmod +x` and the binary's own
//! `install` subcommand, which is exactly what the script does, so shell
//! integration, launcher placement and `$TARGET` handling are unchanged.
//!
//! **The script stays as the fallback.** When `latest` or the manifest cannot
//! be fetched or parsed — an unexpected content type, a region that does not
//! serve the channel, a manifest shape that moved — [`fetch_binary`] answers
//! [`FetchOutcome::Unresolved`] and the caller runs `curl | bash` unchanged.
//! A *checksum* failure is not that case: the manifest was read and the bytes
//! disagreed with it, which is a failure to report rather than a reason to
//! fetch the same bytes a second way.
//!
//! **The `.zst` variant is skipped.** It saves bandwidth only on a machine
//! that has `zstd`, and it costs a second manifest, a second checksum and a
//! decompression step on a path whose whole point is a number the user can
//! trust.
//!
//! ## Stopping, and starting again
//!
//! A download in flight is held by [`take_control`]: one at a time, cancelled
//! through a token. Pausing drops the in-flight request and **keeps** the
//! partial file; cancelling deletes it. Because the partial is named for the
//! version it is bytes of, a pause survives a tugcast restart — the next
//! attempt finds the file, asks for `Range: bytes=<len>-`, and continues.
//!
//! A server that ignores the range and answers 200 is not an error: the
//! response is the whole file, so the partial is truncated and written from
//! the top. That is the one case where a resume silently becomes a restart,
//! and it is why the write path keys off the response's status rather than off
//! what was asked for.

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

/// Where the official script fetches from, and therefore where this does.
pub const DOWNLOAD_BASE_URL: &str = "https://downloads.claude.ai/claude-code-releases";

/// The release-channel and manifest lookups are small documents on a CDN; a
/// slow one is a reason to fall back to the script rather than to sit there.
const METADATA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Why a download stopped short of its last byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The partial file is kept and a later attempt resumes against it.
    Paused,
    /// The partial file is deleted; a later attempt starts from the top.
    Cancelled,
}

/// What a fetch ended as.
#[derive(Debug)]
pub enum FetchOutcome {
    /// The bytes are on disk, verified against the manifest's checksum, at
    /// this path.
    Ready { path: PathBuf, version: String },
    /// The user stopped it.
    Stopped(StopReason),
    /// Something went wrong *after* the release resolved — a dropped
    /// connection, a full disk, a checksum that did not match.
    Failed(String),
    /// `latest` or the manifest could not be fetched or parsed. The caller
    /// runs the official script ([B08]).
    Unresolved,
}

/// A release resolved from the channel: the version, and the platform's
/// entry in its manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub platform: String,
    pub size: u64,
    pub checksum: String,
}

// ---------------------------------------------------------------------------
// The one download in flight
// ---------------------------------------------------------------------------

/// The token cancelling whatever download is running, and the reason it was
/// cancelled with. There is one download at a time — the wizard has one row
/// and one button — so one slot is the whole of the bookkeeping.
struct Control {
    token: Arc<CancellationToken>,
    reason: StopReason,
}

static CURRENT: OnceLock<Mutex<Option<Control>>> = OnceLock::new();

fn current() -> &'static Mutex<Option<Control>> {
    CURRENT.get_or_init(|| Mutex::new(None))
}

/// Register a new download and hand back its cancellation token, displacing
/// (and cancelling) any download already in flight. A second Install press
/// should not leave two writers on one partial file.
pub fn take_control() -> Arc<CancellationToken> {
    let token = Arc::new(CancellationToken::new());
    let mut slot = current().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(previous) = slot.take() {
        previous.token.cancel();
    }
    *slot = Some(Control {
        token: Arc::clone(&token),
        reason: StopReason::Cancelled,
    });
    token
}

/// Release the slot once a download has finished on its own — but only if the
/// slot still holds *this* download.
///
/// Identity, by pointer. Comparing the two tokens' cancelled-ness instead
/// would agree by coincidence in the ordinary cases and disagree in the one
/// that matters: a displaced download finishing after its successor had also
/// been cancelled would clear the successor's slot, leaving a live transfer
/// with nothing to stop it — a Pause that does nothing, and a
/// `stop_reason()` that defaults to `Cancelled` and deletes bytes the user
/// asked to keep.
pub fn release_control(token: &Arc<CancellationToken>) {
    let mut slot = current().lock().unwrap_or_else(|e| e.into_inner());
    if slot
        .as_ref()
        .is_some_and(|control| Arc::ptr_eq(&control.token, token))
    {
        *slot = None;
    }
}

/// Stop the download in flight, recording why. `false` when nothing is
/// running — a Pause the user pressed just as the last byte landed is a
/// no-op rather than an error.
pub fn stop(reason: StopReason) -> bool {
    let mut slot = current().lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_mut() {
        Some(control) => {
            control.reason = reason;
            control.token.cancel();
            true
        }
        None => false,
    }
}

/// Why the download in flight was stopped. Read by the fetch loop the moment
/// its token fires, since the token itself carries no reason.
fn stop_reason() -> StopReason {
    current()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map_or(StopReason::Cancelled, |control| control.reason)
}

// ---------------------------------------------------------------------------
// Platform and paths
// ---------------------------------------------------------------------------

/// The platform string the manifest is keyed by, spelled exactly as the
/// official script spells it (`darwin-arm64`, `linux-x64`, …).
///
/// The script's Rosetta case is not reproduced: tugcast is the app's own
/// binary and is never translated, so `std::env::consts::ARCH` is already the
/// architecture the machine runs natively.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// Where partial and completed downloads live: `<data-dir>/downloads/`.
pub fn download_dir() -> PathBuf {
    tugcore::instance::data_dir().join("downloads")
}

/// The partial file for one release. Named for the version so a resume can
/// tell the bytes it kept from the bytes a newer release would want, and so
/// the file survives a tugcast restart with its identity intact ([B09]).
pub fn partial_path(dir: &Path, release: &Release) -> PathBuf {
    dir.join(format!(
        "claude-{}-{}.partial",
        release.version, release.platform
    ))
}

/// The verified binary's path — the partial's name without the suffix, which
/// is what the script calls it too.
pub fn binary_path(dir: &Path, release: &Release) -> PathBuf {
    dir.join(format!("claude-{}-{}", release.version, release.platform))
}

/// Delete every partial in the download directory. Cancel's other half: the
/// bytes go, and a later Install starts from the top.
pub fn discard_partials(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "partial") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// Resolving the release
// ---------------------------------------------------------------------------

/// A version string as the channel serves it: `2.1.222`, optionally with a
/// pre-release suffix. The script rejects anything else before it builds a
/// manifest URL out of it, because an HTML error page served with a 200 is
/// otherwise concatenated into a request for a directory that does not exist.
fn parse_version(text: &str) -> Option<String> {
    let version = text.trim();
    let mut parts = version.split('-');
    let core = parts.next()?;
    let mut numbers = core.split('.');
    let (major, minor, patch) = (numbers.next()?, numbers.next()?, numbers.next()?);
    if numbers.next().is_some() {
        return None;
    }
    if [major, minor, patch]
        .iter()
        .any(|n| n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(version.to_string())
}

/// Read `platforms[<platform>]`'s `size` and `checksum` out of a manifest.
fn parse_manifest(json: &str, platform: &str) -> Option<(u64, String)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let entry = value.get("platforms")?.get(platform)?;
    let size = entry.get("size")?.as_u64()?;
    let checksum = entry.get("checksum")?.as_str()?.to_string();
    // The script validates the shape before it trusts the comparison; a
    // truncated or absent checksum would otherwise "match" nothing and fail
    // every download with a mismatch rather than with what went wrong.
    if checksum.len() != 64 || !checksum.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((size, checksum))
}

/// Resolve the newest release on the channel and the platform's entry in its
/// manifest. `None` is the script's case ([B08]) rather than a failure.
pub async fn resolve_release(base_url: &str, platform: &str) -> Option<Release> {
    let client = reqwest::Client::new();
    let latest = client
        .get(format!("{base_url}/latest"))
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !latest.status().is_success() {
        return None;
    }
    let version = parse_version(&latest.text().await.ok()?)?;

    let manifest = client
        .get(format!("{base_url}/{version}/manifest.json"))
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !manifest.status().is_success() {
        return None;
    }
    let (size, checksum) = parse_manifest(&manifest.text().await.ok()?, platform)?;
    Some(Release {
        version,
        platform: platform.to_string(),
        size,
        checksum,
    })
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/// Stream the platform's binary to a partial file, resuming against whatever
/// is already there, and verify it against the manifest's checksum.
///
/// `on_progress` is called with `(received, expected)` on every **whole
/// percent** change and once at the end — the same rule the update snapshot
/// publishes under ([B06]), so a 90 MB download costs a hundred frames rather
/// than one per chunk.
pub async fn fetch_binary<F>(
    base_url: &str,
    dir: &Path,
    platform: &str,
    stop: &CancellationToken,
    mut on_progress: F,
) -> FetchOutcome
where
    F: FnMut(u64, u64, &str),
{
    let Some(release) = resolve_release(base_url, platform).await else {
        return FetchOutcome::Unresolved;
    };
    if stop.is_cancelled() {
        return FetchOutcome::Stopped(stop_reason());
    }
    if let Err(e) = tokio::fs::create_dir_all(dir).await {
        return FetchOutcome::Failed(format!("could not make the download directory: {e}"));
    }

    let partial = partial_path(dir, &release);
    let have = tokio::fs::metadata(&partial)
        .await
        .map_or(0, |meta| meta.len());
    // More bytes than the manifest claims is a partial from something else, or
    // from a release that reused a version. Start over rather than reason
    // about it.
    let have = if have >= release.size { 0 } else { have };

    let url = format!("{base_url}/{}/{}/claude", release.version, release.platform);
    let mut request = reqwest::Client::new().get(&url);
    if have > 0 {
        info!(
            version = %release.version,
            have,
            total = release.size,
            "claude_download: resuming"
        );
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => return FetchOutcome::Failed(format!("download failed: {e}")),
    };
    if !response.status().is_success() {
        return FetchOutcome::Failed(format!("download failed: HTTP {}", response.status()));
    }
    // A server that ignored the range answers 200 with the whole file. Keeping
    // the partial would splice the file's head onto its own middle, so the
    // restart is forced here rather than trusted to the request.
    let resuming = have > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if have > 0 && !resuming {
        info!("claude_download: the server ignored the range — starting over");
    }

    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!resuming)
        .open(&partial)
        .await
    {
        Ok(file) => file,
        Err(e) => return FetchOutcome::Failed(format!("could not open the partial file: {e}")),
    };
    let mut received = if resuming { have } else { 0 };
    if resuming {
        if let Err(e) = file.seek(SeekFrom::Start(received)).await {
            return FetchOutcome::Failed(format!("could not seek the partial file: {e}"));
        }
    }

    let mut last_percent = percent_of(received, release.size);
    on_progress(received, release.size, &release.version);

    let mut stream = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            biased;
            () = stop.cancelled() => {
                let _ = file.flush().await;
                let reason = stop_reason();
                if reason == StopReason::Cancelled {
                    drop(file);
                    let _ = tokio::fs::remove_file(&partial).await;
                }
                info!(?reason, received, "claude_download: stopped");
                return FetchOutcome::Stopped(reason);
            }
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => return FetchOutcome::Failed(format!("download failed: {e}")),
        };
        if let Err(e) = file.write_all(&chunk).await {
            return FetchOutcome::Failed(format!("could not write the partial file: {e}"));
        }
        received += chunk.len() as u64;
        let percent = percent_of(received, release.size);
        if percent != last_percent {
            last_percent = percent;
            on_progress(received, release.size, &release.version);
        }
    }
    if let Err(e) = file.flush().await {
        return FetchOutcome::Failed(format!("could not write the partial file: {e}"));
    }
    drop(file);
    on_progress(received, release.size, &release.version);

    match checksum_of(&partial).await {
        Ok(digest) if digest == release.checksum => {}
        Ok(_) => {
            // The manifest was read and the bytes disagree with it. The partial
            // goes, because keeping it would have every later resume continue
            // bytes that are already known to be wrong.
            let _ = tokio::fs::remove_file(&partial).await;
            warn!(version = %release.version, "claude_download: checksum mismatch");
            return FetchOutcome::Failed("the download did not match its checksum".to_string());
        }
        Err(e) => return FetchOutcome::Failed(format!("could not read the download: {e}")),
    }

    let binary = binary_path(dir, &release);
    if let Err(e) = tokio::fs::rename(&partial, &binary).await {
        return FetchOutcome::Failed(format!("could not finish the download: {e}"));
    }
    FetchOutcome::Ready {
        path: binary,
        version: release.version,
    }
}

/// Whole percent, floored, with a zero total reading as zero rather than
/// dividing by it.
fn percent_of(received: u64, expected: u64) -> u64 {
    if expected == 0 {
        return 0;
    }
    received.saturating_mul(100) / expected
}

/// SHA-256 of a file, hex, lowercase — the spelling the manifest uses.
async fn checksum_of(path: &Path) -> std::io::Result<String> {
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// `chmod +x` the verified binary and run its own `install` subcommand, which
/// is the whole of what the script does after its checksum check. The binary
/// is removed afterwards either way — it has installed itself somewhere else.
pub async fn run_installer(binary: &Path) -> (bool, Option<String>) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o755)) {
        return (
            false,
            Some(format!("could not make the download runnable: {e}")),
        );
    }
    let outcome = tokio::process::Command::new(binary)
        .arg("install")
        .output()
        .await;
    let _ = std::fs::remove_file(binary);
    match outcome {
        Ok(out) if out.status.success() => (true, None),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.trim().lines().last().unwrap_or("install failed");
            (false, Some(detail.to_string()))
        }
        Err(e) => (false, Some(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_channel_versions_and_rejects_a_web_page() {
        assert_eq!(parse_version("2.1.222\n").as_deref(), Some("2.1.222"));
        assert_eq!(
            parse_version("  2.1.222-rc.1 ").as_deref(),
            Some("2.1.222-rc.1")
        );
        assert_eq!(parse_version("<!DOCTYPE html>"), None);
        assert_eq!(parse_version("2.1"), None);
        assert_eq!(parse_version("2.1.2.3"), None);
        assert_eq!(parse_version("2.1.x"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn reads_the_platform_entry_and_refuses_a_short_checksum() {
        let good = r#"{"platforms":{"darwin-arm64":{"size":123,"checksum":"ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"}}}"#;
        assert_eq!(
            parse_manifest(good, "darwin-arm64"),
            Some((
                123,
                "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12".to_string()
            ))
        );
        assert_eq!(parse_manifest(good, "linux-x64"), None);
        let short = r#"{"platforms":{"darwin-arm64":{"size":1,"checksum":"abc"}}}"#;
        assert_eq!(parse_manifest(short, "darwin-arm64"), None);
        assert_eq!(parse_manifest("not json", "darwin-arm64"), None);
    }

    #[test]
    fn the_platform_string_is_the_scripts_spelling() {
        let platform = platform();
        assert!(
            platform.starts_with("darwin-") || platform.starts_with("linux-"),
            "unexpected platform {platform}"
        );
        assert!(!platform.contains("x86_64"), "x86_64 is spelled x64");
        assert!(!platform.contains("macos"), "macos is spelled darwin");
    }

    #[test]
    fn percentages_floor_and_survive_a_zero_total() {
        assert_eq!(percent_of(0, 0), 0);
        assert_eq!(percent_of(0, 100), 0);
        assert_eq!(percent_of(1, 3), 33);
        assert_eq!(percent_of(100, 100), 100);
    }

    /// A displaced download must not release its successor's slot.
    ///
    /// The slot is what `stop` reaches and what `stop_reason` reads, so a
    /// download that lost it is one the user's Pause cannot stop — and one
    /// whose bytes a later cancellation would delete under the default
    /// reason.
    #[test]
    #[serial_test::serial]
    fn a_displaced_download_does_not_release_its_successor() {
        let first = take_control();
        let second = take_control();
        assert!(first.is_cancelled(), "a second press displaces the first");

        // The displaced download is stopped too, so the two tokens agree
        // about being cancelled and disagree about being the same thing.
        assert!(stop(StopReason::Paused));
        release_control(&first);

        assert_eq!(
            stop_reason(),
            StopReason::Paused,
            "the slot is still the second download's"
        );
        release_control(&second);
        assert!(
            !stop(StopReason::Paused),
            "and it lets go when its own owner does"
        );
    }
}

/// The fetch, against a stand-in for the release CDN ([B14]).
///
/// A download is the one thing that cannot be reasoned about from its parts:
/// whether the partial survives a pause, whether the resume asks for the right
/// byte, and whether a server that ignores the range splices two halves of a
/// file together are all answers only a real socket gives. So these run one —
/// a few hundred lines of HTTP on an ephemeral port, serving a `latest`, a
/// manifest and a body it can stall in the middle of.
#[cfg(test)]
mod against_a_local_server {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncReadExt;
    use tokio::net::{TcpListener, TcpStream};

    const PLATFORM: &str = "darwin-arm64";

    /// What the stand-in serves. `None` for a version or a manifest is the
    /// script-fallback case ([B08]): the document 404s.
    struct Feed {
        version: Option<String>,
        manifest: Option<String>,
        body: Vec<u8>,
        honor_ranges: bool,
        /// Bytes to write on the **first** request for the binary before going
        /// quiet, so a test can catch a transfer in flight and stop it.
        stall_after: Option<usize>,
    }

    struct Served {
        base: String,
        /// Every `Range` header the binary was asked for, in order — `None`
        /// for a request that carried none.
        ranges: Arc<Mutex<Vec<Option<String>>>>,
    }

    /// A manifest naming this body's real length and digest.
    fn manifest_for(body: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(body);
        let digest = format!("{:x}", hasher.finalize());
        format!(
            r#"{{"platforms":{{"{PLATFORM}":{{"size":{},"checksum":"{digest}"}}}}}}"#,
            body.len()
        )
    }

    /// A body whose bytes are distinguishable from each other, so a splice
    /// shows up as a checksum failure rather than passing by coincidence.
    fn body_of(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    fn feed(body: Vec<u8>) -> Feed {
        Feed {
            version: Some("2.1.222".to_string()),
            manifest: Some(manifest_for(&body)),
            body,
            honor_ranges: true,
            stall_after: None,
        }
    }

    async fn serve(feed: Feed) -> Served {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let feed = Arc::new(feed);
        let ranges: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&ranges);
        let requests = Arc::new(AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let feed = Arc::clone(&feed);
                let seen = Arc::clone(&seen);
                let requests = Arc::clone(&requests);
                tokio::spawn(handle(socket, feed, seen, requests));
            }
        });
        Served {
            base: format!("http://127.0.0.1:{port}"),
            ranges,
        }
    }

    async fn handle(
        mut socket: TcpStream,
        feed: Arc<Feed>,
        seen: Arc<Mutex<Vec<Option<String>>>>,
        requests: Arc<AtomicUsize>,
    ) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        let path = text
            .lines()
            .next()
            .and_then(|line| line.split(' ').nth(1))
            .unwrap_or("")
            .to_string();
        // hyper writes header names lowercase; the spelling is not the point.
        let range = text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("range")
                .then(|| value.trim().to_string())
        });

        if path.ends_with("/latest") {
            match feed.version.as_deref() {
                Some(version) => respond(&mut socket, "200 OK", version.as_bytes(), None).await,
                None => respond(&mut socket, "404 Not Found", b"no", None).await,
            }
            return;
        }
        if path.ends_with("/manifest.json") {
            match feed.manifest.as_deref() {
                Some(manifest) => respond(&mut socket, "200 OK", manifest.as_bytes(), None).await,
                None => respond(&mut socket, "404 Not Found", b"no", None).await,
            }
            return;
        }
        if !path.ends_with("/claude") {
            respond(&mut socket, "404 Not Found", b"no", None).await;
            return;
        }

        seen.lock().unwrap().push(range.clone());
        let first = requests.fetch_add(1, Ordering::SeqCst) == 0;
        let start = match range.as_deref().filter(|_| feed.honor_ranges) {
            Some(value) => value
                .trim_start_matches("bytes=")
                .trim_end_matches('-')
                .parse::<usize>()
                .unwrap_or(0),
            None => 0,
        }
        .min(feed.body.len());
        let slice = &feed.body[start..];
        let status = if start > 0 {
            "206 Partial Content"
        } else {
            "200 OK"
        };
        let content_range = (start > 0)
            .then(|| format!("bytes {start}-{}/{}", feed.body.len() - 1, feed.body.len()));
        let stall = feed.stall_after.filter(|_| first);
        respond_head(&mut socket, status, slice.len(), content_range).await;
        match stall {
            Some(n) => {
                let n = n.min(slice.len());
                let _ = socket.write_all(&slice[..n]).await;
                let _ = socket.flush().await;
                // Go quiet under a full Content-Length: the transfer is in
                // flight and incomplete, which is exactly what a Pause meets.
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
            None => {
                let _ = socket.write_all(slice).await;
                let _ = socket.flush().await;
            }
        }
    }

    async fn respond_head(
        socket: &mut TcpStream,
        status: &str,
        length: usize,
        content_range: Option<String>,
    ) {
        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n"
        );
        if let Some(range) = content_range {
            head.push_str(&format!("Content-Range: {range}\r\n"));
        }
        head.push_str("\r\n");
        let _ = socket.write_all(head.as_bytes()).await;
    }

    async fn respond(
        socket: &mut TcpStream,
        status: &str,
        body: &[u8],
        content_range: Option<String>,
    ) {
        respond_head(socket, status, body.len(), content_range).await;
        let _ = socket.write_all(body).await;
        let _ = socket.flush().await;
    }

    /// Wait for the partial file to reach `len`, so a test stops a transfer
    /// that has genuinely started rather than one that may not have.
    async fn wait_for_partial(path: &Path, len: u64) {
        for _ in 0..1_000 {
            if std::fs::metadata(path).is_ok_and(|meta| meta.len() >= len) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the partial never reached {len} bytes");
    }

    fn partial_in(dir: &Path) -> PathBuf {
        dir.join("claude-2.1.222-darwin-arm64.partial")
    }

    #[tokio::test]
    async fn downloads_the_binary_verifies_it_and_reports_whole_percents() {
        let body = body_of(4096);
        let served = serve(feed(body.clone())).await;
        let dir = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let mut seen: Vec<(u64, u64)> = Vec::new();
        let outcome = fetch_binary(&served.base, dir.path(), PLATFORM, &token, |r, e, _| {
            seen.push((r, e))
        })
        .await;
        match outcome {
            FetchOutcome::Ready { path, version } => {
                assert_eq!(version, "2.1.222");
                assert_eq!(std::fs::read(&path).unwrap(), body);
            }
            other => panic!("expected the bytes, got {other:?}"),
        }
        assert_eq!(seen.first(), Some(&(0, 4096)));
        assert_eq!(seen.last(), Some(&(4096, 4096)));
        // The partial is gone: a finished download is a binary, not a partial.
        assert!(!partial_in(dir.path()).exists());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_pause_keeps_the_partial_and_the_resume_asks_for_the_rest() {
        let body = body_of(8192);
        let served = serve(Feed {
            stall_after: Some(1024),
            ..feed(body.clone())
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let partial = partial_in(dir.path());

        let token = take_control();
        let (outcome, ()) = tokio::join!(
            fetch_binary(&served.base, dir.path(), PLATFORM, &token, |_, _, _| {}),
            async {
                wait_for_partial(&partial, 1024).await;
                assert!(stop(StopReason::Paused));
            }
        );
        assert!(
            matches!(outcome, FetchOutcome::Stopped(StopReason::Paused)),
            "expected a pause, got {outcome:?}"
        );
        assert_eq!(
            std::fs::metadata(&partial).unwrap().len(),
            1024,
            "a pause keeps what arrived"
        );

        let token = take_control();
        let outcome = fetch_binary(&served.base, dir.path(), PLATFORM, &token, |_, _, _| {}).await;
        match outcome {
            FetchOutcome::Ready { path, .. } => {
                assert_eq!(std::fs::read(&path).unwrap(), body)
            }
            other => panic!("expected the rest of the bytes, got {other:?}"),
        }
        assert_eq!(
            *served.ranges.lock().unwrap(),
            vec![None, Some("bytes=1024-".to_string())],
            "the resume asks for the byte after the last one it kept"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_cancel_discards_the_partial() {
        let body = body_of(8192);
        let served = serve(Feed {
            stall_after: Some(1024),
            ..feed(body)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let partial = partial_in(dir.path());

        let token = take_control();
        let (outcome, ()) = tokio::join!(
            fetch_binary(&served.base, dir.path(), PLATFORM, &token, |_, _, _| {}),
            async {
                wait_for_partial(&partial, 1024).await;
                assert!(stop(StopReason::Cancelled));
            }
        );
        assert!(
            matches!(outcome, FetchOutcome::Stopped(StopReason::Cancelled)),
            "expected a cancel, got {outcome:?}"
        );
        assert!(!partial.exists(), "a cancel keeps nothing");
    }

    #[tokio::test]
    async fn a_server_that_ignores_the_range_starts_the_download_over() {
        let body = body_of(4096);
        let served = serve(Feed {
            honor_ranges: false,
            ..feed(body.clone())
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        // A partial from an earlier attempt, and deliberately not this body's
        // first 1024 bytes: if the restart spliced instead of truncating, the
        // checksum would catch it.
        let partial = partial_in(dir.path());
        std::fs::write(&partial, vec![0xAB; 1024]).unwrap();

        let token = CancellationToken::new();
        let outcome = fetch_binary(&served.base, dir.path(), PLATFORM, &token, |_, _, _| {}).await;
        match outcome {
            FetchOutcome::Ready { path, .. } => {
                assert_eq!(std::fs::read(&path).unwrap(), body)
            }
            other => panic!("expected a restart that verified, got {other:?}"),
        }
        assert_eq!(
            *served.ranges.lock().unwrap(),
            vec![Some("bytes=1024-".to_string())],
            "the range was asked for — the server is the one that declined"
        );
    }

    #[tokio::test]
    async fn a_checksum_that_does_not_match_fails_and_keeps_nothing() {
        let body = body_of(4096);
        let served = serve(Feed {
            manifest: Some(format!(
                r#"{{"platforms":{{"{PLATFORM}":{{"size":4096,"checksum":"{}"}}}}}}"#,
                "0".repeat(64)
            )),
            ..feed(body)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let outcome = fetch_binary(&served.base, dir.path(), PLATFORM, &token, |_, _, _| {}).await;
        match outcome {
            FetchOutcome::Failed(message) => assert!(
                message.contains("checksum"),
                "the message should name what went wrong: {message}"
            ),
            other => panic!("expected a failure, got {other:?}"),
        }
        assert!(
            !partial_in(dir.path()).exists(),
            "bytes known to be wrong are not kept for a later resume to continue"
        );
    }

    #[tokio::test]
    async fn a_channel_that_does_not_answer_hands_back_to_the_script() {
        let served = serve(Feed {
            version: None,
            ..feed(body_of(16))
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let outcome = fetch_binary(&served.base, dir.path(), PLATFORM, &token, |_, _, _| {}).await;
        assert!(
            matches!(outcome, FetchOutcome::Unresolved),
            "expected the script's case, got {outcome:?}"
        );
    }

    #[tokio::test]
    async fn a_manifest_without_this_platform_hands_back_to_the_script() {
        let served = serve(Feed {
            manifest: Some(r#"{"platforms":{"linux-x64":{"size":1,"checksum":"x"}}}"#.to_string()),
            ..feed(body_of(16))
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let outcome = fetch_binary(&served.base, dir.path(), PLATFORM, &token, |_, _, _| {}).await;
        assert!(
            matches!(outcome, FetchOutcome::Unresolved),
            "expected the script's case, got {outcome:?}"
        );
    }
}
