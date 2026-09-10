/* Last Looks — 100% client-side engine.
 * Nothing is uploaded anywhere. All analysis runs on the visitor's own CPU using
 * the browser's native <video>/<canvas> APIs plus three WASM/JS libraries:
 *   - jsQR         -> QR code detection/decoding
 *   - Tesseract.js -> OCR (subscribe CTA text, effect-error banner text)
 *   - transformers.js (Xenova/whisper-tiny.en) -> local speech-to-text
 * This mirrors the techniques used in the original Python engine as closely as
 * browser APIs allow. See LAST_LOOKS_SPEC.md in the repo root for the original
 * algorithm details this was ported from.
 */

// ---------------------------------------------------------------------------
// UI wiring (unchanged from the hosted version — same element IDs/behaviour)
// ---------------------------------------------------------------------------

const drop = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const stageIcon = document.getElementById("stageIcon");
const player = document.getElementById("player");
const findingsListEl = document.getElementById("findingsList");
const markerTrack = document.getElementById("markerTrack");
const landing = document.getElementById("landing");
const workspace = document.getElementById("workspace");

const LABELS = {
  black_frame: "Black frame",
  media_offline: "Media offline",
  slipped_frame: "Slipped frame",
  effect_error: "Effect error",
  subscribe_cta: "Subscribe CTA",
  curse_word: "Curse word",
  qr_code: "QR code",
  sponsor_mention: "Sponsor mention",
  giveaway: "Giveaway",
  merch_plug: "Merch plug",
};

const STAGE_LABELS = {
  starting: "Starting...",
  "probing video": "Reading video info...",
  "checking black frames": "Checking for black frames...",
  "checking media offline": "Checking for Media Offline cards...",
  "checking slipped frames": "Checking for slipped/short-cut frames...",
  "checking effect errors": "Checking for effect errors...",
  "checking subscribe cta": "Checking for a subscribe CTA...",
  "checking qr codes": "Checking for QR codes...",
  "transcribing audio": "Transcribing audio (this is the slow part)...",
  "checking curse words": "Checking for curse words...",
  "checking sponsor mentions": "Checking for sponsor mentions...",
  "checking giveaways": "Checking for giveaways...",
  "checking merch plugs": "Checking for merch plugs...",
  done: "Done",
};

const STAGE_ICONS = {
  "checking black frames": "assets/blackframes.png",
  "checking media offline": "assets/mediaoffline.png",
  "checking curse words": "assets/cursewords.png",
  "checking slipped frames": "assets/slipframes.png",
  "checking effect errors": "assets/effectserror.png",
  "checking subscribe cta": "assets/subscribecheck.png",
  "checking sponsor mentions": "assets/sponsor.png",
  "checking giveaways": "assets/giveaway.png",
  "checking merch plugs": "assets/merch.png",
};

drop.addEventListener("click", () => {
  if (!drop.classList.contains("analyzing")) fileInput.click();
});
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!drop.classList.contains("analyzing")) drop.classList.add("drag");
});
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  if (drop.classList.contains("analyzing")) return;
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

document.getElementById("logoLanding").addEventListener("click", resetToLanding);
document.getElementById("logoWorkspace").addEventListener("click", resetToLanding);

let currentIconSrc = null;
let currentObjectUrl = null;

function resetToLanding() {
  workspace.style.display = "none";
  landing.style.display = "flex";
  progressWrap.style.display = "none";
  drop.classList.remove("analyzing", "drag");
  statusEl.textContent = "";
  player.pause();
  player.removeAttribute("src");
  player.load();
  fileInput.value = "";
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  currentIconSrc = null;
  stageIcon.style.display = "none";
  stageIcon.classList.remove("visible", "leaving");
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2);
  return `${m}:${sec.padStart(5, "0")}`;
}

