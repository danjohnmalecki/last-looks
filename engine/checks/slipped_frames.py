"""Flag candidate 'slipped frame' cuts: shots so short they look like an overlay was
cut too short and briefly reveals the frame underneath. Heuristic, high false-positive
rate by nature -- flagged as candidates for human review, not certainties.
"""
from .. import ffmpeg_utils

# A shot shorter than this is suspicious -- a clean edit rarely holds a frame for
# less than a few frames' worth of time.
_SHORT_SHOT_THRESHOLD = 0.15  # seconds


def run(video_path: str, scene_threshold: float = 0.4) -> list[dict]:
    info = ffmpeg_utils.probe(video_path)
    duration = info["duration"]
    cuts = sorted(ffmpeg_utils.run_scenecuts(video_path, threshold=scene_threshold))
    if not cuts:
        return []

    boundaries = [0.0] + cuts + [duration]
    findings = []
    for i in range(1, len(boundaries) - 1):
        shot_start = boundaries[i]
        shot_end = boundaries[i + 1]
        shot_len = shot_end - shot_start
        if shot_len < _SHORT_SHOT_THRESHOLD:
            confidence = max(0.1, 1.0 - (shot_len / _SHORT_SHOT_THRESHOLD))
            findings.append({
                "type": "slipped_frame",
                "timestamp": shot_start,
                "start": shot_start,
                "end": shot_end,
                "confidence": round(confidence, 2),
                "label": f"Very short shot ({shot_len:.3f}s) -- possible slipped/reveal frame",
            })
    return findings
