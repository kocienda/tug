//! SharedAgent — an app-scoped pool of persistent, job-constrained `claude`
//! workers ([P01], [P02]).
//!
//! A `SharedAgent` is a model operated against a **fixed table of named jobs**,
//! not a general-purpose model handle: callers ask for a job by name and hand
//! it an input, and there is no API that accepts an arbitrary prompt ([P01]).
//! Adding a capability means adding a [`JobSpec`], which is reviewed like any
//! other contract change; standing up a second agent on a different model means
//! constructing a second [`AgentSpec`], not writing new machinery.
//!
//! Workers are **persistent** because a cold `claude` spawn costs more than the
//! whole latency budget of the job that would be waiting on it — measured at
//! 2327 ms for the first turn against 867–989 ms for every turn after it (CLI
//! 2.1.222, `claude-haiku-4-5`). One warm process therefore serves many turns,
//! recycled by turn count and reaped when idle ([P04]).
//!
//! Which means **nobody waits on a cold start**. A job whose ceiling is shorter
//! than one is never handed a worker that has not answered yet: its turn
//! becomes that worker's warmup and the caller degrades immediately. The lane
//! is otherwise brought up ahead of any caller — by `ensure_warm`, called on
//! traffic that precedes the job — and kept up across a recycle by warming the
//! replacement before the old worker stops answering.
//!
//! Every turn is self-contained ([P05]): the job's full instructions ride each
//! message and the model is told to answer only from it, so any turn can be a
//! worker's first and a recycle costs nothing but a spawn.
//!
//! The test seam is [`AgentWorkerSpawner`] (the `ScribeSpawner` / `ChildSpawner`
//! pattern): production spawns the persistent child, tests script turn outcomes
//! and never assert model prose.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::{Duration, Instant};
use tracing::{info, warn};
use tugcast_core::{FeedId, Frame};

// MARK: - Recycle and growth policy ([P04])

/// Turns one worker answers before it is retired and replaced.
///
/// Bounds both conversation growth (cost, and the cross-turn bleed of [R01])
/// and the blast radius of a worker that has drifted. Self-contained turns
/// ([P05]) are what make this free: the replacement's first turn is no
/// different from the turn it replaced.
const MAX_TURNS_PER_WORKER: u64 = 40;

/// Idle time after which a worker is reaped, mirroring the idle unload the
/// on-device backend used. A machine nobody is working on carries no worker at
/// all.
///
/// Per class, because the two lanes pay a respawn differently. A sentence job
/// is asked on the session synopsis's own cadence and its 6 s ceiling absorbs a
/// cold spawn, so a reaped sentence worker costs nothing anyone sees. A
/// classify is asked by somebody who is mid-keystroke and its 2 s ceiling
/// cannot cover a spawn at all, so a reaped classify worker costs the next
/// typed command its routing. The classify window is therefore long enough to
/// span a working session's gaps — an app left open overnight still drops the
/// worker, a person who steps away for coffee does not.
fn idle_reap(class: JobClass) -> Duration {
    match class {
        JobClass::Classify => Duration::from_secs(1800),
        JobClass::Sentence => Duration::from_secs(300),
    }
}

/// What a cold worker needs before it can answer anything: the `claude` spawn
/// plus its first turn, measured at 1.6–2.3 s against CLI 2.1.222.
///
/// This is what decides whether a caller may be handed a freshly spawned worker
/// at all. A job whose ceiling is under this cannot be answered by a cold
/// worker — waiting on one can only end in a timeout, and (before the warmup
/// path below) that timeout retired the very process the wait had just paid
/// for, so the lane never became warm and every classify was a cold classify.
const COLD_START_BUDGET: Duration = Duration::from_secs(4);

/// Ceiling on a warmup turn — the throwaway first turn that makes a freshly
/// spawned worker warm. Nobody is waiting on it, so it is generous; it exists
/// only so a worker that never answers is retired rather than held forever.
const WARMUP_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a class waits before replacing a worker that **died**, mirroring
/// the daemon respawn debounce in `feeds::pulse`. This gates replacement after
/// a failure, never healthy growth — a first spawn and a growth spawn are both
/// immediate, so nothing pays this cost except a crash loop.
const RESPAWN_MIN_INTERVAL: Duration = Duration::from_secs(5);

// Reaping and recycling are decided when a job arrives rather than on a timer:
// a pool with no traffic has nothing to reap, and a background ticker would be
// a task to leak. The constants above are provisional and meant to be set from
// the `shared agent call` telemetry ([P04]).

// MARK: - Job and agent specification ([P01])

/// One named job: what the model is told, and what the caller's wait is bounded
/// by. Instructions are fixed per job so behavior stays auditable, scorable
/// against a corpus, and stable enough to cache against later ([Q02]).
pub struct JobSpec {
    pub name: &'static str,
    pub instructions: &'static str,
    /// Ceiling on the caller's wait. Past this the job is an error and the
    /// caller degrades ([P06]).
    pub timeout: Duration,
    /// Turnaround past which a call is marked `slow=true`. Nothing is
    /// cancelled — this only makes drift readable in accumulated logs.
    pub slow: Option<Duration>,
}

/// A model plus the table of jobs it is operated against.
///
/// `model` is a closure rather than a value so a settings change applies on the
/// next worker spawn without a restart, matching the scribe-model pattern in
/// `main.rs` ([P03]).
pub struct AgentSpec {
    pub name: &'static str,
    pub model: Arc<dyn Fn() -> String + Send + Sync>,
    pub jobs: &'static [JobSpec],
    /// Total workers across all job classes ([P12]).
    pub max_workers: usize,
}

impl AgentSpec {
    fn job(&self, name: &str) -> Option<&'static JobSpec> {
        self.jobs.iter().find(|j| j.name == name)
    }
}

/// The latency lane a job runs in ([P12]).
///
/// A worker is assigned the class of the job that spawned it and only ever
/// answers jobs of that class. The two lanes have incompatible latency
/// contracts — 2 s against 6 s — and reactive growth cannot rescue a classify
/// that arrives while the only worker is mid-sentence: the rescue spawn alone
/// costs more than classify's entire budget. Since sentence occupancy is
/// routine rather than rare, without affinity shell routing would simply "not
/// work sometimes".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobClass {
    Classify,
    Sentence,
}

impl JobClass {
    /// Both classify wordings share the lane: they are the same question asked
    /// with and without the program's documentation, and they answer the same
    /// 2 s submit. Splitting them would put the `maybe` band on a worker that
    /// has to be spawned while somebody waits.
    fn of(job: &str) -> Self {
        match job {
            "classify" | "classify_with_grammar" => Self::Classify,
            _ => Self::Sentence,
        }
    }
}

// MARK: - Worker spawner seam

/// One image riding a turn — base64 bytes plus the media type they were
/// decoded as, which is exactly the pair an Anthropic `image` content block
/// takes. The worker protocol already writes the turn as a content-block
/// array, so an image is a second block rather than a second mechanism.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnImage {
    pub media_type: String,
    /// Base64, no `data:` prefix.
    pub data: String,
}

/// What one turn says: the composed message, and any images shown with it.
///
/// Text-only is the overwhelming case and spells itself — `Turn::from(text)` —
/// so a job that has never seen an image reads exactly as it did when a turn
/// WAS a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub text: String,
    pub images: Vec<TurnImage>,
}

impl From<String> for Turn {
    fn from(text: String) -> Self {
        Self {
            text,
            images: Vec::new(),
        }
    }
}

/// One job turn: what to say, and where its answer goes.
pub struct TurnRequest {
    pub turn: Turn,
    pub reply: oneshot::Sender<Result<String, String>>,
}

/// Spawns persistent workers. The pool holds one of these and never knows
/// whether the thing on the other end is a `claude` process or a script.
///
/// A worker is represented by the channel its turns are written to: the worker
/// answers them one at a time, in order, and dropping the sender reaps it.
pub trait AgentWorkerSpawner: Send + Sync + 'static {
    fn spawn(&self, model: String) -> Result<mpsc::Sender<TurnRequest>, String>;
}

/// One spawned worker and the bookkeeping the pool recycles it by.
struct Worker {
    id: u64,
    class: JobClass,
    tx: mpsc::Sender<TurnRequest>,
    /// Turns started, which is what the recycle cap counts — a turn that timed
    /// out still spent context.
    turns: AtomicU64,
    in_flight: AtomicUsize,
    last_used: Mutex<Instant>,
    /// Set when the worker has timed out or died. A retired worker answers
    /// nothing further and is dropped on the next sweep.
    retired: AtomicBool,
    /// Set when the worker has reached the turn cap and a replacement is on its
    /// way up. It goes on answering — a warm worker one turn past the cap beats
    /// a cold one — and is retired the moment the replacement is warm.
    superseded: AtomicBool,
    /// Set once the worker has answered a turn. Until then it is still paying
    /// its cold start, and a job whose ceiling is shorter than that cannot be
    /// spent on it.
    answered: AtomicBool,
}

impl Worker {
    fn idle(&self) -> bool {
        self.in_flight.load(Ordering::Relaxed) == 0
    }

    /// Warm: it has answered something, and it is not on its way out.
    fn warm(&self) -> bool {
        self.answered.load(Ordering::Relaxed) && !self.retired.load(Ordering::Relaxed)
    }
}

/// What the pool can offer a job right now.
enum Acquired {
    /// A worker that has already answered a turn. The only kind a ceiling
    /// shorter than a cold start can be spent on.
    Warm(Arc<Worker>),
    /// A worker still paying its cold start: `fresh` when this job's own turn
    /// would be the warmup, and false when one is already in flight on it.
    Cold { worker: Arc<Worker>, fresh: bool },
}

// MARK: - The pool ([P02])

/// One pool per [`AgentSpec`], app-scoped, lazily spawning workers up to
/// `max_workers` and reaping them on idle. Callers hold this and never see a
/// worker.
pub struct SharedAgentPool {
    spec: AgentSpec,
    spawner: Arc<dyn AgentWorkerSpawner>,
    workers: Mutex<Vec<Arc<Worker>>>,
    /// When a worker of each class last died, for the respawn debounce.
    last_death: Mutex<Vec<(JobClass, Instant)>>,
    next_worker_id: AtomicU64,
}

impl SharedAgentPool {
    pub fn new(spec: AgentSpec, spawner: Arc<dyn AgentWorkerSpawner>) -> Arc<Self> {
        Arc::new(Self {
            spec,
            spawner,
            workers: Mutex::new(Vec::new()),
            last_death: Mutex::new(Vec::new()),
            next_worker_id: AtomicU64::new(1),
        })
    }