function setStageIcon(iconSrc) {
  if (iconSrc === currentIconSrc) return;

  if (!iconSrc) {
    stageIcon.classList.remove("visible");
    stageIcon.classList.add("leaving");
    setTimeout(() => {
      stageIcon.style.display = "none";
      stageIcon.classList.remove("leaving");
    }, 220);
    currentIconSrc = null;
    return;
  }

  const swapIn = () => {
    stageIcon.src = iconSrc;
    stageIcon.style.display = "block";
    stageIcon.classList.remove("leaving", "visible");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => stageIcon.classList.add("visible"));
    });
  };

  if (currentIconSrc) {
    stageIcon.classList.remove("visible");
    stageIcon.classList.add("leaving");
    setTimeout(swapIn, 200);
  } else {
    swapIn();
  }

  currentIconSrc = iconSrc;
}

function setProgress(percent, stage) {
  drop.classList.add("analyzing");
  progressWrap.style.display = "flex";
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = `${STAGE_LABELS[stage] || stage} (${percent}%)`;
  setStageIcon(STAGE_ICONS[stage] || null);
}

function seekAndPause(timestamp) {
  player.pause();
  player.currentTime = timestamp;
}

function render(report) {
  landing.style.display = "none";
  workspace.style.display = "block";

  findingsListEl.innerHTML = "";
  if (report.findings.length === 0) {
    const empty = document.createElement("div");
    empty.id = "emptyFindings";
    empty.textContent = "No issues found.";
    findingsListEl.appendChild(empty);
  }

  for (const f of report.findings) {
    const row = document.createElement("div");
    row.className = "finding-row";
    row.addEventListener("click", () => seekAndPause(f.timestamp));

    if (f.thumbnail) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = f.thumbnail; // data URL, generated client-side
      row.appendChild(img);
    }

    const meta = document.createElement("div");
    meta.className = "finding-meta";

    const badge = document.createElement("span");
    badge.className = `badge ${f.type}`;
    badge.textContent = LABELS[f.type] || f.type;

    const time = document.createElement("span");
    time.className = "finding-time";
    time.textContent = ` ${fmtTime(f.timestamp)}`;

    const label = document.createElement("div");
    label.className = "finding-label";
    label.textContent = f.label;

    meta.append(badge, time, label);

    if (f.url) {
      const link = document.createElement("a");
      link.className = "finding-url";
      link.href = f.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = f.url;
      link.addEventListener("click", (e) => e.stopPropagation());
      meta.appendChild(link);
    }

    const conf = document.createElement("div");
    conf.className = "finding-conf";
    conf.textContent = `${Math.round(f.confidence * 100)}%`;

    row.append(meta, conf);
    findingsListEl.appendChild(row);
  }

  renderMarkers(report);
}

function renderMarkers(report) {
  markerTrack.innerHTML = "";
  const duration = report.video_info?.duration;
  if (!duration) return;

  for (const f of report.findings) {
    const marker = document.createElement("div");
    marker.className = `marker ${f.type}`;
    marker.style.left = `${Math.min(100, (f.timestamp / duration) * 100)}%`;
    marker.title = `${LABELS[f.type] || f.type} @ ${fmtTime(f.timestamp)}`;
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      seekAndPause(f.timestamp);
    });
    markerTrack.appendChild(marker);
  }

  markerTrack.addEventListener("click", (e) => {
    const rect = markerTrack.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekAndPause(Math.max(0, Math.min(duration, ratio * duration)));
  });
}

