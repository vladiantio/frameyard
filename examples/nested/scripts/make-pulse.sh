#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/assets/pulse.wav}"
mkdir -p "$(dirname "$out")"

ffmpeg -y -v error \
  -f lavfi \
  -i "sine=frequency=659.25:duration=1.8:sample_rate=24000" \
  -f lavfi \
  -i "sine=frequency=987.77:duration=1.8:sample_rate=24000" \
  -filter_complex "[0:a]volume=1.6,afade=t=in:st=0:d=0.012,afade=t=out:st=0.18:d=1.62[a0];[1:a]volume=0.7,afade=t=in:st=0:d=0.012,afade=t=out:st=0.3:d=1.5[a1];[a0][a1]amix=inputs=2:normalize=0,alimiter=limit=0.9[out]" \
  -map "[out]" \
  -ac 1 \
  -ar 24000 \
  -c:a pcm_s16le \
  "$out"

printf 'Wrote %s\n' "$out"
