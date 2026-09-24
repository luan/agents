use std::collections::BTreeMap;
use std::time::Duration;

use bytes::Bytes;
use tokio::time::Instant;

const START_PACKETS: usize = 3;
const MAX_SEQUENCE_DISTANCE: usize = 6;
const MAX_PENDING_PACKETS: usize = MAX_SEQUENCE_DISTANCE + 1;

#[derive(Debug, PartialEq)]
pub enum PlayoutFrame {
    Buffering,
    Packet(Bytes),
    Missing,
}

pub struct PacketPlayout {
    pending: BTreeMap<i64, Bytes>,
    expected: Option<i64>,
    playing: bool,
}

pub struct PlayoutClock {
    deadline: Option<Instant>,
}

impl PlayoutClock {
    pub fn new() -> Self {
        Self { deadline: None }
    }

    pub fn start(&mut self, now: Instant) {
        self.deadline.get_or_insert(now);
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub fn advance(&mut self, samples: usize, sample_rate: u32) {
        let Some(deadline) = self.deadline else {
            return;
        };
        let frame_duration = Duration::from_secs_f64(samples as f64 / f64::from(sample_rate));
        self.deadline = Some(deadline + frame_duration);
    }

    pub fn stop(&mut self) {
        self.deadline = None;
    }
}

impl Default for PlayoutClock {
    fn default() -> Self {
        Self::new()
    }
}

impl PacketPlayout {
    pub fn new() -> Self {
        Self {
            pending: BTreeMap::new(),
            expected: None,
            playing: false,
        }
    }

    pub fn push(&mut self, sequence: u16, payload: Bytes) {
        let expected = *self.expected.get_or_insert(i64::from(sequence));
        let delta = i64::from(sequence.wrapping_sub(expected as u16) as i16);
        let extended = expected + delta;
        if extended < expected {
            if self.playing || expected - extended > MAX_SEQUENCE_DISTANCE as i64 {
                return;
            }
            self.expected = Some(extended);
        } else if extended - expected > MAX_SEQUENCE_DISTANCE as i64 {
            self.pending.clear();
            self.expected = Some(extended);
            self.playing = false;
        }
        self.pending.entry(extended).or_insert(payload);
        while self.pending.len() > MAX_PENDING_PACKETS {
            let Some(oldest) = self.pending.keys().next().copied() else {
                break;
            };
            self.pending.remove(&oldest);
        }
        if !self.playing && self.pending.len() >= START_PACKETS {
            self.playing = true;
        }
    }

    pub fn next_frame(&mut self) -> PlayoutFrame {
        if !self.playing {
            return PlayoutFrame::Buffering;
        }
        let expected = self
            .expected
            .expect("playing playout has an expected sequence");
        let frame = if let Some(payload) = self.pending.remove(&expected) {
            PlayoutFrame::Packet(payload)
        } else if self
            .pending
            .keys()
            .next()
            .is_some_and(|sequence| *sequence > expected)
        {
            PlayoutFrame::Missing
        } else {
            self.playing = false;
            return PlayoutFrame::Buffering;
        };
        self.expected = Some(expected + 1);
        frame
    }

    pub fn ready(&self) -> bool {
        self.playing
    }
}

impl Default for PacketPlayout {
    fn default() -> Self {
        Self::new()
    }
}
