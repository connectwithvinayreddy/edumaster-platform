#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <input-video> <output-dir>" >&2
  echo "Example: $0 ./uploads/lesson.mp4 ./tmp/lesson-cmaf" >&2
  exit 1
fi

INPUT_VIDEO="$1"
OUTPUT_DIR="$2"
WORK_DIR="${OUTPUT_DIR}/_work"

if [[ ! -f "${INPUT_VIDEO}" ]]; then
  echo "Input video not found: ${INPUT_VIDEO}" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required. Install it first." >&2
  exit 1
fi

if ! command -v mp4dash >/dev/null 2>&1; then
  echo "Bento4 mp4dash is required. Install Bento4 and make mp4dash available on PATH." >&2
  exit 1
fi

mkdir -p "${WORK_DIR}"
mkdir -p "${OUTPUT_DIR}"

SOURCE_BASENAME="$(basename "${INPUT_VIDEO}")"
SOURCE_NAME="${SOURCE_BASENAME%.*}"

encode_variant() {
  local height="$1"
  local video_bitrate="$2"
  local max_rate="$3"
  local buffer_size="$4"
  local output_file="${WORK_DIR}/${SOURCE_NAME}-${height}p.mp4"

  ffmpeg -y -i "${INPUT_VIDEO}" \
    -map 0:v:0 -map 0:a? \
    -c:v libx264 -preset veryfast -profile:v main \
    -vf "scale=-2:${height}" \
    -b:v "${video_bitrate}" -maxrate "${max_rate}" -bufsize "${buffer_size}" \
    -g 48 -keyint_min 48 -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 \
    -movflags +faststart \
    "${output_file}"
}

echo "[free-video] encoding adaptive ladder"
encode_variant 360 800k 960k 1600k
encode_variant 480 1400k 1680k 2800k
encode_variant 720 2800k 3360k 5600k

echo "[free-video] packaging DASH + HLS with Bento4"
mp4dash \
  --force \
  --use-segment-timeline \
  --hls \
  --output-dir="${OUTPUT_DIR}" \
  "${WORK_DIR}/${SOURCE_NAME}-360p.mp4" \
  "${WORK_DIR}/${SOURCE_NAME}-480p.mp4" \
  "${WORK_DIR}/${SOURCE_NAME}-720p.mp4"

cat <<EOF

[free-video] packaging complete
Output directory: ${OUTPUT_DIR}

Generated manifests:
- DASH: ${OUTPUT_DIR}/stream.mpd
- HLS:  ${OUTPUT_DIR}/master.m3u8

This script creates a free adaptive ladder for testing.
It does not create a full production DRM workflow by itself.
EOF
