use pretty_assertions::assert_eq;
use rstest::rstest;
use voice_host::resample::*;

#[rstest]
fn resamples_without_losing_stream_continuity() {
    let mut resampler = LinearResampler::new(48_000, 24_000).unwrap();
    let mut output = Vec::new();
    resampler.process(&[0.0, 1.0, 2.0], &mut output);
    resampler.process(&[3.0, 4.0], &mut output);
    assert_eq!(output, vec![0.0, 2.0]);
}
