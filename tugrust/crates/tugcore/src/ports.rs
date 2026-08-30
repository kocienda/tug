//! Per-instance TCP port allocation.
//!
//! Tugcast and Vite derive their default listening port from the
//! per-instance identifier: `BASE + (fnv1a32(id) mod WINDOW)`. The
//! result is deterministic across launches of the same identity,
//! which is friendly for muscle-memory ("port 553XX is the dev
//! instance") and for log-tail commands keyed on a fixed address.
//!
//! On collision (the derived port is held by some other process) the
//! caller walks forward by +1 within the window for up to 32 attempts
//! before falling back to OS-ephemeral (`0`) — recorded in the
//! registry like any other port.
//!
//! Tugcast window: 55300–55399 (`tugcast_port_default`).
//! Vite window:    55200–55299 (`vite_port_default`).
//!
//! See [D08] in `dash/tug-multi-instance.md` for the design.

/// Tugcast HTTP listener window. Inclusive at the base, exclusive at
/// the top: 55300 ≤ port < 55400.
pub const TUGCAST_PORT_BASE: u16 = 55300;
pub const TUGCAST_PORT_WINDOW: u16 = 100;

/// Vite dev-server window. Inclusive at the base, exclusive at the
/// top: 55200 ≤ port < 55300.
pub const VITE_PORT_BASE: u16 = 55200;
pub const VITE_PORT_WINDOW: u16 = 100;

/// Dedicated tugcast window for app-test instances: 55400 ≤ port < 55500.
///
/// App-test instances (`apptest-<uuid>`) draw from a separate window so
/// their ports can NEVER overlap an interactive dev/release instance's
/// — a running `just app-debug` and an `app-test` sweep are guaranteed
/// disjoint, even on an FNV hash collision. See [`window_for`].
pub const APPTEST_TUGCAST_PORT_BASE: u16 = 55400;
pub const APPTEST_TUGCAST_PORT_WINDOW: u16 = 100;

/// Dedicated Vite window for app-test instances: 55500 ≤ port < 55600.
pub const APPTEST_VITE_PORT_BASE: u16 = 55500;
pub const APPTEST_VITE_PORT_WINDOW: u16 = 100;

/// Instance-ID prefix marking an app-test instance. Kept in sync with
/// the harness (`tests/app-test/_harness/index.ts` mints `apptest-<uuid>`)
/// and `InstanceConfig` on the Swift side.
pub const APPTEST_ID_PREFIX: &str = "apptest-";

/// Well-known port for the `apptest` invocation gate
/// (`tugtool host gate run --name apptest`). One fixed port OUTSIDE every
/// hashed window: holding a listener on it is the machine-wide mutex
/// that serializes whole `just app-test` invocations — native CGEvent
/// input and app activation are login-session singletons, so only one
/// app-test run may drive them at a time. The kernel frees the port on
/// any holder death (including SIGKILL); there is no lock file. See
/// `tuglaws/app-test-harness.md`.
pub const APPTEST_GATE_PORT: u16 = 55600;

/// Resolve a gate name to its reserved well-known port. Gates are
/// enumerated here (never hashed) so nothing can collide with the
/// windowed allocations above.
pub fn gate_port(name: &str) -> Option<u16> {
    match name {
        "apptest" => Some(APPTEST_GATE_PORT),
        _ => None,
    }
}

/// True when `instance_id` belongs to the app-test family and should
/// draw ports from the dedicated app-test windows.
pub fn is_apptest_id(instance_id: &str) -> bool {
    instance_id.starts_with(APPTEST_ID_PREFIX)
}

/// Maximum number of +1 walk attempts before falling back to ephemeral.
pub const MAX_WALK_ATTEMPTS: u16 = 32;

