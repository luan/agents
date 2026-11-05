use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};
use crossbeam_queue::ArrayQueue;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCIceGatheringState, RTCPeerConnectionState, RTCSessionDescription, Registry,
    register_default_interceptors,
};

use crate::audio::{self, Capture, Playback};
use crate::levels::{AudioPeak, spawn_levels};
use crate::protocol::{Event, MAX_DATA_MESSAGE_BYTES};
use crate::v3_media::{
    BRIDGE_RATE, OutputSink, audio_codec, create_audio_sender, play_remote_track, spawn_encoder,
};

const BRIDGE_INPUT_SECONDS: usize = 3;

pub struct V3Session {
    peer: Arc<dyn PeerConnection>,
    handler: Arc<SessionHandler>,
    data_channel: Arc<dyn DataChannel>,
    data_task: tokio::task::JoinHandle<()>,
    encoder_task: tokio::task::JoinHandle<()>,
    meter_task: tokio::task::JoinHandle<()>,
    input_muted: Arc<AtomicBool>,
    capture: Option<Capture>,
    _playback: Option<Playback>,
    bridge_input: Option<Arc<ArrayQueue<f32>>>,
}

impl V3Session {
    pub async fn create_devices(
        microphone: Option<String>,
        speaker: Option<String>,
        events: mpsc::Sender<Event>,
    ) -> Result<(Self, String)> {
        let capture = audio::capture(microphone.as_deref())?;
        let playback = audio::playback(speaker.as_deref(), events.clone())?;
        let input_samples = Arc::clone(&capture.samples);
        let input_rate = capture.sample_rate;
        let output = OutputSink::Device {
            samples: Arc::clone(&playback.samples),
            sample_rate: playback.sample_rate,
            peak: Arc::clone(&playback.peak),
        };
        Self::create(
            input_samples,
            input_rate,
            output,
            events,
            Some(capture),
            Some(playback),
            None,
        )
        .await
    }

    pub async fn create_bridge(events: mpsc::Sender<Event>) -> Result<(Self, String)> {
        let input = Arc::new(ArrayQueue::new(BRIDGE_RATE as usize * BRIDGE_INPUT_SECONDS));
        Self::create(
            Arc::clone(&input),
            BRIDGE_RATE,
            OutputSink::Bridge {
                peak: Arc::new(AudioPeak::default()),
            },
            events,
            None,
            None,
            Some(input),
        )
        .await
    }

    async fn create(
        input_samples: Arc<ArrayQueue<f32>>,
        input_rate: u32,
        output: OutputSink,
        events: mpsc::Sender<Event>,
        capture: Option<Capture>,
        playback: Option<Playback>,
        bridge_input: Option<Arc<ArrayQueue<f32>>>,
    ) -> Result<(Self, String)> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_codec(
            audio_codec(),
            rtc::rtp_transceiver::rtp_sender::RtpCodecKind::Audio,
        )?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;
        let gathered = Arc::new(Notify::new());
        let handler = Arc::new(SessionHandler {
            events: events.clone(),
            output: output.clone(),
            gathered: gathered.clone(),
            playout: tokio::sync::Mutex::new(Some(tokio::task::JoinSet::new())),
        });
        let peer: Arc<dyn PeerConnection> = Arc::new(
            Box::pin(
                PeerConnectionBuilder::new()
                    .with_media_engine(media_engine)
                    .with_interceptor_registry(registry)
                    .with_udp_addrs(vec!["0.0.0.0:0"])
                    .with_handler(handler.clone())
                    .build(),
            )
            .await?,
        );
        let track = create_audio_sender(&peer).await?;
        let input_enabled = Arc::new(AtomicBool::new(false));
        let data_channel = peer.create_data_channel("oai-events", None).await?;
        let data_task = tokio::spawn(poll_data_channel(
            data_channel.clone(),
            input_enabled.clone(),
            events.clone(),
        ));

        let speaker_peak = output.peak();
        let microphone_peak = capture.as_ref().map_or_else(
            || Arc::new(AudioPeak::default()),
            |capture| Arc::clone(&capture.peak),
        );
        let input_muted = Arc::new(AtomicBool::new(false));
        let encoder_task = if let (Some(capture), Some(playback)) = (&capture, &playback) {
            crate::device_encoder::spawn(
                track,
                crate::device_encoder::DeviceAudio {
                    capture: capture.frames.clone(),
                    input_rate,
                    render: playback.rendered.clone(),
                    output_rate: playback.sample_rate,
                },
                input_enabled,
                events.clone(),
            )
        } else {
            spawn_encoder(
                track,
                input_samples,
                input_rate,
                input_enabled,
                Arc::clone(&input_muted),
                Arc::clone(&microphone_peak),
                events.clone(),
            )
        };

