python3 - <<'PY'
import pathlib, re
p = pathlib.Path("crates/tugcast/src/feeds/session_overview.rs")
s = p.read_text()
marker = "mod tests {"
i = s.index(marker) + len(marker)
helper = """

    /// The register normalizer's text alone. Every production path wants the
    /// report; these tests are about the string it produces.
    fn headline_register(raw: &str) -> String {
        headline_register_report(raw).text
    }
"""
p.write_text(s[:i] + helper + s[i:])
print("added test helper")
PY