    /// Run one named job, bounded by that job's timeout.
    ///
    /// Every failure shape — the app-test gate, an unknown job, a spawn
    /// failure, a dead worker, a timeout — comes back as `Err`, because every
    /// caller degrades identically on one ([P06]). An unknown job name is a
    /// programming error, so it panics where a test would catch it and errors
    /// where a user would rather have a missing description than a dead process.
    pub async fn run(self: &Arc<Self>, job: &str, input: String) -> Result<String, String> {
        self.run_seeing(job, input, Vec::new()).await
    }

    /// Run one named job with images shown alongside its input.
    ///
    /// The Overview's Operator is what this exists for: a question can arrive
    /// with a screenshot attached, and an answer about a screenshot has to be
    /// written by a model that saw it. Every other property of `run` holds —
    /// same job table, same ceilings, same degradation.
    pub async fn run_seeing(
        self: &Arc<Self>,
        job: &str,
        input: String,
        images: Vec<TurnImage>,
    ) -> Result<String, String> {
        let Some(spec) = self.spec.job(job) else {
            debug_assert!(false, "unknown shared-agent job {job:?}");
            return Err(format!("unknown job {job}"));
        };
        self.run_spec(
            spec,
            Turn {
                text: compose_turn(spec.instructions, &input),
                images,
            },
        )
        .await
    }

    /// Ask whether one line means the shell or means Claude.
    ///
    /// `grammar` is the program's own condensed documentation, attached by the
    /// command-grammar grader exactly when it could not account for the line
    /// against the grammar it knows; its presence picks the documentation-
    /// bearing wording, as it did on the device.
    ///
    /// The label parse happens here so no caller ever sees raw model text: an
    /// answer naming no label, or naming both, is a refusal rather than a coin
    /// flip.
    pub async fn run_classify(
        self: &Arc<Self>,
        text: String,
        grammar: Option<String>,
    ) -> Result<String, String> {
        let job = match &grammar {
            Some(_) => "classify_with_grammar",
            None => "classify",
        };
        let Some(spec) = self.spec.job(job) else {
            debug_assert!(false, "unknown shared-agent job {job:?}");
            return Err(format!("unknown job {job}"));
        };
        let instructions = match &grammar {
            Some(g) => spec.instructions.replace(GRAMMAR_PLACEHOLDER, g),
            None => spec.instructions.to_string(),
        };
        let raw = self
            .run_spec(spec, compose_turn(&instructions, &text).into())
            .await?;
        // The call itself succeeded, so `record` has already timed it; a refusal
        // is a fact about the answer, and logging it as a second `shared agent
        // call` line would double-count one call.
        verdict(&raw).ok_or_else(|| {
            warn!(task = spec.name, %raw, "shared agent classify named no label");
            "classification did not name a label".to_string()
        })
    }

    async fn run_spec(
        self: &Arc<Self>,
        spec: &'static JobSpec,
        turn: Turn,
    ) -> Result<String, String> {
        if app_test_gated() {
            record(spec.name, "unavailable", None);
            return Err(UNAVAILABLE.to_string());
        }
        let started = Instant::now();
        let class = JobClass::of(spec.name);
        let acquired = match self.acquire(class) {
            Ok(acquired) => acquired,
            Err(error) => {
                record(spec.name, "unavailable", Some((started, spec)));
                return Err(error);
            }
        };

        // A job whose ceiling is shorter than a cold start cannot be answered
        // by a worker that has not answered anything yet. Waiting would spend
        // the caller's whole budget and end in a timeout that retires the very
        // process the wait had just paid for — which is how the classify lane
        // came to be cold on every single call. So the turn becomes the
        // worker's warmup instead: it runs with nobody waiting on it, the
        // caller degrades now rather than in two seconds ([P06]), and the lane
        // is warm for the next question.
        let worker = match acquired {
            Acquired::Warm(worker) => worker,
            Acquired::Cold { worker, fresh } if spec.timeout < COLD_START_BUDGET => {
                if fresh {
                    self.warm(worker, turn);
                }
                record(spec.name, "warming", Some((started, spec)));
                return Err(UNAVAILABLE.to_string());
            }
            // A ceiling that covers a cold start waits for one: a first
            // description is worth the spawn, and there is no earlier caller to
            // have paid it.
            Acquired::Cold { worker, .. } => worker,
        };

        worker.turns.fetch_add(1, Ordering::Relaxed);
        worker.in_flight.fetch_add(1, Ordering::Relaxed);
        let outcome = self.turn(&worker, spec, turn).await;
        worker.in_flight.fetch_sub(1, Ordering::Relaxed);
        *worker.last_used.lock().unwrap() = Instant::now();
        if outcome.is_ok() {
            worker.answered.store(true, Ordering::Relaxed);
        }

        // A worker that reached the turn cap is replaced, and the replacement
        // comes up warm before the old one stops answering: retiring on the
        // spot would leave the lane cold, which for a ceiling that cannot cover
        // a cold start means one degraded call every `MAX_TURNS_PER_WORKER`.
        // The caller already has its answer either way and never pays for the
        // hygiene.
        if worker.turns.load(Ordering::Relaxed) >= MAX_TURNS_PER_WORKER {
            worker.superseded.store(true, Ordering::Relaxed);
            self.ensure_warm(class);
        }

        match &outcome {
            Ok(_) => record(spec.name, "ok", Some((started, spec))),
            Err(_) => record(spec.name, "failed", Some((started, spec))),
        }
        outcome
    }

    /// One turn against one worker, under the job's ceiling.
    ///
    /// A timeout retires the worker rather than leaving it in the rotation: it
    /// is still working on an answer nobody is waiting for, so the next job
    /// handed to it would queue behind that and time out too.
    async fn turn(
        &self,
        worker: &Arc<Worker>,
        spec: &'static JobSpec,
        turn: Turn,
    ) -> Result<String, String> {
        match one_turn(worker, turn, spec.timeout).await {
            Ok(text) => Ok(text),
            Err(TurnFailure::Died(error)) => {
                self.mark_dead(worker);
                Err(error)
            }
            Err(TurnFailure::TimedOut) => {
                // A hung worker counts as a failure for the respawn debounce:
                // without it a systematically stalled backend would spawn one
                // fresh child per call.
                self.retire(worker, "timed out");
                self.note_death(worker.class);
                Err(format!("{} timed out", spec.name))
            }
        }
    }

    /// Make sure `class` has a live worker, warming a fresh one if it does not.
    ///
    /// The lane's own way of paying its cold start, called on traffic that
    /// *precedes* the job rather than by the job itself — a Session card asking
    /// for the login-PATH command set has a composer somebody may type a
    /// command into, and that is exactly the moment to have a classify worker
    /// on its way up. Cheap and idempotent: a lane that already has a worker
    /// does nothing, and a warmup spends one short turn, not one per keystroke.
    pub fn ensure_warm(self: &Arc<Self>, class: JobClass) {
        if app_test_gated() {
            return;
        }
        let Some(spec) = self
            .spec
            .jobs
            .iter()
            .find(|j| JobClass::of(j.name) == class)
        else {
            return;
        };
        let worker = {
            let mut workers = self.workers.lock().unwrap();
            self.sweep(&mut workers);
            // A superseded worker is still answering but is on its way out, so
            // it is not the live worker this asks about — it is the reason to
            // bring one up. A worker still warming counts as live: it is
            // already the answer to this call.
            let live = workers.iter().any(|w| {
                w.class == class
                    && !w.retired.load(Ordering::Relaxed)
                    && !w.superseded.load(Ordering::Relaxed)
            });
            if live || staying(&workers) >= self.spec.max_workers || !self.respawn_allowed(class) {
                return;
            }
            match self.spawn(class) {
                Ok(worker) => {
                    workers.push(Arc::clone(&worker));
                    worker
                }
                Err(error) => {
                    self.note_death(class);
                    warn!(agent = self.spec.name, %error, "shared agent spawn failed");
                    return;
                }
            }
        };
        self.warm(
            worker,
            compose_turn(spec.instructions, warmup_input(class)).into(),
        );
    }

