#!/usr/bin/env bash
#
# Regenerate examples/video/assets/clip.webm and clip.mp4.
#
# The visual is a procedural gradient field warped by two sinusoidal
# displacement maps. The audio is an additive sine pad with pink-noise air.
# Fixed seeds keep the generated grain stable across runs on the same FFmpeg.
#
# Requires FFmpeg with libvpx-vp9, libx264, Opus, and AAC support.
#
# Usage:
#   examples/video/scripts/make-clip.sh
#   examples/video/scripts/make-clip.sh --out-dir /tmp/frameyard-clip

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: make-clip.sh [--out-dir <directory>]

Writes clip.webm (VP9 + Opus) and clip.mp4 (H.264 + AAC) to
examples/video/assets by default.
EOF
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
out_dir="$(cd -- "$script_dir/.." && pwd)/assets"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir)
      if [ "$#" -lt 2 ]; then
        echo "make-clip: --out-dir requires a directory." >&2
        usage >&2
        exit 2
      fi
      out_dir="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "make-clip: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "make-clip: $tool is required on PATH." >&2
    exit 1
  fi
done

mkdir -p "$out_dir"
out_dir="$(cd -- "$out_dir" && pwd)"
work_dir="$(mktemp -d "$out_dir/.make-clip.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

# 12 seconds of a slow circular gradient, warped by two radial sine/cosine
# displacement maps. Scaling up and cropping hides the displacement edges.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "gradients=s=1280x720:r=30:d=12:c0=0x071827:c1=0x0d3a3a:c2=0x2f8a7e:c3=0xffd7a0:c4=0x123a58:c5=0x8fe6c8:n=6:type=circular:speed=0.02:seed=9" \
  -f lavfi -i "nullsrc=s=1280x720:r=30:d=12,geq=lum='128+72*sin(hypot(X-640,Y-360)/42-T*0.55)':cb=128:cr=128" \
  -f lavfi -i "nullsrc=s=1280x720:r=30:d=12,geq=lum='128+68*cos(hypot(X-640,Y-360)/55+T*0.47)':cb=128:cr=128" \
  -filter_complex "[0:v][1:v][2:v]displace=edge=smear,scale=1440:810,crop=1280:720,gblur=sigma=6,eq=contrast=1.26:brightness=0.015:saturation=1.06,noise=alls=4:allf=t+u:all_seed=7,vignette=PI/3.6,format=yuv420p[v]" \
  -map "[v]" -t 12 -an \
  -c:v libvpx-vp9 -crf 31 -b:v 0 -row-mt 1 -tile-columns 2 -cpu-used 2 -g 60 \
  "$work_dir/clip-video.webm"

# A slow A-minor-ish pad with movement from chorus/echo and a filtered
# pink-noise bed. The clip fades in and out so the timeline edit is soft.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=exprs='0.24*sin(2*PI*110*t)+0.12*sin(2*PI*164.81*t)+0.10*sin(2*PI*220*t)*(0.8+0.2*sin(2*PI*0.07*t))+0.06*sin(2*PI*261.63*t)+0.04*sin(2*PI*329.63*t)+0.018*sin(2*PI*440*t)':s=48000:d=12" \
  -f lavfi -i "anoisesrc=color=pink:sample_rate=48000:duration=12:amplitude=0.08:seed=7" \
  -filter_complex "[0:a]chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.3:2|1.3,aecho=0.8:0.6:280|520:0.25|0.16,lowpass=f=4200,volume=0.9[pad];[1:a]lowpass=f=700,volume=0.075[air];[pad][air]amix=inputs=2:duration=longest:normalize=0,afade=t=in:st=0:d=2,afade=t=out:st=9.4:d=2.6,alimiter=limit=0.9,pan=stereo|c0=c0|c1=c0[a]" \
  -map "[a]" -t 12 -c:a libopus -b:a 96k \
  "$work_dir/clip-audio.webm"

ffmpeg -hide_banner -loglevel error -y \
  -i "$work_dir/clip-video.webm" \
  -i "$work_dir/clip-audio.webm" \
  -map 0:v:0 -map 1:a:0 -c copy \
  "$work_dir/clip.webm"

# The MP4 variant is a transcode of the WebM source with the same timeline.
ffmpeg -hide_banner -loglevel error -y \
  -i "$work_dir/clip.webm" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -g 60 \
  -c:a aac -b:a 128k -movflags +faststart \
  "$work_dir/clip.mp4"

for file in "$work_dir/clip.webm" "$work_dir/clip.mp4"; do
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,width,height,r_frame_rate \
    -of default=noprint_wrappers=1 "$file" >/dev/null
  ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
    -of default=noprint_wrappers=1 "$file" >/dev/null
done

mv -f "$work_dir/clip.webm" "$out_dir/clip.webm"
mv -f "$work_dir/clip.mp4" "$out_dir/clip.mp4"

echo "Wrote $out_dir/clip.webm (VP9 + Opus)"
echo "Wrote $out_dir/clip.mp4 (H.264 + AAC)"
