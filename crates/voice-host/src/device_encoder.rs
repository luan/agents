use crate::audio::AudioFrames;
use crate::codex_audio::processing::{MAX_PROCESSING_DELAY, PROCESSING_LATE, Processor};
use crate::protocol::Event;
use crate::v3_media::AudioSender;
use bytes::Bytes;
use rtc::media::Sample;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct DeviceAudio {
    pub capture: AudioFrames,
    pub input_rate: u32,
    pub render: AudioFrames,
    pub output_rate: u32,
}

pub fn spawn(
    track: Arc<AudioSender>,
    device: DeviceAudio,
    enabled: Arc<AtomicBool>,
    events: mpsc::Sender<Event>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(message) = Box::pin(encode(track, device, enabled)).await {
            let _ = events.send(Event::Error { message }).await;
        }
    })
}

async fn encode(
    track: Arc<AudioSender>,
    device: DeviceAudio,
    enabled: Arc<AtomicBool>,
) -> Result<(), String> {
    let DeviceAudio {
        capture,
        input_rate,
        render,
        output_rate,
    } = device;
    let mut processor = Processor::new(input_rate, output_rate)?;
    let mut generation = capture.generation.load(Ordering::Acquire);
    let mut pending = VecDeque::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(20));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        if capture.failed.load(Ordering::Acquire) {
            return Err("microphone stream failed".into());
        }
        let current = capture.generation.load(Ordering::Acquire);
        if generation != current || capture.dropped.swap(false, Ordering::AcqRel) {
            generation = current;
            pending.clear();
            while capture.queue.pop().is_some() {}
            processor.reset()?;
        }
        if render.dropped.swap(false, Ordering::AcqRel) {
            while render.queue.pop().is_some() {}
            processor.reset_render();
        }
        for _ in 0..render.queue.capacity() {
            let Some(frame) = render.queue.pop() else {
                break;
            };
            processor.render(&frame, Instant::now())?;
        }
        if !enabled.load(Ordering::Acquire) {
            while capture.queue.pop().is_some() {}
            pending.clear();
            continue;
        }
        if current % 2 == 1 {
            while capture.queue.pop().is_some() {}
            pending.clear();
            pending.push_back(processor.silence(Instant::now())?);
        } else {
            for _ in 0..capture.queue.capacity() {
                let Some(frame) = capture.queue.pop() else {
                    break;
                };
                if frame.generation != current {
                    continue;
                }
                match processor.capture(&frame, Instant::now) {
                    Ok(encoded) => pending.extend(encoded),
                    Err(PROCESSING_LATE) => {
                        pending.clear();
                        processor.reset()?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        let Some(packet) = pending.pop_front() else {
            continue;
        };
        if current != capture.generation.load(Ordering::Acquire) {
            pending.clear();
            continue;
        }
        if Instant::now().saturating_duration_since(packet.at) > MAX_PROCESSING_DELAY {
            pending.clear();
            processor.reset()?;
            continue;
        }
        tokio::time::timeout(
            MAX_PROCESSING_DELAY,
            track.write_sample(&Sample {
                data: Bytes::from(packet.data),
                duration: Duration::from_millis(20),
                timestamp: packet.at,
                packet_timestamp: 0,
                prev_dropped_packets: 0,
                prev_padding_packets: 0,
            }),
        )
        .await
        .map_err(|_| "realtime microphone stream stalled".to_owned())?
        .map_err(|error| format!("realtime microphone stream failed: {error}"))?;
    }
}
