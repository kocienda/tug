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

/// The pairs settling now, each with whether a round asked for another pass.
fn settling() -> &'static Mutex<HashMap<String, bool>> {
    static SETTLING: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    SETTLING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Settle the crossing between `name` and `sibling` on a task of its own.
pub fn settle_in_background(ctx: SettleContext, repo: PathBuf, name: String, sibling: String) {
    let (lo, hi) = if name <= sibling {
        (&name, &sibling)
    } else {
        (&sibling, &name)
    };
    let key = format!("{}\n{lo}\n{hi}", repo.display());
    {
        let mut pairs = settling().lock();
        if let Some(again) = pairs.get_mut(&key) {
            *again = true;
            return;
        }
        pairs.insert(key.clone(), false);
    }
    tokio::spawn(async move {
        loop {
            match settle_once(&ctx, &repo, &name, &sibling).await {
                Ok(settled) => info!(
                    arc = %name,
                    sibling = %sibling,
                    resolved = settled.ladder.resolved.len(),
                    left = settled.ladder.unresolved.len(),
                    resolver = ?settled.resolver,
                    "crossing settled",
                ),
                Err(err) => {
                    warn!(arc = %name, sibling = %sibling, error = %err, "crossing settle failed")
                }
            }
            let mut pairs = settling().lock();
            if pairs.get(&key) == Some(&true) {
                pairs.insert(key.clone(), false);
                continue;
            }
            pairs.remove(&key);
            break;
        }
    });
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
    Ok(Settled {
        ladder,
        resolver: Some(resolver),
    })
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
