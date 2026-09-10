"""Shared local speech-to-text (faster-whisper) used by every transcript-based check
(curse words, sponsor mentions, giveaways, merch plugs). Transcribing is the slowest
step in the pipeline, so it runs exactly once per video and the word list is handed
to every check that needs it, rather than each check re-transcribing independently.
"""
import re

_MODEL_SIZE = "base"
_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(_MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


def transcribe_words(video_path: str) -> list[dict]:
    """Return a flat list of {start, end, word, probability} dicts for the whole video."""
    model = _get_model()
    segments, _info = model.transcribe(video_path, word_timestamps=True)

    words = []
    for segment in segments:
        for word in segment.words or []:
            words.append({
                "start": float(word.start),
                "end": float(word.end),
                "word": word.word,
                "probability": float(word.probability),
            })
    return words


_WORD_RE = re.compile(r"[a-z']+")


def keyword_findings(words: list[dict], keywords: set[str], finding_type: str, label_fn) -> list[dict]:
    """Scan a transcript's words for single-word keyword hits.

    label_fn(cleaned_word) -> str builds the finding's label from the matched word.
    """
    findings = []
    for w in words:
        match = _WORD_RE.search(w["word"].lower())
        if not match:
            continue
        cleaned = match.group().strip("'")
        if cleaned in keywords:
            findings.append({
                "type": finding_type,
                "timestamp": w["start"],
                "start": w["start"],
                "end": w["end"],
                "confidence": w["probability"],
                "label": label_fn(cleaned),
            })
    return findings
