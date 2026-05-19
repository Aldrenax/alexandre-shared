#!/usr/bin/env python3
"""Local CPU transcription with faster-whisper.

Usage:
    python3 transcribe.py <audio_path> [language] [model]

  - language: ISO 639-1 code (default: fr)
  - model:    faster-whisper checkpoint name
              (default: small  — best speed/quality balance for CPU)
              Other valid: tiny, base, small, medium, large-v3, large-v3-turbo, distil-large-v3

Prints transcript text to stdout. Progress to stderr.
"""
from __future__ import annotations

import os
import sys
import time

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio_path> [language] [model]", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "fr"
    model_name = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("WHISPER_MODEL", "small")
    compute_type = os.environ.get("WHISPER_COMPUTE", "int8")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("error: faster-whisper not installed. Run: pip3 install --user faster-whisper", file=sys.stderr)
        return 3

    print(f"[transcribe] model={model_name} compute={compute_type} lang={language}", file=sys.stderr)
    t0 = time.time()
    model = WhisperModel(model_name, device="cpu", compute_type=compute_type)
    print(f"[transcribe] model loaded in {time.time() - t0:.1f}s", file=sys.stderr)

    t1 = time.time()
    segments, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=1,
        best_of=1,
        condition_on_previous_text=False,
    )

    parts = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            parts.append(text)
    elapsed = time.time() - t1
    print(f"[transcribe] {len(parts)} segments, {elapsed:.1f}s, duration={info.duration:.0f}s, language_probability={info.language_probability:.2f}", file=sys.stderr)
    sys.stdout.write(" ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
