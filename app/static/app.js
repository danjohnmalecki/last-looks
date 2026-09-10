const drop = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const stageIcon = document.getElementById("stageIcon");
const player = document.getElementById("player");
const summaryEl = document.getElementById("summary");
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
  "transcribing audio": "Transcribing audio...",
  "checking curse words": "Checking for curse words...",
  "checking sponsor mentions": "Checking for sponsor mentions...",
  "checking giveaways": "Checking for giveaways...",
  "checking merch plugs": "Checking for merch plugs...",
  "generating thumbnails": "Generating thumbnails...",
  done: "Done",
};

const STAGE_ICONS = {
  "checking black frames": "/blackframes.png",
  "checking media offline": "/mediaoffline.png",
  "checking curse words": "/cursewords.png",
  "checking slipped frames": "/slipframes.png",
  "checking effect errors": "/effectserror.png",
  "checking subscribe cta": "/subscribecheck.png",
  "checking sponsor mentions": "/sponsor.png",
  "checking giveaways": "/giveaway.png",
  "checking merch plugs": "/merch.png",
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

  currentIconSrc = null;
  stageIcon.style.display = "none";
  stageIcon.classList.remove("visible", "leaving");
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2);
  return `${m}:${sec.padStart(5, "0")}`;
}

// Crossfade the stage icon: slide the old one out to the right (blur+fade), then
// slide the new one in from the left (blur+fade) once it's swapped in.
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

async function handleFile(file) {
  statusEl.textContent = "";
  drop.classList.remove("drag");
  setProgress(0, "starting");

  const formData = new FormData();
  formData.append("file", file);

  try {
    const startRes = await fetch("/api/analyze", { method: "POST", body: formData });
    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      throw new Error(err.detail || startRes.statusText);
    }
    const { job_id } = await startRes.json();
    const report = await pollJob(job_id);
    render(report);
  } catch (e) {
    progressWrap.style.display = "none";
    drop.classList.remove("analyzing");
    statusEl.textContent = `Error: ${e.message}`;
  }
}

function pollJob(jobId) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`/api/analyze/${jobId}`);
        if (!res.ok) throw new Error("Lost track of analysis job");
        const job = await res.json();

        if (job.status === "error") {
          reject(new Error(job.error || "Analysis failed"));
          return;
        }

        setProgress(job.percent ?? 0, job.stage ?? "starting");

        if (job.status === "done") {
          resolve({ ...job.report, video_url: job.video_url });
          return;
        }
        setTimeout(tick, 500);
      } catch (e) {
        reject(e);
      }
    };
    tick();
  });
}

function seekAndPause(timestamp) {
  player.pause();
  player.currentTime = timestamp;
}

function render(report) {
  player.src = report.video_url;

  landing.style.display = "none";
  workspace.style.display = "block";

  summaryEl.innerHTML = "";
  for (const [type, count] of Object.entries(report.summary)) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = `${LABELS[type] || type}: ${count}`;
    summaryEl.appendChild(chip);
  }

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
      img.src = `/api/thumbnail/${f.thumbnail}`;
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
