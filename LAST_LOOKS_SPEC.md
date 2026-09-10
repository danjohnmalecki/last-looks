# Last Looks — Build Spec

Video QC tool: drop in a video, get back a timestamped list of things to check before
it ships. Built as a local Python app; this doc is a complete spec to rebuild it as a
hosted feature inside War Room (or anywhere else).

**Give this whole file to the coding session building the War Room version.** It
describes what the tool does, exactly how each check works (including the specific
techniques/thresholds that took iteration to get right), the API contract, and the
UI/UX down to animation details — enough to rebuild it 1:1 without access to the
original code.

---

## 1. What it does

User drops a video in. The tool runs 10 automated checks against it and returns a
list of timestamped findings the user can click to jump straight to in the video —
a "last looks" pass before a video ships, catching things a human might miss on a
final watch-through.

## 2. Architecture (important — read before building)

Two layers, kept strictly separate:

- **Analysis engine**: pure backend logic (currently Python). Takes a video file,
  runs 10 checks, returns structured JSON. No UI code, no web framework coupling.
- **Web layer**: upload endpoint, job polling, static frontend.

**Why this matters for hosting:** the engine calls `ffmpeg`, Tesseract OCR, OpenCV,
and a local Whisper speech-to-text model. These need a real filesystem, real CPU
time (30–90s per video), and installed system binaries. **This cannot run on Vercel
serverless functions** (or similar). It needs a persistent host — a small
always-on container/VM (Render, Railway, Fly.io, or similar). The War Room
frontend page should be a thin client that uploads to and polls that hosted
service's API; it should not try to reimplement the analysis in the Next.js app
itself unless deliberately rewriting the whole engine (see §7).

## 3. The 10 checks

Each check takes a video path and returns a list of **findings**:
`{type, timestamp, start, end, confidence (0–1), label, thumbnail?, url?}`.
`start`/`end` matter for checks that can span a range (e.g. a black segment);
`timestamp` is the primary point used for seeking/markers.

### 3.1 Black frames
`ffmpeg`'s built-in `blackdetect` filter:
```
ffmpeg -i in.mp4 -vf blackdetect=d=0.1:pic_th=0.98 -an -f null -
```
Parse `black_start:X black_end:Y black_duration:Z` out of stderr with regex. No
custom frame diffing needed — ffmpeg does the whole job. Confidence always 1.0.

