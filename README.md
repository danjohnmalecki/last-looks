# Last Looks

Local video QC tool. v1 checks: black frames, Media Offline (Premiere red card), and
candidate slipped/short-cut frames. Curse words and subscribe-CTA detection are v2.

## Run it

```bash
cd "last-looks"
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8791
```

Open http://127.0.0.1:8791 and drop in a video.

## Layout

- `engine/` — pure-Python analysis pipeline (no web framework deps). Reusable as-is by
  a future hosted service or Premiere panel.
- `app/` — FastAPI backend + static frontend that wraps the engine for local use.

## Notes / known limitations (v1)

- **Slipped frame detection** is heuristic (flags very short shots between scene cuts)
  and will have false positives on legit fast cuts — treat results as candidates to
  review, not certainties.
- **Media Offline** detection is a color-heuristic match on Premiere's red placeholder;
  it hasn't been tuned against a real Premiere export yet — thresholds in
  `engine/checks/media_offline.py` may need adjusting once tested against real footage.
- **Effect errors** in v1 is limited to the Media Offline detector. True AE render-error
  detection needs real example frames to build a matcher against.
