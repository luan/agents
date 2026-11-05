use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use crossbeam_queue::ArrayQueue;
use rtc::media::Sample as MediaSample;
use rtc::media_stream::MediaStreamTrack;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};
use tokio::sync::mpsc;
use tokio::time::Instant;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::PeerConnection;

use crate::audio;
use crate::levels::AudioPeak;
use crate::playout::{PacketPlayout, PlayoutClock, PlayoutFrame};
use crate::protocol::Event;
use crate::resample::LinearResampler;

const OPUS_RATE: u32 = 48_000;
const OPUS_FRAME_SAMPLES: usize = 960;
pub const BRIDGE_RATE: u32 = 24_000;
const BRIDGE_FRAME_SAMPLES: usize = 480;

#[derive(Clone)]
pub enum OutputSink {
    Device {
        samples: Arc<ArrayQueue<f32>>,
        sample_rate: u32,
        peak: Arc<AudioPeak>,
    },
    Bridge {
        peak: Arc<AudioPeak>,
    },
}

impl OutputSink {
    pub fn peak(&self) -> Arc<AudioPeak> {
        match self {
            Self::Device { peak, .. } | Self::Bridge { peak } => Arc::clone(peak),
        }
    }
    fn sample_rate(&self) -> u32 {
        match self {
            Self::Device { sample_rate, .. } => *sample_rate,
            Self::Bridge { .. } => BRIDGE_RATE,
        }
    }
}

pub struct AudioSender {
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
}

impl AudioSender {
    pub async fn write_sample(&self, sample: &MediaSample) -> webrtc::error::Result<()> {
        self.track
            .write_sample(self.ssrc, self.payload_type, sample, &[])
            .await
    }
}

pub fn audio_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: "audio/opus".to_owned(),
            clock_rate: OPUS_RATE,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
            ..Default::default()
        },
        payload_type: 111,
    }
}

pub async fn create_audio_sender(peer: &Arc<dyn PeerConnection>) -> Result<Arc<AudioSender>> {
    let codec = audio_codec();
    let ssrc = rand::random();
    let media = MediaStreamTrack::new(
        "pi".to_owned(),
        "audio".to_owned(),
        "audio".to_owned(),
        RtpCodecKind::Audio,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(ssrc),
                ..Default::default()
            },
            codec: codec.rtp_codec,
            ..Default::default()
        }],
    );
    let track = Arc::new(TrackLocalStaticSample::new(
        std::time::Instant::now(),
        media,
    )?);
    peer.add_track(track.clone()).await?;
    Ok(Arc::new(AudioSender {
        track,
        ssrc,
        payload_type: codec.payload_type,
    }))
}

