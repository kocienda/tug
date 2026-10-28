//! Crossing conflicts settled into the rerere cache, while each side is a
//! round old.
//!
//! The probe ([`tugarc_core::crossing::probe_crossings`]) says two live arcs
//! conflict; this settles the conflict. The join ladder's per-file rungs run
//! over a merge of the two tips, with the scribe as their AI rung, and what
//! they settle teaches the shared rerere cache. Whatever they leave goes to
//! the resolver, automatically, in a scratch checkout of the same merge, and
//! the files it finishes teach the same cache. Neither branch moves and
//! nothing is committed: the cache is the whole of the record, and the
//! second arc's join replays it through rung 2.
//!
//! **Nobody is asked.** A crossing has no user waiting on it, and a join's
//! readiness must not depend on an agent's attention. A resolver that asks
//! instead of finishing leaves its paths for the join, whose own resolver can
//! ask a user who is present.
//!
//! **One settle per pair at a time.** A round of either arc wakes a settle,
//! and a settle can spend minutes in a model. A round that lands while its
//! pair is settling marks the pair for one more pass rather than starting a
//! second, so the pass that follows reads the newest tips.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use tracing::{info, warn};
use tugarc_core::ResolvedBy;
use tugarc_core::resolve::{FileMerger, PairCheckout, PairResolution};
use tugcore::instance::Paths;

use super::agent_supervisor::AgentSupervisor;
use super::join_resolve::ScribeFileMerger;
use super::join_resolver::{
    CharterInputs, JoinResolverSpawner, RESOLVE_DEADLINE, ResolverRun, ResolverTurn,
    compose_charter, spawner_for, validate_report,
};
use crate::scribe::ScribeSpawner;

/// What a settle runs with: the scribe for the AI rung, and the resolver's
/// production spawn, each present only in a build that wires a model.
#[derive(Clone)]
pub struct SettleContext {
    pub paths: Arc<Paths>,
    pub scribe: Option<Arc<dyn ScribeSpawner>>,
    pub model: Arc<dyn Fn() -> String + Send + Sync>,
    pub production: Option<Arc<dyn JoinResolverSpawner>>,
}

impl SettleContext {
    /// The supervisor's scribe, and the production resolver when it has one —
    /// the join's own rule: a build with a scribe is a build with a model.
    pub fn from_supervisor(supervisor: &AgentSupervisor) -> Self {
        let scribe = supervisor.scribe.as_ref();
        Self {
            paths: Arc::new(Paths::from_env()),
            scribe: scribe.map(|s| s.spawner.clone()),
            model: match scribe {
                Some(s) => s.model.clone(),
                None => Arc::new(|| "sonnet".to_string()),
            },
            production: scribe.map(|_| {
                Arc::new(super::join_resolver::ClaudeJoinResolverSpawner)
                    as Arc<dyn JoinResolverSpawner>
            }),
        }
    }
}

/// How one settle ended.
#[derive(Debug, Clone, Default)]
pub struct Settled {
    /// What the pair ladder's rungs settled, and what they left.
    pub ladder: PairResolution,
    /// The resolver's verdict on what the rungs left: `None` when nothing
    /// was left for it, `Err` with the sentence when it taught nothing.
    pub resolver: Option<Result<(), String>>,
}

/// One background task per key at a time. A request for a key already running
/// is recorded as "again" rather than spawned, and the running task loops once
/// more when it ends, so a burst of requests costs at most one extra pass.
#[derive(Default)]
struct OneAtATime(Mutex<HashMap<String, bool>>);

impl OneAtATime {
    /// Whether the caller should start a task for `key`. `false` means one is
    /// running, and it has been asked to go again.
    fn admit(&self, key: &str) -> bool {
        let mut running = self.0.lock();
        if let Some(again) = running.get_mut(key) {
            *again = true;
            return false;
        }
        running.insert(key.to_string(), false);
        true
    }

    /// Called as the running task for `key` ends a pass: `true` when a request
    /// arrived meanwhile and it should pass once more, `false` when it is done
    /// and the key is released.
    fn again(&self, key: &str) -> bool {
        let mut running = self.0.lock();
        if running.get(key) == Some(&true) {
            running.insert(key.to_string(), false);
            return true;
        }
        running.remove(key);
        false
    }
}

/// The pairs settling now.
fn settling() -> &'static OneAtATime {
    static SETTLING: OnceLock<OneAtATime> = OnceLock::new();
    SETTLING.get_or_init(OneAtATime::default)
}

