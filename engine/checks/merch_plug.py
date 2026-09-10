"""Detect a spoken merch plug, using the shared transcript."""
from .. import transcribe

_KEYWORDS = {
    "merch", "merchandise", "hoodie", "hoodies",
}


def run(video_path: str, words: list[dict] | None = None) -> list[dict]:
    if words is None:
        words = transcribe.transcribe_words(video_path)
    return transcribe.keyword_findings(
        words, _KEYWORDS, "merch_plug",
        label_fn=lambda w: f'Possible merch plug: "{w}"',
    )
