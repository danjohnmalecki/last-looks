from .. import ffmpeg_utils


def run(video_path: str, min_duration: float = 0.1) -> list[dict]:
    ranges = ffmpeg_utils.run_blackdetect(video_path, min_duration=min_duration)
    findings = []
    for r in ranges:
        findings.append({
            "type": "black_frame",
            "start": r["start"],
            "end": r["end"],
            "timestamp": r["start"],
            "confidence": 1.0,
            "label": f"Black frames for {r['duration']:.2f}s",
        })
    return findings
