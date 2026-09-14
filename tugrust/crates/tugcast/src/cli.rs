use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("TUG_COMMIT"), ")");

/// Default tmux session name. When `TUG_INSTANCE_ID` is set, the
/// session is named `cc-<id>` so concurrent instances do not collide;
/// otherwise the legacy `cc0` default applies.
fn default_session() -> String {
    match tugcore::instance::instance_id() {
        Some(id) => format!("cc-{id}"),
        None => "cc0".to_owned(),
    }
}

/// tugcast: WebSocket multiplexer — bridges multiple backends to tugdeck via binary-framed feeds
#[derive(Parser, Debug)]
#[command(name = "tugcast")]
#[command(version = VERSION)]
#[command(
    about = "WebSocket multiplexer serving terminal, code, filesystem, and git feeds to tugdeck",
    long_about = "tugcast multiplexes multiple data feeds over a single WebSocket connection to\nthe tugdeck browser frontend. Feeds include: terminal I/O (via tmux), Claude Code\nevents (via tugcode bridge), filesystem watching, git status, and\ntugbank defaults. Each feed is identified by a FeedId byte in binary-framed messages.\n\nUsage:\n  tugcast                               Start with defaults (session: cc-<TUG_INSTANCE_ID> or cc0, port: 55255)\n  tugcast --session dev --port 8080         Custom session and port\n  tugcast --source-tree /path/to/project    Watch a specific directory"
)]
pub struct Cli {
    /// Tmux session name to attach to (created if it doesn't exist).
    /// Default is `cc-<TUG_INSTANCE_ID>` when set, else `cc0`.
    #[arg(long, default_value_t = default_session())]
    pub session: String,

    /// Port to bind the HTTP server to. When omitted, the port is
    /// derived from the per-instance identifier via
    /// `tugcore::ports::tugcast_port_default` (window 55300–55399),
    /// walking forward on collision. Pass `0` to request an
    /// OS-ephemeral port.
    #[arg(long)]
    pub port: Option<u16>,

    /// Optional bootstrap workspace directory for the file-tree/git feeds.
    /// The distributed app omits this — per-card workspaces drive every feed
    /// directory at card-open time. When absent, the bootstrap watches an
    /// empty per-instance directory purely to emit the initial empty
    /// snapshots an unbound Session card renders against. Transitional: removed
    /// entirely once the bootstrap workspace is retired.
    #[arg(long)]
    pub source_tree: Option<PathBuf>,

    /// Path to tugcode binary (overrides auto-detection)
    #[arg(long)]
    pub tugcode_path: Option<PathBuf>,

    /// Unix domain socket path for parent IPC
    #[arg(long)]
    pub control_socket: Option<PathBuf>,

    /// Path to the tugbank SQLite database (default: ~/.tugbank.db)
    #[arg(long)]
    pub bank_path: Option<PathBuf>,

    /// Skip authentication for development/testing. Allows any WebSocket
    /// connection without session cookies or origin checks. Do not use
    /// in production.
    #[arg(long)]
    pub no_auth: bool,

    /// Kill any existing tugcast process holding the TCP port before binding.
    /// Useful when a zombie tugcast is holding the port after a crash.
    #[arg(long)]
    pub force: bool,

    /// Seed this instance's ledger from a JSON spec, then exit without
    /// starting a server — the app-test harness's pre-launch hook.
    ///
    /// A session row is written by the real spawn path and nothing else
    /// (`session_init` from a live tugcode), so an app-test cannot compose a
    /// *session-entry* changeset row without either a real Claude subprocess
    /// or this. It writes through the same `SessionLedger` the server uses, so
    /// the schema and the journal are correct by construction rather than by a
    /// hand-mirrored `CREATE TABLE` that drifts.
    ///
    /// Refused outside an app-test instance — see `seed_ledger` in `main`.
    #[arg(long, value_name = "JSON_FILE")]
    pub seed_ledger: Option<PathBuf>,

    /// Developer subcommands. Absent means "run the server", which is what
    /// every launch does; a present one runs its tool and exits before any
    /// listener binds.
    #[command(subcommand)]
    pub command: Option<Command>,
}

