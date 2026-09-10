"""Shared ffmpeg/ffprobe subprocess helpers used by all checks."""
import json
import re
import subprocess


def probe(video_path: str) -> dict:
    """Return {duration, fps, width, height} for a video file."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate,duration",
            "-show_entries", "format=duration",
            "-of", "json", video_path,
        ],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)
    stream = data["streams"][0]
    num, den = stream["r_frame_rate"].split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    duration = float(data.get("format", {}).get("duration") or stream.get("duration") or 0.0)
    return {
        "duration": duration,
        "fps": fps,
        "width": int(stream["width"]),
        "height": int(stream["height"]),
    }


def run_blackdetect(video_path: str, min_duration: float = 0.1, pic_threshold: float = 0.98) -> list[dict]:
    """Run ffmpeg blackdetect filter and parse black_start/black_end ranges from stderr."""
    result = subprocess.run(
        [
            "ffmpeg", "-i", video_path,
            "-vf", f"blackdetect=d={min_duration}:pic_th={pic_threshold}",
            "-an", "-f", "null", "-",
        ],
        capture_output=True, text=True,
    )
    ranges = []
    for match in re.finditer(
        r"black_start:(?P<start>[\d.]+) black_end:(?P<end>[\d.]+) black_duration:(?P<dur>[\d.]+)",
        result.stderr,
    ):
        ranges.append({
            "start": float(match.group("start")),
            "end": float(match.group("end")),
            "duration": float(match.group("dur")),
        })
    return ranges


def run_scenecuts(video_path: str, threshold: float = 0.4) -> list[float]:
    """Return timestamps (seconds) of detected hard cuts via ffmpeg's scene filter."""
    result = subprocess.run(
        [
            "ffmpeg", "-i", video_path,
            "-vf", f"select='gt(scene,{threshold})',showinfo",
            "-an", "-f", "null", "-",
        ],
        capture_output=True, text=True,
    )
    timestamps = []
    for match in re.finditer(r"pts_time:(?P<t>[\d.]+)", result.stderr):
        timestamps.append(float(match.group("t")))
    return timestamps


def extract_frame(video_path: str, timestamp: float, out_path: str) -> None:
    """Extract a single JPEG frame at the given timestamp (seconds)."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-ss", str(timestamp), "-i", video_path,
            "-frames:v", "1", "-q:v", "3", out_path,
        ],
        capture_output=True, text=True, check=True,
    )