    /// Bring `class`'s lane up and wait for it, up to the warmup ceiling.
    ///
    /// For the callers with no keystroke behind them — the observability verbs
    /// and the eval harness they serve. A composer must never wait here: its
    /// whole budget is shorter than the wait. But "the lane was cold" is not a
    /// fact about the line the harness asked about, so those callers warm the
    /// lane and then ask. Answers `false` if the lane never came up.
    pub async fn wait_until_warm(self: &Arc<Self>, class: JobClass) -> bool {
        let deadline = Instant::now() + WARMUP_TIMEOUT;
        loop {
            self.ensure_warm(class);
            if self.lane_warm(class) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Take a freshly spawned worker through one turn nobody is waiting on.
    ///
    /// The answer is discarded — what the turn is for is the process it leaves
    /// behind, ready to answer the next caller inside that caller's ceiling. A
    /// warmup that never lands retires its worker, so a `claude` that hangs on
    /// its first turn cannot be held forever by the thing meant to make it
    /// useful.
    fn warm(self: &Arc<Self>, worker: Arc<Worker>, turn: Turn) {
        let pool = Arc::clone(self);
        worker.turns.fetch_add(1, Ordering::Relaxed);
        worker.in_flight.fetch_add(1, Ordering::Relaxed);
        tokio::spawn(async move {
            let outcome = one_turn(&worker, turn, WARMUP_TIMEOUT).await;
            worker.in_flight.fetch_sub(1, Ordering::Relaxed);
            *worker.last_used.lock().unwrap() = Instant::now();
            match outcome {
                Ok(_) => {
                    worker.answered.store(true, Ordering::Relaxed);
                    info!(
                        agent = pool.spec.name,
                        worker = worker.id,
                        class = ?worker.class,
                        "shared agent worker warm",
                    );
                    pool.retire_superseded(worker.class);
                }
                Err(_) => {
                    pool.retire(&worker, "warmup failed");
                    pool.note_death(worker.class);
                }
            }
        });
    }

    /// Pick a worker of `class`, growing the pool when the class has none to
    /// use ([P12]). `fresh` says the worker came back straight from a spawn,
    /// which is what tells the caller it is cold.
    ///
    /// The order is warm-first, in every sense. An idle warm worker; failing
    /// that a *busy* warm one, because queueing a classify behind a classify is
    /// harmless — typing serializes them and the wait is one turn — while
    /// spawning a second child for a lane that has one buys a cold start
    /// nobody can spend. Only a class with no usable worker at all grows the
    /// pool, and that is exactly what [P12] is about: a classify must never
    /// queue behind a *sentence job*, whose ceiling is three times its own.
    fn acquire(&self, class: JobClass) -> Result<Acquired, String> {
        let mut workers = self.workers.lock().unwrap();
        self.sweep(&mut workers);
        let of_class = |w: &&Arc<Worker>| w.class == class;

        if let Some(idle) = workers
            .iter()
            .find(|w| of_class(w) && w.warm() && w.idle())
            .cloned()
        {
            return Ok(Acquired::Warm(idle));
        }
        // Never queue behind a retired worker: it is stuck on or has abandoned
        // a turn nobody is waiting for, so honest unavailability beats a wait
        // that can only time out.
        if let Some(busy) = workers.iter().find(|w| of_class(w) && w.warm()).cloned() {
            return Ok(Acquired::Warm(busy));
        }
        // A lane already coming up is not a lane to grow: the warmup in flight
        // is about to produce the idle worker this job wanted, and a second
        // child would pay the same cold start twice.
        if let Some(warming) = workers
            .iter()
            .find(|w| of_class(w) && !w.retired.load(Ordering::Relaxed))
            .cloned()
        {
            return Ok(Acquired::Cold {
                worker: warming,
                fresh: false,
            });
        }

        if staying(&workers) < self.spec.max_workers && self.respawn_allowed(class) {
            match self.spawn(class) {
                Ok(worker) => {
                    workers.push(Arc::clone(&worker));
                    return Ok(Acquired::Cold {
                        worker,
                        fresh: true,
                    });
                }
                Err(error) => {
                    self.note_death(class);
                    warn!(agent = self.spec.name, %error, "shared agent spawn failed");
                }
            }
        }

        Err(UNAVAILABLE.to_string())
    }

    /// Drop workers that are retired, or that have been idle past the reap
    /// window. Dropping the last sender closes the worker's channel, which ends
    /// its driver task and reaps the child.
    fn sweep(&self, workers: &mut Vec<Arc<Worker>>) {
        let now = Instant::now();
        workers.retain(|w| {
            if w.retired.load(Ordering::Relaxed) && w.idle() {
                return false;
            }
            if w.idle() && now.duration_since(*w.last_used.lock().unwrap()) >= idle_reap(w.class) {
                info!(
                    agent = self.spec.name,
                    worker = w.id,
                    "shared agent worker reaped"
                );
                return false;
            }
            true
        });
    }

    fn spawn(&self, class: JobClass) -> Result<Arc<Worker>, String> {
        let model = (self.spec.model)();
        let tx = self.spawner.spawn(model.clone())?;
        let id = self.next_worker_id.fetch_add(1, Ordering::Relaxed);
        info!(
            agent = self.spec.name,
            worker = id,
            class = ?class,
            %model,
            "shared agent worker spawned",
        );
        Ok(Arc::new(Worker {
            id,
            class,
            tx,
            turns: AtomicU64::new(0),
            in_flight: AtomicUsize::new(0),
            last_used: Mutex::new(Instant::now()),
            retired: AtomicBool::new(false),
            superseded: AtomicBool::new(false),
            answered: AtomicBool::new(false),
        }))
    }

    /// Retire the workers of `class` a now-warm replacement was brought up for.
    /// Called from the replacement's warmup, which is the moment the lane can
    /// afford to lose them.
    fn retire_superseded(&self, class: JobClass) {
        let workers = self.workers.lock().unwrap();
        for worker in workers
            .iter()
            .filter(|w| w.class == class && w.superseded.load(Ordering::Relaxed))
        {
            self.retire(worker, "recycled");
        }
    }

    fn retire(&self, worker: &Arc<Worker>, why: &str) {
        if !worker.retired.swap(true, Ordering::Relaxed) {
            info!(
                agent = self.spec.name,
                worker = worker.id,
                why,
                "shared agent worker retired",
            );
        }
    }

    /// A worker that failed is retired *and* starts its class's respawn
    /// debounce, so a `claude` that dies on every spawn cannot be respawned in
    /// a hot loop.
    fn mark_dead(&self, worker: &Arc<Worker>) {
        self.retire(worker, "died");
        self.note_death(worker.class);
    }

    fn note_death(&self, class: JobClass) {
        let mut deaths = self.last_death.lock().unwrap();
        let now = Instant::now();
        match deaths.iter_mut().find(|(c, _)| *c == class) {
            Some(entry) => entry.1 = now,
            None => deaths.push((class, now)),
        }
    }

    fn respawn_allowed(&self, class: JobClass) -> bool {
        let deaths = self.last_death.lock().unwrap();
        match deaths.iter().find(|(c, _)| *c == class) {
            Some((_, at)) => Instant::now().duration_since(*at) >= RESPAWN_MIN_INTERVAL,
            None => true,
        }
    }

    /// Live worker count after a sweep — how the pool-policy tests read growth
    /// and reaping without reaching inside the lock.
    #[cfg(test)]
    pub fn worker_count(&self) -> usize {
        let mut workers = self.workers.lock().unwrap();
        self.sweep(&mut workers);
        workers.len()
    }

    /// Whether `class` has a worker that has answered a turn and is free to
    /// answer another — the state [`ensure_warm`](Self::ensure_warm) exists to
    /// reach.
    pub fn lane_warm(&self, class: JobClass) -> bool {
        self.workers
            .lock()
            .unwrap()
            .iter()
            .any(|w| w.class == class && w.warm() && w.idle())
    }
}

/// Workers that are staying: neither retired nor superseded. The cap bounds
/// these, not the raw roster — a rolling replacement overlaps the worker it
/// retires, and counting both would let a pool held at its cap by the other
/// lane block its own recycle forever.
fn staying(workers: &[Arc<Worker>]) -> usize {
    workers
        .iter()
        .filter(|w| !w.retired.load(Ordering::Relaxed) && !w.superseded.load(Ordering::Relaxed))
        .count()
}

/// What every unavailable path answers with. One string because callers do not
/// branch on the reason — they degrade ([P06]).
const UNAVAILABLE: &str = "shared agent unavailable";

/// Why one turn did not answer. The two are handled differently by the pool —
/// a death is the worker's, a timeout is the caller's — but a warmup, which has
/// no caller, treats them alike.
enum TurnFailure {
    Died(String),
    TimedOut,
}

/// One turn against one worker, under `ceiling`.
///
/// The ceiling covers the whole wait: the channel send (which blocks when the
/// worker's queue is full) and the answer both count against it, so a caller's
/// wait is bounded no matter where the turn stalls.
async fn one_turn(
    worker: &Arc<Worker>,
    turn: Turn,
    ceiling: Duration,
) -> Result<String, TurnFailure> {
    let (reply, answer) = oneshot::channel();
    let attempt = async {
        if worker.tx.send(TurnRequest { turn, reply }).await.is_err() {
            return Err("shared agent worker died".to_string());
        }
        match answer.await {
            Ok(outcome) => outcome,
            Err(_) => Err("shared agent worker dropped the turn".to_string()),
        }
    };
    match tokio::time::timeout(ceiling, attempt).await {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(error)) => Err(TurnFailure::Died(error)),
        Err(_) => Err(TurnFailure::TimedOut),
    }
}

/// The throwaway input a warmup turn carries — shaped like the job's real input
/// so the turn exercises the wording the next caller will get.
fn warmup_input(class: JobClass) -> &'static str {
    match class {
        JobClass::Classify => "pwd",
        JobClass::Sentence => {
            "What the session was most recently asked to do:\nwarm up\n\nWhere it stands right now (background, not the subject):\n- nothing\n"
        }
    }
}

/// The slot [`JobSpec::instructions`] substitutes a command's own documentation
/// into, carried over from the on-device wording.
pub const GRAMMAR_PLACEHOLDER: &str = "{{GRAMMAR}}";

/// Instructions and input in one self-contained message ([P05]).
///
/// The input rides verbatim: a caller that composed a digest to an exact shape
/// gets that shape in front of the model, and what the caller logged is what
/// was asked.
fn compose_turn(instructions: &str, input: &str) -> String {
    format!("{}\n\n{}", instructions.trim_end(), input)
}

/// Whether this process is one of the app-test harness's launches ([P08]).
///
/// App-tests must be free, fast, and deterministic, so no worker is ever
/// spawned under one and every job answers with the designed degraded posture.
/// The variable reaches tugcast because `ProcessManager.swift` seeds the
/// tugcast child's environment from the app's own, and the app is what the
/// harness launches with `TUGAPP_APP_TEST=1`.
fn app_test_gated() -> bool {
    std::env::var("TUGAPP_APP_TEST").as_deref() == Ok("1")
}

/// Match a classify answer to one of the two labels.
///
/// The contract is prompt-and-parse, not constrained decoding, so an answer
/// naming no label is a refusal rather than a guess, and one naming both is a
/// refusal too, because nothing in the answer prefers either. Labels match only
/// as whole tokens, so prose that merely contains the word "shell" inside
/// another word cannot route a command.
fn verdict(raw: &str) -> Option<String> {
    let mut found: Option<&str> = None;
    for piece in raw.split(|c: char| !c.is_alphanumeric()) {
        let label = match piece.to_ascii_lowercase().as_str() {
            "shell" => "shell",
            "prompt" => "prompt",
            _ => continue,
        };
        match found {
            Some(seen) if seen != label => return None,
            _ => found = Some(label),
        }
    }
    found.map(str::to_string)
}

/// The caller's side of one job.
///
/// Says what the caller waited for and whether it gave up — a fact the worker
/// itself cannot see, since a timed-out turn finishes eventually and never
/// learns nobody was listening.
fn record(task: &str, outcome: &str, timing: Option<(Instant, &JobSpec)>) {
    let Some((started, spec)) = timing else {
        info!(task = %task, outcome = %outcome, "shared agent call");
        return;
    };
    let elapsed = started.elapsed();
    let slow = spec.slow.is_some_and(|threshold| elapsed > threshold);
    let elapsed_ms = elapsed.as_millis() as u64;
    if slow {
        info!(task = %task, outcome = %outcome, elapsed_ms, slow = true, "shared agent call");
    } else {
        info!(task = %task, outcome = %outcome, elapsed_ms, "shared agent call");
    }
}

