//! The one number formatter for output, and exact trigonometry at the
//! right angles.

/// Formats `v` rounded to two decimals with trailing zeros stripped:
/// `12`, `12.5`, `12.25`, `-0.5`. Negative zero is `0`. Built from integer
/// arithmetic so the bytes cannot depend on a float printer.
pub(crate) fn fmt_num(v: f64) -> String {
    let mut n = (v * 100.0).round() as i64;
    let neg = n < 0;
    if neg {
        n = -n;
    }
    let (int, frac) = (n / 100, n % 100);
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    s.push_str(&int.to_string());
    if frac != 0 {
        s.push('.');
        if frac % 10 == 0 {
            s.push_str(&(frac / 10).to_string());
        } else {
            s.push_str(&format!("{frac:02}"));
        }
    }
    s
}

/// `(cos, sin)` of an angle in degrees, exact at every multiple of 90 so a
/// turtle walking a square lands on its own start.
pub(crate) fn cos_sin_deg(deg: f64) -> (f64, f64) {
    let a = deg.rem_euclid(360.0);
    if a == 0.0 {
        (1.0, 0.0)
    } else if a == 90.0 {
        (0.0, 1.0)
    } else if a == 180.0 {
        (-1.0, 0.0)
    } else if a == 270.0 {
        (0.0, -1.0)
    } else {
        let r = a.to_radians();
        (r.cos(), r.sin())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_two_decimals_stripped() {
        assert_eq!(fmt_num(12.0), "12");
        assert_eq!(fmt_num(12.5), "12.5");
        assert_eq!(fmt_num(12.25), "12.25");
        assert_eq!(fmt_num(0.05), "0.05");
        assert_eq!(fmt_num(0.29), "0.29");
        assert_eq!(fmt_num(-0.5), "-0.5");
        assert_eq!(fmt_num(-0.001), "0");
        assert_eq!(fmt_num(1e6), "1000000");
        assert_eq!(fmt_num(6.123e-17), "0");
    }

    #[test]
    fn right_angles_are_exact() {
        assert_eq!(cos_sin_deg(90.0), (0.0, 1.0));
        assert_eq!(cos_sin_deg(-90.0), (0.0, -1.0));
        assert_eq!(cos_sin_deg(540.0), (-1.0, 0.0));
    }
}
