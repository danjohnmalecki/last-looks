"""Detect a spoken giveaway mention, using the shared transcript."""
from .. import transcribe

_KEYWORDS = {
    "giveaway", "giveaways",
}


def run(video_path: str, words: list[dict] | None = None) -> list[dict]:
    if words is None:
        words = transcribe.transcribe_words(video_path)
    return transcribe.keyword_findings(
        words, _KEYWORDS, "giveaway",
        label_fn=lambda w: f'Possible giveaway mention: "{w}"',
    )