// MARK: - Production spawner (#worker-protocol, [P13])

/// The directory workers run in ([P13]).
///
/// Tug-owned and free of any `CLAUDE.md`, for two reasons the spike confirmed
/// against CLI 2.1.222. A worker rooted in a user repo inherits that repo's
/// instructions — a decoy `CLAUDE.md` demanding a token got it appended to the
/// answer, while the same turn from here came back bare. And the CLI writes
/// each worker's transcript to `~/.claude/projects/<encoded cwd>/<session>.jsonl`,
/// so a project cwd would file 40-turn worker conversations where the session
/// picker's on-disk scan reads them as real sessions — its exclusion rules
/// (cwd mismatch, id/filename mismatch) would not catch them.
///
/// Fixed and Tug-owned, so no user-supplied path is resolved and [L29]'s
/// canonicalization gateway is not in play.
fn worker_cwd() -> std::path::PathBuf {
    tugcore::instance::base_data_dir().join("shared-agent")
}

/// Spawns one persistent `claude` in streaming-input mode per worker
/// (#worker-protocol).
pub struct ClaudeAgentWorkerSpawner;

impl AgentWorkerSpawner for ClaudeAgentWorkerSpawner {
    fn spawn(&self, model: String) -> Result<mpsc::Sender<TurnRequest>, String> {
        let cwd = worker_cwd();
        std::fs::create_dir_all(&cwd).map_err(|e| format!("shared agent cwd: {e}"))?;

        // Verified against claude 2.1.222 from an empty neutral cwd:
        //
        // - `--disallowedTools '*'` reports `tools: []` in the init frame and the
        //   answer comes back text-only in one turn. Without it the same
        //   tool-baiting turn ran Bash and took two turns — slow, and a hazard
        //   for a classify that is deciding whether to run a command.
        // - `--strict-mcp-config` with no `--mcp-config` leaves the worker no
        //   MCP servers, so nothing project-scoped is loaded.
        // - No session flag: a streaming-input spawn with none works and the CLI
        //   mints its own id, which is what keeps worker transcripts out of any
        //   directory a session query reads ([P13]).
        //
        // Tugplug's hooks are PreToolUse-only, so with no tools available no
        // Tug hook can fire on a worker turn.
        let mut cmd = crate::feeds::claude_auth::claude_command(&[
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            &model,
            "--strict-mcp-config",
            "--disallowedTools",
            "*",
        ]);
        cmd.current_dir(&cwd)
            .env("MAX_THINKING_TOKENS", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Claude Code isn't installed".to_string()
            } else {
                e.to_string()
            }
        })?;
        let stdin = child.stdin.take().ok_or("shared agent worker: no stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("shared agent worker: no stdout")?;
        let stderr = child.stderr.take();

        let (tx, rx) = mpsc::channel::<TurnRequest>(8);
        tokio::spawn(drive_worker(child, stdin, stdout, stderr, rx));
        Ok(tx)
    }
}

/// One worker's whole life: take turns off the channel, write each as a user
/// message, read stdout to that turn's `result` frame, answer.
///
/// Turns are answered strictly in order because the transport is one stdio
/// pipe — which is also what makes "one job at a time per worker" true by
/// construction rather than by a lock. When the channel closes the child is
/// dropped, and `kill_on_drop` reaps it.
async fn drive_worker(
    mut child: tokio::process::Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut stderr: Option<tokio::process::ChildStderr>,
    mut rx: mpsc::Receiver<TurnRequest>,
) {
    let mut lines = BufReader::new(stdout).lines();

    while let Some(TurnRequest { turn, reply }) = rx.recv().await {
        // The turn's text first, then whatever it was shown — the order a
        // person would use, and the order the answering model reads the
        // question in.
        let mut content = vec![serde_json::json!({ "type": "text", "text": turn.text })];
        for image in &turn.images {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.media_type,
                    "data": image.data,
                },
            }));
        }
        let message = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content },
        });
        let Ok(line) = serde_json::to_string(&message) else {
            let _ = reply.send(Err("shared agent turn could not be encoded".to_string()));
            continue;
        };
        if stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .is_err()
            || stdin.flush().await.is_err()
        {
            let _ = child.start_kill();
            let _ = reply.send(Err(worker_failure(stderr.take()).await));
            return;
        }

        // The `result` frame carries the whole answer — the same frame shape
        // `scribe.rs` and tugcode already parse. Streamed deltas are ignored:
        // nothing renders a job turn as it arrives.
        let answer = loop {
            match lines.next_line().await {
                Ok(Some(out)) => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&out) else {
                        continue;
                    };
                    if value.get("type").and_then(|t| t.as_str()) != Some("result") {
                        continue;
                    }
                    if value.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
                        break Err(value
                            .get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("shared agent turn failed")
                            .to_string());
                    }
                    break Ok(value
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or_default()
                        .to_string());
                }
                // EOF or a read error is the worker dying; the pool replaces it.
                _ => {
                    let _ = child.start_kill();
                    let _ = reply.send(Err(worker_failure(stderr.take()).await));
                    return;
                }
            }
        };
        let _ = reply.send(answer);
    }
}

/// The detail a dead worker gets reported with: its stderr tail when there is
/// one, the way `agent_bridge` surfaces a child's own account of itself. The
/// read is bounded because the caller kills the child rather than waiting on
/// it — a process that holds stderr open must not hold the driver task with
/// it.
async fn worker_failure(stderr: Option<tokio::process::ChildStderr>) -> String {
    let Some(mut stderr) = stderr else {
        return "shared agent worker exited".to_string();
    };
    let mut buf = String::new();
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut buf),
    )
    .await;
    buf.trim()
        .lines()
        .last()
        .filter(|l| !l.is_empty())
        .unwrap_or("shared agent worker exited")
        .to_string()
}

// MARK: - Observability CONTROL verbs ([P07])

/// The pool as the router holds it: absent until `main` builds one, which is
/// also the shape a build with no agent would have.
pub type SharedAgentHandle = Option<Arc<SharedAgentPool>>;

fn send_control(cat: &broadcast::Sender<Frame>, body: serde_json::Value) {
    if let Ok(bytes) = serde_json::to_vec(&body) {
        let _ = cat.send(Frame::new(FeedId::CONTROL, bytes));
    }
}

/// Run one synopsis job and broadcast the description it wrote.
///
/// The socket-reachable form of the question the session synopsis asks on its
/// own cadence, so what the model actually says about a given digest can be
/// read without waiting for a session row to update. The raw answer rides
/// alongside the normalized one: the two differing is the signal that the
/// prompt is drifting and the normalizer is covering for it.
pub fn request_synopsis(
    agent: SharedAgentHandle,
    cat: Option<broadcast::Sender<Frame>>,
    prompt: String,
) {
    let task = "synopsis";
    tokio::spawn(async move {
        let result = match agent {
            Some(pool) => pool.run(task, prompt).await,
            None => Err(UNAVAILABLE.to_string()),
        };
        let (ok, text, error) = match result {
            Ok(raw) => {
                let report = crate::feeds::session_synopsis::synopsis_register_report(&raw);
                info!(
                    task,
                    %raw,
                    line = %report.text,
                    normalized = report.normalized,
                    clipped = report.clipped,
                    "shared agent synopsis answered",
                );
                (true, Some(report.text), None)
            }
            Err(error) => {
                warn!(task, %error, "shared agent synopsis failed");
                (false, None, Some(error))
            }
        };
        let Some(cat) = cat else { return };
        send_control(
            &cat,
            serde_json::json!({
                "action": "shared_agent_synopsis_result",
                "task": task,
                "ok": ok,
                "text": text,
                "error": error,
            }),
        );
    });
}

/// Run one classify job and broadcast the verdict.
///
/// The shell-routing tenant asks this on every ambiguous line as part of a
/// submit; this is the same question with nothing waiting on it, so a verdict
/// can be observed without a composer in the loop.
pub fn request_classification(
    agent: SharedAgentHandle,
    cat: Option<broadcast::Sender<Frame>>,
    text: String,
    grammar: Option<String>,
) {
    let has_grammar = grammar.is_some();
    tokio::spawn(async move {
        let result = match agent {
            Some(pool) => {
                // Unlike a submit, this verb can wait for the lane — and must,
                // or the first line of an eval run would be scored on a cold
                // start rather than on an answer.
                pool.wait_until_warm(JobClass::Classify).await;
                pool.run_classify(text.clone(), grammar).await
            }
            None => Err(UNAVAILABLE.to_string()),
        };
        // No elapsed here: `shared agent call` already timed this from the
        // caller's side, and two timings of one call invite the reader to
        // wonder which is authoritative.
        let (ok, verdict, error) = match result {
            Ok(verdict) => {
                info!(%text, %verdict, grammar = has_grammar, "shared agent classify answered");
                (true, Some(verdict), None)
            }
            Err(error) => {
                warn!(%text, %error, grammar = has_grammar, "shared agent classify failed");
                (false, None, Some(error))
            }
        };
        let Some(cat) = cat else { return };
        send_control(
            &cat,
            serde_json::json!({
                "action": "shared_agent_classify_result",
                "ok": ok,
                "verdict": verdict,
                "error": error,
            }),
        );
    });
}

// MARK: - Configuration (Spec S04, [P10])

/// Tugbank domain for the shared agents. Mirrored in
/// `tugdeck/src/lib/shared-agent-store.ts`.
pub const SHARED_AGENT_DOMAIN: &str = "dev.tugtool.shared-agent";

/// Per-tenant kill switch for the session description.
///
/// The shell-routing switch under the same domain has no Rust consumer — that
/// tenant lives entirely in the deck — so its key is declared only in
/// `shared-agent-store.ts`.
pub const SYNOPSIS_KEY: &str = "synopsis";

/// What [`SYNOPSIS_KEY`] used to be called, read once at startup by
/// [`carry_synopsis_tenant_forward`] and never again.
const LEGACY_PULSE_OVERVIEW_KEY: &str = "pulse-overview";

/// Full model id override, read per spawn.
pub const MODEL_KEY: &str = "model";

/// Total worker cap across job classes.
pub const MAX_WORKERS_KEY: &str = "max_workers";

/// Room for one worker per job class in steady state ([P12]), which is what the
/// measured traffic asks for: the session synopsis holds one ask in flight
/// process-wide, and classify is serialized by typing.
pub const DEFAULT_MAX_WORKERS: usize = 2;