pub async fn play_remote_track(
    remote: Arc<dyn TrackRemote>,
    output: OutputSink,
    output_events: mpsc::Sender<Event>,
) {
    let output_rate = output.sample_rate();
    let mut decoder = match opus::Decoder::new(OPUS_RATE, opus::Channels::Stereo) {
        Ok(decoder) => decoder,
        Err(error) => {
            let _ = output_events
                .send(Event::Error {
                    message: format!("could not start realtime audio decoder: {error}"),
                })
                .await;
            return;
        }
    };
    let mut resampler = match LinearResampler::new(OPUS_RATE, output_rate) {
        Ok(resampler) => resampler,
        Err(error) => {
            let _ = output_events
                .send(Event::Error {
                    message: error.to_string(),
                })
                .await;
            return;
        }
    };
    let mut playout = PacketPlayout::new();
    let mut playout_clock = PlayoutClock::new();
    let mut pcm_samples = vec![0_f32; OPUS_FRAME_SAMPLES * 2 * 6];
    let mut converted = Vec::new();
    let mut bridge_pending = Vec::new();
    let mut last_frame_samples = OPUS_FRAME_SAMPLES;
    loop {
        tokio::select! {
            packet = next_rtp_packet(remote.as_ref()) => {
                let packet = match packet {
                    Ok(packet) => packet,
                    Err(error) => {
                        let _ = output_events.send(Event::Error { message: format!("realtime speaker stream ended: {error}") }).await;
                        return;
                    }
                };
                playout.push(packet.header.sequence_number, packet.payload);
                if playout.ready() {
                    playout_clock.start(Instant::now());
                }
            }
            () = wait_for_playout(playout_clock.deadline()) => {
                let frame = playout.next_frame();
                let (payload, decoded_output) = match frame {
                    PlayoutFrame::Buffering => {
                        playout_clock.stop();
                        continue;
                    }
                    PlayoutFrame::Packet(payload) => (payload, &mut pcm_samples[..]),
                    PlayoutFrame::Missing => (Bytes::new(), &mut pcm_samples[..last_frame_samples * 2]),
                };
                let Ok(samples_per_channel) = decoder.decode_float(&payload, decoded_output, false) else {
                    playout_clock.advance(last_frame_samples, OPUS_RATE);
                    continue;
                };
                last_frame_samples = samples_per_channel;
                playout_clock.advance(samples_per_channel, OPUS_RATE);
                let mut mono = Vec::with_capacity(samples_per_channel);
                for pair in pcm_samples[..samples_per_channel * 2].as_chunks::<2>().0 {
                    mono.push(f32::midpoint(pair[0], pair[1]));
                }
                converted.clear();
                resampler.process(&mono, &mut converted);
                match &output {
                    OutputSink::Device { samples, .. } => {
                        for sample in &converted {
                            audio::push_latest(samples, *sample);
                        }
                    }
                    OutputSink::Bridge { peak } => {
                        peak.record(converted.iter().fold(0_f32, |peak, sample| peak.max(sample.abs())));
                        bridge_pending.extend_from_slice(&converted);
                        while bridge_pending.len() >= BRIDGE_FRAME_SAMPLES {
                            let frame: Vec<f32> = bridge_pending.drain(..BRIDGE_FRAME_SAMPLES).collect();
                            let mut bytes = Vec::with_capacity(BRIDGE_FRAME_SAMPLES * 2);
                            for sample in frame {
                                bytes.extend_from_slice(&((sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16).to_le_bytes());
                            }
                            if output_events.send(Event::Pcm {
                                audio: BASE64.encode(bytes),
                                sample_rate: BRIDGE_RATE,
                                num_channels: 1,
                            }).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

async fn next_rtp_packet(remote: &dyn TrackRemote) -> Result<rtc::rtp::Packet> {
    while let Some(event) = remote.poll().await {
        match event {
            TrackRemoteEvent::OnRtpPacket(packet) => return Ok(packet),
            TrackRemoteEvent::OnError | TrackRemoteEvent::OnEnded => {
                anyhow::bail!("remote audio track ended")
            }
            _ => {}
        }
    }
    anyhow::bail!("remote audio track closed")
}

pub fn spawn_encoder(
    track: Arc<AudioSender>,
    samples: Arc<ArrayQueue<f32>>,
    input_rate: u32,
    enabled: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    peak: Arc<AudioPeak>,
    events: mpsc::Sender<Event>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut encoder =
            match opus::Encoder::new(OPUS_RATE, opus::Channels::Mono, opus::Application::Voip) {
                Ok(value) => value,
                Err(error) => {
                    let _ = events
                        .send(Event::Error {
                            message: format!("could not start realtime audio encoder: {error}"),
                        })
                        .await;
                    return;
                }
            };
        let mut resampler = match LinearResampler::new(input_rate, OPUS_RATE) {
            Ok(value) => value,
            Err(error) => {
                let _ = events
                    .send(Event::Error {
                        message: error.to_string(),
                    })
                    .await;
                return;
            }
        };
        let mut pending = Vec::new();
        let mut source = Vec::new();
        let mut packet = vec![0_u8; 4_000];
        let mut was_muted = false;
        let mut ticker = tokio::time::interval(Duration::from_millis(20));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if !enabled.load(Ordering::Acquire) {
                continue;
            }
            source.clear();
            audio::drain(&samples, input_rate as usize / 50, &mut source);
            peak.record(
                source
                    .iter()
                    .fold(0_f32, |peak, sample| peak.max(sample.abs())),
            );
            if muted.load(Ordering::Relaxed) {
                pending.clear();
                if !was_muted {
                    resampler.reset();
                    was_muted = true;
                }
                pending.resize(OPUS_FRAME_SAMPLES, 0.0);
            } else {
                was_muted = false;
                resampler.process(&source, &mut pending);
            }
            while pending.len() >= OPUS_FRAME_SAMPLES {
                let frame: Vec<f32> = pending.drain(..OPUS_FRAME_SAMPLES).collect();
                let size = match encoder.encode_float(&frame, &mut packet) {
                    Ok(size) => size,
                    Err(error) => {
                        let _ = events
                            .send(Event::Error {
                                message: format!("realtime microphone encoder failed: {error}"),
                            })
                            .await;
                        return;
                    }
                };
                if let Err(error) = track
                    .write_sample(&MediaSample {
                        data: Bytes::copy_from_slice(&packet[..size]),
                        duration: Duration::from_millis(20),
                        timestamp: Instant::now().into_std(),
                        packet_timestamp: 0,
                        prev_dropped_packets: 0,
                        prev_padding_packets: 0,
                    })
                    .await
                {
                    let _ = events
                        .send(Event::Error {
                            message: format!("realtime microphone stream failed: {error}"),
                        })
                        .await;
                    return;
                }
            }
        }
    })
}

async fn wait_for_playout(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
