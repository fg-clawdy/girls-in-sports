#!/usr/bin/env python3
"""
Beat Detection for Girls In Sports (GIS)
Uses librosa to detect BPM and beat timestamps in audio/video files.

Usage:
    python analyze_beats.py <video_or_audio_path>

Output (JSON to stdout):
    {
        "bpm": float,
        "beatTimestamps": [float, ...],
        "confidence": float  // 0-1 beat strength
    }
"""

import sys
import json
import os


def analyze_beats(file_path: str) -> dict:
    import librosa
    import numpy as np

    # Load audio (librosa handles both audio and video files)
    y, sr = librosa.load(file_path, sr=None, mono=True)

    # Get tempo (BPM) — use the newer API if available
    try:
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        if isinstance(tempo, np.ndarray):
            bpm = float(tempo[0])
        else:
            bpm = float(tempo)
    except Exception:
        # Fallback for older/newer API variations
        tempo = librosa.beat.beat_track(y=y, sr=sr)
        if isinstance(tempo, tuple):
            bpm = float(tempo[0] if isinstance(tempo[0], (int, float)) else tempo[0][0])
        else:
            bpm = float(tempo)

    # Get beat frames and convert to timestamps
    _, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_timestamps = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    # Calculate average beat strength (onset envelope at beat frames)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    if len(beat_frames) > 0 and len(onset_env) > 0:
        # Map beat frames to onset envelope indices safely
        beat_onset_strengths = []
        for bf in beat_frames:
            idx = min(int(bf), len(onset_env) - 1)
            beat_onset_strengths.append(onset_env[idx])
        avg_strength = float(np.mean(beat_onset_strengths))
        max_strength = float(np.max(onset_env)) if len(onset_env) > 0 else 1.0
        confidence = min(avg_strength / max_strength, 1.0) if max_strength > 0 else 0.5
    else:
        confidence = 0.5

    return {
        "bpm": round(bpm, 2),
        "beatTimestamps": [round(t, 3) for t in beat_timestamps],
        "confidence": round(confidence, 3),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python analyze_beats.py <file_path>"}), file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}), file=sys.stderr)
        sys.exit(1)

    try:
        result = analyze_beats(file_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
