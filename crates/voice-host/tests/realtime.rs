use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use pretty_assertions::assert_eq;
use rstest::rstest;
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{Notify, mpsc};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCIceGatheringState, RTCSessionDescription, Registry, register_default_interceptors,
};

struct RemotePeer {
    channels: mpsc::UnboundedSender<Arc<dyn DataChannel>>,
    audio: mpsc::UnboundedSender<rtc::rtp::Packet>,
    gathered: Arc<Notify>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for RemotePeer {
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let _ = self.channels.send(channel);
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let audio = self.audio.clone();
        tokio::spawn(async move {
            while let Some(event) = track.poll().await {
                if let TrackRemoteEvent::OnRtpPacket(packet) = event {
                    let _ = audio.send(packet);
                }
            }
        });
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.gathered.notify_one();
        }
    }
}

async fn send(input: &mut ChildStdin, message: Value) -> Result<()> {
    input
        .write_all(serde_json::to_string(&message)?.as_bytes())
        .await?;
    input.write_all(b"\n").await?;
    input.flush().await?;
    Ok(())
}

async fn event(output: &mut Lines<BufReader<ChildStdout>>, kind: &str) -> Result<Value> {
    while let Some(line) = output.next_line().await? {
        let value: Value = serde_json::from_str(&line)?;
        if value["type"] == "error" {
            bail!("voice helper failed: {}", value["message"]);
        }
        if value["type"] == kind {
            return Ok(value);
        }
    }
    bail!("voice helper closed before {kind}");
}

#[rstest]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn realtime_bridge_exchanges_data_and_opus_audio_over_a_real_peer_connection() -> Result<()> {
    let (channels_tx, mut channels_rx) = mpsc::unbounded_channel();
    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel();
    let gathered = Arc::new(Notify::new());
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;
    let peer = Box::pin(
        PeerConnectionBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .with_handler(Arc::new(RemotePeer {
                channels: channels_tx,
                audio: audio_tx,
                gathered: gathered.clone(),
            }))
            .build(),
    )
    .await?;
    let mut child = Command::new(env!("CARGO_BIN_EXE_voice-host"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;

    let stage = std::cell::Cell::new("start helper");
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut input = child.stdin.take().context("voice helper stdin")?;
        let mut output =
            BufReader::new(child.stdout.take().context("voice helper stdout")?).lines();
        event(&mut output, "ready").await?;
        send(&mut input, json!({"type":"start_v3_bridge"})).await?;
        stage.set("create offer");
        let offer = event(&mut output, "offer").await?;
        peer.set_remote_description(RTCSessionDescription::offer(
            offer["sdp"].as_str().context("offer SDP")?.to_owned(),
        )?)
        .await?;

        let track = Arc::new(TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "remote".into(),
                "audio".into(),
                "audio".into(),
                RtpCodecKind::Audio,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(123_456),
                        ..Default::default()
                    },
                    codec: RTCRtpCodec {
                        mime_type: "audio/opus".into(),
                        clock_rate: 48_000,
                        channels: 2,
                        sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
                        ..Default::default()
                    },
                    ..Default::default()
                }],
            ),
        )?);
        peer.add_track(track.clone())
            .await
            .context("add remote audio track")?;
        peer.set_local_description(peer.create_answer(None).await?)
            .await?;
        stage.set("gather answer candidates");
        gathered.notified().await;
        let answer = peer.local_description().await.context("answer SDP")?;
        send(&mut input, json!({"type":"apply_answer","sdp":answer.sdp})).await?;
        stage.set("open data channel");
        let channel = channels_rx.recv().await.context("remote data channel")?;
        while let Some(event) = channel.poll().await {
            if matches!(event, DataChannelEvent::OnOpen) {
                break;
            }
        }
        while event(&mut output, "state").await?["state"] != "ready" {}

        stage.set("exchange data");
        let message = json!({"fixture":"from-host"});
        send(&mut input, json!({"type":"send_data","message":message})).await?;
        loop {
            let next = channel.poll().await.context("data from voice helper")?;
            if let DataChannelEvent::OnMessage(data) = next {
                assert_eq!(serde_json::from_slice::<Value>(&data.data)?, message);
                break;
            }
        }
        channel.send_text(r#"{"fixture":"from-peer"}"#).await?;
        assert_eq!(
            event(&mut output, "data").await?["message"],
            json!({"fixture":"from-peer"})
        );

        send(
            &mut input,
            json!({
                "type":"send_pcm", "audio":BASE64.encode(vec![0_u8; 9_600]),
                "sample_rate":24_000, "num_channels":1
            }),
        )
        .await?;
        stage.set("receive microphone RTP");
        let packet = tokio::select! {
            packet = audio_rx.recv() => packet.context("encoded microphone audio")?,
            unexpected = event(&mut output, "pcm") => bail!("unexpected speaker event before remote audio: {}", unexpected?),
        };
        let mut decoder = opus::Decoder::new(48_000, opus::Channels::Mono)?;
        assert_eq!(
            decoder.decode_float(&packet.payload, &mut vec![0_f32; 5_760], false)?,
            960
        );

        let mut encoder =
            opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip)?;
        let mut encoded = [0_u8; 4_000];
        let len = encoder.encode_float(&[0_f32; 960], &mut encoded)?;
        for _ in 0..4 {
            track
                .write_sample(
                    123_456,
                    111,
                    &Sample {
                        data: Bytes::copy_from_slice(&encoded[..len]),
                        timestamp: Instant::now(),
                        duration: Duration::from_millis(20),
                        packet_timestamp: 0,
                        prev_dropped_packets: 0,
                        prev_padding_packets: 0,
                    },
                    &[],
                )
                .await?;
        }
        stage.set("receive speaker PCM");
        let pcm = event(&mut output, "pcm").await?;
        assert_eq!(pcm["sample_rate"], 24_000);
        assert_eq!(pcm["num_channels"], 1);
        assert_eq!(
            BASE64
                .decode(pcm["audio"].as_str().context("speaker PCM")?)?
                .len(),
            960
        );
        send(&mut input, json!({"type":"shutdown"})).await?;
        anyhow::ensure!(
            child.wait().await?.success(),
            "voice helper failed to shut down"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;

    let _ = child.kill().await;
    let _ = child.wait().await;
    peer.close().await?;
    result.with_context(|| format!("local realtime bridge timed out during {}", stage.get()))??;
    Ok(())
}
