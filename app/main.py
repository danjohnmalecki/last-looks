import os
import shutil
import threading
import uuid

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from engine.pipeline import analyze

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
THUMB_DIR = os.path.join(BASE_DIR, "uploads", "thumbnails")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

app = FastAPI(title="Last Looks")

# In-memory job store. Fine for a single-user local tool; would move to a real
# queue/store if this becomes a hosted multi-user service.
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _run_job(job_id: str, video_path: str):
    def on_progress(percent: int, stage: str):
        with _jobs_lock:
            _jobs[job_id].update(percent=percent, stage=stage)

    try:
        report = analyze(video_path, THUMB_DIR, progress_cb=on_progress)
        with _jobs_lock:
            _jobs[job_id].update(status="done", percent=100, stage="done", report=report)
    except Exception as e:
        with _jobs_lock:
            _jobs[job_id].update(status="error", error=str(e))


@app.post("/api/analyze")
async def start_analysis(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1] or ".mp4"
    video_id = uuid.uuid4().hex
    video_path = os.path.join(UPLOAD_DIR, f"{video_id}{ext}")

    with open(video_path, "wb") as out:
        shutil.copyfileobj(file.file, out)

    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "percent": 0,
            "stage": "starting",
            "video_id": video_id,
            "video_url": f"/api/video/{video_id}{ext}",
        }

    thread = threading.Thread(target=_run_job, args=(job_id, video_path), daemon=True)
    thread.start()

    return {"job_id": job_id}


@app.get("/api/analyze/{job_id}")
async def get_job_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown job")
        return dict(job)


@app.get("/api/video/{filename}")
async def get_video(filename: str):
    path = os.path.join(UPLOAD_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)


@app.get("/api/thumbnail/{filename}")
async def get_thumbnail(filename: str):
    path = os.path.join(THUMB_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)


app.mount("/", StaticFiles(directory=os.path.join(BASE_DIR, "app", "static"), html=True), name="static")