async function handleFile(file) {
  statusEl.textContent = "";
  drop.classList.remove("drag");
  setProgress(0, "starting");

  try {
    const report = await analyzeLocally(file, setProgress);
    currentObjectUrl = URL.createObjectURL(file);
    player.src = currentObjectUrl;
    render(report);
    progressWrap.style.display = "none";
    drop.classList.remove("analyzing");
  } catch (e) {
    console.error(e);
    progressWrap.style.display = "none";
    drop.classList.remove("analyzing");
    statusEl.textContent = `Error: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Analysis engine
// ---------------------------------------------------------------------------

const STAGE_WEIGHTS = [
  ["probing video", 2],
  ["checking black frames", 8],
  ["checking media offline", 10],
  ["checking slipped frames", 15],
  ["checking effect errors", 16],
  ["checking subscribe cta", 16],
  ["checking qr codes", 8],
  ["transcribing audio", 20],
  ["checking curse words", 1],
  ["checking sponsor mentions", 1],
  ["checking giveaways", 1],
  ["checking merch plugs", 2],
];
const TOTAL_WEIGHT = STAGE_WEIGHTS.reduce((s, [, w]) => s + w, 0);

function seekTo(video, t) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
}

function drawFrame(video, canvas, ctx, targetWidth) {
  const scale = targetWidth / video.videoWidth;
  const w = targetWidth;
  const h = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  return { w, h };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, s, v];
}

function mergeAdjacent(findings, gap, sameKey = () => true) {
  if (!findings.length) return [];
  findings.sort((a, b) => a.timestamp - b.timestamp);
  const merged = [{ ...findings[0] }];
  for (let i = 1; i < findings.length; i++) {
    const f = findings[i];
    const last = merged[merged.length - 1];
    if (sameKey(f, last) && f.timestamp - last.end <= gap) {
      last.end = f.timestamp;
      last.confidence = Math.max(last.confidence, f.confidence);
      if (f.thumbnail && !last.thumbnail) last.thumbnail = f.thumbnail;
    } else {
      merged.push({ ...f });
    }
  }
  return merged;
}

async function forEachSample(video, duration, interval, fn) {
  for (let t = 0; t < duration; t += interval) {
    await seekTo(video, t);
    await fn(t);
  }
}

// ---- 1. Black frames ----
async function checkBlackFrames(video, canvas, ctx, duration) {
  const findings = [];
  await forEachSample(video, duration, 0.5, (t) => {
    drawFrame(video, canvas, ctx, 120);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    const mean = sum / ((data.length / 4) * 3 * 255);
    if (mean < 0.03) {
      findings.push({ type: "black_frame", timestamp: t, start: t, end: t, confidence: 1.0, label: "Black frame" });
    }
  });
  const merged = mergeAdjacent(findings, 0.75);
  for (const f of merged) f.label = `Black frames for ${(f.end - f.start + 0.5).toFixed(2)}s`;
  return merged;
}

// ---- 2. Media Offline (HSV red-gradient card) ----
async function checkMediaOffline(video, canvas, ctx, duration) {
  const findings = [];
  await forEachSample(video, duration, 1.0, (t) => {
    drawFrame(video, canvas, ctx, 200);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hits = 0;
    const total = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if ((h <= 24 || h >= 338) && s >= 0.235 && v >= 0.118 && v <= 0.92) hits++;
    }
    const ratio = hits / total;
    if (ratio > 0.5) {
      drawFrame(video, canvas, ctx, 480);
      findings.push({
        type: "media_offline", timestamp: t, start: t, end: t,
        confidence: Math.min(1, ratio), label: "Possible Media Offline card",
        thumbnail: canvas.toDataURL("image/jpeg", 0.75),
      });
    }
  });
  return mergeAdjacent(findings, 2.0);
}

// ---- 3. Slipped / short-cut frames (frame-diff scene-cut proxy) ----
async function checkSlippedFrames(video, canvas, ctx, duration) {
  const interval = 0.2;
  let prev = null;
  const cuts = [];
  await forEachSample(video, duration, interval, (t) => {
    drawFrame(video, canvas, ctx, 48);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = new Float32Array(data.length / 4);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    if (prev) {
      let diff = 0;
      for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - prev[i]);
      diff /= gray.length;
      if (diff > 28) cuts.push(t);
    }
    prev = gray;
  });

  const findings = [];
  for (let i = 1; i < cuts.length; i++) {
    const shotLen = cuts[i] - cuts[i - 1];
    if (shotLen < 0.15) {
      const confidence = Math.max(0.1, 1 - shotLen / 0.15);
      findings.push({
        type: "slipped_frame", timestamp: cuts[i - 1], start: cuts[i - 1], end: cuts[i],
        confidence: Math.round(confidence * 100) / 100,
        label: `Very short shot (${shotLen.toFixed(3)}s) -- possible slipped/reveal frame`,
      });
    }
  }
  return findings;
}

// ---- 4. Effect errors (banner-text OCR + magenta card) ----
const EFFECT_ERROR_KEYWORDS = [
  "FAILURE", "CAN'T APPLY", "CANT APPLY", "UNSUPPORTED", "UNRENDERED",
  "RENDER ERROR", "RENDERING ERROR", "EFFECT ERROR", "MISSING EFFECT",
  "PLUGIN", "CODEC ERROR", "ERROR:",
];

async function checkEffectErrors(video, canvas, ctx, duration, ocrWorker) {
  const findings = [];
  const bandCanvas = document.createElement("canvas");
  const bandCtx = bandCanvas.getContext("2d", { willReadFrequently: true });

  await forEachSample(video, duration, 1.0, async (t) => {
    drawFrame(video, canvas, ctx, 200);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const total = canvas.width * canvas.height;

    let magentaHits = 0;
    const rowSat = new Float32Array(canvas.height);
    const rowVal = new Float32Array(canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      let sSum = 0, vSum = 0;
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        sSum += s; vSum += v;
        if (h >= 271.5 && h <= 331.8 && s >= 0.314 && v >= 0.314) magentaHits++;
      }
      rowSat[y] = sSum / canvas.width;
      rowVal[y] = vSum / canvas.width;
    }

    const magentaRatio = magentaHits / total;
    if (magentaRatio > 0.5) {
      findings.push({
        type: "effect_error", timestamp: t, start: t, end: t,
        confidence: Math.min(1, magentaRatio),
        label: "Possible effect error (magenta/missing-media card)",
        thumbnail: canvas.toDataURL("image/jpeg", 0.75),
      });
      return;
    }

    // Find a horizontal banner band: contiguous rows with high sat+val.
    let bandStart = -1, bandEnd = -1;
    const minH = canvas.height * 0.02, maxH = canvas.height * 0.2;
    for (let y = 0; y < canvas.height; y++) {
      const hit = rowSat[y] > 0.353 && rowVal[y] > 0.235;
      if (hit && bandStart === -1) bandStart = y;
      if (!hit && bandStart !== -1) {
        if (y - bandStart >= minH && y - bandStart <= maxH) { bandEnd = y; break; }
        bandStart = -1;
      }
    }
    if (bandStart === -1 || bandEnd === -1 || !ocrWorker) return;

    // Redraw at higher res for a crisper OCR crop, using the same row fractions.
    const { h: fullH } = drawFrame(video, canvas, ctx, 960);
    const y0 = Math.max(0, Math.floor((bandStart / 200) * fullH) - 4);
    const y1 = Math.min(fullH, Math.ceil((bandEnd / 200) * fullH) + 4);
    bandCanvas.width = canvas.width;
    bandCanvas.height = y1 - y0;
    bandCtx.drawImage(canvas, 0, y0, canvas.width, y1 - y0, 0, 0, canvas.width, y1 - y0);

    const bandData = bandCtx.getImageData(0, 0, bandCanvas.width, bandCanvas.height);
    for (let i = 0; i < bandData.data.length; i += 4) {
      const gray = 0.299 * bandData.data[i] + 0.587 * bandData.data[i + 1] + 0.114 * bandData.data[i + 2];
      const v = gray > 180 ? 255 : 0;
      bandData.data[i] = bandData.data[i + 1] = bandData.data[i + 2] = v;
    }
    bandCtx.putImageData(bandData, 0, 0);

    try {
      const { data: ocrData } = await ocrWorker.recognize(bandCanvas);
      const text = (ocrData.text || "").toUpperCase();
      if (EFFECT_ERROR_KEYWORDS.some((kw) => text.includes(kw))) {
        findings.push({
          type: "effect_error", timestamp: t, start: t, end: t,
          confidence: 0.85, label: "Possible effect error (error banner text detected)",
          thumbnail: bandCanvas.toDataURL("image/jpeg", 0.8),
        });
      }
    } catch (_) { /* OCR failure on a sampled frame is not fatal, just skip it */ }
  });

  return mergeAdjacent(findings, 2.0);
}

// ---- 5. Subscribe CTA (OCR) ----
async function checkSubscribeCta(video, canvas, ctx, duration, ocrWorker) {
  const findings = [];
  if (!ocrWorker) return findings;
  await forEachSample(video, duration, 2.0, async (t) => {
    drawFrame(video, canvas, ctx, 640);
    try {
      const { data } = await ocrWorker.recognize(canvas);
      const text = (data.text || "").toUpperCase();
      if (text.includes("SUBSCRIBE")) {
        findings.push({
          type: "subscribe_cta", timestamp: t, start: t, end: t,
          confidence: Math.max(0.5, (data.confidence || 70) / 100),
          label: "Possible 'Subscribe' CTA detected",
          thumbnail: canvas.toDataURL("image/jpeg", 0.75),
        });
      }
    } catch (_) { /* skip a failed frame */ }
  });
  return mergeAdjacent(findings, 2.0);
}

// ---- 6. QR codes ----
async function checkQrCodes(video, canvas, ctx, duration) {
  const findings = [];
  await forEachSample(video, duration, 1.0, (t) => {
    drawFrame(video, canvas, ctx, 640);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imgData.data, imgData.width, imgData.height);
    if (code && code.data) {
      findings.push({
        type: "qr_code", timestamp: t, start: t, end: t, confidence: 1.0,
        label: "QR code confirmed scannable", url: code.data,
        thumbnail: canvas.toDataURL("image/jpeg", 0.75),
      });
    }
  });
  return mergeAdjacent(findings, 2.0, (f, last) => f.url === last.url);
}

// ---- 7. Audio decode + local Whisper transcription ----
async function decodeAudioFloat32(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const tmpCtx = new AudioCtx();
  const decoded = await tmpCtx.decodeAudioData(arrayBuffer.slice(0));
  await tmpCtx.close();

  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

let whisperPipeline = null;
async function getWhisperPipeline() {
  if (whisperPipeline) return whisperPipeline;
  let tries = 0;
  while (!window.__transformersPipeline && tries < 40) {
    await new Promise((r) => setTimeout(r, 250));
    tries++;
  }
  if (!window.__transformersPipeline) throw new Error("transformers.js failed to load");
  whisperPipeline = await window.__transformersPipeline(
    "automatic-speech-recognition", "Xenova/whisper-tiny.en"
  );
  return whisperPipeline;
}

async function transcribeWords(file) {
  const audio = await decodeAudioFloat32(file);
  const transcriber = await getWhisperPipeline();
  const output = await transcriber(audio, {
    chunk_length_s: 30, stride_length_s: 5, return_timestamps: "word",
  });
  const chunks = output.chunks || [];
  return chunks.map((c) => ({
    word: c.text, start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 0.3,
    probability: 0.75,
  }));
}

const WORD_RE = /[a-z']+/;
function keywordFindings(words, keywords, type, labelFn) {
  const out = [];
  for (const w of words) {
    const m = WORD_RE.exec((w.word || "").toLowerCase());
    if (!m) continue;
    const cleaned = m[0].replace(/'/g, "");
    if (keywords.has(cleaned)) {
      out.push({
        type, timestamp: w.start, start: w.start, end: w.end,
        confidence: w.probability, label: labelFn(cleaned),
      });
    }
  }
  return out;
}

const PROFANITY = new Set([
  "fuck", "fucking", "fucked", "fucker", "motherfucker",
  "shit", "shitty", "bullshit", "bitch", "bitches", "cunt",
  "asshole", "ass", "dick", "dickhead", "pussy", "bastard",
  "piss", "pissed", "cock", "whore", "slut",
]);
const SPONSOR_WORDS = new Set(["sponsor", "sponsors", "sponsored", "sponsoring", "sponsorship"]);
const GIVEAWAY_WORDS = new Set(["giveaway", "giveaways"]);
const MERCH_WORDS = new Set(["merch", "merchandise", "hoodie", "hoodies"]);

// ---------------------------------------------------------------------------

async function analyzeLocally(file, onProgress) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("Could not read video file")), { once: true });
  });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const duration = video.duration;

  let done = 0;
  const report = (stage) => onProgress(Math.round((100 * done) / TOTAL_WEIGHT), stage);
  const advance = (i) => { done += STAGE_WEIGHTS[i][1]; };

  report(STAGE_WEIGHTS[0][0]); advance(0);

  const findings = [];

  report(STAGE_WEIGHTS[1][0]);
  findings.push(...await checkBlackFrames(video, canvas, ctx, duration));
  advance(1);

  report(STAGE_WEIGHTS[2][0]);
  findings.push(...await checkMediaOffline(video, canvas, ctx, duration));
  advance(2);

  report(STAGE_WEIGHTS[3][0]);
  findings.push(...await checkSlippedFrames(video, canvas, ctx, duration));
  advance(3);

  const ocrWorker = await Tesseract.createWorker("eng");

  report(STAGE_WEIGHTS[4][0]);
  findings.push(...await checkEffectErrors(video, canvas, ctx, duration, ocrWorker));
  advance(4);

  report(STAGE_WEIGHTS[5][0]);
  findings.push(...await checkSubscribeCta(video, canvas, ctx, duration, ocrWorker));
  advance(5);

  await ocrWorker.terminate();

  report(STAGE_WEIGHTS[6][0]);
  findings.push(...await checkQrCodes(video, canvas, ctx, duration));
  advance(6);

  report(STAGE_WEIGHTS[7][0]);
  let words = [];
  try {
    words = await transcribeWords(file);
  } catch (err) {
    console.warn("Transcription failed/unavailable, skipping speech-based checks:", err);
  }
  advance(7);

  report(STAGE_WEIGHTS[8][0]);
  findings.push(...keywordFindings(words, PROFANITY, "curse_word", (w) => `Possible profanity: "${w}"`));
  advance(8);

  report(STAGE_WEIGHTS[9][0]);
  findings.push(...keywordFindings(words, SPONSOR_WORDS, "sponsor_mention", (w) => `Possible sponsor mention: "${w}"`));
  advance(9);

  report(STAGE_WEIGHTS[10][0]);
  findings.push(...keywordFindings(words, GIVEAWAY_WORDS, "giveaway", (w) => `Possible giveaway mention: "${w}"`));
  advance(10);

  report(STAGE_WEIGHTS[11][0]);
  findings.push(...keywordFindings(words, MERCH_WORDS, "merch_plug", (w) => `Possible merch plug: "${w}"`));
  advance(11);

  onProgress(100, "done");

  findings.sort((a, b) => a.timestamp - b.timestamp);

  const CHECK_TYPES = [
    "black_frame", "media_offline", "slipped_frame", "effect_error", "subscribe_cta",
    "curse_word", "qr_code", "sponsor_mention", "giveaway", "merch_plug",
  ];
  const summary = {};
  for (const t of CHECK_TYPES) summary[t] = findings.filter((f) => f.type === t).length;

  URL.revokeObjectURL(video.src);

  return {
    video_info: { duration, width: video.videoWidth, height: video.videoHeight },
    findings,
    summary,
  };
}
