"""Detect spoken profanity via local speech-to-text.

Uses the shared transcript (see engine/transcribe.py) and matches words against a
profanity list. Runs entirely locally -- no audio leaves the machine.
"""
from .. import transcribe

# Common strong profanity. Deliberately excludes mild words ("damn", "hell") that
# are common in normal speech and would produce too many low-value flags for a QC
# pass -- this list is about catching words that would need a bleep/cut, not casual
# swearing.
_PROFANITY = {
    "fuck", "fucking", "fucked", "fucker", "motherfucker",
    "shit", "shitty", "bullshit",
    "bitch", "bitches",
    "cunt",
    "asshole", "ass",
    "dick", "dickhead",
    "pussy",
    "bastard",
    "piss", "pissed",
    "cock",
    "whore", "slut",
}


def run(video_path: str, words: list[dict] | None = None) -> list[dict]:
    if words is None:
        words = transcribe.transcribe_words(video_path)
    return transcribe.keyword_findings(
        words, _PROFANITY, "curse_word",
        label_fn=lambda w: f'Possible profanity: "{w}"',
    )
