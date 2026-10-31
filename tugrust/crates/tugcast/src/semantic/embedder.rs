//! The client for `tugembed`, the Swift helper that embeds on device: one process
//! at a time, spoken to over JSON lines, restarted when it dies.
//!
//! The process sits behind a spawner seam, as a `claude` worker does, so tests run
//! against a fake that speaks the same protocol. A helper that cannot be started
//! is a state the client reports and never an error anything else has to survive:
//! the first time is logged, and every caller just gets no vectors.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, watch};
use tracing::{info, warn};

/// How long a helper has to announce its model, which loads it.
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// How long one batch of texts may take. A helper past this is retired.
const EMBED_TIMEOUT: Duration = Duration::from_secs(60);

/// The first wait before restarting a helper that died, doubled per failure.
const RESTART_BACKOFF: Duration = Duration::from_secs(1);

/// Consecutive deaths after which the client stops restarting by itself. The next
/// caller still tries once, so a helper that recovers is picked up.
const MAX_RESTARTS: u32 = 5;

/// A running helper's pipes. Dropping it ends the helper.
pub(crate) struct EmbedderPipes {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    /// Whatever must live as long as the process does.
    pub guard: Box<dyn Send>,
}

pub(crate) trait EmbedderSpawner: Send + Sync + 'static {
    fn spawn(&self) -> std::io::Result<EmbedderPipes>;
}

/// Spawns the `tugembed` beside this executable.
pub(crate) struct HelperSpawner;

impl EmbedderSpawner for HelperSpawner {
    fn spawn(&self) -> std::io::Result<EmbedderPipes> {
        let exe = std::env::current_exe()?;
        let helper = exe.with_file_name("tugembed");
        let mut child = tokio::process::Command::new(helper)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        Ok(EmbedderPipes {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            guard: Box::new(child),
        })
    }
}

/// One batch's vectors, all of the model named. A `None` is a text the model could
/// not embed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Embedded {
    pub model: String,
    pub vectors: Vec<Option<Vec<f32>>>,
}

/// Why a batch has no vectors.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum EmbedError {
    #[error("no embedding model is available")]
    Unavailable,
    #[error("the embedder died")]
    Died,
    #[error("the embedder timed out")]
    TimedOut,
    #[error("the embedder refused: {0}")]
    Refused(String),
}

#[derive(Debug, Deserialize)]
struct Line {
    event: Option<String>,
    id: Option<u64>,
    model: Option<String>,
    vectors: Option<Vec<Option<Vec<f32>>>>,
    error: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Embedded, EmbedError>>>>>;

struct Running {
    generation: u64,
    stdin: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    pending: Pending,
    _guard: Box<dyn Send>,
}

pub(crate) struct EmbedderClient {
    spawner: Box<dyn EmbedderSpawner>,
    /// Serializes starting a helper, so two callers cannot start two.
    starting: tokio::sync::Mutex<()>,
    running: Mutex<Option<Running>>,
    /// The live model: `None` with no helper running or none on this machine.
    /// This is what a caller watches to know its vectors have gone stale.
    model: watch::Sender<Option<String>>,
    next_id: AtomicU64,
    next_generation: AtomicU64,
    deaths: AtomicU32,
    said_unavailable: AtomicBool,
    restart_backoff: Duration,
}

impl EmbedderClient {
    pub(crate) fn new(spawner: impl EmbedderSpawner) -> Arc<Self> {
        Self::with_backoff(spawner, RESTART_BACKOFF)
    }

    fn with_backoff(spawner: impl EmbedderSpawner, restart_backoff: Duration) -> Arc<Self> {
        Arc::new(Self {
            spawner: Box::new(spawner),
            starting: tokio::sync::Mutex::new(()),
            running: Mutex::new(None),
            model: watch::Sender::new(None),
            next_id: AtomicU64::new(1),
            next_generation: AtomicU64::new(1),
            deaths: AtomicU32::new(0),
            said_unavailable: AtomicBool::new(false),
            restart_backoff,
        })
    }

