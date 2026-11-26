//! One terminal: its screen model, OSC title / progress, the detected agent and its state.

use super::*;

/// Keeps the last OSC 0/2 title and OSC 9 payload.
#[derive(Default)]
pub(super) struct Osc {
    pub(super) title: String,
    pub(super) progress: String,
}

pub(super) fn sanitize(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| !c.is_control())
        .take(OSC_MAX_CHARS)
        .collect()
}

impl vt100::Callbacks for Osc {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.title = sanitize(title);
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        match params {
            [b"9", rest @ ..] => self.progress = sanitize(&rest.join(&b';')),
            // A title with `;` in it: vt100 splits it into more parameters and skips
            // `set_window_title`. The title is everything after the first `;`.
            [b"0" | b"2", rest @ ..] if rest.len() > 1 => self.title = sanitize(&rest.join(&b';')),
            _ => {}
        }
    }
}

/// What the Session panel shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Shown {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

impl Shown {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Unknown => "unknown",
        }
    }
}

pub(super) struct Watch {
    pub(super) parser: vt100::Parser<Osc>,
    /// Output or a resize since the screen was last looked at.
    pub(super) dirty: bool,
    pub(super) probe: Option<Probe>,
    pub(super) next_probe: Instant,
    pub(super) foreground: Option<Foreground>,
    pub(super) agent: Option<usize>,
    /// The agent was recognised from the screen (not from its process).
    pub(super) by_screen: bool,
    /// …while a full-screen program had the alternate screen.
    pub(super) identified_in_alt: bool,
    pub(super) evidence_lost: Option<Instant>,
    pub(super) state: State,
    /// Finished a turn while its terminal was not the one being viewed.
    pub(super) done: bool,
    /// working → plain idle not yet confirmed: since when, how many times seen.
    pub(super) pending_idle: Option<(Instant, u8)>,
    /// Last state sent to the UI.
    pub(super) sent: Option<(usize, Shown)>,
    /// The latest output, raw (at most RECENT_BYTES): replayed for longer reads (`Agents::recent`).
    pub(super) recent: std::collections::VecDeque<u8>,
}

