//! How much of the transcripts on this machine the index holds so far, which a search
//! says aloud, because an answer drawn from part of the history should say it is.

use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemanticCoverage {
    pub transcripts_done: usize,
    pub transcripts_total: usize,
    pub catching_up: bool,
    pub model_live: bool,
}

impl SemanticCoverage {
    pub(crate) fn sentence(&self) -> String {
        if !self.model_live {
            return "semantic index: lexical only, no embedding model".to_string();
        }
        if self.catching_up {
            return format!(
                "semantic index: catching up, {} of {} transcripts indexed so far",
                grouped(self.transcripts_done),
                grouped(self.transcripts_total)
            );
        }
        format!(
            "semantic index: complete, {} transcripts",
            grouped(self.transcripts_total)
        )
    }

    /// How far along, in whole percent.
    pub(crate) fn percent(&self) -> usize {
        (self.transcripts_done * 100)
            .checked_div(self.transcripts_total)
            .unwrap_or(100)
    }
}

/// A channel for the worker to say how far it has come. `catching_up` is whether there
/// is a catch-up to wait for.
pub(crate) fn coverage_channel(
    catching_up: bool,
) -> (
    watch::Sender<SemanticCoverage>,
    watch::Receiver<SemanticCoverage>,
) {
    watch::channel(SemanticCoverage {
        transcripts_done: 0,
        transcripts_total: 0,
        catching_up,
        model_live: true,
    })
}

fn grouped(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coverage(
        done: usize,
        total: usize,
        catching_up: bool,
        model_live: bool,
    ) -> SemanticCoverage {
        SemanticCoverage {
            transcripts_done: done,
            transcripts_total: total,
            catching_up,
            model_live,
        }
    }

    #[test]
    fn each_state_has_its_sentence() {
        assert_eq!(
            coverage(412, 1073, true, true).sentence(),
            "semantic index: catching up, 412 of 1,073 transcripts indexed so far"
        );
        assert_eq!(
            coverage(1073, 1073, false, true).sentence(),
            "semantic index: complete, 1,073 transcripts"
        );
        assert_eq!(
            coverage(5, 9, true, false).sentence(),
            "semantic index: lexical only, no embedding model"
        );
    }

    #[test]
    fn nothing_to_do_is_all_of_it() {
        assert_eq!(coverage(0, 0, false, true).percent(), 100);
        assert_eq!(coverage(1, 3, true, true).percent(), 33);
    }
}