/// The triples composing now.
fn composing() -> &'static OneAtATime {
    static COMPOSING: OnceLock<OneAtATime> = OnceLock::new();
    COMPOSING.get_or_init(OneAtATime::default)
}

/// Two arcs in a fixed order, so a key does not depend on which one asked.
fn ordered<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b { (a, b) } else { (b, a) }
}

/// A pair settle's key: the repo and the unordered pair.
fn pair_key(repo: &Path, name: &str, sibling: &str) -> String {
    let (lo, hi) = ordered(name, sibling);
    format!("{}\n{lo}\n{hi}", repo.display())
}

/// A compose's key: the repo, the arc composed, and its unordered siblings.
fn compose_key(repo: &Path, name: &str, sib_a: &str, sib_b: &str) -> String {
    let (lo, hi) = ordered(sib_a, sib_b);
    format!("{}\n{name}\n{lo}\n{hi}", repo.display())
}

/// Settle the crossing between `name` and `sibling` on a task of its own.
pub fn settle_in_background(ctx: SettleContext, repo: PathBuf, name: String, sibling: String) {
    let key = pair_key(&repo, &name, &sibling);
    if !settling().admit(&key) {
        return;
    }
    tokio::spawn(async move {
        loop {
            match settle_once(&ctx, &repo, &name, &sibling).await {
                Ok(settled) => {
                    info!(
                        arc = %name,
                        sibling = %sibling,
                        resolved = settled.ladder.resolved.len(),
                        left = settled.ladder.unresolved.len(),
                        resolver = ?settled.resolver,
                        "crossing settled",
                    );
                    record_decline(&ctx, &repo, &name, &sibling, &settled);
                }
                Err(err) => {
                    warn!(arc = %name, sibling = %sibling, error = %err, "crossing settle failed")
                }
            }
            if !settling().again(&key) {
                break;
            }
        }
    });
}

/// Record a settle that could not teach the cache — a resolver that declined,
/// so the paths it was handed are still unresolved. [F03b]: the decline used to
/// live only in the log, where no probe reads it; this writes one arc-log line
/// a surface sees beside the crossing it belongs to. A clean settle writes
/// nothing — only a decline is news.
fn record_decline(ctx: &SettleContext, repo: &Path, name: &str, sibling: &str, settled: &Settled) {
    if !matches!(settled.resolver, Some(Err(_))) {
        return;
    }
    let reason = match &settled.resolver {
        Some(Err(reason)) => reason.as_str(),
        _ => return,
    };
    let note = format!("{sibling} · unsettled: {reason}");
    if let Err(e) = tugarc_core::log::append_arc_log(
        &ctx.paths,
        repo,
        name,
        tugarc_core::crossing::CROSSING_UNSETTLED,
        &note,
    ) {
        warn!(arc = %name, sibling = %sibling, error = %e, "recording the crossing decline failed");
    }
}

/// Compose a third arc against two siblings that cross it and each other, on a
/// task of its own. [F03d]: two pairwise settles never produce the preimage a
/// third arc's join meets once the siblings have merged, so the settle of a
/// third arc also settles it against the siblings' merged hunk, teaching that
/// preimage now. Best-effort: a compose that cannot run is logged, never fatal.
/// One compose per triple at a time, as one settle per pair: a round that asks
/// again while one runs gets one more pass when it ends, never a second scribe.
pub fn compose_in_background(
    ctx: SettleContext,
    repo: PathBuf,
    name: String,
    sib_a: String,
    sib_b: String,
) {
    let key = compose_key(&repo, &name, &sib_a, &sib_b);
    if !composing().admit(&key) {
        return;
    }
    tokio::spawn(async move {
        loop {
            compose_once(&ctx, &repo, &name, &sib_a, &sib_b).await;
            if !composing().again(&key) {
                break;
            }
        }
    });
}

