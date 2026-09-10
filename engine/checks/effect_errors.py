"""Detect likely effect/render errors.

Primary signal: error-banner text. Premiere/AE render and effect failures commonly
show as a horizontal colored banner across the frame with text like
"Failure: Can't apply to a single clip", "Error", or "Unsupported". Full-frame OCR
is unreliable here -- busy video content reads as noise to Tesseract -- so instead
we scan each frame's row-wise saturation/brightness profile for a solid-color band
(the banner), crop just that band, threshold it to isolate the bright text from the
colored background, and OCR the crop. This is far more reliable than full-frame OCR
and works regardless of the banner's color.

Secondary signals (color/pattern heuristics, since we don't have a full set of real
example frames to build from):
- Magenta/pink placeholder: some renderers flag missing effects/media with a flat
  magenta or hot-pink card, distinct from Premiere's red Media Offline card.
- Transparency checkerboard: missing/unrendered layers sometimes render as a gray
  alpha checker grid, detected via OpenCV's chessboard-corner finder.

All three are candidate-only -- revisit and retune as real example frames turn up.
"""
import cv2
import numpy as np
import pytesseract

_ERROR_KEYWORDS = (
    "FAILURE", "CAN'T APPLY", "CANT APPLY", "UNSUPPORTED", "UNRENDERED",
    "RENDER ERROR", "RENDERING ERROR", "EFFECT ERROR", "MISSING EFFECT",
    "PLUGIN", "CODEC ERROR", "ERROR:",
)

# A banner row: solid, fairly saturated/bright color spanning most of the frame.
_BAND_SAT_MIN = 90
_BAND_VAL_MIN = 60
_BAND_MIN_HEIGHT = 15
_BAND_MAX_HEIGHT_RATIO = 0.15  # ignore bands taller than this fraction of frame height
_BAND_TEXT_THRESHOLD = 180  # brightness cutoff to isolate light text from the band

_CHECKER_SIZES = [(7, 7), (4, 4)]
_CHECKER_SCALE_WIDTH = 640

_MAGENTA_HUE_LOW = 135
_MAGENTA_HUE_HIGH = 165
_SAT_MIN = 80
_VAL_MIN = 80
_MAGENTA_COVERAGE_THRESHOLD = 0.5


def _find_banner_bands(hsv) -> list[tuple[int, int]]:
    s = hsv[:, :, 1].astype(np.float32)
    v = hsv[:, :, 2].astype(np.float32)
    row_hit = (s.mean(axis=1) > _BAND_SAT_MIN) & (v.mean(axis=1) > _BAND_VAL_MIN)

    bands = []
    start = None
    h = len(row_hit)
    max_height = h * _BAND_MAX_HEIGHT_RATIO
    for y, hit in enumerate(row_hit):
        if hit and start is None:
            start = y
        elif not hit and start is not None:
            if _BAND_MIN_HEIGHT <= (y - start) <= max_height:
                bands.append((start, y))
            start = None
    if start is not None and _BAND_MIN_HEIGHT <= (h - start) <= max_height:
        bands.append((start, h))
    return bands


def _banner_text_hit(frame, hsv) -> tuple[bool, float]:
    h = frame.shape[0]
    for y0, y1 in _find_banner_bands(hsv):
        pad = 6
        crop = frame[max(0, y0 - pad):min(h, y1 + pad), :]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, _BAND_TEXT_THRESHOLD, 255, cv2.THRESH_BINARY)
        text = pytesseract.image_to_string(thresh, config="--psm 6").upper()
        for kw in _ERROR_KEYWORDS:
            if kw in text:
                return True, 0.85
    return False, 0.0


def _has_checkerboard(frame) -> bool:
    h, w = frame.shape[:2]
    if w > _CHECKER_SCALE_WIDTH:
        scale = _CHECKER_SCALE_WIDTH / w
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    for size in _CHECKER_SIZES:
        found, _ = cv2.findChessboardCorners(gray, size, flags=cv2.CALIB_CB_FAST_CHECK)
        if found:
            return True
    return False


def _magenta_coverage(hsv) -> float:
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    mask = (h >= _MAGENTA_HUE_LOW) & (h <= _MAGENTA_HUE_HIGH) & (s >= _SAT_MIN) & (v >= _VAL_MIN)
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
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

            text_hit, text_conf = _banner_text_hit(frame, hsv)
            magenta_ratio = _magenta_coverage(hsv)

            if text_hit:
                findings.append({
                    "type": "effect_error",
                    "timestamp": timestamp,
                    "start": timestamp,
                    "end": timestamp,
                    "confidence": text_conf,
                    "label": "Possible effect error (error banner text detected)",
                })
            elif magenta_ratio > _MAGENTA_COVERAGE_THRESHOLD:
                findings.append({
                    "type": "effect_error",
                    "timestamp": timestamp,
                    "start": timestamp,
                    "end": timestamp,
                    "confidence": min(1.0, magenta_ratio),
                    "label": "Possible effect error (magenta/missing-media card)",
                })
            elif _has_checkerboard(frame):
                findings.append({
                    "type": "effect_error",
                    "timestamp": timestamp,
                    "start": timestamp,
                    "end": timestamp,
                    "confidence": 0.4,
                    "label": "Possible effect error (transparency checkerboard)",
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