/// Tools that share the binary but not its job.
#[derive(Subcommand, Debug)]
pub enum Command {
    /// Replay a session transcript through the Observer's wake core and print
    /// the overview it would have produced.
    ///
    /// Hidden because it is a calibration instrument, not part of running
    /// tugcast: it exists so the channel's cadence can be set by reading real
    /// output at two or three values rather than by guessing one.
    #[command(hide = true)]
    OverviewReplay(OverviewReplayArgs),

    /// Ask the Overview's Operator a question against a named ledger and print
    /// what it answers, with every verb it ran on the way.
    ///
    /// Hidden for the same reason as `overview-replay`: it is a verification and
    /// calibration instrument. It runs the real pipeline — real ledger, real
    /// verbs, real model — which is the only way a question that once failed
    /// can be shown to answer now.
    #[command(hide = true)]
    OperatorAsk(OperatorAskArgs),
}

/// Flags for `tugcast operator-ask`.
#[derive(Args, Debug)]
pub struct OperatorAskArgs {
    /// The question, exactly as someone would type it into the Overview card.
    pub question: String,

    /// Session ledger to read. POINT THIS AT A COPY: `just db-inspect` makes
    /// one safely. A foreign process on a live ledger is a corruption vector,
    /// and opening one also runs any pending schema migration on it.
    #[arg(long)]
    pub db: PathBuf,

    /// The repository a question means when it names no session — what
    /// `--source-tree` resolves to in a running instance.
    #[arg(long)]
    pub project_dir: PathBuf,

    /// Shell-route command history, for `shell.history`. Omitted reads as "no
    /// command history to search", which is a legal state, not an error.
    #[arg(long)]
    pub shell_db: Option<PathBuf>,

    /// Model for both Operator jobs, for this run only.
    #[arg(long)]
    pub model: Option<String>,

    /// Print each verb's full result JSON, not just its row count.
    #[arg(long)]
    pub show_rounds: bool,

    /// A file the asker pointed at with an `@` atom, repeatable — the same
    /// gesture the Overview composer sends as a question ref. Without it this
    /// instrument cannot reach the seeded half of the pipeline, and a replay
    /// would silently measure the unseeded path.
    #[arg(long = "ref", value_name = "PATH")]
    pub refs: Vec<String>,
}

/// Flags for `tugcast overview-replay`. Each one overrides a `dev.tugapp.overview`
/// default for the length of the run without writing to tugbank, so a sweep
/// never disturbs a live instance's settings.
#[derive(Args, Debug)]
pub struct OverviewReplayArgs {
    /// Claude Code session transcript (`~/.claude/projects/<slug>/<id>.jsonl`).
    pub jsonl: PathBuf,

    /// Seconds of continuous activity before a sitrep wake. The number the
    /// sweep is about; 0 leaves only turn-end and session-end wakes.
    #[arg(long)]
    pub sitrep_secs: Option<i64>,

    /// Seconds after a user submission before the Observer wakes to write the
    /// turn's current line. 0 turns the submission wake off, which is the
    /// baseline half of the comparison the footer prints: the same transcript
    /// segmented with the short arm and without it says exactly what the
    /// currency costs in wakes.
    #[arg(long)]
    pub submission_arm_secs: Option<i64>,

    /// How many prior posts ride each wake — the dedup mechanism.
    #[arg(long)]
    pub last_k: Option<usize>,

    /// Per-window frame cap before the oldest are elided.
    #[arg(long)]
    pub max_frames: Option<usize>,

    /// Billed tokens since the last post that force a wake. 0 is off.
    #[arg(long)]
    pub token_wake_tokens: Option<i64>,

    /// Model for the `observer-post` job.
    #[arg(long)]
    pub model: Option<String>,

    /// Segment and report the wake windows without calling the model. Free,
    /// instant, and deterministic — the right first look at a new cadence.
    #[arg(long)]
    pub no_model: bool,

    /// Print the composed job input for each wake — exactly the bytes the
    /// Observer is shown. The answer to "why did it stay silent?", which
    /// cannot be read off the post that was not written. Combines with
    /// `--no-model` to inspect the material for free.
    #[arg(long)]
    pub show_input: bool,