/// One compose of `name` against its two siblings' merged hunk.
async fn compose_once(ctx: &SettleContext, repo: &Path, name: &str, sib_a: &str, sib_b: &str) {
    let merger = ctx.scribe.as_ref().map(|spawner| ScribeFileMerger {
        spawner: spawner.clone(),
        model: ctx.model.clone(),
        handle: tokio::runtime::Handle::current(),
        recorder: None,
    });
    let result = {
        let paths = ctx.paths.clone();
        let repo = repo.to_path_buf();
        let (name, sib_a, sib_b) = (name.to_string(), sib_a.to_string(), sib_b.to_string());
        tokio::task::spawn_blocking(move || {
            tugarc_core::crossing::settle_composed(
                &paths,
                &repo,
                &name,
                &sib_a,
                &sib_b,
                merger.as_ref().map(|m| m as &dyn FileMerger),
            )
            .map_err(|e| e.to_string())
        })
        .await
    };
    match result {
        Ok(Ok(Some(settled))) => info!(
            arc = %name,
            siblings = %format!("{sib_a}·{sib_b}"),
            resolved = settled.resolved.len(),
            left = settled.unresolved.len(),
            "crossing composed",
        ),
        Ok(Ok(None)) => {}
        Ok(Err(err)) => {
            warn!(arc = %name, siblings = %format!("{sib_a}·{sib_b}"), error = %err, "crossing compose failed")
        }
        Err(err) => {
            warn!(arc = %name, error = %err, "crossing compose task failed")
        }
    }
}

/// One settle: the pair ladder, then the resolver over whatever it left.
pub async fn settle_once(
    ctx: &SettleContext,
    repo: &Path,
    name: &str,
    sibling: &str,
) -> Result<Settled, String> {
    let merger = ctx.scribe.as_ref().map(|spawner| ScribeFileMerger {
        spawner: spawner.clone(),
        model: ctx.model.clone(),
        handle: tokio::runtime::Handle::current(),
        recorder: None,
    });
    let (pair, ladder, intent) = {
        let paths = ctx.paths.clone();
        let repo = repo.to_path_buf();
        let (name, sibling) = (name.to_string(), sibling.to_string());
        tokio::task::spawn_blocking(move || {
            let (pair, ladder) = tugarc_core::crossing::settle_crossing(
                &paths,
                &repo,
                &name,
                &sibling,
                merger.as_ref().map(|m| m as &dyn FileMerger),
            )
            .map_err(|e| e.to_string())?;
            let intent = pair.intent(&paths, &repo);
            Ok::<_, String>((pair, ladder, intent))
        })
        .await
        .map_err(|e| format!("crossing settle task: {e}"))??
    };
    if ladder.unresolved.is_empty() {
        mark_settled(repo, &pair);
        return Ok(Settled {
            ladder,
            resolver: None,
        });
    }
    let resolver = match tokio::time::timeout(
        RESOLVE_DEADLINE,
        finish_with_resolver(ctx, repo, &pair, &ladder, &intent),
    )
    .await
    {
        Ok(verdict) => verdict,
        Err(_) => Err(format!(
            "the resolver passed its {}-hour deadline",
            RESOLVE_DEADLINE.as_secs() / 3600
        )),
    };
    mark_settled(repo, &pair);
    Ok(Settled {
        ladder,
        resolver: Some(resolver),
    })
}

/// Mark the pair's conflict settled, so a later round over the same conflict
/// does not settle it again. Only a settle that ran to its end marks; one that
/// errored, or was lost with the process, leaves the conflict due.
fn mark_settled(repo: &Path, pair: &tugarc_core::crossing::CrossingPair) {
    if let Err(e) = tugarc_core::crossing::mark_settled(repo, pair) {
        warn!(first = %pair.first, second = %pair.second, error = %e, "marking the crossing settled failed");
    }
}

/// Hand the paths the rungs left to the resolver in a checkout of the pair's
/// merge, and teach the cache what it finishes.
async fn finish_with_resolver(
    ctx: &SettleContext,
    repo: &Path,
    pair: &tugarc_core::crossing::CrossingPair,
    ladder: &PairResolution,
    intent: &str,
) -> Result<(), String> {
    let (spawner, checkout) = {
        let repo = repo.to_path_buf();
        let production = ctx.production.clone();
        let (first, second) = (pair.first_tip.clone(), pair.second_tip.clone());
        let ladder = ladder.clone();
        tokio::task::spawn_blocking(move || {
            let spawner = spawner_for(&repo, production)?;
            let checkout = PairCheckout::open(&repo, &first, &second, &ladder)
                .map_err(|e| format!("could not open the crossing's checkout: {e}"))?;
            Ok::<_, String>((spawner, checkout))
        })
        .await
        .map_err(|e| format!("crossing checkout task: {e}"))??
    };
    let checkout = Arc::new(checkout);
    let verdict = resolve_in(ctx, repo, pair, ladder, intent, spawner.as_ref(), &checkout).await;
    // The checkout removes its worktree on drop, which runs git.
    let _ = tokio::task::spawn_blocking(move || drop(checkout)).await;
    verdict
}

