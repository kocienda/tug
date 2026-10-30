//! The standalone measurer: the deck's own woff2 faces, parsed and shaped
//! natively, so a render with no page lays text out against the very bytes
//! the page serves rather than an approximation of them.
//!
//! Behind the `font` feature. The page measures through its canvas and the
//! WASM build never carries this; a native door that has no page does.
//!
//! A string is mapped to glyphs, shaped with `allsorts` — GSUB for the
//! ligatures the browser also applies, GPOS with kerning on — and its width
//! is the sum of advances plus kerning, scaled from font units to px.
//! Ascent and descent are the font's own: the OS/2 typographic metrics
//! when the face asks for them (`USE_TYPO_METRICS`), `hhea` otherwise,
//! rounded up to whole px as WebKit rounds a face's box. A character the
//! face lacks measures as its `.notdef` glyph, where the browser would fall
//! back to another face; the deck's charts carry Latin text, digits and
//! punctuation, which every face here has.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;

use allsorts::binary::read::ReadScope;
use allsorts::font::MatchingPresentation;
use allsorts::font_data::{DynamicFontTableProvider, FontData};
use allsorts::gsub::{FeatureMask, FeatureMaskExt};
use allsorts::tables::os2::FsSelectionFlag;
use allsorts::{tag, Font};

use crate::measure::{Measure, Metrics, TypeRole};

/// One face at one size: the parsed font, the role's px size, and the
/// box every string in it shares.
struct Face<'a> {
    font: RefCell<Font<DynamicFontTableProvider<'a>>>,
    size: f64,
    upem: f64,
    ascent: f64,
    descent: f64,
    widths: RefCell<HashMap<String, f64>>,
}

impl<'a> Face<'a> {
    fn parse(bytes: &'a [u8], size: f64) -> Result<Face<'a>, String> {
        if !(size > 0.0 && size.is_finite()) {
            return Err("size is a positive number of px".into());
        }
        let data = ReadScope::new(bytes)
            .read::<FontData<'_>>()
            .map_err(|e| format!("not a font file: {e}"))?;
        let provider = data.table_provider(0).map_err(|e| format!("no font tables: {e}"))?;
        let font = Font::new(provider).map_err(|e| format!("unreadable font tables: {e}"))?;
        let upem = f64::from(font.head_table.units_per_em);
        if upem <= 0.0 {
            return Err("the face has no units per em".into());
        }
        let typo = font
            .os2_table()
            .ok()
            .flatten()
            .filter(|os2| os2.fs_selection.contains(FsSelectionFlag::USE_TYPO_METRICS))
            .and_then(|os2| os2.version0)
            .map(|v0| (f64::from(v0.s_typo_ascender), f64::from(v0.s_typo_descender)));
        let (ascender, descender) =
            typo.unwrap_or((f64::from(font.hhea_table.ascender), f64::from(font.hhea_table.descender)));
        let px = |units: f64| (units * size / upem).ceil();
        Ok(Face {
            font: RefCell::new(font),
            size,
            upem,
            ascent: px(ascender),
            // Descenders are written below the baseline, so negative.
            descent: px(-descender),
            widths: RefCell::new(HashMap::new()),
        })
    }

    fn width(&self, text: &str) -> f64 {
        if let Some(w) = self.widths.borrow().get(text) {
            return *w;
        }
        let mut font = self.font.borrow_mut();
        let glyphs = font.map_glyphs(text, tag::LATN, MatchingPresentation::NotRequired);
        // Shaping carries on past an error and returns what it placed, which
        // is the better answer than no width at all.
        let infos = match font.shape(
            glyphs,
            tag::LATN,
            Some(tag::DFLT),
            FeatureMask::default_mask(),
            &[],
            None,
            true,
        ) {
            Ok(infos) => infos,
            Err((_, infos)) => infos,
        };
        let units: f64 = infos
            .iter()
            .map(|info| {
                f64::from(font.horizontal_advance(info.glyph.glyph_index).unwrap_or(0)) + f64::from(info.kerning)
            })
            .sum();
        let w = units * self.size / self.upem;
        self.widths.borrow_mut().insert(text.to_string(), w);
        w
    }
}

/// A [`Measure`] over one woff2 face per type role, each at the role's px
/// size. Built once per render; widths are remembered per string.
pub struct FaceMeasurer<'a> {
    faces: HashMap<TypeRole, Face<'a>>,
}