/// The Haiku agent's pinned model ([P03]). A full id, never a bare alias:
/// aliases drift, and a drifting aux model is a silent behavior change.
pub const HAIKU_MODEL: &str = "claude-haiku-4-5";

/// Carry the description tenant's kill switch across the key rename, once, at
/// startup.
///
/// The switch is a live user setting and absent reads as *enabled*, so a silent
/// rename would turn the description back on for everyone who had turned it
/// off. The copy runs only when [`SYNOPSIS_KEY`] is unset: a value written
/// since the rename is never overwritten by the world before it.
///
/// Copy-only. The stale [`LEGACY_PULSE_OVERVIEW_KEY`] entry is left where it
/// sits — an unread key in a defaults store costs nothing, and growing a delete
/// API to tidy one would cost more than it saves. Both this function and that
/// orphan are deletable once no installation predates this release.
pub fn carry_synopsis_tenant_forward(bank: &tugbank_core::TugbankClient) {
    match bank.get(SHARED_AGENT_DOMAIN, SYNOPSIS_KEY) {
        Ok(None) => {}
        Ok(Some(_)) => return,
        Err(err) => {
            warn!(error = %err, "synopsis tenant: carry-forward read failed");
            return;
        }
    }
    let legacy = match bank.get(SHARED_AGENT_DOMAIN, LEGACY_PULSE_OVERVIEW_KEY) {
        Ok(Some(value)) => value,
        Ok(None) => return,
        Err(err) => {
            warn!(error = %err, "synopsis tenant: legacy read failed");
            return;
        }
    };
    if let Err(err) = bank.set(SHARED_AGENT_DOMAIN, SYNOPSIS_KEY, legacy) {
        warn!(error = %err, "synopsis tenant: carry-forward failed");
    }
}

/// Read a tenant kill switch. Absent — and any non-bool — reads as enabled, so
/// a tenant is never accidentally dark because a value was never written.
pub fn tenant_enabled(bank: Option<&tugbank_core::TugbankClient>, key: &str) -> bool {
    let Some(bank) = bank else {
        return true;
    };
    match bank.get(SHARED_AGENT_DOMAIN, key) {
        Ok(Some(tugbank_core::Value::Bool(enabled))) => enabled,
        _ => true,
    }
}

// MARK: - The Haiku agent's job table (Spec S01)

/// Ported from the on-device wording, then simplified for a model that does not
/// need propping up.
///
/// What is kept verbatim is everything the Rust gates downstream depend on: the
/// two labels, and the register rules that `synopsis_register_report` and
/// `ground_synopsis` enforce. What is dropped is scaffolding that existed only
/// because a 4-bit 4B pack over-read whatever came first — long example ladders
/// teaching one distinction at a time.
///
/// The sentence wordings are deliberately **extractive**: a fluent model
/// paraphrases where a weak one copies, and `ground_synopsis` refuses any line
/// whose words are not in the digest, so the instruction to reuse the digest's
/// own words is what keeps the refusal rate down ([R01]).
pub static HAIKU_AGENT_JOBS: &[JobSpec] = &[
    JobSpec {
        name: "classify",
        timeout: CLASSIFY_TIMEOUT,
        slow: Some(CLASSIFY_SLOW),
        instructions: CLASSIFY_INSTRUCTIONS,
    },
    JobSpec {
        name: "classify_with_grammar",
        timeout: CLASSIFY_TIMEOUT,
        slow: Some(CLASSIFY_SLOW),
        instructions: CLASSIFY_WITH_GRAMMAR_INSTRUCTIONS,
    },
    JobSpec {
        name: "synopsis",
        timeout: SENTENCE_TIMEOUT,
        slow: Some(SENTENCE_SLOW),
        instructions: SYNOPSIS_INSTRUCTIONS,
    },
    JobSpec {
        name: "expand_query",
        timeout: SENTENCE_TIMEOUT,
        slow: Some(SENTENCE_SLOW),
        instructions: EXPAND_QUERY_INSTRUCTIONS,
    },
];

/// Classify's ceiling is one of **three** constants that must agree:
/// `CLASSIFY_REQUEST_TIMEOUT_MS` in `tugdeck/src/lib/shell-classify-store.ts`
/// and `VERDICT_SUBMIT_WAIT_MS` in
/// `tugdeck/src/components/tugways/tug-prompt-entry.tsx` are the same 2s from
/// the deck's side. Lowering one silently makes it the real deadline and the
/// other two unreachable.
const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(2);

/// A sentence job stays under the session-synopsis debounce
/// (`SYNOPSIS_MIN_INTERVAL`, 60s), so a description can never still be in
/// flight when the next one is due.
const SENTENCE_TIMEOUT: Duration = Duration::from_secs(6);

/// Set from the Step 1 spike rather than guessed: warm classify turns measured
/// 867–989 ms against CLI 2.1.222, so a 1s mark would fire on roughly half of
/// all calls. A slow-mark that fires constantly is not a signal, and the
/// `slow=true` rate is what the latency risk is meant to be read by — so the
/// threshold sits above the measured warm band and marks the calls that are
/// genuinely drifting toward the 2s ceiling.
const CLASSIFY_SLOW: Duration = Duration::from_millis(1500);

const SENTENCE_SLOW: Duration = Duration::from_secs(3);

/// What both classify wordings share: the task, the one fact the caller has
/// already established, and the asymmetry that decides every close call.
///
/// A macro rather than a `const` because the two wordings are assembled with
/// `concat!`, which folds string *literals* at compile time — the instructions
/// have to be `&'static str` to live in a [`JobSpec`]. Shared rather than
/// duplicated because the two variants must ask the same question: a drift
/// between them would surface as a band difference and be misread as a fact
/// about the grader.
macro_rules! classify_core {
    () => {
        "\
You label one line a developer typed into a dev tool. Answer with exactly one word and nothing else: SHELL or PROMPT.

The first word of the line ALWAYS names a real program installed on this machine. The question is never whether the program exists — only whether the person meant to RUN it, or was writing a sentence to an AI assistant that happens to begin with that word.

SHELL — they meant to run the program. Anything after the first word is an argument to it: a file name, a directory, a flag, a path, or a subcommand.

PROMPT — they were writing to the assistant. The line reads as English prose: it contains an article, a pronoun, a preposition, or it asks a question.

The two mistakes are not equal. A wrong SHELL runs a command nobody asked for and cannot be taken back. A wrong PROMPT costs one keystroke to retype. When the line could be read either way, answer PROMPT.

Answer only from this message."
    };
}

const CLASSIFY_INSTRUCTIONS: &str = concat!(
    classify_core!(),
    "

Decide by what follows the first word. A bare word that could name a file or a directory means SHELL. An English phrase means PROMPT.

cd tugrust => SHELL
rg TODO src => SHELL
open index.html => SHELL
make clean => SHELL
head over to the docs => PROMPT
open an issue for this bug => PROMPT
make this function faster => PROMPT
why is the test failing => PROMPT

The line:"
);

/// The same question with the program's own documentation in hand — the
/// `maybe` band, where the grader has confirmed the first word names a real
/// program and has failed to account for what follows.
///
/// The contrast pairs are the load-bearing part: a real command wearing a flag
/// the documentation happens not to list is still a command, while an English
/// sentence the documentation gives no meaning to is not. That difference is
/// the entire population of this band.
const CLASSIFY_WITH_GRAMMAR_INSTRUCTIONS: &str = concat!(
    classify_core!(),
    "

Here is that program's own documentation, from this machine:

{{GRAMMAR}}

Read the rest of the line against this documentation.

If the words after the first read as arguments — a subcommand it lists, a flag, a file, a path, a value — answer SHELL. Documentation is never complete: a flag or subcommand missing from it, or spelled a little wrong, is still someone running the program. Judge the SHAPE of what follows, not whether every token appears above.

If the words after the first read as English about the program — a request, a question, a description of what to do — answer PROMPT. The giveaway is that the documentation gives those words no meaning at all.

curl -sS --compressed https://example.com/api => SHELL
curl the config down from the staging box => PROMPT
docker compose up --detach --wait => SHELL
docker the worker into a smaller image => PROMPT

The line:"
);

/// The session's standing description — the line that names what a session is
/// *about*.
///
/// **It is not a headline, and the wording's whole job is to stop it becoming
/// one.** It shipped asking for headline rules against a stretch-scoped digest,
/// and produced a headline. Two things carry it:
///
///  - **The evidence.** The digest is `compose_synopsis_digest`'s —
///    session-lifetime and NEWEST FIRST: the most recent ask is the subject,
///    prior asks are earlier work, the session's opening is context, and the
///    newest activity lines are explicitly labelled background. The boundaries
///    between work items are the user's own messages, not idle-barrier
///    stretches — a stretch swallowed every ask after its first, which is how a
///    description kept leading with the morning's job after the session had
///    moved on.
///  - **The register.** A summary's rules, not a headline's: articles and
///    conjunctions are allowed, the budget is `MAX_SYNOPSIS_CHARS`, and the
///    line is asked to name the undertaking and its object. The wording asks
///    for less than the budget on purpose: the first cut at this line said
///    "about 110 characters" and the model filled every one of them, which
///    overran the Lens and picker rows and shipped clipped mid-word.
///
/// The instruction is deliberately **extractive**: `ground_synopsis` refuses a
/// description whose words are not in the digest, so telling the model to reuse
/// the digest's own words is what keeps the refusal rate down.
const SYNOPSIS_INSTRUCTIONS: &str = "\
You write the standing description of a coding session — ONE sentence saying what the session is about, weighted toward what it is about NOW. It sits under the session's name. A session moves through work items over time, each new ask closing the one before it, and the reader scanning a list of sessions wants the newest work named first.

The digest comes in labeled sections, and they are not equal.

\"What the session was most recently asked to do\" is THE SUBJECT. The newest ask is the work item the session is on, and the line leads with it.

\"What it worked on before that\" is EARLIER WORK, listed newest first. Mention it only if the line has room after the subject, and at most one item of it; when the line names two undertakings, the more recent one comes first.

\"What the session set out to do at the start\" is CONTEXT. It says where the session began. It earns a place in the line only when the newest ask is still that same undertaking.

\"Where it stands right now\" is BACKGROUND: the raw trail of what the session has just been doing — tool calls written as Name(target), shell commands written after a $, and lines the assistant said, newest last. It is there so you know the work is live and what it currently touches. It is never the subject, and a description that restates one of those lines says nothing.

