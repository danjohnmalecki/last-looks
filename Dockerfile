FROM python:3.12-slim

# ffmpeg -> frame/audio processing, tesseract-ocr -> OCR checks,
# libgl1/libglib2.0-0 -> required by opencv-python at runtime on Debian slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg tesseract-ocr libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY engine ./engine
COPY app ./app

# Where faster-whisper caches its downloaded model on first run.
ENV HF_HOME=/app/.cache
RUN mkdir -p /app/uploads/thumbnails /app/.cache

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