    /// The live model, without starting anything.
    pub(crate) fn live_model(&self) -> Option<String> {
        self.model.borrow().clone()
    }

    /// A receiver that wakes when the live model changes.
    pub(crate) fn watch_model(&self) -> watch::Receiver<Option<String>> {
        self.model.subscribe()
    }

    /// Make sure a helper is running and has said what its model is, and answer
    /// that model.
    pub(crate) async fn start(self: &Arc<Self>) -> Option<String> {
        let _starting = self.starting.lock().await;
        if self.running.lock().is_some() {
            return self.live_model();
        }
        let pipes = match self.spawner.spawn() {
            Ok(pipes) => pipes,
            Err(err) => {
                self.say_unavailable(&format!("tugembed could not start: {err}"));
                return None;
            }
        };
        let mut stdout = BufReader::new(pipes.stdout).lines();
        let announced = tokio::time::timeout(START_TIMEOUT, stdout.next_line()).await;
        let Ok(Ok(Some(first))) = announced else {
            self.say_unavailable("tugembed never announced a model");
            return None;
        };
        let model = serde_json::from_str::<Line>(&first)
            .ok()
            .filter(|line| line.event.as_deref() == Some("model"))
            .and_then(|line| line.model);
        if model.is_none() {
            self.say_unavailable("tugembed has no embedding model on this machine");
        }

        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let pending: Pending = Arc::default();
        *self.running.lock() = Some(Running {
            generation,
            stdin: Arc::new(tokio::sync::Mutex::new(pipes.stdin)),
            pending: Arc::clone(&pending),
            _guard: pipes.guard,
        });
        self.model.send_replace(model.clone());
        tokio::spawn(read_lines(
            Arc::downgrade(self),
            generation,
            stdout,
            pending,
        ));
        model
    }

    /// Embed `texts`, starting a helper if none is running.
    pub(crate) async fn embed(
        self: &Arc<Self>,
        texts: Vec<String>,
    ) -> Result<Embedded, EmbedError> {
        if self.start().await.is_none() {
            return Err(EmbedError::Unavailable);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        let (generation, stdin) = {
            let running = self.running.lock();
            let Some(running) = running.as_ref() else {
                return Err(EmbedError::Died);
            };
            running.pending.lock().insert(id, reply_tx);
            (running.generation, Arc::clone(&running.stdin))
        };
        let mut request =
            serde_json::json!({ "id": id, "op": "embed", "texts": texts }).to_string();
        request.push('\n');
        let written = {
            let mut stdin = stdin.lock().await;
            match stdin.write_all(request.as_bytes()).await {
                Ok(()) => stdin.flush().await,
                Err(err) => Err(err),
            }
        };
        if written.is_err() {
            self.retire(generation);
            return Err(EmbedError::Died);
        }
        match tokio::time::timeout(EMBED_TIMEOUT, reply_rx).await {
            Ok(Ok(reply)) => {
                if reply.is_ok() {
                    self.deaths.store(0, Ordering::Relaxed);
                }
                reply
            }
            Ok(Err(_dropped)) => Err(EmbedError::Died),
            Err(_elapsed) => {
                warn!("tugembed took over {EMBED_TIMEOUT:?} on a batch; retiring it");
                self.retire(generation);
                Err(EmbedError::TimedOut)
            }
        }
    }

    /// End a helper, if it is still the running one. Its reader sees the end of
    /// its output, and that is what restarts it.
    fn retire(&self, generation: u64) {
        let retired = {
            let mut running = self.running.lock();
            match running.as_ref() {
                Some(current) if current.generation == generation => running.take(),
                _ => None,
            }
        };
        drop(retired);
    }

    fn say_unavailable(&self, why: &str) {
        if !self.said_unavailable.swap(true, Ordering::Relaxed) {
            info!("semantic index stays lexical: {why}");
        }
    }

    /// A helper's output ended. Everything waiting on it has already failed by the
    /// time this runs, because the reader dropped `pending`.
    fn after_death(self: &Arc<Self>, generation: u64) {
        self.retire(generation);
        let replaced = self.running.lock().is_some();
        if replaced {
            return;
        }
        self.model.send_replace(None);
        let deaths = self.deaths.fetch_add(1, Ordering::Relaxed);
        if deaths >= MAX_RESTARTS {
            warn!("tugembed has died {MAX_RESTARTS} times running; leaving it down");
            return;
        }
        let wait = self.restart_backoff * 2u32.pow(deaths);
        let client = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            if let Some(client) = client.upgrade() {
                client.start().await;
            }
        });
    }
}

