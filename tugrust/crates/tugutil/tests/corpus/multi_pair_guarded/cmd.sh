python3 - <<'EOF'
import pathlib
p = pathlib.Path("tugrust/crates/tugcast/src/feeds/session_overview.rs")
s = p.read_text()
subs = [
 ('let mut h = start(Some("Building the workspace."), true, true, true);', 'let mut h = start(Some("Harden the watch loop."), true, true, true);'),
 ('assert_eq!(overview["text"], "Building the workspace");', 'assert_eq!(overview["text"], "Harden the watch loop");'),
 ('start_cadenced(Some("Running commands."), true, true, true, cadence)', 'start_cadenced(Some("Harden the watch loop."), true, true, true, cadence)'),
 ('let mut h = start(Some("Building again."), true, true, true);', 'let mut h = start(Some("Harden the watch loop."), true, true, true);'),
]
for a,b in subs:
    assert s.count(a) == 1, (a, s.count(a))
    s = s.replace(a,b)
p.write_text(s)
print("ok")
EOF