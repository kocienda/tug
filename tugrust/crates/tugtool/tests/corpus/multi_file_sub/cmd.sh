sed 's/\.list_exchanges(\("[a-z0-9]*"\))/.list_exchanges_since(\1, None)/g' tugrust/crates/tugcast/src/shell_ledger.rs > shell_ledger.new && mv shell_ledger.new tugrust/crates/tugcast/src/shell_ledger.rs
sed 's/\.list_exchanges(\("[a-z0-9]*"\))/.list_exchanges_since(\1, None)/g' tugrust/crates/tugcast/src/feeds/shell.rs > shell.new && mv shell.new tugrust/crates/tugcast/src/feeds/shell.rs
