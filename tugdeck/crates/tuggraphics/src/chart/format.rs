//! Value formats.
//!
//! Every number a chart writes as text goes through here. The arithmetic
//! is integer-based on values rounded with `f64::round`, which IEEE 754
//! defines exactly, so the WASM build and a native build resolved from a
//! different lockfile write the same strings; `f64`'s `Display` and
//! `serde_json`'s number printing are never used.

/// A value format. `auto` is the default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// Integers as [`Format::Int`]; anything else with at most two
    /// decimals, or two significant digits below 1.
    Auto,
    /// Rounded to an integer, with `,` thousands separators.
    Int,
    /// Fixed one decimal.
    Decimal,
    /// The value × 100, no decimals, then `%`.
    Percent,
    /// A duration in seconds: `850ms`, `12.3s`, `4m05s`, `1h02m`.
    Secs,
    /// A size in bytes, 1024 to the step: `512B`, `1.2KB`, `3.4MB`.
    Bytes,
    /// A count, 1000 to the step: `950`, `1.2k`, `3.4M`.
    Count,
}

impl Format {
    pub const NAMES: [&'static str; 7] = [
        "auto", "int", "decimal", "percent", "secs", "bytes", "count",
    ];

    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "auto" => Some(Format::Auto),
            "int" => Some(Format::Int),
            "decimal" => Some(Format::Decimal),
            "percent" => Some(Format::Percent),
            "secs" => Some(Format::Secs),
            "bytes" => Some(Format::Bytes),
            "count" => Some(Format::Count),
            _ => None,
        }
    }

    pub fn apply(self, v: f64) -> String {
        if v < 0.0 {
            let s = self.apply(-v);
            // A value that rounds to zero carries no sign.
            if s.bytes().any(|b| b.is_ascii_digit() && b != b'0') {
                return format!("-{s}");
            }
            return s;
        }
        match self {
            Format::Auto => auto(v),
            Format::Int => group(v.round() as u64),
            Format::Decimal => scaled(v, 1, true),
            Format::Percent => format!("{}%", group((v * 100.0).round() as u64)),
            Format::Secs => secs(v),
            Format::Bytes => units(v, 1024.0, "B", &["KB", "MB", "GB", "TB", "PB"]),
            Format::Count => {
                if v.round() < 1000.0 {
                    auto(v)
                } else {
                    units(v, 1000.0, "", &["k", "M", "B", "T"])
                }
            }
        }
    }
}

/// `n` with `,` between each group of three digits.
fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A non-negative `v` with `places` decimals, its integer part grouped.
/// `keep_zeros` writes every decimal; otherwise trailing zeros, and a
/// bare point, are dropped.
fn scaled(v: f64, places: u32, keep_zeros: bool) -> String {
    let scale = 10u64.pow(places);
    let n = (v * scale as f64).round() as u64;
    let (int, frac) = (n / scale, n % scale);
    let mut s = group(int);
    let mut digits = format!("{frac:0width$}", width = places as usize);
    if !keep_zeros {
        while digits.ends_with('0') {
            digits.pop();
        }
    }
    if !digits.is_empty() {
        s.push('.');
        s.push_str(&digits);
    }
    s
}

/// The `auto` rule for a non-negative value: an integer is grouped; a value
/// of 1 or more keeps at most two decimals; a smaller one keeps two
/// significant digits, down to twelve decimal places, below which it is 0.
fn auto(v: f64) -> String {
    if v.fract() == 0.0 {
        return group(v as u64);
    }
    if v >= 1.0 {
        return scaled(v, 2, false);
    }
    // Find the decimal place of the first significant digit by repeated
    // multiplication, which is exact enough and identical everywhere.
    let mut places = 1u32;
    let mut probe = v * 10.0;
    while probe < 1.0 && places < 12 {
        probe *= 10.0;
        places += 1;
    }
    scaled(v, (places + 1).min(12), false)
}

/// A duration in seconds, non-negative. Zero is `0s`, the spelling an
/// axis's first tick wants.
fn secs(v: f64) -> String {
    let ms = (v * 1000.0).round() as u64;
    if ms == 0 {
        return "0s".into();
    }
    if ms < 1000 {
        return format!("{ms}ms");
    }
    let tenths = (v * 10.0).round() as u64;
    if tenths < 600 {
        return if tenths.is_multiple_of(10) {
            format!("{}s", tenths / 10)
        } else {
            format!("{}.{}s", tenths / 10, tenths % 10)
        };
    }
    let s = v.round() as u64;
    if s < 3600 {
        return format!("{}m{:02}s", s / 60, s % 60);
    }
    let m = (v / 60.0).round() as u64;
    format!("{}h{:02}m", group(m / 60), m % 60)
}