async fn resolve_in(
    ctx: &SettleContext,
    repo: &Path,
    pair: &tugarc_core::crossing::CrossingPair,
    ladder: &PairResolution,
    intent: &str,
    spawner: &dyn JoinResolverSpawner,
    checkout: &Arc<PairCheckout>,
) -> Result<(), String> {
    let mut run = ResolverRun::open(spawner, checkout.path(), (ctx.model)())?;
    let rung_resolved: Vec<(String, ResolvedBy)> = ladder.resolved.clone();
    let charter = compose_charter(&CharterInputs {
        intent,
        base_branch: &format!("tugarc/{}", pair.first),
        unresolved: &ladder.unresolved,
        rung_resolved: &rung_resolved,
    });
    let report = match run.send(charter, None).await? {
        ResolverTurn::Report(report) => report,
        ResolverTurn::Ask(ask) => {
            return Err(format!(
                "the resolver asked \"{}\", and a crossing has nobody to answer; the join will meet it",
                ask.question
            ));
        }
    };
    let resolution_set: Vec<String> = ladder
        .unresolved
        .iter()
        .cloned()
        .chain(rung_resolved.iter().map(|(path, _)| path.clone()))
        .collect();
    validate_report(&report, &resolution_set, &[])?;

    // Only the files the resolver finished are taught: a machine resolution
    // it redid is already in the cache under the same preimage, and rerere
    // keeps the first answer it recorded.
    let repo = repo.to_path_buf();
    let checkout = checkout.clone();
    let finished = ladder.unresolved.clone();
    tokio::task::spawn_blocking(move || checkout.teach(&repo, &finished))
        .await
        .map_err(|e| format!("crossing teach task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcore::test_fixtures::git::{GitFixture, git};

    fn ten_with_line_five(to: &str) -> String {
        (1..=10)
            .map(|i| {
                if i == 5 {
                    format!("{to}\n")
                } else {
                    format!("line {i}\n")
                }
            })
            .collect()
    }

    /// `main` with a ten-line `f.txt`, and two arcs that each rewrite its
    /// fifth line, so no text rung settles their merge.
    fn conflicting_arcs(root: &Path) {
        GitFixture::init(root);
        std::fs::write(root.join("f.txt"), ten_with_line_five("line 5")).unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-m", "base"]);
        for arc in ["a", "b"] {
            git(root, &["branch", &format!("tugarc/{arc}")]);
            git(
                root,
                &["config", &format!("branch.tugarc/{arc}.tugbase"), "main"],
            );
            git(root, &["switch", "-q", &format!("tugarc/{arc}")]);
            std::fs::write(
                root.join("f.txt"),
                ten_with_line_five(&format!("{arc} five")),
            )
            .unwrap();
            git(root, &["commit", "-qam", &format!("{arc} round")]);
            git(root, &["switch", "-q", "main"]);
        }
    }

    /// A resolver stub that writes `kept` over the checkout's `f.txt` and
    /// reports it finished.
    fn stub_resolver(root: &Path, kept: &str) {
        let answer = root.join(".git").join("kept.txt");
        std::fs::write(&answer, kept).unwrap();
        let stub = root.join(".git").join("stub-resolver.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\nread -r _charter\ncp '{}' \"$1/f.txt\"\nprintf '%s\\n' '{{\"files\":[{{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"both rewrote line five\",\"reconciliation\":\"kept both\"}}],\"notes\":\"\"}}'\n",
                answer.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(
            root,
            &["config", "tugarc.joinresolver", &stub.to_string_lossy()],
        );
    }

    fn context(state: &Path) -> SettleContext {
        SettleContext {
            paths: Arc::new(Paths::under(state)),
            scribe: None,
            model: Arc::new(|| "haiku".to_string()),
            production: None,
        }
    }

    /// One task per key: a second request while one runs is recorded rather
    /// than started, buys exactly one more pass, and the key is free again
    /// once the task ends. The pair settle and the composed settle both run
    /// under this.
    #[test]
    fn a_key_runs_one_at_a_time_and_a_second_request_buys_one_more_pass() {
        let guard = OneAtATime::default();
        assert!(guard.admit("k"), "the first request starts a task");
        assert!(
            !guard.admit("k"),
            "a second request while it runs starts none"
        );
        assert!(!guard.admit("k"), "nor does a third");
        assert!(guard.admit("other"), "another key is not held up");
        assert!(guard.again("k"), "the requests meanwhile buy one more pass");
        assert!(!guard.again("k"), "and only one");
        assert!(guard.admit("k"), "an ended task frees its key");
    }

    /// A compose is keyed on the repo, the arc and both siblings, the siblings
    /// in either order; a pair settle on the unordered pair.
    #[test]
    fn a_compose_is_keyed_on_the_triple_with_its_siblings_unordered() {
        let repo = Path::new("/r");
        assert_eq!(
            compose_key(repo, "c", "a", "b"),
            compose_key(repo, "c", "b", "a")
        );
        assert_ne!(
            compose_key(repo, "c", "a", "b"),
            compose_key(repo, "a", "c", "b")
        );
        assert_ne!(
            compose_key(repo, "c", "a", "b"),
            compose_key(Path::new("/s"), "c", "a", "b")
        );
        assert_eq!(pair_key(repo, "a", "b"), pair_key(repo, "b", "a"));
    }

    /// No rung settles the crossing, so the resolver does, and its finished
    /// file is what the second arc's join replays through rung 2.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_resolver_settles_what_the_rungs_leave() {
        let state = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        conflicting_arcs(&root);
        let kept = ten_with_line_five("a five\nb five");
        stub_resolver(&root, &kept);
        let ctx = context(state.path());

        let settled = settle_once(&ctx, &root, "a", "b").await.unwrap();
        assert_eq!(settled.ladder.unresolved, vec!["f.txt".to_string()]);
        assert_eq!(settled.resolver, Some(Ok(())));

        git(&root, &["merge", "-q", "--ff-only", "tugarc/a"]);
        git(&root, &["branch", "-D", "tugarc/a"]);
        let joined = tokio::task::spawn_blocking({
            let root = root.clone();
            let paths = ctx.paths.clone();
            move || tugarc_core::resolve_conflicts(&paths, &root, "b", None).unwrap()
        })
        .await
        .unwrap();
        assert_eq!(joined.resolved.len(), 1);
        assert_eq!(joined.resolved[0].resolved_by, ResolvedBy::Rerere);
    }

    /// [F03b] A settle the resolver declined is recorded on the arc log, where
    /// a probe reads it — not left in the process log alone.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_declined_settle_is_recorded_on_the_arc_log() {
        let state = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        conflicting_arcs(&root);
        // A finish that rewrites clean text teaches nothing, so the settle
        // declines and the resolver's verdict is an error.
        stub_resolver(
            &root,
            &ten_with_line_five("a five\nb five").replace("line 1\n", "LINE 1\n"),
        );
        let ctx = context(state.path());
        let settled = settle_once(&ctx, &root, "a", "b").await.unwrap();
        assert!(matches!(settled.resolver, Some(Err(_))), "{settled:?}");

        record_decline(&ctx, &root, "a", "b", &settled);
        let log = std::fs::read_to_string(tugtool_core::paths::arc_log_path_at(&ctx.paths, &root))
            .unwrap_or_default();
        assert!(log.contains("crossing-unsettled"), "no decline line: {log}");
        assert!(log.contains("b · unsettled"), "{log}");

        // A clean settle records nothing — only a decline is news.
        let state2 = tempfile::tempdir().unwrap();
        let dir2 = tempfile::tempdir().unwrap();
        let root2 = dir2.path().canonicalize().unwrap();
        conflicting_arcs(&root2);
        stub_resolver(&root2, &ten_with_line_five("a five\nb five"));
        let ctx2 = context(state2.path());
        let clean = settle_once(&ctx2, &root2, "a", "b").await.unwrap();
        assert_eq!(clean.resolver, Some(Ok(())));
        record_decline(&ctx2, &root2, "a", "b", &clean);
        let log2 =
            std::fs::read_to_string(tugtool_core::paths::arc_log_path_at(&ctx2.paths, &root2))
                .unwrap_or_default();
        assert!(
            !log2.contains("crossing-unsettled"),
            "clean settle logged: {log2}"
        );
    }

    /// A resolver whose finish rewrites text git merged by itself teaches
    /// nothing, and says so.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resolver_finish_that_rewrites_clean_text_teaches_nothing() {
        let state = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        conflicting_arcs(&root);
        stub_resolver(
            &root,
            &ten_with_line_five("a five\nb five").replace("line 1\n", "LINE 1\n"),
        );

        let settled = settle_once(&context(state.path()), &root, "a", "b")
            .await
            .unwrap();
        let refused = settled.resolver.unwrap().unwrap_err();
        assert!(
            refused.contains("outside the conflicts in f.txt"),
            "{refused}"
        );
    }
}