/// Read one helper's lines until they end: model events go to the watch, and
/// answers to whoever asked.
async fn read_lines(
    client: Weak<EmbedderClient>,
    generation: u64,
    mut stdout: tokio::io::Lines<BufReader<Box<dyn AsyncRead + Send + Unpin>>>,
    pending: Pending,
) {
    while let Ok(Some(text)) = stdout.next_line().await {
        let Ok(line) = serde_json::from_str::<Line>(&text) else {
            continue;
        };
        if line.event.as_deref() == Some("model") {
            let Some(client) = client.upgrade() else {
                return;
            };
            client.model.send_replace(line.model);
            continue;
        }
        let Some(reply) = line.id.and_then(|id| pending.lock().remove(&id)) else {
            continue;
        };
        let answer = match (line.model, line.vectors, line.error) {
            (Some(model), Some(vectors), _) => Ok(Embedded { model, vectors }),
            (_, _, Some(error)) => Err(EmbedError::Refused(error)),
            _ => Err(EmbedError::Refused("an answer with no vectors".to_string())),
        };
        let _ = reply.send(answer);
    }
    pending.lock().clear();
    if let Some(client) = client.upgrade() {
        client.after_death(generation);
    }
}

/// The real helper, compiled for a test that reads what it answers.
#[cfg(test)]
pub(crate) mod compiled {
    use super::*;
    use std::path::{Path, PathBuf};

    struct Compiled(PathBuf);

    impl EmbedderSpawner for Compiled {
        fn spawn(&self) -> std::io::Result<EmbedderPipes> {
            let mut child = tokio::process::Command::new(&self.0)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()?;
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            Ok(EmbedderPipes {
                stdin: Box::new(stdin),
                stdout: Box::new(stdout),
                guard: Box::new(child),
            })
        }
    }

