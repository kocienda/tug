python3 - <<'PY'
p="tugrust/crates/tugdash-core/src/ops.rs"
s=open(p).read()
s=s.replace("""    if !intersect.is_empty() {
        let plan_rel = dash_plan_path(&repo_root, name);
        return Err(if intersect.tracked.is_empty() {
            untracked_overwrite_detail(&intersect.untracked, plan_rel.as_deref(), name)
        } else {
            base_dirt_detail(&intersect.tracked, plan_rel.as_deref(), name)
        });
    }""","""    if !intersect.is_empty() {
        return Err(if intersect.tracked.is_empty() {
            untracked_overwrite_detail(&intersect.untracked)
        } else {
            base_dirt_detail(&intersect.tracked)
        });
    }""")
open(p,"w").write(s)
PY
