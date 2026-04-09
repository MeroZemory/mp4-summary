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

WORKDIR /app
COPY viewer/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY viewer/backend/ .
COPY --from=frontend /build/viewer/frontend/dist ./dist
COPY output/ ./lecture_data/

ENV DIST_DIR=/app/dist
ENV LECTURE_DATA_DIR=/app/lecture_data
EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
