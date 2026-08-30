//! Timestamp utilities for tug

/// Generate ISO 8601 timestamp in UTC
///
/// Returns a string in the format "YYYY-MM-DDTHH:MM:SS.MMMZ"
/// This function is used for timestamp generation across the codebase.
pub fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("SystemTime before UNIX_EPOCH");

    iso8601_from_unix(duration.as_secs(), duration.subsec_nanos())
}

/// Render a Unix instant as an ISO 8601 UTC timestamp.
///
/// Split from `now_iso8601` so the calendar conversion is testable without the
/// system clock.
fn iso8601_from_unix(secs: u64, nanos: u32) -> String {
    const SECONDS_PER_DAY: u64 = 86400;

    let days_since_epoch = (secs / SECONDS_PER_DAY) as i64;
    let seconds_today = secs % SECONDS_PER_DAY;

    let hours = seconds_today / 3600;
    let minutes = (seconds_today % 3600) / 60;
    let seconds = seconds_today % 60;
    let millis = nanos / 1_000_000;

    let (year, month, day) = civil_from_days(days_since_epoch);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hours, minutes, seconds, millis
    )
}

/// Convert a count of days since 1970-01-01 into a (year, month, day) civil date.
///
/// This is Howard Hinnant's `civil_from_days`: the calendar is shifted so that
/// the year starts in March, which puts the leap day at the end of the year and
/// makes the month/day arithmetic exact for every era.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    // Shift the epoch to 0000-03-01, the start of an era.
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let day_of_era = (z - era * 146097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365; // [0, 399]
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100); // [0, 365]
    let month_shifted = (5 * day_of_year + 2) / 153; // [0, 11], where 0 is March
    let day = (day_of_year - (153 * month_shifted + 2) / 5 + 1) as u32;
    let month = if month_shifted < 10 {
        month_shifted + 3
    } else {
        month_shifted - 9
    } as u32;

    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::iso8601_from_unix;

    #[test]
    fn the_epoch_is_the_first_of_january_1970() {
        assert_eq!(iso8601_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn a_known_instant_renders_its_own_calendar_date() {
        // `date -u -r 1786500000` → Wed Aug 12 02:00:00 UTC 2026
        assert_eq!(iso8601_from_unix(1786500000, 0), "2026-08-12T02:00:00.000Z");
    }

    #[test]
    fn a_leap_day_and_the_day_after_it_are_distinct() {
        // 2024-02-29T12:00:00Z and the following day. A displacement measured in
        // days rather than years lands one day off across this boundary, so the
        // pair falsifies more than a single-date pin can.
        assert_eq!(iso8601_from_unix(1709208000, 0), "2024-02-29T12:00:00.000Z");
        assert_eq!(iso8601_from_unix(1709294400, 0), "2024-03-01T12:00:00.000Z");
    }

    #[test]
    fn the_last_second_of_a_year_is_still_that_year() {
        assert_eq!(iso8601_from_unix(1735689599, 0), "2024-12-31T23:59:59.000Z");
        assert_eq!(iso8601_from_unix(1735689600, 0), "2025-01-01T00:00:00.000Z");
    }

    #[test]
    fn a_century_boundary_is_not_a_leap_year() {
        // 1900 is divisible by 4 but not a leap year; 2000 is.
        assert_eq!(iso8601_from_unix(951782400, 0), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn sub_second_precision_renders_as_millis() {
        assert_eq!(
            iso8601_from_unix(1786500000, 123_456_789),
            "2026-08-12T02:00:00.123Z"
        );
    }
}