        let offer = peer.create_offer(None).await?;
        peer.set_local_description(offer).await?;
        gathered.notified().await;
        let sdp = peer
            .local_description()
            .await
            .context("WebRTC offer was not created")?
            .sdp;
        let meter_task = spawn_levels(
            microphone_peak,
            speaker_peak,
            Arc::clone(&input_muted),
            events,
        );
        Ok((
            Self {
                peer,
                handler,
                data_channel,
                data_task,
                encoder_task,
                meter_task,
                input_muted,
                capture,
                _playback: playback,
                bridge_input,
            },
            sdp,
        ))
    }

    pub async fn apply_answer(&self, sdp: String) -> Result<()> {
        self.peer
            .set_remote_description(RTCSessionDescription::answer(sdp)?)
            .await?;
        Ok(())
    }

    pub async fn send(&self, message: Value) -> Result<()> {
        self.data_channel
            .send_text(&serde_json::to_string(&message)?)
            .await?;
        Ok(())
    }

    pub fn set_input_muted(&self, muted: bool) {
        let previous = self.input_muted.swap(muted, Ordering::AcqRel);
        if previous != muted
            && let Some(capture) = &self.capture
        {
            capture.frames.generation.fetch_add(1, Ordering::AcqRel);
        }
    }

    pub fn send_pcm(&self, pcm: &[u8]) -> Result<()> {
        let input = self
            .bridge_input
            .as_ref()
            .context("PCM input requires a bridge V3 session")?;
        if !pcm.len().is_multiple_of(2) {
            anyhow::bail!("bridge PCM must contain complete i16 samples");
        }
        for bytes in pcm.as_chunks::<2>().0 {
            let sample = i16::from_le_bytes([bytes[0], bytes[1]]);
            let normalized = f32::from(sample) / if sample < 0 { 32_768.0 } else { 32_767.0 };
            audio::push_latest(input, normalized);
        }
        Ok(())
    }

    pub async fn close(self) -> Result<()> {
        self.data_task.abort();
        self.encoder_task.abort();
        self.meter_task.abort();
        let _ = self.data_task.await;
        let _ = self.encoder_task.await;
        let _ = self.meter_task.await;
        let playout = self.handler.playout.lock().await.take();
        if let Some(mut tasks) = playout {
            tasks.shutdown().await;
        }
        self.peer.close().await?;
        Ok(())
    }
}

struct SessionHandler {
    events: mpsc::Sender<Event>,
    output: OutputSink,
    gathered: Arc<Notify>,
    playout: tokio::sync::Mutex<Option<tokio::task::JoinSet<()>>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for SessionHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.gathered.notify_one();
        }
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let state = match state {
            RTCPeerConnectionState::Connected => "connected",
            RTCPeerConnectionState::Disconnected => "disconnected",
            RTCPeerConnectionState::Failed => "failed",
            RTCPeerConnectionState::Closed => "closed",
            _ => return,
        };
        let _ = self.events.send(Event::State { state }).await;
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        if let Some(tasks) = self.playout.lock().await.as_mut() {
            tasks.spawn(play_remote_track(
                track,
                self.output.clone(),
                self.events.clone(),
            ));
        }
    }
}

async fn poll_data_channel(
    channel: Arc<dyn DataChannel>,
    input: Arc<AtomicBool>,
    events: mpsc::Sender<Event>,
) {
    while let Some(event) = channel.poll().await {
        match event {
            DataChannelEvent::OnOpen => {
                input.store(true, Ordering::Release);
                let _ = events.send(Event::State { state: "ready" }).await;
            }
            DataChannelEvent::OnMessage(message)
                if message.data.len() <= MAX_DATA_MESSAGE_BYTES =>
            {
                let event = match serde_json::from_slice::<Value>(&message.data) {
                    Ok(message) => Event::Data { message },
                    Err(error) => Event::Error {
                        message: format!("invalid realtime data event: {error}"),
                    },
                };
                if events.send(event).await.is_err() {
                    return;
                }
            }
            _ => {}
        }
    }
}
