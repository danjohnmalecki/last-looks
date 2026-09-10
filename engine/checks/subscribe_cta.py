"""Detect a 'Subscribe' call-to-action appearing somewhere in the frame.

Heuristic OCR-based approach (Tesseract via pytesseract): sample frames, run text
detection, and flag any frame containing the word "SUBSCRIBE" (or "SUBSCRIBED").
This catches most on-screen CTA graphics/text but will miss purely iconographic
CTAs with no text, and can be fooled by verbal on-screen captions that happen to
say "subscribe". Treat hits as candidates to confirm visually.
"""
import cv2
import pytesseract

_TARGET_WIDTH = 1280  # downscale for OCR speed; CTA text is normally large/legible
_KEYWORDS = ("SUBSCRIBE", "SUBSCRIBED")


def _contains_subscribe(frame) -> tuple[bool, float]:
    h, w = frame.shape[:2]
    if w > _TARGET_WIDTH:
        scale = _TARGET_WIDTH / w
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)))

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    data = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT)

    best_conf = 0.0
    hit = False
    for text, conf in zip(data["text"], data["conf"]):
        word = text.strip().upper()
        if any(kw in word for kw in _KEYWORDS):
            hit = True
            try:
                best_conf = max(best_conf, float(conf) / 100.0)
            except (TypeError, ValueError):
                pass
    return hit, max(best_conf, 0.5 if hit else 0.0)


def run(video_path: str, sample_fps: float = 0.5) -> list[dict]:
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
            hit, confidence = _contains_subscribe(frame)
            if hit:
                findings.append({
                    "type": "subscribe_cta",
                    "timestamp": timestamp,
                    "start": timestamp,
                    "end": timestamp,
                    "confidence": confidence,
                    "label": "Possible 'Subscribe' CTA detected",
                })
        frame_idx += 1
    cap.release()
    return _merge_adjacent(findings, gap=2.0)


def _merge_adjacent(findings: list[dict], gap: float) -> list[dict]:
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