/// FNV-1a 32-bit hash of `input`. Stable, dependency-free,
/// non-cryptographic — adequate for our "spread instance IDs evenly
/// across a 100-port window" use case.
pub fn fnv1a_32(input: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in input {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Derive the deterministic default port for `instance_id` within
/// `[base, base + window)`.
///
/// `window` must be > 0 and `base + window` must fit in a `u16` —
/// inputs outside that range are clamped via wrapping arithmetic, so
/// pathological inputs yield a valid port rather than a panic.
pub fn derive_port(instance_id: &str, base: u16, window: u16) -> u16 {
    let window = window.max(1);
    let offset = (fnv1a_32(instance_id.as_bytes()) % u32::from(window)) as u16;
    base.wrapping_add(offset)
}

/// The `(base, window)` tugcast port range for `instance_id` — the
/// dedicated app-test window for `apptest-*` IDs, the shared dev/release
/// window otherwise.
pub fn tugcast_window_for(instance_id: &str) -> (u16, u16) {
    if is_apptest_id(instance_id) {
        (APPTEST_TUGCAST_PORT_BASE, APPTEST_TUGCAST_PORT_WINDOW)
    } else {
        (TUGCAST_PORT_BASE, TUGCAST_PORT_WINDOW)
    }
}

/// The `(base, window)` Vite port range for `instance_id`.
pub fn vite_window_for(instance_id: &str) -> (u16, u16) {
    if is_apptest_id(instance_id) {
        (APPTEST_VITE_PORT_BASE, APPTEST_VITE_PORT_WINDOW)
    } else {
        (VITE_PORT_BASE, VITE_PORT_WINDOW)
    }
}

/// Tugcast default port for `instance_id` (window chosen by ID family).
pub fn tugcast_port_default(instance_id: &str) -> u16 {
    let (base, window) = tugcast_window_for(instance_id);
    derive_port(instance_id, base, window)
}

/// Vite default port for `instance_id` (window chosen by ID family).
pub fn vite_port_default(instance_id: &str) -> u16 {
    let (base, window) = vite_window_for(instance_id);
    derive_port(instance_id, base, window)
}

/// Outcome of [`allocate_port`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllocatedPort {
    /// A port within `[base, base + window)` was found. Carries the
    /// number of +1 steps from the derived default — `0` means no
    /// collision.
    Window { port: u16, walk_offset: u16 },
    /// The whole window was exhausted; caller should fall back to
    /// OS-ephemeral (`bind` to 0). Tugcast records the actually-bound
    /// port in the registry regardless of which branch fires.
    EphemeralFallback,
}

/// Try to claim a port for `instance_id` from `[base, base + window)`
/// by hashing then walking forward on collision.
///
/// The caller supplies `is_free`, a predicate that should return
/// `true` iff a `bind` on the port would succeed right now. The walk
/// stops after [`MAX_WALK_ATTEMPTS`] tries (or after exhausting the
/// window, whichever is smaller) — at which point the caller falls
/// back to OS-ephemeral.
pub fn allocate_port<F>(instance_id: &str, base: u16, window: u16, mut is_free: F) -> AllocatedPort
where
    F: FnMut(u16) -> bool,
{
    let window = window.max(1);
    let start_offset = (fnv1a_32(instance_id.as_bytes()) % u32::from(window)) as u16;
    let max_steps = MAX_WALK_ATTEMPTS.min(window);

    for step in 0..max_steps {
        let offset = (start_offset + step) % window;
        let port = base + offset;
        if is_free(port) {
            return AllocatedPort::Window {
                port,
                walk_offset: step,
            };
        }
    }
    AllocatedPort::EphemeralFallback
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_32_known_vectors() {
        // Known FNV-1a 32-bit vectors from the canonical reference.
        assert_eq!(fnv1a_32(b""), 0x811c_9dc5);
        assert_eq!(fnv1a_32(b"a"), 0xe40c_292c);
        assert_eq!(fnv1a_32(b"foobar"), 0xbf9c_f968);
    }

    #[test]
    fn derive_port_is_deterministic() {
        let a = derive_port("debug-foo", 55300, 100);
        let b = derive_port("debug-foo", 55300, 100);
        assert_eq!(a, b);
    }

    #[test]
    fn derive_port_is_within_window() {
        for id in [
            "release-main",
            "debug-main",
            "debug-dev-wake-1",
            "release-detached-deadbeef",
        ] {
            let p = derive_port(id, 55300, 100);
            assert!((55300..55400).contains(&p), "{id} → {p} out of range");
        }
    }

    #[test]
    fn derive_port_spreads_inputs() {
        // No two of these should collide given the 100-port window
        // unless we are uniquely unlucky.
        let ports: Vec<_> = [
            "release-main",
            "debug-main",
            "debug-foo",
            "debug-bar",
            "debug-baz",
        ]
        .iter()
        .map(|id| derive_port(id, 55300, 100))
        .collect();
        let mut sorted = ports.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ports.len(), "ports collided: {ports:?}");
    }

    #[test]
    fn tugcast_and_vite_defaults_are_in_their_windows() {
        let tc = tugcast_port_default("debug-foo");
        let v = vite_port_default("debug-foo");
        assert!((TUGCAST_PORT_BASE..TUGCAST_PORT_BASE + TUGCAST_PORT_WINDOW).contains(&tc));
        assert!((VITE_PORT_BASE..VITE_PORT_BASE + VITE_PORT_WINDOW).contains(&v));
    }

    #[test]
    fn apptest_ids_draw_from_the_dedicated_windows() {
        let id = "apptest-27b5400c-7d5e-4a9a-99a0-4f787deb6d80";
        assert!(is_apptest_id(id));
        let tc = tugcast_port_default(id);
        let v = vite_port_default(id);
        assert!(
            (APPTEST_TUGCAST_PORT_BASE..APPTEST_TUGCAST_PORT_BASE + APPTEST_TUGCAST_PORT_WINDOW)
                .contains(&tc),
            "{id} → tugcast {tc} not in app-test window"
        );
        assert!(
            (APPTEST_VITE_PORT_BASE..APPTEST_VITE_PORT_BASE + APPTEST_VITE_PORT_WINDOW)
                .contains(&v)
        );
    }

    #[test]
    fn apptest_and_dev_windows_never_overlap() {
        // The structural guarantee: an app-test sweep and a live
        // dev/release instance can never land on the same port.
        let dev_lo = TUGCAST_PORT_BASE;
        let dev_hi = TUGCAST_PORT_BASE + TUGCAST_PORT_WINDOW; // exclusive
        let at_lo = APPTEST_TUGCAST_PORT_BASE;
        let at_hi = APPTEST_TUGCAST_PORT_BASE + APPTEST_TUGCAST_PORT_WINDOW;
        assert!(
            dev_hi <= at_lo || at_hi <= dev_lo,
            "tugcast windows overlap"
        );
        let vdev_hi = VITE_PORT_BASE + VITE_PORT_WINDOW;
        let vat_lo = APPTEST_VITE_PORT_BASE;
        assert!(vdev_hi <= vat_lo, "vite windows overlap");
        assert!(!is_apptest_id("debug-main"));
        assert!(!is_apptest_id("release-main"));
    }

    #[test]
    fn allocate_port_returns_derived_when_free() {
        let id = "debug-foo";
        let want = derive_port(id, 55300, 100);
        let alloc = allocate_port(id, 55300, 100, |_| true);
        assert_eq!(
            alloc,
            AllocatedPort::Window {
                port: want,
                walk_offset: 0
            }
        );
    }

    #[test]
    fn allocate_port_walks_past_held_port() {
        let id = "debug-foo";
        let derived = derive_port(id, 55300, 100);
        let alloc = allocate_port(id, 55300, 100, |p| p != derived);
        match alloc {
            AllocatedPort::Window { port, walk_offset } => {
                assert_ne!(port, derived);
                assert_eq!(walk_offset, 1);
                assert!((55300..55400).contains(&port));
            }
            other => panic!("expected Window, got {other:?}"),
        }
    }

    #[test]
    fn allocate_port_falls_back_when_window_full() {
        let alloc = allocate_port("debug-foo", 55300, 100, |_| false);
        assert_eq!(alloc, AllocatedPort::EphemeralFallback);
    }

    #[test]
    fn allocate_port_wraps_within_window() {
        // Use a window narrower than MAX_WALK_ATTEMPTS so a single
        // full walk is guaranteed to visit every port. With four
        // ports total and only one accepted, the walker MUST wrap to
        // reach it from any starting offset.
        let id = "debug-wrap";
        let base: u16 = 9000;
        let window: u16 = 4;
        let target: u16 = 9000;
        let alloc = allocate_port(id, base, window, |p| p == target);
        match alloc {
            AllocatedPort::Window { port, .. } => assert_eq!(port, target),
            other => panic!("expected wrap, got {other:?}"),
        }
    }
}