### 3.2 Media Offline (Premiere red card)
Sample frames at ~1fps via OpenCV. **Real Premiere Media Offline cards render as a
vertical gradient** (bright pink-red top → dark maroon bottom), not a flat color —
a fixed BGR color-box match will miss the lighter part of the gradient. Convert to
HSV instead: hue stays stable across the gradient's brightness range even though
raw BGR doesn't.
- Hue near red wraparound (`h <= 12 or h >= 168` in OpenCV's 0–179 hue range)
- Saturation ≥ 60, value between 30–235 (excludes pure white text / near-black)
- Flag if this mask covers > 50% of the frame
- Merge consecutive sampled hits within a 2s gap into one range finding

### 3.3 Slipped / short-cut frames
Heuristic, framed to the user as **candidates to review, not certainties** — false
positives are expected on legitimate fast cuts.
1. Get scene cuts via ffmpeg: `select='gt(scene,0.4)',showinfo`, parse `pts_time:`
   values from stderr.
2. Treat consecutive cut timestamps as shot boundaries.
3. Any shot shorter than **0.15s** gets flagged — confidence scales with how much
   shorter than the threshold it is (`1 - shot_len/0.15`, floor 0.1).

### 3.4 Effect errors
Three heuristics, most-to-least reliable:

1. **Error-banner text (primary signal).** Full-frame OCR is unreliable — busy
   video content reads as noise to Tesseract. Instead: scan each sampled frame's
   row-wise HSV saturation/brightness profile for a horizontal band where
   `mean(saturation) > 90 and mean(value) > 60` for a contiguous run of rows
   between 15px and 15% of frame height (catches a colored error banner
   regardless of its actual color). Crop just that band (+6px padding), convert
   to grayscale, **threshold at brightness 180** to isolate light text from the
   colored background, then OCR the thresholded crop with `--psm 6`. This
   combo (band-detect → crop → threshold → OCR) is what actually works — full-
   frame OCR or OCR without the threshold step both failed in testing. Match
   against keywords: `FAILURE, CAN'T APPLY, UNSUPPORTED, UNRENDERED, RENDER
   ERROR, EFFECT ERROR, MISSING EFFECT, PLUGIN, CODEC ERROR, ERROR:`.
   Confidence 0.85 on hit.
2. **Magenta/pink placeholder card.** HSV hue 135–165, saturation ≥ 80, value ≥
   80, covering > 50% of frame. Confidence = coverage ratio.
3. **Transparency checkerboard.** Reuse OpenCV's `findChessboardCorners`
   (built for calibration patterns) with `CALIB_CB_FAST_CHECK` at grid sizes
   (7,7) and (4,4) on a downscaled (640px wide) frame — cheap way to detect a
   regular checker grid some renderers use for missing/unrendered layers.
   Confidence 0.4 (weakest signal, least tested against real examples).

### 3.5 Subscribe CTA
OCR-based. Sample at 0.5fps, downscale to 1280px wide for speed, run
`pytesseract.image_to_data` (word-level, gives per-word confidence), search for
`SUBSCRIBE` / `SUBSCRIBED` (substring match on each OCR'd word, uppercased).
Confidence = OCR word confidence (or 0.5 floor if hit but confidence unavailable).
Misses purely iconographic CTAs with no text.

### 3.6 QR codes
`cv2.QRCodeDetector().detectAndDecode(frame)`, sampled at 2fps. A successful
decode **is** the confirmation that the code scans — same guarantee a phone
camera would give. Carry the decoded payload as `url` on the finding (usually a
URL) — this is what the frontend renders as a clickable link. Confidence always
1.0 (decode either works or it doesn't). Merge consecutive same-URL hits within
a 2s gap; a changed URL starts a new finding (code changed mid-video).

### 3.7 Curse words (speech-based)
Uses **faster-whisper**, `base` model, `device="cpu", compute_type="int8"` — runs
entirely locally, no audio leaves the machine, ~5–15s to transcribe a ~90s clip on
CPU. `model.transcribe(video_path, word_timestamps=True)` gives word-level
start/end/probability directly (ffmpeg audio extraction happens internally). Match
each word (lowercased, punctuation stripped) against a profanity set:
```
fuck, fucking, fucked, fucker, motherfucker, shit, shitty, bullshit,
bitch, bitches, cunt, asshole, ass, dick, dickhead, pussy, bastard,
piss, pissed, cock, whore, slut
```
Deliberately **excludes mild words** ("damn", "hell") — common in normal speech,
would create noise. Confidence = Whisper's per-word probability.

### 3.8 Sponsor mention (speech-based)
Same transcript, keyword set: `sponsor, sponsors, sponsored, sponsoring,
sponsorship`.

### 3.9 Giveaway (speech-based)
Same transcript, keyword set: `giveaway, giveaways`.

### 3.10 Merch plug (speech-based)
Same transcript, keyword set: `merch, merchandise, hoodie, hoodies`.

**Important perf note:** checks 3.7–3.10 all consume the **same transcript** —
transcribe once per video, reuse the word list across all four checks. Do not
re-run Whisper per check (4x slower and pointless).

## 4. Tech stack (current local implementation)

- Python 3.14, FastAPI + Uvicorn
- `opencv-python` — frame sampling, HSV analysis, QR decode, checkerboard detect
- `pytesseract` + system Tesseract (`brew install tesseract`) — OCR
- `faster-whisper` — local speech-to-text (downloads a small model from Hugging
  Face on first run, ~150MB, one-time, free)
- `ffmpeg`/`ffprobe` (system binary) — probe, blackdetect, scene-cut, frame extract
- No paid APIs anywhere. Everything above is free/open-source and runs offline
  after first model download.

## 5. API contract

```
POST /api/analyze         (multipart form, field "file" = video)
  → { job_id }

GET /api/analyze/{job_id}
  → { status: "running"|"done"|"error", percent, stage, video_id, video_url,
      report? (once done), error? (once errored) }

GET /api/video/{filename}      → serves the uploaded video
GET /api/thumbnail/{filename}  → serves an extracted thumbnail JPEG
```

Analysis runs in a background thread per job (in-memory job dict — fine for
single-instance use; would need a real queue/store for multi-instance scaling).
Frontend polls every 500ms.

**Report shape:**
```json
{
  "video_info": { "duration": 94.1, "fps": 30.0, "width": 3840, "height": 2160 },
  "findings": [
    {
      "type": "media_offline",
      "timestamp": 13.01, "start": 13.01, "end": 14.09,
      "confidence": 0.70,
      "label": "Possible Media Offline card",
      "thumbnail": "abc123.jpg",
      "url": null
    }
  ],
  "summary": { "black_frame": 1, "media_offline": 1, "...": 0 }
}
```

**Progress stages** (in order, each reported as `{percent, stage}` during the
run): `probing video` → `checking black frames` → `checking media offline` →
`checking slipped frames` → `checking effect errors` → `checking subscribe cta`
→ `checking qr codes` → `transcribing audio` → `checking curse words` →
`checking sponsor mentions` → `checking giveaways` → `checking merch plugs` →
`generating thumbnails` → `done`. Weight the percent estimate toward the slow
stages (transcription is the single biggest chunk, then the two OCR stages).

## 6. Frontend UX spec

### Two screens, one page
- **Landing**: logo, drop zone, subheading, hidden progress area, status text.
- **Workspace**: shown only after analysis completes. Video (left, large) +
  scrollable findings list (right) side by side, wrapping to stacked on narrow
  viewports.
- Clicking the logo (in either screen) resets fully back to the landing screen
  (pause video, clear src, clear file input, hide workspace).

### Landing screen — drop zone
- The drop zone box **itself morphs into the progress UI** when a file is
  dropped/selected — it's not a separate element that appears below. Same
  card, same border/background; the "Drop a video here" prompt fades out
  (opacity + slight scale) and the progress bar + stage icon fade in, in the
  same box. Box padding shrinks slightly during the analyzing state. Box
  stops accepting clicks/drags while analyzing.
- Progress bar is a real rainbow gradient (SMPTE color-bar palette — see
  below) filling left to right, not a spinner.
- Below the progress bar: a **stage icon** (a small PNG matching the check
  currently running) sits centered, and **crossfades** between icons as the
  stage changes — old icon slides right + fades + blurs out (~200ms), new
  icon slides in from the left + fades + blurs in (~400ms). Implement as:
  remove "visible" class + add "leaving" class → after ~200ms swap the `src`
  → remove both classes (resets to off-screen-left/blurred/transparent state)
  → double-`requestAnimationFrame` → add "visible" class to trigger the
  transition in.
- Percent + human-readable stage label shown as text under the bar (e.g.
  "Checking for Media Offline cards... (23%)").

### Workspace screen
- "Preview" title above the video; "Findings" title above the results panel.
- Video has a **custom marker track** below the native `<video controls>`
  element — a thin bar spanning the video's duration, with small colored
  tick marks at each finding's timestamp (positioned by
  `timestamp/duration * 100%`). Clicking a marker (or anywhere on the track)
  pauses the video and seeks to that time.
- Findings list: header row with "Finding" / "Confidence Level" labels above
  a scrollable list (not a `<table>` — a flex list works better for the
  thumbnail + multi-line content). Each row: thumbnail (if the finding type
  has one), colored type badge, timestamp, one-line label, confidence %
  right-aligned. **Clicking a row pauses the video and jumps to that
  timestamp — it must NOT resume playback.** (`player.pause(); player.currentTime
  = ts;` — pause before or after set, not `play()`.)
- Findings that carry a `url` (currently only QR codes) render the URL as an
  underlined clickable link (`target="_blank" rel="noopener noreferrer"`)
  under the label, with click propagation stopped so it doesn't also trigger
  the row's seek behavior.
- Summary chips (one per check type, count) above the findings list.
- Video scales up to fill available space but is capped
  (`max-height: min(80vh, 950px)`) so it never exceeds the viewport.

### Branding
- Logo: provided as a transparent PNG wordmark with a TV-test-pattern-circle
  accent (asset to be supplied — see War Room's asset pipeline).
- **SMPTE color bars** are the visual identity throughout: a thin 7-color
  rainbow strip at the very top of the page, the same gradient used for the
  progress bar fill and a thin accent stripe on the drop zone, and a subtle
  **glow** on every one of those bar elements (a blurred duplicate of the same
  gradient positioned behind the element, ~10px blur, ~0.75 opacity).
  Palette (used as CSS custom properties):
  ```
  white  #c8c8c8   yellow #c8c810   cyan  #10c8c8   green #10c810
  magenta #c810c8  red    #c81010   blue  #1010c8
  ```
  7 equal stops left to right in that order.
- Per-finding-type accent colors (used for badges + markers), roughly:
  black_frame → yellow/amber, media_offline → red, slipped_frame → cyan,
  effect_error → magenta, subscribe_cta → green, curse_word → orange,
  qr_code → near-black, sponsor_mention → gold, giveaway → blue,
  merch_plug → purple.
- **Theme: white background**, light gray card surfaces (`#f6f7f9`), light
  borders (`#e3e5ea`), dark text (`#17181c`), muted gray secondary text
  (`#6b7280`). Not a dark theme.
- Everything sized generously — this is a QC tool meant to be comfortable to
  scan, not a dense dashboard. Logo ~150px tall on the landing screen; stage
  icons sized to roughly half the logo's height.

### Stage icons
9 small PNGs, one per check that has a visual identity (the two purely-
structural stages — probing video, generating thumbnails — show no icon,
just the progress bar): black frames, media offline, curse words, slipped
frames, effect errors, subscribe check, sponsor, giveaway, merch. These are
custom illustrated assets — get equivalents from whoever owns War Room's
asset/design pipeline, or reuse the existing ones if the files are portable.

## 7. Porting notes for War Room specifically

- **Keep the Python engine as a separate hosted service** (see §2) rather
  than rewriting it in TypeScript, unless there's a strong reason to — it
  would mean re-implementing OCR, QR decoding, and speech-to-text in a
  different language ecosystem for no functional gain.
- War Room's Next.js page becomes a thin client: upload → poll → render,
  matching the API contract in §5.
- Nothing should be hardcoded to a local machine — the hosted engine needs a
  stable public URL (see the hosting cost discussion: Render/Railway/Fly.io,
  roughly $5–25/mo depending on tier, since the free tiers are too memory-
  constrained and/or cold-start for this workload).
- Match War Room's existing role-gating/auth patterns for whichever page this
  lands on — this spec doesn't cover that, since it's App-specific plumbing
  the War Room session already knows.

## 8. Known limitations (be upfront about these — don't silently "fix" by
   over-claiming accuracy)

- Slipped-frame detection is a heuristic with real false-positive risk on
  legitimate fast cuts.
- Effect-error detection (especially the checkerboard signal) was built from
  general knowledge of how NLEs render errors, not a large set of real
  reference frames — expect it to need retuning against real examples.
- Subscribe CTA and merch/sponsor/giveaway checks only catch things that are
  literally spoken or literally rendered as text — a purely iconographic CTA
  or an unspoken visual merch plug won't be caught.
- Curse-word/sponsor/giveaway/merch detection quality is bounded by Whisper's
  transcription accuracy (the `base` model — a larger model would improve
  accuracy at the cost of speed).