/// A non-negative value in steps of `base`: below one step it is an
/// integer with `unit` appended, above it one decimal (dropped when zero)
/// and the step's suffix, moving up a step when rounding reaches the next.
fn units(v: f64, base: f64, unit: &str, suffixes: &[&str]) -> String {
    if v.round() < base {
        return format!("{}{unit}", v.round() as u64);
    }
    let mut x = v;
    let mut k = 0;
    while k < suffixes.len() && (x / base * 10.0).round() >= 10.0 {
        x /= base;
        k += 1;
        if (x * 10.0).round() < base * 10.0 {
            break;
        }
    }
    let tenths = (x * 10.0).round() as u64;
    let s = if tenths.is_multiple_of(10) {
        group(tenths / 10)
    } else {
        format!("{}.{}", group(tenths / 10), tenths % 10)
    };
    format!("{s}{}", suffixes[k - 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(fmt: &str, v: f64) -> String {
        Format::parse(fmt).unwrap().apply(v)
    }

    #[test]
    fn names_round_trip() {
        for name in Format::NAMES {
            assert!(Format::parse(name).is_some(), "{name}");
        }
        assert_eq!(Format::parse("money"), None);
    }

    #[test]
    fn auto() {
        assert_eq!(f("auto", 0.0), "0");
        assert_eq!(f("auto", -0.0), "0");
        assert_eq!(f("auto", 7.0), "7");
        assert_eq!(f("auto", 1234.0), "1,234");
        assert_eq!(f("auto", 12.345), "12.35");
        assert_eq!(f("auto", 12.5), "12.5");
        assert_eq!(f("auto", 1234.5), "1,234.5");
        assert_eq!(f("auto", 0.5), "0.5");
        assert_eq!(f("auto", 0.01234), "0.012");
        assert_eq!(f("auto", 0.005), "0.005");
        assert_eq!(f("auto", 1e9), "1,000,000,000");
        assert_eq!(f("auto", -3.25), "-3.25");
        assert_eq!(f("auto", -1234.0), "-1,234");
        assert_eq!(f("auto", 1e-15), "0");
    }

    #[test]
    fn int() {
        assert_eq!(f("int", 0.0), "0");
        assert_eq!(f("int", 950.0), "950");
        assert_eq!(f("int", 1234567.0), "1,234,567");
        assert_eq!(f("int", 2.5), "3");
        assert_eq!(f("int", 0.005), "0");
        assert_eq!(f("int", -0.4), "0");
        assert_eq!(f("int", -1500.0), "-1,500");
        assert_eq!(f("int", 1e9), "1,000,000,000");
    }

    #[test]
    fn decimal() {
        assert_eq!(f("decimal", 0.0), "0.0");
        assert_eq!(f("decimal", 3.0), "3.0");
        assert_eq!(f("decimal", 4.26), "4.3");
        assert_eq!(f("decimal", 0.005), "0.0");
        assert_eq!(f("decimal", -2.25), "-2.3");
        assert_eq!(f("decimal", -0.01), "0.0");
        assert_eq!(f("decimal", 1e9), "1,000,000,000.0");
    }

    #[test]
    fn percent() {
        assert_eq!(f("percent", 0.0), "0%");
        assert_eq!(f("percent", 0.42), "42%");
        assert_eq!(f("percent", 1.0), "100%");
        assert_eq!(f("percent", 0.005), "1%");
        assert_eq!(f("percent", -0.125), "-13%");
        assert_eq!(f("percent", 1e9), "100,000,000,000%");
    }

    #[test]
    fn secs() {
        assert_eq!(f("secs", 0.85), "850ms");
        assert_eq!(f("secs", 12.3), "12.3s");
        assert_eq!(f("secs", 245.0), "4m05s");
        assert_eq!(f("secs", 3720.0), "1h02m");
        assert_eq!(f("secs", 0.0), "0s");
        assert_eq!(f("secs", 0.0004), "0s");
        assert_eq!(f("secs", 0.005), "5ms");
        assert_eq!(f("secs", 0.9996), "1s");
        assert_eq!(f("secs", 5.0), "5s");
        assert_eq!(f("secs", 59.96), "1m00s");
        assert_eq!(f("secs", 3599.6), "1h00m");
        assert_eq!(f("secs", -12.3), "-12.3s");
        assert_eq!(f("secs", 1e9), "277,777h47m");
    }

    #[test]
    fn bytes() {
        assert_eq!(f("bytes", 512.0), "512B");
        assert_eq!(f("bytes", 1228.8), "1.2KB");
        assert_eq!(f("bytes", 3.4 * 1024.0 * 1024.0), "3.4MB");
        assert_eq!(f("bytes", 0.0), "0B");
        assert_eq!(f("bytes", 0.005), "0B");
        assert_eq!(f("bytes", 1024.0), "1KB");
        assert_eq!(f("bytes", 1023.99 * 1024.0), "1MB");
        assert_eq!(f("bytes", -2048.0), "-2KB");
        assert_eq!(f("bytes", 1e9), "953.7MB");
    }

    #[test]
    fn count() {
        assert_eq!(f("count", 950.0), "950");
        assert_eq!(f("count", 1200.0), "1.2k");
        assert_eq!(f("count", 3.4e6), "3.4M");
        assert_eq!(f("count", 0.0), "0");
        assert_eq!(f("count", 0.005), "0.005");
        assert_eq!(f("count", 999.96), "1k");
        assert_eq!(f("count", 999_960.0), "1M");
        assert_eq!(f("count", -1500.0), "-1.5k");
        assert_eq!(f("count", 1e9), "1B");
    }
}
