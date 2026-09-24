use bytes::Bytes;
use tokio::time::{Duration, Instant};

use pretty_assertions::assert_eq;
use rstest::rstest;
use voice_host::playout::*;

fn packet(value: u8) -> Bytes {
    Bytes::from(vec![value])
}

#[rstest]
fn reorders_packets_and_conceals_a_known_gap() {
    let mut playout = PacketPlayout::new();
    playout.push(12, packet(12));
    playout.push(10, packet(10));
    playout.push(11, packet(11));
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(10)));
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(11)));
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(12)));

    let mut gap = PacketPlayout::new();
    gap.push(20, packet(20));
    gap.push(22, packet(22));
    gap.push(23, packet(23));
    assert_eq!(gap.next_frame(), PlayoutFrame::Packet(packet(20)));
    assert_eq!(gap.next_frame(), PlayoutFrame::Missing);
    assert_eq!(gap.next_frame(), PlayoutFrame::Packet(packet(22)));
}

#[rstest]
fn rejects_duplicates_and_orders_across_sequence_wrap() {
    let mut playout = PacketPlayout::new();
    playout.push(u16::MAX, packet(1));
    playout.push(0, packet(2));
    playout.push(0, packet(9));
    playout.push(1, packet(3));
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(1)));
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(2)));
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(3)));
    playout.push(0, packet(4));
    assert_eq!(playout.next_frame(), PlayoutFrame::Buffering);
}

#[rstest]
fn resynchronizes_after_a_gap_larger_than_the_playout_window() {
    let mut playout = PacketPlayout::new();
    for sequence in 10..=12 {
        playout.push(sequence, packet(sequence as u8));
    }
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(10)));
    for sequence in 30..=32 {
        playout.push(sequence, packet(sequence as u8));
    }
    assert_eq!(playout.next_frame(), PlayoutFrame::Packet(packet(30)));
}

#[rstest]
fn retains_every_packet_at_the_inclusive_window_boundary() {
    let mut playout = PacketPlayout::new();
    for sequence in 10..=16 {
        playout.push(sequence, packet(sequence as u8));
    }
    for sequence in 10..=16 {
        assert_eq!(
            playout.next_frame(),
            PlayoutFrame::Packet(packet(sequence as u8))
        );
    }
}

#[rstest]
fn opus_decoder_conceals_one_missing_twenty_millisecond_frame() {
    let mut encoder =
        opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip).unwrap();
    let mut encoded = vec![0_u8; 4_000];
    let size = encoder.encode_float(&vec![0.1; 960], &mut encoded).unwrap();
    let mut decoder = opus::Decoder::new(48_000, opus::Channels::Stereo).unwrap();
    let mut decoded = vec![0.0; 960 * 2];
    assert_eq!(
        decoder
            .decode_float(&encoded[..size], &mut decoded, false)
            .unwrap(),
        960
    );
    assert_eq!(decoder.decode_float(&[], &mut decoded, false).unwrap(), 960);
}

#[rstest]
fn playout_clock_preserves_media_time_across_a_coarse_wake() {
    let start = Instant::now();
    let mut clock = PlayoutClock::new();
    clock.start(start);
    clock.advance(960, 48_000);

    let coarse_wake = start + Duration::from_millis(31);
    assert!(clock.deadline().unwrap() <= coarse_wake);

    clock.advance(960, 48_000);
    assert_eq!(clock.deadline(), Some(start + Duration::from_millis(40)));
    assert!(clock.deadline().unwrap() > coarse_wake);
}