\"The description you are revising\" is your own last answer. Keep its voice and wording where they still fit — but the subject moves with the work. When the newest ask is a new undertaking, the line changes with it; a description still leading with finished work is stale, not stable.

Write it as a sentence, not as a headline:

START WITH A VERB, in the plain command form: Rework, Repair, Trace, Port, Audit, Bundle, Investigate, Extend. Not \"Fixing\", not \"Working on\" — Rework, Repair.
ARTICLES AND CONJUNCTIONS ARE ALLOWED. \"the\", \"a\", \"and\" — use them where the sentence wants them. This is the one line that gets to read as English.
NAME THE WORK AND ITS OBJECT: what is being done, and to what. One subject and one object for the newest work, with at most one earlier item riding after it — never a list of surfaces, parts, or steps.
BE BRIEF. ROOM FOR ABOUT 65 CHARACTERS, and shorter is better — a line that runs long is cut off mid-word on every surface that shows it.
SENTENCE CASE. Proper names keep their capitals — Lens, Finder, Keychain, CodeMirror.
No period at the end. No quotes.

USE THE DIGEST'S OWN WORDS. Build the line out of words that appear in the digest you were given; do not reach for a synonym when the digest has the word. Never name a tool — Bash, Edit, Read, Write, Grep — and never write a path or a file's location.

Answer only from the digest below. Output only the line.

DIGEST:";

/// Search terms for a question whose own words are nowhere in the record.
///
/// The Overview's index is lexical: it finds a record by the words that record
/// contains. "Where did we fix the thing that made the cards flash" shares no
/// token with any commit, command, or post about that work, and no amount of
/// splitting or OR-relaxing manufactures one — this job is what turns the
/// question into words that *would* appear in the record, so the lexical index
/// can do the rest.
///
/// It is asked only when a search has already come back empty twice, so an
/// empty answer costs nothing: the alternative was returning nothing anyway.
/// That is why `{"terms": []}` is a first-class reply rather than a failure —
/// the same silence-is-an-answer posture the Observer's `{"post": null}` has.
const EXPAND_QUERY_INSTRUCTIONS: &str = "\
You generate SEARCH TERMS. Someone asked a question about their own coding work, a full-text search of the record found nothing, and your job is to guess the words that record would actually contain.

The record is a fact library: every prompt the person typed, every shell command run, every test run, every commit, and session lifecycle events. Fact text reads like this:

$ just app-test at0365-overview-card.test.ts → ok
tests: cargo nextest — passed (1614 passed, 0 failed)
commit 3f16971b \"tugways(transcript-copy): route native ⌘C through onCopy substitution\" — 4 file(s)

So write the words that would APPEAR IN THE RECORD OF THE WORK, not synonyms of the question. A commit subject's vocabulary, a filename fragment, a command name, the technical word for the symptom the question describes in plain English. \"Made the cards flash\" is written down somewhere as flicker, repaint, transition, or animation — those are the terms.

Rules:

Single words, never phrases. Every term is OR-ed against the index separately.
3 to 8 of them. Fewer is fine; more is noise that buries the match.
Lowercase, no punctuation, no wildcards.
Do not repeat a word from the question — the search already tried those and found nothing.
If you have nothing better to suggest than the question's own words, say so with an empty list. That is a real answer and it is preferred over filler.

Answer with JSON and nothing else — no prose before it, no code fence around it:

