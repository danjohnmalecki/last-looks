"""Locates the ffmpeg/ffprobe/tesseract binaries this engine shells out to.

By default, assumes they're on PATH (true for local dev with Homebrew installed).
When packaged into a standalone desktop app, the wrapper sets these env vars to
point at binaries bundled alongside the app instead, so end users don't need
ffmpeg/Tesseract installed separately.
"""
import os

FFMPEG_BIN = os.environ.get("LAST_LOOKS_FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("LAST_LOOKS_FFPROBE_BIN", "ffprobe")
TESSERACT_BIN = os.environ.get("LAST_LOOKS_TESSERACT_BIN")

if TESSERACT_BIN:
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_BIN
