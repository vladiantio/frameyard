#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/assets/ink.mp4}"
mkdir -p "$(dirname "$out")"

ffmpeg -y -v error \
  -f lavfi \
  -i "gradients=size=1280x720:rate=30:c0=0x0b1020:c1=0x1b4dff:c2=0xff2d7a:c3=0xffb347:n=4:type=spiral:speed=0.08:duration=12" \
  -f lavfi \
  -i "anullsrc=channel_layout=stereo:sample_rate=48000" \
  -t 12 \
  -map 0:v:0 \
  -map 1:a:0 \
  -c:v libx264 \
  -preset medium \
  -crf 20 \
  -pix_fmt yuv420p \
  -g 30 \
  -c:a aac \
  -b:a 96k \
  -shortest \
  "$out"

printf 'Wrote %s\n' "$out"