{\"terms\": [\"flicker\", \"repaint\", \"transition\"]}

Or, when you have nothing to add:

{\"terms\": []}

Answer only from the question below.

QUESTION:";

/// Scripted workers, for this module's pool-policy tests and for any other
/// module that needs a pool answering a known thing.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Scripts turn outcomes. Every worker this hands out draws from the same
    /// script, so a test says what the model does without saying which process
    /// said it.
    pub(crate) struct FakeSpawner {
        /// Answer for each turn, by the order turns arrive at this worker.
        answers: Mutex<Vec<Result<String, String>>>,
        /// Held before answering turns whose text carries the marker, so a test
        /// can put a worker of **one** class mid-turn while the other answers
        /// at once — which is the whole shape [P12] exists to produce.
        delay: Option<(&'static str, Duration)>,
        /// Spawns attempted, and whether each is allowed to succeed.
        spawns: AtomicUsize,
        spawn_fails: bool,
        /// Turn text seen, for the composition assertions.
        seen: Arc<Mutex<Vec<Turn>>>,
    }

    impl FakeSpawner {
        pub(crate) fn new(answers: Vec<Result<String, String>>) -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(answers),
                delay: None,
                spawns: AtomicUsize::new(0),
                spawn_fails: false,
                seen: Arc::new(Mutex::new(Vec::new())),
            })
        }
        pub(crate) fn always(answer: Result<String, String>) -> Arc<Self> {
            Self::new(vec![answer; 64])
        }
        /// Answers turns containing `marker` only after `delay`.
        pub(crate) fn slow(
            answer: Result<String, String>,
            marker: &'static str,
            delay: Duration,
        ) -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(vec![answer; 64]),
                delay: Some((marker, delay)),
                spawns: AtomicUsize::new(0),
                spawn_fails: false,
                seen: Arc::new(Mutex::new(Vec::new())),
            })
        }
        pub(crate) fn failing() -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(Vec::new()),
                delay: None,
                spawns: AtomicUsize::new(0),
                spawn_fails: true,
                seen: Arc::new(Mutex::new(Vec::new())),
            })
        }
    }

    impl AgentWorkerSpawner for FakeSpawner {
        fn spawn(&self, _model: String) -> Result<mpsc::Sender<TurnRequest>, String> {
            self.spawns.fetch_add(1, Ordering::Relaxed);
            if self.spawn_fails {
                return Err("no claude here".to_string());
            }
            let (tx, mut rx) = mpsc::channel::<TurnRequest>(8);
            let answers: Vec<_> = self.answers.lock().unwrap().clone();
            let delay = self.delay;
            let seen = Arc::clone(&self.seen);
            tokio::spawn(async move {
                let mut answers = answers.into_iter();
                while let Some(TurnRequest { turn, reply }) = rx.recv().await {
                    if let Some((marker, delay)) = delay {
                        if turn.text.contains(marker) {
                            tokio::time::sleep(delay).await;
                        }
                    }
                    seen.lock().unwrap().push(turn);
                    let answer = answers
                        .next()
                        .unwrap_or_else(|| Err("fake ran out of answers".to_string()));
                    let _ = reply.send(answer);
                }
            });
            Ok(tx)
        }
    }

    /// Spawn counter and turn log, for the pool-policy assertions.
    impl FakeSpawner {
        pub(crate) fn spawn_count(&self) -> usize {
            self.spawns.load(Ordering::Relaxed)
        }
        pub(crate) fn turns_seen(&self) -> Vec<String> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .map(|turn| turn.text.clone())
                .collect()
        }
        /// What each turn was SHOWN, in the same order `turns_seen` reports —
        /// how a test asserts an attached screenshot actually reached the
        /// model rather than only the sentence about it.
        pub(crate) fn images_seen(&self) -> Vec<Vec<TurnImage>> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .map(|turn| turn.images.clone())
                .collect()
        }
    }

    /// A pool over the **real** Haiku job table, answering `answer` to every
    /// turn — what another module's tests want when they are exercising a verb
    /// rather than pool policy.
    pub(crate) fn scripted_haiku_pool(answer: Result<String, String>) -> Arc<SharedAgentPool> {
        SharedAgentPool::new(
            AgentSpec {
                name: "haiku",
                model: Arc::new(|| HAIKU_MODEL.to_string()),
                jobs: HAIKU_AGENT_JOBS,
                max_workers: DEFAULT_MAX_WORKERS,
            },
            FakeSpawner::always(answer) as Arc<dyn AgentWorkerSpawner>,
        )
    }

    pub(crate) static TEST_JOBS: &[JobSpec] = &[
        JobSpec {
            name: "classify",
            instructions: "CLASSIFY",
            timeout: Duration::from_secs(2),
            slow: Some(Duration::from_secs(1)),
        },
        JobSpec {
            name: "classify_with_grammar",
            instructions: "CLASSIFY-DOC {{GRAMMAR}}",
            timeout: Duration::from_secs(2),
            slow: None,
        },
        JobSpec {
            name: "synopsis",
            instructions: "SYNOPSIS",
            timeout: Duration::from_secs(6),
            slow: None,
        },
    ];

    /// Bring `class`'s lane up and wait for its warmup turn to land.
    ///
    /// In production the shell feed calls `ensure_warm` on traffic that
    /// precedes a classify, so by the time anybody submits a line the lane is
    /// warm. A test asserting on what a *caller* pays has to stand in that same
    /// place — an unwarmed classify is answered by the warmup path, not by the
    /// worker.
    pub(crate) async fn warmed(pool: &Arc<SharedAgentPool>, class: JobClass) {
        assert!(
            pool.wait_until_warm(class).await,
            "the {class:?} lane never warmed",
        );
    }

    pub(crate) fn pool(spawner: Arc<FakeSpawner>, max_workers: usize) -> Arc<SharedAgentPool> {
        SharedAgentPool::new(
            AgentSpec {
                name: "test",
                model: Arc::new(|| "test-model".to_string()),
                jobs: TEST_JOBS,
                max_workers,
            },
            spawner,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{FakeSpawner, pool, warmed};
    use super::*;

    #[tokio::test]
    async fn a_job_turn_carries_its_instructions_and_input() {
        let fake = FakeSpawner::always(Ok("Fix the thing".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        pool.run("synopsis", "the digest".to_string())
            .await
            .expect("answers");
        assert_eq!(fake.turns_seen().as_slice(), ["SYNOPSIS\n\nthe digest"]);
    }

    /// A job run with images shows them WITH the turn rather than instead of
    /// it: the composed text is still the composed text, and the pictures ride
    /// beside it. This is the whole contract the Overview's Operator rests on —
    /// an answer about a screenshot is written by a model that was handed the
    /// screenshot.
    #[tokio::test]
    async fn a_turn_can_be_shown_images_alongside_its_text() {
        let fake = FakeSpawner::always(Ok("A cat".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        let shown = vec![TurnImage {
            media_type: "image/png".to_string(),
            data: "aGVsbG8=".to_string(),
        }];
        pool.run_seeing("synopsis", "what is this".to_string(), shown.clone())
            .await
            .expect("answers");
        assert_eq!(fake.turns_seen().as_slice(), ["SYNOPSIS\n\nwhat is this"]);
        assert_eq!(fake.images_seen().as_slice(), [shown]);
    }

    /// And a job run without them is byte-identical to what it always was —
    /// every existing caller goes through `run`, which is `run_seeing` with
    /// nothing to see.
    #[tokio::test]
    async fn a_turn_with_no_images_carries_none() {
        let fake = FakeSpawner::always(Ok("Fix the thing".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        pool.run("synopsis", "the digest".to_string())
            .await
            .expect("answers");
        assert_eq!(fake.images_seen().as_slice(), [Vec::<TurnImage>::new()]);
    }

    #[tokio::test]
    async fn one_worker_serves_every_job_of_its_class_in_turn() {
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;
        for _ in 0..3 {
            pool.run_classify("ls".to_string(), None).await.expect("ok");
        }
        // Serialized by typing, so a second classify worker would be pool
        // growth nobody asked for.
        assert_eq!(fake.spawn_count(), 1);
        assert_eq!(pool.worker_count(), 1);
    }

    /// [P12]'s reason for existing: a classify that arrives while the only
    /// other worker is mid-sentence must not wait for it. The sentence job here
    /// holds for 5s — longer than classify's entire 2s ceiling — so if the
    /// classify queued behind it, it would time out instead of answering.
    #[tokio::test(start_paused = true)]
    async fn a_classify_never_queues_behind_a_busy_sentence_worker() {
        let fake = FakeSpawner::slow(Ok("SHELL".to_string()), "SYNOPSIS", Duration::from_secs(5));
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;

        let describing = {
            let pool = Arc::clone(&pool);
            tokio::spawn(async move { pool.run("synopsis", "digest".to_string()).await })
        };
        // Let the synopsis claim its own worker before the classify arrives.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let verdict = pool.run_classify("ls -la".to_string(), None).await;
        assert_eq!(verdict.as_deref(), Ok("shell"));
        assert_eq!(
            fake.spawn_count(),
            2,
            "the classify answered on its own class's worker",
        );
        describing
            .await
            .expect("join")
            .expect("the synopsis answers");
    }

    /// The regression that took shell routing out entirely: a classify spawned
    /// a worker, spent its whole 2 s ceiling on that worker's cold start, and
    /// the timeout retired the very process the wait had paid for. The lane
    /// never became warm, so every classify was a cold classify and no typed
    /// command was ever recognized as one. A cold lane now costs the one line
    /// that found it cold.
    #[tokio::test]
    async fn a_cold_lane_costs_one_line_and_then_answers() {
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 2);

        assert!(
            pool.run_classify("gs".to_string(), None).await.is_err(),
            "the line that found the lane cold goes to Claude",
        );
        warmed(&pool, JobClass::Classify).await;
        assert_eq!(
            pool.run_classify("gs".to_string(), None).await.as_deref(),
            Ok("shell"),
            "and the next one is answered",
        );
        assert_eq!(
            fake.spawn_count(),
            1,
            "by the worker the first line paid for",
        );
    }

    /// A class with a worker never grows the pool: concurrent classifies queue
    /// behind the warm one rather than buying a cold start apiece. The submit
    /// path depends on it — a grammar-bearing question routinely arrives while
    /// the typing debounce's question is still in flight.
    #[tokio::test(start_paused = true)]
    async fn concurrent_jobs_of_a_class_share_its_worker() {
        // The marker matches only a caller's turn (`…\n\nls`), never the
        // warmup's (`…\n\npwd`), so warming a lane is never the slow path.
        let fake = FakeSpawner::slow(
            Ok("SHELL".to_string()),
            "\n\nls",
            Duration::from_millis(300),
        );
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;

        let mut running = Vec::new();
        for _ in 0..4 {
            let pool = Arc::clone(&pool);
            running.push(tokio::spawn(async move {
                pool.run_classify("ls".to_string(), None).await
            }));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for job in running {
            assert_eq!(job.await.expect("join").as_deref(), Ok("shell"));
        }
        assert_eq!(fake.spawn_count(), 1, "one worker served all four");
    }

    /// The cap is over the whole pool, so a second class can only have a worker
    /// while the first still fits under it.
    #[tokio::test]
    async fn the_pool_never_grows_past_max_workers() {
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 1);
        warmed(&pool, JobClass::Classify).await;

        let error = pool
            .run("synopsis", "digest".to_string())
            .await
            .expect_err("no room for a second class");
        assert_eq!(error, UNAVAILABLE);
        assert_eq!(fake.spawn_count(), 1);
    }

    /// The replacement for a recycled worker is warmed on the spot, so the lane
    /// does not go cold once every `MAX_TURNS_PER_WORKER` and hand some
    /// unlucky classify a spawn it cannot wait for.
    #[tokio::test]
    async fn a_worker_is_recycled_at_the_turn_cap() {
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;
        // The warmup was this worker's first turn, so the cap falls one caller
        // turn short of the loop count.
        for _ in 0..MAX_TURNS_PER_WORKER - 1 {
            pool.run_classify("ls".to_string(), None).await.expect("ok");
        }
        assert_eq!(fake.spawn_count(), 2, "the replacement is already up");

        pool.run_classify("ls".to_string(), None).await.expect("ok");
        assert_eq!(fake.spawn_count(), 2, "answered by the warm replacement");
    }

    /// The cap must not block the recycle. A superseded worker is leaving, so
    /// it does not count against `max_workers` — otherwise a pool held at its
    /// cap by the other lane could never replace a capped worker, and that
    /// worker would go on answering with a conversation the turn cap exists to
    /// bound.
    #[tokio::test]
    async fn a_recycle_proceeds_while_the_other_lane_holds_the_cap() {
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;
        warmed(&pool, JobClass::Sentence).await;

        // The warmup was the classify worker's first turn, so the cap lands on
        // the last loop turn.
        for _ in 0..MAX_TURNS_PER_WORKER - 1 {
            pool.run_classify("ls".to_string(), None).await.expect("ok");
        }
        assert_eq!(
            fake.spawn_count(),
            3,
            "the replacement spawned despite the pool sitting at its cap",
        );
        pool.run_classify("ls".to_string(), None).await.expect("ok");
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_worker_is_reaped() {
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;
        pool.run_classify("ls".to_string(), None).await.expect("ok");
        assert_eq!(pool.worker_count(), 1);

        tokio::time::advance(idle_reap(JobClass::Classify) + Duration::from_secs(1)).await;
        assert_eq!(pool.worker_count(), 0, "reaped after the idle window");

        // The lane comes back on the next classify — as that classify's warmup,
        // not as its answer.
        assert!(pool.run_classify("ls".to_string(), None).await.is_err());
        assert_eq!(fake.spawn_count(), 2, "spawned again on demand");
    }

    /// The sentence lane's ceiling *can* cover a cold start, so a synopsis is
    /// answered by the worker it spawns rather than degraded into a warmup.
    #[tokio::test]
    async fn a_sentence_job_is_answered_by_the_worker_it_spawns() {
        let fake = FakeSpawner::always(Ok("A description".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        assert_eq!(
            pool.run("synopsis", "digest".to_string()).await.as_deref(),
            Ok("A description"),
        );
        assert_eq!(fake.spawn_count(), 1);
    }

    /// A worker that dies must not be respawned in a hot loop. Within the
    /// debounce the job degrades; past it the class may spawn again.
    #[tokio::test(start_paused = true)]
    async fn a_dead_worker_is_not_respawned_inside_the_debounce() {
        let fake = FakeSpawner::failing();
        let pool = pool(Arc::clone(&fake), 2);

        assert!(pool.run_classify("ls".to_string(), None).await.is_err());
        assert_eq!(fake.spawn_count(), 1);

        // Immediately again: the debounce holds, so no second spawn attempt.
        assert!(pool.run_classify("ls".to_string(), None).await.is_err());
        assert_eq!(fake.spawn_count(), 1);

        tokio::time::advance(RESPAWN_MIN_INTERVAL + Duration::from_secs(1)).await;
        assert!(pool.run_classify("ls".to_string(), None).await.is_err());
        assert_eq!(fake.spawn_count(), 2, "allowed past the debounce");
    }

    #[tokio::test(start_paused = true)]
    async fn a_job_past_its_ceiling_errors_and_retires_the_worker() {
        // Classify's ceiling is 2s in the test table; this worker takes 10 on a
        // caller's turn (the marker never matches a warmup's `…\n\npwd`).
        let fake = FakeSpawner::slow(Ok("SHELL".to_string()), "\n\nls", Duration::from_secs(10));
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;

        let error = pool
            .run_classify("ls".to_string(), None)
            .await
            .expect_err("the ceiling is the answer");
        assert!(error.contains("timed out"), "{error}");
        // The stuck worker is out of the rotation rather than left to make the
        // next job time out behind it.
        assert_eq!(pool.worker_count(), 0);
    }

    /// A timeout is a failure for the respawn debounce too: a hung backend is
    /// never paid for with one fresh spawn per call, and a job arriving inside
    /// the window degrades instead of queueing behind the retired worker.
    #[tokio::test(start_paused = true)]
    async fn a_timed_out_class_holds_the_respawn_debounce() {
        let fake = FakeSpawner::slow(Ok("SHELL".to_string()), "\n\nls", Duration::from_secs(10));
        let pool = pool(Arc::clone(&fake), 2);
        warmed(&pool, JobClass::Classify).await;

        assert!(pool.run_classify("ls".to_string(), None).await.is_err());
        assert_eq!(fake.spawn_count(), 1);

        let error = pool
            .run_classify("ls".to_string(), None)
            .await
            .expect_err("degrades inside the debounce");
        assert!(error.contains("unavailable"), "{error}");
        assert_eq!(fake.spawn_count(), 1, "no spawn inside the debounce");

        tokio::time::advance(RESPAWN_MIN_INTERVAL + Duration::from_secs(1)).await;
        assert!(pool.run_classify("ls".to_string(), None).await.is_err());
        assert_eq!(fake.spawn_count(), 2, "allowed past the debounce");
    }

    #[tokio::test]
    async fn a_classify_answer_naming_no_label_or_both_is_a_refusal() {
        for answer in ["I am not sure", "SHELL or PROMPT", "", "shellfish"] {
            let fake = FakeSpawner::always(Ok(answer.to_string()));
            let pool = pool(fake, 2);
            warmed(&pool, JobClass::Classify).await;
            let error = pool
                .run_classify("ls".to_string(), None)
                .await
                .expect_err("refusal");
            assert!(
                error.contains("did not name a label"),
                "{answer:?}: {error}"
            );
        }
        // A label anywhere in the answer, named once, is the verdict.
        for (answer, expected) in [
            ("SHELL", "shell"),
            ("prompt", "prompt"),
            ("**SHELL**", "shell"),
            ("The answer is PROMPT.", "prompt"),
        ] {
            let fake = FakeSpawner::always(Ok(answer.to_string()));
            let pool = pool(fake, 2);
            warmed(&pool, JobClass::Classify).await;
            assert_eq!(
                pool.run_classify("ls".to_string(), None).await.as_deref(),
                Ok(expected),
                "{answer:?}",
            );
        }
    }

    #[tokio::test]
    async fn a_grammar_picks_the_documentation_wording_and_is_substituted() {
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 2);
        // Both wordings share the lane, so the warm worker serves this one.
        warmed(&pool, JobClass::Classify).await;
        pool.run_classify(
            "curl -sS x".to_string(),
            Some("usage: curl [options]".to_string()),
        )
        .await
        .expect("ok");
        assert_eq!(
            fake.turns_seen().last().map(String::as_str),
            Some("CLASSIFY-DOC usage: curl [options]\n\ncurl -sS x"),
        );
    }

    /// [P08]: an app-test instance must never reach a real worker, so the gate
    /// answers before anything is spawned.
    #[tokio::test]
    async fn the_app_test_gate_answers_without_spawning() {
        // Safe under nextest, which runs each test in its own process.
        unsafe { std::env::set_var("TUGAPP_APP_TEST", "1") };
        let fake = FakeSpawner::always(Ok("SHELL".to_string()));
        let pool = pool(Arc::clone(&fake), 2);

        let error = pool
            .run_classify("ls".to_string(), None)
            .await
            .expect_err("gated");
        assert_eq!(error, UNAVAILABLE);
        assert!(pool.run("synopsis", "d".to_string()).await.is_err());
        assert_eq!(fake.spawn_count(), 0, "nothing was spawned");
        unsafe { std::env::remove_var("TUGAPP_APP_TEST") };
    }

    /// The future-Sonnet exit criterion ([P01]): a second agent is a second
    /// value, not new machinery. This spec shares nothing with the Haiku one
    /// but the pool type.
    #[tokio::test]
    async fn a_second_agent_spec_runs_on_the_same_pool_machinery() {
        static OTHER_JOBS: &[JobSpec] = &[
            JobSpec {
                name: "synopsis",
                instructions: "OTHER-SYNOPSIS",
                timeout: Duration::from_secs(30),
                slow: None,
            },
            JobSpec {
                name: "critique",
                instructions: "OTHER-CRITIQUE",
                timeout: Duration::from_secs(30),
                slow: None,
            },
        ];
        let fake = FakeSpawner::always(Ok("an answer".to_string()));
        let pool = SharedAgentPool::new(
            AgentSpec {
                name: "other",
                model: Arc::new(|| "claude-sonnet-5".to_string()),
                jobs: OTHER_JOBS,
                max_workers: 1,
            },
            Arc::clone(&fake) as Arc<dyn AgentWorkerSpawner>,
        );
        assert_eq!(
            pool.run("critique", "a draft".to_string()).await.as_deref(),
            Ok("an answer"),
        );
        assert_eq!(fake.turns_seen().as_slice(), ["OTHER-CRITIQUE\n\na draft"]);
    }

    #[test]
    fn the_haiku_job_table_carries_every_contract_the_gates_depend_on() {
        let job = |name: &str| {
            HAIKU_AGENT_JOBS
                .iter()
                .find(|j| j.name == name)
                .unwrap_or_else(|| panic!("{name} missing"))
        };
        // Both labels, in both classify wordings.
        for name in ["classify", "classify_with_grammar"] {
            let text = job(name).instructions;
            assert!(text.contains("SHELL") && text.contains("PROMPT"), "{name}");
            assert!(text.contains("answer PROMPT"), "{name} keeps the asymmetry");
        }
        assert!(
            job("classify_with_grammar")
                .instructions
                .contains(GRAMMAR_PLACEHOLDER)
        );
        assert!(!job("classify").instructions.contains(GRAMMAR_PLACEHOLDER));

        // The register rules `synopsis_register_report` and `ground_synopsis`
        // enforce, and the extractive instruction that keeps grounding passing.
        let synopsis = job("synopsis").instructions;
        assert!(synopsis.contains("SENTENCE CASE"));
        assert!(synopsis.contains("USE THE DIGEST'S OWN WORDS"));

        // Expansion's output contract, which `expand_via_model` parses and
        // whose empty case it treats as a real answer. Both halves are pinned:
        // the shape, and the permission to return nothing — without the latter
        // a model with no good suggestion invents filler, and filler here is
        // rows that look like evidence.
        let expand = job("expand_query").instructions;
        assert!(expand.contains(r#"{"terms": []}"#));
        assert!(expand.contains("That is a real answer"));
        assert!(expand.contains("Single words, never phrases"));
        assert!(expand.contains("3 to 8"));
        // The whole point: terms as the RECORD spells them, not synonyms of
        // the question. A model that reached for synonyms would produce words
        // just as absent from the index as the question's own.
        assert!(expand.contains("APPEAR IN THE RECORD OF THE WORK"));
        // Its ceiling sits inside the verb's, with room for the two lexical
        // rungs that already ran. Raising one without the other turns graceful
        // degradation into verb timeouts.
        assert!(job("expand_query").timeout < crate::feeds::operator::VERB_TIMEOUT);

        // Classify's ceiling is the triad's Rust member; a sentence job stays
        // under the synopsis debounce.
        assert_eq!(job("classify").timeout, Duration::from_secs(2));
        assert!(job("synopsis").timeout < crate::feeds::session_synopsis::SYNOPSIS_MIN_INTERVAL);
    }

    /// The only test that spawns a real `claude` and spends real tokens.
    ///
    /// `#[ignore]`-gated **and** `TUG_REAL_CLAUDE`-gated, the same
    /// belt-and-suspenders as `tests/multi_session_real_claude.rs`, so a
    /// developer running `--run-ignored only` without the variable gets a fast
    /// no-op rather than a surprise spawn. To run it:
    ///
    /// ```sh
    /// cd tugrust
    /// TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast \
    ///   --run-ignored only a_real_worker_answers
    /// ```
    ///
    /// It pins the seam the fake spawner cannot: that the argv, the isolation
    /// posture, and the stream-json frame parsing actually work against the
    /// installed CLI. It asserts a label and a non-empty line — never model
    /// prose, which is the eval harness's business.
    #[tokio::test]
    #[ignore = "requires TUG_REAL_CLAUDE=1 and a live claude binary"]
    async fn a_real_worker_answers_one_classify_and_one_synopsis() {
        if std::env::var("TUG_REAL_CLAUDE").as_deref() != Ok("1") {
            return;
        }
        let pool = SharedAgentPool::new(
            AgentSpec {
                name: "haiku",
                model: Arc::new(|| HAIKU_MODEL.to_string()),
                jobs: HAIKU_AGENT_JOBS,
                max_workers: DEFAULT_MAX_WORKERS,
            },
            Arc::new(ClaudeAgentWorkerSpawner),
        );

        // The first turn of a class pays the cold spawn, which is more than
        // classify's own ceiling — so warm the lane the way the shell feed
        // does, and time the turn a user would actually wait on.
        warmed(&pool, JobClass::Classify).await;
        let started = Instant::now();
        let verdict = pool
            .run_classify("ls -la".to_string(), None)
            .await
            .expect("a warm classify answers");
        let warm_ms = started.elapsed().as_millis();
        assert_eq!(
            verdict, "shell",
            "an unambiguous command routes to the shell"
        );
        assert!(
            started.elapsed() < CLASSIFY_TIMEOUT,
            "a warm classify took {warm_ms}ms, past the {CLASSIFY_TIMEOUT:?} budget",
        );

        let digest = "What the session was most recently asked to do:\n\
             make the watch loop resilient\n\n\
             Where it stands right now (background, not the subject):\n\
             - Edit(watch.rs)\n";
        let line = pool
            .run("synopsis", digest.to_string())
            .await
            .expect("a synopsis answers");
        assert!(!line.trim().is_empty(), "an empty description is a failure");
    }

    /// The rename must not re-enable a tenant somebody turned off. Absent reads
    /// as enabled, so an uncopied `false` is a description switching itself back
    /// on — and a value written under the new key is the newer intent, so the
    /// copy never overwrites one.
    #[test]
    fn the_description_tenant_survives_its_key_rename() {
        use tempfile::NamedTempFile;
        use tugbank_core::TugbankClient;

        let switched_off = |legacy: Option<bool>, current: Option<bool>| {
            let tmp = NamedTempFile::new().expect("temp file");
            let bank = TugbankClient::open(tmp.path()).expect("open bank");
            if let Some(value) = legacy {
                bank.set(
                    SHARED_AGENT_DOMAIN,
                    LEGACY_PULSE_OVERVIEW_KEY,
                    tugbank_core::Value::Bool(value),
                )
                .unwrap();
            }
            if let Some(value) = current {
                bank.set(
                    SHARED_AGENT_DOMAIN,
                    SYNOPSIS_KEY,
                    tugbank_core::Value::Bool(value),
                )
                .unwrap();
            }
            carry_synopsis_tenant_forward(&bank);
            (
                tenant_enabled(Some(&bank), SYNOPSIS_KEY),
                bank.get(SHARED_AGENT_DOMAIN, LEGACY_PULSE_OVERVIEW_KEY)
                    .unwrap()
                    .is_some(),
            )
        };

        assert!(!switched_off(Some(false), None).0, "the off carries");
        assert!(switched_off(Some(true), None).0, "so does the on");
        assert!(
            switched_off(Some(false), Some(true)).0,
            "a value written since the rename is the newer intent",
        );
        assert!(switched_off(None, None).0, "absent reads enabled");
        assert!(
            switched_off(Some(false), None).1,
            "the copy leaves the stale key where it sits",
        );
    }

    #[test]
    fn job_classes_split_the_two_latency_lanes() {
        assert_eq!(JobClass::of("classify"), JobClass::Classify);
        assert_eq!(
            JobClass::of("classify_with_grammar"),
            JobClass::Classify,
            "both classify wordings share a lane",
        );
        assert_eq!(JobClass::of("synopsis"), JobClass::Sentence);
        assert_eq!(JobClass::of("expand_query"), JobClass::Sentence);
    }
}