    /// Compose every wake with an empty facts section — the pre-facts diet.
    ///
    /// The instrument for the one comparison the facts section cannot be judged
    /// without: the same transcript, the same segmentation, read once with the
    /// settled facts and once without. Without this the baseline would have to
    /// come from a differently-built binary, and then the diet would not be the
    /// only thing that changed between the two runs.
    #[arg(long)]
    pub no_facts: bool,
}

impl Cli {
    /// Parse CLI arguments from the environment
    pub fn parse() -> Self {
        <Self as Parser>::parse()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Mutex;

    /// `default_session()` reads `TUG_INSTANCE_ID` from the process env.
    /// Serialize tests that mutate it.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Verify the per-instance session default. Clap parsing itself is
    /// vendor code — we don't test that defaults parse or that --help
    /// works. We test the *one* piece of logic we own: the session
    /// name computed from TUG_INSTANCE_ID.
    #[test]
    fn session_default_unset_is_cc0() {
        let _lock = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let prior = std::env::var_os("TUG_INSTANCE_ID");
        unsafe {
            std::env::remove_var("TUG_INSTANCE_ID");
        }
        // default_session() is the one piece of logic we own here;
        // clap parsing itself is vendor code.
        assert_eq!(default_session(), "cc0");
        unsafe {
            match prior {
                Some(v) => std::env::set_var("TUG_INSTANCE_ID", v),
                None => std::env::remove_var("TUG_INSTANCE_ID"),
            }
        }
        let _: Option<OsString> = std::env::var_os("TUG_INSTANCE_ID");
    }

    /// The one piece of `operator-ask`'s shape that is ours rather than
    /// clap's: which arguments it demands, and the fact that it demands the
    /// ledger by name. A `--db` that slipped to optional would default to
    /// nothing and the instrument would be pointed at whatever ran it.
    #[test]
    fn operator_ask_takes_a_ledger_a_repo_and_a_question() {
        let cli = <Cli as Parser>::try_parse_from([
            "tugcast",
            "operator-ask",
            "--db",
            "/tmp/copy/sessions.db",
            "--project-dir",
            "/repo",
            "--show-rounds",
            "what was the recent commit about tooltips?",
        ])
        .expect("operator-ask parses");
        let Some(Command::OperatorAsk(args)) = cli.command else {
            panic!("parsed as something other than operator-ask");
        };
        assert_eq!(args.db, PathBuf::from("/tmp/copy/sessions.db"));
        assert_eq!(args.project_dir, PathBuf::from("/repo"));
        assert_eq!(args.question, "what was the recent commit about tooltips?");
        assert!(args.show_rounds);
        // Both are genuinely optional: no shell ledger reads as "no command
        // history", and no model means the Overview's own default.
        assert!(args.shell_db.is_none());
        assert!(args.model.is_none());

        assert!(
            <Cli as Parser>::try_parse_from(["tugcast", "operator-ask", "a question"]).is_err(),
            "the ledger and the repo are required",
        );
    }

    /// Both developer subcommands are instruments, not features. A user
    /// reading `tugcast --help` should see the server's flags and nothing
    /// about replaying transcripts or interrogating ledger copies.
    #[test]
    fn the_developer_subcommands_stay_out_of_help() {
        let help = <Cli as clap::CommandFactory>::command()
            .render_help()
            .to_string();
        assert!(!help.contains("operator-ask"), "{help}");
        assert!(!help.contains("overview-replay"), "{help}");
    }

    #[test]
    fn session_default_with_instance_id_is_cc_id() {
        let _lock = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let prior = std::env::var_os("TUG_INSTANCE_ID");
        unsafe {
            std::env::set_var("TUG_INSTANCE_ID", "debug-foo");
        }
        assert_eq!(default_session(), "cc-debug-foo");
        unsafe {
            match prior {
                Some(v) => std::env::set_var("TUG_INSTANCE_ID", v),
                None => std::env::remove_var("TUG_INSTANCE_ID"),
            }
        }
        let _: Option<OsString> = std::env::var_os("TUG_INSTANCE_ID");
    }
}