    /// The checkout this test build was made from.
    pub(crate) fn checkout_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }

    /// A client over a helper compiled into `dir`.
    pub(crate) fn client(dir: &Path) -> Arc<EmbedderClient> {
        let helper = dir.join("tugembed");
        let compiled = std::process::Command::new("bash")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", dir)
            .arg(checkout_root().join("tugrust/scripts/compile-tugembed.sh"))
            .arg(&helper)
            .status()
            .unwrap();
        assert!(compiled.success());
        EmbedderClient::new(Compiled(helper))
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! A helper in-process, speaking the protocol over a duplex pipe. A text's
    //! vector is its words hashed into a few dimensions, so the same text always
    //! gets the same vector and texts sharing words are similar.

    use super::*;
    use tokio::io::duplex;

    #[derive(Default)]
    pub(crate) struct FakeState {
        /// The model it announces, or none for a machine with no model.
        pub model: Mutex<Option<String>>,
        /// Every text it has been asked to embed.
        pub embedded: Mutex<Vec<String>>,
        /// How many helpers have been spawned.
        pub spawns: AtomicU32,
        /// Refuse to spawn, as a missing binary does.
        pub missing: AtomicBool,
        /// Sends to the live helper: a new model to announce, or `None` to die.
        pub control: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Option<String>>>>,
        /// Never answer a request.
        pub silent: AtomicBool,
        /// The model each coming answer is tagged with, ahead of `model`: a helper
        /// that moves between two batches, with no announcement yet.
        pub answer_models: Mutex<std::collections::VecDeque<String>>,
        /// How many texts each answered request held.
        pub batches: Mutex<Vec<usize>>,
    }

    impl FakeState {
        pub(crate) fn new(model: Option<&str>) -> Arc<Self> {
            let state = Self::default();
            *state.model.lock() = model.map(str::to_string);
            Arc::new(state)
        }

        pub(crate) fn switch_model(&self, model: &str) {
            *self.model.lock() = Some(model.to_string());
            let control = self.control.lock();
            control
                .as_ref()
                .unwrap()
                .send(Some(model.to_string()))
                .unwrap();
        }

        pub(crate) fn kill(&self) {
            let control = self.control.lock();
            control.as_ref().unwrap().send(None).unwrap();
        }

        pub(crate) fn take_embedded(&self) -> Vec<String> {
            std::mem::take(&mut *self.embedded.lock())
        }
    }

    pub(crate) struct FakeSpawner(pub Arc<FakeState>);

    pub(crate) fn vector_of(text: &str) -> Vec<f32> {
        let mut vector = [0.0_f32; 16];
        for word in text.split_whitespace() {
            let hash = word.bytes().fold(7_usize, |hash, byte| {
                hash.wrapping_mul(31).wrapping_add(byte as usize)
            });
            vector[hash % 16] += 1.0;
        }
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
        vector.iter().map(|value| value / norm).collect()
    }

    impl EmbedderSpawner for FakeSpawner {
        fn spawn(&self) -> std::io::Result<EmbedderPipes> {
            if self.0.missing.load(Ordering::Relaxed) {
                return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
            }
            self.0.spawns.fetch_add(1, Ordering::Relaxed);
            let (client_in, helper_in) = duplex(1 << 20);
            let (mut helper_out, client_out) = duplex(1 << 20);
            let (control_tx, mut control) = tokio::sync::mpsc::unbounded_channel();
            *self.0.control.lock() = Some(control_tx);
            let state = Arc::clone(&self.0);
            tokio::spawn(async move {
                let announce = |model: Option<String>| {
                    let line = match model {
                        Some(model) => {
                            serde_json::json!({ "event": "model", "model": model, "dimensions": 16 })
                        }
                        None => serde_json::json!({ "event": "model" }),
                    };
                    format!("{line}\n")
                };
                let first = announce(state.model.lock().clone());
                helper_out.write_all(first.as_bytes()).await.unwrap();
                let mut requests = BufReader::new(helper_in).lines();
                loop {
                    tokio::select! {
                        message = control.recv() => match message {
                            Some(Some(model)) => {
                                let line = announce(Some(model));
                                let _ = helper_out.write_all(line.as_bytes()).await;
                            }
                            _ => return,
                        },
                        request = requests.next_line() => {
                            let Ok(Some(request)) = request else { return };
                            if state.silent.load(Ordering::Relaxed) {
                                continue;
                            }
                            let request: serde_json::Value = serde_json::from_str(&request).unwrap();
                            let id = request["id"].as_u64().unwrap();
                            let scripted = state.answer_models.lock().pop_front();
                            let model = scripted.or_else(|| state.model.lock().clone());
                            let answer = match model {
                                None => serde_json::json!({ "id": id, "error": "no embedding model is available" }),
                                Some(model) => {
                                    let texts: Vec<String> = request["texts"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .map(|text| text.as_str().unwrap().to_string())
                                        .collect();
                                    let vectors: Vec<Option<Vec<f32>>> =
                                        texts.iter().map(|text| Some(vector_of(text))).collect();
                                    state.batches.lock().push(texts.len());
                                    state.embedded.lock().extend(texts);
                                    serde_json::json!({ "id": id, "model": model, "vectors": vectors })
                                }
                            };
                            let _ = helper_out.write_all(format!("{answer}\n").as_bytes()).await;
                        }
                    }
                }
            });
            Ok(EmbedderPipes {
                stdin: Box::new(client_in),
                stdout: Box::new(client_out),
                guard: Box::new(()),
            })
        }
    }

    /// A client over a fake, restarting with no wait.
    pub(crate) fn client(state: &Arc<FakeState>) -> Arc<EmbedderClient> {
        EmbedderClient::with_backoff(FakeSpawner(Arc::clone(state)), Duration::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{FakeState, client, vector_of};
    use super::*;

    async fn model_becomes(client: &EmbedderClient, wanted: Option<&str>) {
        let mut models = client.watch_model();
        models
            .wait_for(|model| model.as_deref() == wanted)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_batch_comes_back_tagged_with_its_model() {
        let state = FakeState::new(Some("nl-a"));
        let client = client(&state);
        let answer = client
            .embed(vec!["one text".to_string(), "another".to_string()])
            .await
            .unwrap();
        assert_eq!(answer.model, "nl-a");
        assert_eq!(answer.vectors[0], Some(vector_of("one text")));
        assert_eq!(answer.vectors.len(), 2);
        assert_eq!(client.live_model().as_deref(), Some("nl-a"));
        assert_eq!(state.spawns.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_missing_helper_is_no_model_and_no_panic() {
        let state = FakeState::new(Some("nl-a"));
        state.missing.store(true, Ordering::Relaxed);
        let client = client(&state);
        assert_eq!(client.start().await, None);
        assert_eq!(
            client.embed(vec!["text".to_string()]).await,
            Err(EmbedError::Unavailable)
        );
        assert!(client.said_unavailable.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn a_helper_with_no_model_says_so_and_stays_up() {
        let state = FakeState::new(None);
        let client = client(&state);
        assert_eq!(client.start().await, None);
        assert_eq!(
            client.embed(vec!["text".to_string()]).await,
            Err(EmbedError::Unavailable)
        );
        assert_eq!(state.spawns.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_model_event_moves_the_watch() {
        let state = FakeState::new(Some("nl-static"));
        let client = client(&state);
        client.start().await;
        state.switch_model("nl-contextual");
        model_becomes(&client, Some("nl-contextual")).await;
    }

    #[tokio::test]
    async fn a_helper_that_dies_is_restarted_and_answers_again() {
        let state = FakeState::new(Some("nl-a"));
        let client = client(&state);
        client.start().await;
        let mut models = client.watch_model();
        models.borrow_and_update();
        state.kill();
        models.wait_for(|model| model.is_none()).await.unwrap();
        model_becomes(&client, Some("nl-a")).await;
        assert_eq!(state.spawns.load(Ordering::Relaxed), 2);
        assert!(client.embed(vec!["text".to_string()]).await.is_ok());
    }

    #[tokio::test]
    async fn a_request_in_flight_when_the_helper_dies_fails_rather_than_hanging() {
        let state = FakeState::new(Some("nl-a"));
        state.silent.store(true, Ordering::Relaxed);
        let client = client(&state);
        client.start().await;
        let asking = tokio::spawn({
            let client = Arc::clone(&client);
            async move { client.embed(vec!["text".to_string()]).await }
        });
        // The answer arrives only once the request is pending, so yield until it is.
        while client
            .running
            .lock()
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
        state.kill();
        assert_eq!(asking.await.unwrap(), Err(EmbedError::Died));
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_helper_is_retired_at_the_timeout() {
        let state = FakeState::new(Some("nl-a"));
        state.silent.store(true, Ordering::Relaxed);
        let client = client(&state);
        assert_eq!(
            client.embed(vec!["text".to_string()]).await,
            Err(EmbedError::TimedOut)
        );
        assert!(client.running.lock().is_none());
    }

    #[tokio::test]
    async fn a_helper_that_keeps_dying_is_left_down_until_someone_asks() {
        let state = FakeState::new(Some("nl-a"));
        let client = client(&state);
        client.deaths.store(MAX_RESTARTS, Ordering::Relaxed);
        client.start().await;
        let mut models = client.watch_model();
        state.kill();
        models.wait_for(|model| model.is_none()).await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(state.spawns.load(Ordering::Relaxed), 1);
        assert!(client.embed(vec!["text".to_string()]).await.is_ok());
        assert_eq!(state.spawns.load(Ordering::Relaxed), 2);
        assert_eq!(client.deaths.load(Ordering::Relaxed), 0);
    }
}
