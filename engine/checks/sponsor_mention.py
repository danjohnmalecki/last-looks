"""Detect a spoken sponsor mention, using the shared transcript."""
from .. import transcribe

_KEYWORDS = {
    "sponsor", "sponsors", "sponsored", "sponsoring", "sponsorship",
}


def run(video_path: str, words: list[dict] | None = None) -> list[dict]:
    if words is None:
        words = transcribe.transcribe_words(video_path)
    return transcribe.keyword_findings(
        words, _KEYWORDS, "sponsor_mention",
        label_fn=lambda w: f'Possible sponsor mention: "{w}"',
    )
