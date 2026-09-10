"""Detect and decode QR codes appearing on-screen, confirming they actually scan.

Uses OpenCV's built-in QRCodeDetector (no extra dependency). A successful decode
means the code is confirmed scannable and readable at that frame's resolution --
this is the same thing a phone camera would confirm. The decoded payload (usually
a URL) is carried on the finding as `url` so it can be rendered as a clickable link.
"""
import cv2

_detector = cv2.QRCodeDetector()


def run(video_path: str, sample_fps: float = 2.0) -> list[dict]:
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
            try:
                data, _points, _straight = _detector.detectAndDecode(frame)
            except cv2.error:
                data = ""
            if data:
                findings.append({
                    "type": "qr_code",
                    "timestamp": timestamp,
                    "start": timestamp,
                    "end": timestamp,
                    "confidence": 1.0,
                    "label": "QR code confirmed scannable",
                    "url": data,
                })
        frame_idx += 1
    cap.release()
    return _merge_adjacent(findings, gap=2.0)


def _merge_adjacent(findings: list[dict], gap: float) -> list[dict]:
    """Collapse consecutive hits into ranges, but only when the decoded payload
    matches -- a QR code changing mid-video should stay as separate findings."""
    if not findings:
        return []
    findings.sort(key=lambda f: f["timestamp"])
    merged = [dict(findings[0])]
    for f in findings[1:]:
        last = merged[-1]
        if f["url"] == last["url"] and f["timestamp"] - last["end"] <= gap:
            last["end"] = f["timestamp"]
        else:
            merged.append(dict(f))
    return merged
