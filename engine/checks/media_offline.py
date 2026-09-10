"""Detect Premiere Pro 'Media Offline' red placeholder cards (and, as a lower-confidence
side effect, generic mostly-solid-background-with-text frames that may be AE effect errors).

Real Media Offline cards render as a red/maroon vertical gradient (bright pink-red at
top fading to dark maroon at bottom), not a flat color -- so detection is done in HSV,
where hue stays stable across the gradient's brightness range even though raw BGR does
not.
"""
import cv2
import numpy as np

# Red hue wraps around 0/180 in OpenCV's 0-179 hue range. Require decent saturation so
# we don't match desaturated grays/whites, and a value floor/ceiling to exclude pure
# white text and near-black shadow pixels.
_HUE_MAX_LOW = 12
_HUE_MIN_HIGH = 168
_SAT_MIN = 60
_VAL_MIN = 30
_VAL_MAX = 235

_RED_COVERAGE_THRESHOLD = 0.5


def _red_coverage(frame: "cv2.Mat") -> float:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    mask = ((h <= _HUE_MAX_LOW) | (h >= _HUE_MIN_HIGH)) & (s >= _SAT_MIN) & (v >= _VAL_MIN) & (v <= _VAL_MAX)
    return float(np.count_nonzero(mask)) / mask.size


def run(video_path: str, sample_fps: float = 1.0) -> list[dict]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = max(1, round(src_fps / sample_fps))

    findings = []
    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx % frame_interval == 0:
            timestamp = frame_idx / src_fps
            coverage = _red_coverage(frame)
            if coverage > _RED_COVERAGE_THRESHOLD:
                findings.append({
                    "type": "media_offline",
                    "timestamp": timestamp,
                    "start": timestamp,
                    "end": timestamp,
                    "confidence": min(1.0, coverage),
                    "label": "Possible Media Offline card",
                })
        frame_idx += 1
    cap.release()
    return _merge_adjacent(findings, gap=2.0)


def _merge_adjacent(findings: list[dict], gap: float) -> list[dict]:
    """Collapse consecutive sampled hits into single ranges so a 5s offline card
    doesn't produce 5 separate findings."""
    if not findings:
        return []
    findings.sort(key=lambda f: f["timestamp"])
    merged = [dict(findings[0])]
    for f in findings[1:]:
        last = merged[-1]
        if f["timestamp"] - last["end"] <= gap:
            last["end"] = f["timestamp"]
            last["confidence"] = max(last["confidence"], f["confidence"])
        else:
            merged.append(dict(f))
    return merged