impl Watch {
    pub(super) fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(rows.max(1), cols.max(2), 0, Osc::default()),
            dirty: false,
            probe: None,
            next_probe: Instant::now(),
            foreground: None,
            agent: None,
            by_screen: false,
            identified_in_alt: false,
            evidence_lost: None,
            state: State::Idle,
            done: false,
            pending_idle: None,
            sent: None,
            recent: std::collections::VecDeque::new(),
        }
    }

    pub(super) fn feed(&mut self, data: &[u8]) {
        let tail = &data[data.len().saturating_sub(RECENT_BYTES)..];
        let overflow = (self.recent.len() + tail.len()).saturating_sub(RECENT_BYTES);
        self.recent.drain(..overflow);
        self.recent.extend(tail);
        let parser = &mut self.parser;
        // The screen model runs on the terminal's reader thread: a parser bug must not take the
        // terminal down with it. Start over with a blank screen instead.
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parser.process(data))).is_err()
        {
            let (rows, cols) = self.parser.screen().size();
            log::warn!("Agent status: screen model failed, starting over");
            self.parser = vt100::Parser::new_with_callbacks(rows, cols, 0, Osc::default());
        }
        self.dirty = true;
    }

    pub(super) fn screen_text(&self) -> String {
        let screen = self.parser.screen();
        let (_, cols) = screen.size();
        screen.rows(0, cols).collect::<Vec<_>>().join("\n")
    }

    pub(super) fn set_agent(&mut self, agent: Option<usize>, by_screen: bool) {
        if self.agent == agent {
            self.by_screen = by_screen && agent.is_some();
            return;
        }
        if self.agent.is_some() {
            // A new agent must not inherit the previous one's title / progress.
            let osc = self.parser.callbacks_mut();
            osc.title.clear();
            osc.progress.clear();
        }
        self.agent = agent;
        self.by_screen = by_screen && agent.is_some();
        self.identified_in_alt = self.by_screen && self.parser.screen().alternate_screen();
        self.evidence_lost = None;
        self.state = State::Idle;
        self.done = false;
        self.pending_idle = None;
        self.dirty = true;
    }

    /// One look at the terminal; returns the event to send when what the UI shows has changed.
    pub(super) fn tick(
        &mut self,
        now: Instant,
        viewed: bool,
        catalog: &Catalog,
    ) -> Option<(Option<usize>, Shown)> {
        if let Some(probe) = &self.probe {
            if now >= self.next_probe {
                self.foreground = probe.foreground();
                self.next_probe = now + PROBE_EVERY;
            }
        }
        // Agent from the process; else (another program, or no process information) from the screen.
        let screen_allowed = match self.foreground {
            Some(Foreground::Agent(agent)) => {
                self.set_agent(Some(agent), false);
                false
            }
            Some(Foreground::Shell) => {
                self.set_agent(None, false);
                false
            }
            Some(Foreground::Other) | None => {
                if !self.by_screen {
                    self.set_agent(None, false);
                }
                true
            }
        };
        if self.dirty || self.pending_idle.is_some() {
            self.dirty = false;
            let text = self.screen_text();
            let osc = self.parser.callbacks();
            let (title, progress) = (osc.title.clone(), osc.progress.clone());
            let input = Input {
                screen: &text,
                osc_title: &title,
                osc_progress: &progress,
            };
            let signature = |agent: Option<usize>| {
                catalog
                    .signatures
                    .iter()
                    .filter(|signature| agent.is_none_or(|agent| signature.agent == agent))
                    .find(|signature| signature.gate.matches_region(signature.region.text(input)))
                    .map(|signature| signature.agent)
            };
            if screen_allowed && self.agent.is_none() {
                if let Some(agent) =
                    signature(None).filter(|agent| catalog.manifests[*agent].is_some())
                {
                    self.set_agent(Some(agent), true);
                }
            }
            if let Some(manifest) = self
                .agent
                .and_then(|agent| catalog.manifests[agent].as_ref())
            {
                let detection = manifest.detect(input);
                if self.by_screen {
                    let evidence = (detection.rule.is_some() && detection.on_screen)
                        || signature(self.agent).is_some();
                    if evidence {
                        self.evidence_lost = None;
                    } else {
                        self.evidence_lost.get_or_insert(now);
                    }
                }
                self.apply(detection, now, viewed);
            }
        }
        if self.by_screen
            && (self
                .evidence_lost
                .is_some_and(|since| now.duration_since(since) >= SCREEN_EVIDENCE_GRACE)
                || (self.identified_in_alt && !self.parser.screen().alternate_screen()))
        {
            self.set_agent(None, false);
        }
        if self.agent.is_some() && viewed && self.done {
            self.done = false;
        }
        let shown = self.shown();
        if shown != self.sent {
            self.sent = shown;
            return Some(shown.map_or((None, Shown::Idle), |(agent, state)| (Some(agent), state)));
        }
        None
    }

    pub(super) fn apply(&mut self, detection: Detection, now: Instant, viewed: bool) {
        if detection.skip_state_update {
            return;
        }
        let mut next = detection.state;
        if self.state == State::Working
            && next == State::Idle
            && !detection.visible_idle
            && !detection.visible_blocker
        {
            let (since, seen) = self.pending_idle.get_or_insert((now, 0));
            *seen += 1;
            if *seen < IDLE_CONFIRMATIONS && now.duration_since(*since) < IDLE_HOLD_MAX {
                return;
            }
            next = State::Idle;
        }
        self.pending_idle = None;
        if self.state == State::Working && next == State::Idle && !viewed {
            self.done = true;
        }
        if next != State::Idle {
            self.done = false;
        }
        self.state = next;
    }

    pub(super) fn shown(&self) -> Option<(usize, Shown)> {
        let agent = self.agent?;
        let state = match self.state {
            State::Idle if self.done => Shown::Done,
            State::Idle => Shown::Idle,
            State::Working => Shown::Working,
            State::Blocked => Shown::Blocked,
            State::Unknown => Shown::Unknown,
        };
        Some((agent, state))
    }
}