impl fmt::Debug for FaceMeasurer<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut map = f.debug_map();
        for role in TypeRole::ALL {
            if let Some(face) = self.faces.get(&role) {
                map.entry(&role.name(), &format_args!("{}px", face.size));
            }
        }
        map.finish()
    }
}

impl<'a> FaceMeasurer<'a> {
    /// Parses one woff2 face per role at the role's size in px. Every role
    /// in [`TypeRole::ALL`] must be given: a layout would otherwise have no
    /// answer for a string set in the missing one.
    pub fn from_woff2(faces: &[(TypeRole, &'a [u8], f64)]) -> Result<FaceMeasurer<'a>, String> {
        let mut parsed = HashMap::new();
        for (role, bytes, size) in faces {
            let face = Face::parse(bytes, *size).map_err(|e| format!("{} face: {e}", role.name()))?;
            parsed.insert(*role, face);
        }
        for role in TypeRole::ALL {
            if !parsed.contains_key(&role) {
                return Err(format!("no face for the {} role", role.name()));
            }
        }
        Ok(FaceMeasurer { faces: parsed })
    }
}

impl Measure for FaceMeasurer<'_> {
    fn measure(&self, role: TypeRole, text: &str) -> Option<Metrics> {
        let face = self.faces.get(&role)?;
        Some(Metrics {
            w: face.width(text),
            a: face.ascent,
            d: face.descent,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The deck's faces, as the page serves them.
    const SANS_REGULAR: &[u8] = include_bytes!("../../../public/fonts/IBMPlexSans-Regular.woff2");
    const SANS_SEMIBOLD: &[u8] = include_bytes!("../../../public/fonts/IBMPlexSans-SemiBold.woff2");
    const MONO_REGULAR: &[u8] = include_bytes!("../../../public/fonts/IBMPlexMono-Regular.woff2");

    fn measurer() -> FaceMeasurer<'static> {
        FaceMeasurer::from_woff2(&[
            (TypeRole::Title, SANS_SEMIBOLD, 13.0),
            (TypeRole::Label, SANS_REGULAR, 12.0),
            (TypeRole::Value, SANS_REGULAR, 11.0),
            (TypeRole::Mono, MONO_REGULAR, 11.0),
        ])
        .unwrap()
    }

    #[test]
    fn hello_at_twelve_px_has_a_positive_box() {
        let m = measurer().measure(TypeRole::Label, "Hello").unwrap();
        assert!(m.w > 0.0, "{m:?}");
        assert!(m.a > 0.0 && m.d > 0.0, "{m:?}");
        // A whole-px box, as the page reports one.
        assert_eq!(m.a, m.a.round());
        assert_eq!(m.d, m.d.round());
        // Five sans letters at 12 px are between two and five ems wide.
        assert!(m.w > 24.0 && m.w < 60.0, "{m:?}");
    }

    #[test]
    fn kerned_pairs_are_narrower_than_their_letters_apart() {
        let m = measurer();
        let w = |s: &str| m.measure(TypeRole::Label, s).unwrap().w;
        assert!(w("AV") < w("A") + w("V") - 0.05, "AV {} vs A+V {}", w("AV"), w("A") + w("V"));
        // An unkerned pair sums exactly.
        assert!((w("HH") - 2.0 * w("H")).abs() < 1e-9);
    }

    #[test]
    fn roles_scale_with_their_size_and_the_mono_face_is_uniform() {
        let m = measurer();
        let label = m.measure(TypeRole::Label, "2026").unwrap().w;
        let value = m.measure(TypeRole::Value, "2026").unwrap().w;
        assert!((label / value - 12.0 / 11.0).abs() < 1e-9, "{label} vs {value}");
        let narrow = m.measure(TypeRole::Mono, "iiii").unwrap().w;
        let wide = m.measure(TypeRole::Mono, "MMMM").unwrap().w;
        assert!((narrow - wide).abs() < 1e-9, "{narrow} vs {wide}");
    }

    #[test]
    fn every_role_needs_a_face_and_garbage_is_refused() {
        let err = FaceMeasurer::from_woff2(&[(TypeRole::Label, SANS_REGULAR, 12.0)]).unwrap_err();
        assert!(err.contains("no face for the title role"), "{err}");
        let err = FaceMeasurer::from_woff2(&[(TypeRole::Label, b"not a font", 12.0)]).unwrap_err();
        assert!(err.starts_with("label face:"), "{err}");
        let err = FaceMeasurer::from_woff2(&[(TypeRole::Label, SANS_REGULAR, 0.0)]).unwrap_err();
        assert!(err.contains("positive"), "{err}");
    }
}
