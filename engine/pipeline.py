import os
import uuid

from . import ffmpeg_utils, transcribe
from .checks import (
    black_frames, media_offline, slipped_frames, effect_errors, subscribe_cta,
    curse_words, qr_code, sponsor_mention, giveaway, merch_plug,
)

CHECKS = {
    "black_frame": black_frames.run,
    "media_offline": media_offline.run,
    "slipped_frame": slipped_frames.run,
    "effect_error": effect_errors.run,
    "subscribe_cta": subscribe_cta.run,
    "curse_word": curse_words.run,
    "qr_code": qr_code.run,
    "sponsor_mention": sponsor_mention.run,
    "giveaway": giveaway.run,
    "merch_plug": merch_plug.run,
}

# Findings whose surrounding frame is worth a thumbnail. Transcript-based findings
# (curse words, sponsor/giveaway/merch mentions) have no relevant single frame.
_THUMBNAIL_TYPES = {"media_offline", "slipped_frame", "effect_error", "subscribe_cta", "qr_code"}

# Rough relative weight of each pipeline stage, used to compute a percent-complete
# estimate. These aren't measured -- just an approximation so the UI has something
# better than a spinner. Transcription (used by 4 checks) only runs once.
_STAGE_WEIGHTS = [
    ("probing video", 1),
    ("checking black frames", 7),
    ("checking media offline", 12),
    ("checking slipped frames", 9),
    ("checking effect errors", 13),
    ("checking subscribe cta", 13),
    ("checking qr codes", 8),
    ("transcribing audio", 22),
    ("checking curse words", 3),
    ("checking sponsor mentions", 3),
    ("checking giveaways", 3),
    ("checking merch plugs", 3),
    ("generating thumbnails", 3),
]


def analyze(video_path: str, thumbnail_dir: str, progress_cb=None) -> dict:
    """progress_cb(percent: int, stage: str) is called as work proceeds, if given."""
    os.makedirs(thumbnail_dir, exist_ok=True)

    done_weight = 0
    total_weight = sum(w for _, w in _STAGE_WEIGHTS)
    stage_i = 0

    def report():
        if progress_cb:
            stage_name = _STAGE_WEIGHTS[stage_i][0]
            progress_cb(round(100 * done_weight / total_weight), stage_name)

    def advance():
        nonlocal done_weight, stage_i
        done_weight += _STAGE_WEIGHTS[stage_i][1]
        stage_i += 1

    report()
    info = ffmpeg_utils.probe(video_path)
    advance()

    findings: list[dict] = []

    report()
    findings += black_frames.run(video_path)
    advance()

    report()
    findings += media_offline.run(video_path)
    advance()

    report()
    findings += slipped_frames.run(video_path)
    advance()

    report()
    findings += effect_errors.run(video_path)
    advance()

    report()
    findings += subscribe_cta.run(video_path)
    advance()

    report()
    findings += qr_code.run(video_path)
    advance()

    report()
    words = transcribe.transcribe_words(video_path)
    advance()

    report()
    findings += curse_words.run(video_path, words=words)
    advance()

    report()
    findings += sponsor_mention.run(video_path, words=words)
    advance()

    report()
    findings += giveaway.run(video_path, words=words)
    advance()

    report()
    findings += merch_plug.run(video_path, words=words)
    advance()

    report()
    findings.sort(key=lambda f: f["timestamp"])

    for f in findings:
        if f["type"] in _THUMBNAIL_TYPES:
            thumb_name = f"{uuid.uuid4().hex}.jpg"
            thumb_path = os.path.join(thumbnail_dir, thumb_name)
            try:
                ffmpeg_utils.extract_frame(video_path, f["timestamp"], thumb_path)
                f["thumbnail"] = thumb_name
            except Exception:
                f["thumbnail"] = None
        else:
            f["thumbnail"] = None
    advance()

    if progress_cb:
        progress_cb(100, "done")

    return {
        "video_info": info,
        "findings": findings,
        "summary": {
            check_type: sum(1 for f in findings if f["type"] == check_type)
            for check_type in CHECKS
        },
    }
