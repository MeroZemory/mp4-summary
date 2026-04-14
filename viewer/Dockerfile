# ── Stage 1: Build frontend ──────────────────────────────
FROM node:20-alpine AS frontend

WORKDIR /build/viewer/frontend
COPY viewer/frontend/package.json viewer/frontend/package-lock.json ./
RUN npm ci

COPY viewer/frontend/ .
COPY output/ /build/output/
RUN npm run build

# ── Stage 2: Python server ──────────────────────────────
FROM python:3.13-slim

# ffmpeg는 extract_audio에서 필수
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY viewer/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY viewer/backend/ .
COPY --from=frontend /build/viewer/frontend/dist ./dist

# 파이프라인 스크립트 + 도메인 프롬프트 복사 (import 및 런타임에 필요)
COPY extract_and_correct.py /project/extract_and_correct.py
COPY domain_detector.py /project/domain_detector.py
COPY prompts/ /project/prompts/
RUN mkdir -p /project/downloads /project/output /project/embeddings_cache

ENV DIST_DIR=/app/dist \
    LECTURE_DATA_DIR=/project/output \
    DOWNLOADS_DIR=/project/downloads \
    PROJECT_ROOT=/project \
    PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
