use std::env;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::imageops::FilterType;
use image::{GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};

// Deliberate sanity limit. Raise it only if the model input boundary accepts larger images.
const MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_HIGH_DETAIL_DIMENSION: u32 = 2048;

#[derive(Deserialize)]
struct ViewImageArgs {
    path: String,
    detail: Option<String>,
}

#[derive(Serialize)]
struct ViewImageOutput {
    image_url: String,
    detail: String,
    path: PathBuf,
    width: u32,
    height: u32,
    bytes: usize,
}

pub fn run() -> anyhow::Result<()> {
    let ViewImageArgs { path, detail } = parse_args()?;
    let detail = match detail.as_deref() {
        None | Some("high") => "high",
        Some("original") => "original",
        Some(detail) => bail!(
            "view_image.detail only supports `high` or `original`; omit `detail` for default high resized behavior, got `{detail}`"
        ),
    };

    let path = absolute_path(&path)?;
    let metadata = fs::metadata(&path)
        .with_context(|| format!("unable to locate image at `{}`", path.display()))?;
    if !metadata.is_file() {
        bail!("image path `{}` is not a file", path.display());
    }
    if metadata.len() > MAX_INPUT_BYTES {
        bail!(
            "image at `{}` is too large ({} bytes; max {MAX_INPUT_BYTES} bytes)",
            path.display(),
            metadata.len()
        );
    }

    let source =
        fs::read(&path).with_context(|| format!("unable to read image at `{}`", path.display()))?;
    let format = image::guess_format(&source)
        .with_context(|| format!("unable to process image at `{}`", path.display()))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        bail!("unsupported image format at `{}`", path.display());
    }
    let decoded = image::load_from_memory_with_format(&source, format)
        .with_context(|| format!("unable to process image at `{}`", path.display()))?;
    let source_dimensions = decoded.dimensions();
    let decoded = if detail == "high"
        && (source_dimensions.0 > MAX_HIGH_DETAIL_DIMENSION
            || source_dimensions.1 > MAX_HIGH_DETAIL_DIMENSION)
    {
        decoded.resize(
            MAX_HIGH_DETAIL_DIMENSION,
            MAX_HIGH_DETAIL_DIMENSION,
            FilterType::Triangle,
        )
    } else {
        decoded
    };
    let (width, height) = decoded.dimensions();
    let resized = (width, height) != source_dimensions;
    let (bytes, mime_type) = match format {
        ImageFormat::Png if !resized => (source, "image/png"),
        ImageFormat::Jpeg if !resized => (source, "image/jpeg"),
        ImageFormat::WebP if !resized => (source, "image/webp"),
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif => {
            let mut png = Cursor::new(Vec::new());
            decoded
                .write_to(&mut png, ImageFormat::Png)
                .context("unable to encode image as PNG")?;
            (png.into_inner(), "image/png")
        }
        _ => unreachable!("unsupported image formats were rejected above"),
    };
    let bytes_len = bytes.len();
    let encoded = BASE64_STANDARD.encode(bytes);
    let output = ViewImageOutput {
        image_url: format!("data:{mime_type};base64,{encoded}"),
        detail: detail.to_string(),
        path,
        width,
        height,
        bytes: bytes_len,
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

fn parse_args() -> anyhow::Result<ViewImageArgs> {
    let mut args = env::args().skip(1);
    let input = match args.next() {
        None => read_stdin()?,
        Some(first) if first == "-" => {
            if args.next().is_some() {
                bail!("view_image accepts a single JSON argument or stdin");
            }
            read_stdin()?
        }
        Some(first) => {
            if args.next().is_some() {
                bail!("view_image accepts a single JSON argument or stdin");
            }
            first
        }
    };
    if input.trim().is_empty() {
        bail!("view_image requires JSON arguments");
    }
    serde_json::from_str(input.trim()).context("failed to parse view_image JSON arguments")
}

fn read_stdin() -> anyhow::Result<String> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("failed to read view_image JSON arguments from stdin")?;
    Ok(input)
}

fn absolute_path(path: &str) -> anyhow::Result<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(env::current_dir()?.join(path))
    }
}
