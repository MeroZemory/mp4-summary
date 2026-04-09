# MP4 Summary

An end-to-end pipeline that automatically transcribes, corrects, and summarizes lecture videos (MP4), with an interactive web viewer for exploring the results. The correction prompts are domain-configurable — currently tuned for pharmaceutical/biomedical lectures, but adaptable to any subject by modifying `CORRECTION_SYSTEM_PROMPT`.

## Architecture Overview

```
MP4 Video Files
    │
    ▼
┌──────────────────────────────────────────────┐
│         extract_and_correct.py               │
│  ┌─────────┐  ┌─────────┐  ┌──────────────┐ │
│  │ Audio   │→ │  STT    │→ │ GPT Correct  │ │
│  │ Extract │  │ (EL/W)  │  │  (gpt-5.4)   │ │
│  └─────────┘  └─────────┘  └──────┬───────┘ │
│                                    ▼         │
│              ┌─────────────────────────┐     │
│              │  Summary (8 modules)    │     │
│              │  GPT-5.4 + Claude Opus  │     │
│              └────────────┬────────────┘     │
└───────────────────────────┼──────────────────┘
                            ▼
                      output/ (JSON, MD)
                            │
    ┌───────────────────────┼───────────────────────┐
    │               Viewer Web App                   │
    │  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
    │  │ FastAPI  │  │ React/TS │  │ PostgreSQL  │  │
    │  │ Backend  │  │ Frontend │  │ Database    │  │
    │  └──────────┘  └──────────┘  └─────────────┘ │
    └────────────────────────────────────────────────┘
```

## 1. Pipeline (`extract_and_correct.py`)

A 4-stage pipeline that extracts lecture content from MP4 videos and processes it with AI for correction and summarization.

### Pipeline Stages

| Stage | Description | API |
|-------|-------------|-----|
| **Audio** | MP4 → MP3 conversion (16kHz mono, 64kbps) | ffmpeg |
| **STT** | Speech-to-text with speaker diarization | ElevenLabs Scribe v2 / OpenAI Whisper |
| **Correct** | Domain terminology correction, language boundary fixes | GPT-5.4 |
| **Summary** | 8 parallel summary modules | GPT-5.4 + Claude Opus 4.6 |

### Summary Modules (8 parallel)

- **Overview** — Lecture title + summary
- **Key Concepts** — 8-15 core terms with first-mention timestamps
- **Timeline** — 5-10 chapter breakpoints
- **Study Guide** — 5-8 Q&A pairs
- **ShowMe (GPT/Claude)** — Visualizations with Mermaid diagrams
- **Notes (GPT/Claude)** — Comprehensive lecture notes

### Usage

```bash
# Run full pipeline
python extract_and_correct.py

# Run specific stages only
python extract_and_correct.py --stages summary

# Clear summary cache and regenerate
python extract_and_correct.py --refresh-summary
```

### Output Files

```
output/
├── {name}_raw_transcript_{hash}.json    # Raw STT output
├── {name}_corrected_{hash}.json         # Corrected transcript
├── {name}_summary_{hash}.json           # Summary (8 modules)
├── {name}_transcript_md_{hash}.md       # Markdown transcript
└── all_transcripts_{hash}.json          # Batch metadata
```

### Key Features

- **Parallel processing** — ThreadPoolExecutor (default 20 workers)
- **Caching** — Config-aware MD5 hashing to prevent redundant API calls
- **Auto-fallback** — Automatic switch from ElevenLabs to Whisper on failure
- **Retry with backoff** — Rate limit: 30s × attempt, general: 5-10s
- **Large file handling** — Auto-splits into 10-min chunks when exceeding API size limits

## 2. Viewer Web App (`viewer/`)

A full-stack web application for exploring pipeline results.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Backend | FastAPI, Uvicorn, asyncpg |
| Database | PostgreSQL 16 |
| AI Chat | Claude Sonnet 4.6 (SSE streaming) |
| Infra | Docker, docker-compose |

### Features

**Transcript Viewer**
- Toggle between corrected / raw / JSON view modes
- Per-segment timestamps with text display
- In-transcript search (⌘K)

**AI Summary Dashboard**
- Lecture overview, key concepts, timeline, study guide
- Mermaid diagrams with fullscreen zoom/pan
- Side-by-side GPT vs Claude comparison

**Audio Player**
- Click any timestamp to jump to that position
- Playback speed control (0.75x - 2x)

**AI Chat**
- Lecture-context Q&A powered by Claude Sonnet 4.6
- Real-time SSE streaming
- Multi-session management
- Auto-compaction (compresses conversation when exceeding 80K tokens)

**Bookmarks**
- Right-click segments to add bookmarks
- 5 color tags + notes
- Sidebar bookmark list management

**Learning Notes (QA Insights)**
- Auto-extracts learning notes from chat Q&A (Claude Haiku 4.5)
- Classifies as new / merge with existing / skip
- Batch approve/edit/dismiss

**Authentication**
- JWT + bcrypt local auth
- Google OAuth 2.0

### API Endpoints

```
POST   /api/auth/register               # Sign up
POST   /api/auth/login                  # Sign in
GET    /api/auth/me                     # Current user
GET    /api/auth/google                 # Google OAuth

GET    /api/chat/sessions               # List chat sessions
POST   /api/chat/sessions               # Create session
POST   /api/chat/sessions/:id/messages  # Send message (SSE)

GET    /api/bookmarks                   # List bookmarks
POST   /api/bookmarks                   # Create bookmark

GET    /api/insights                    # List learning notes
GET    /api/insights/pending            # Pending notes
POST   /api/insights/batch              # Batch operations
```

## 3. Getting Started

### Pipeline Requirements

- Python 3.10+
- ffmpeg, ffprobe
- API keys: OpenAI (required), ElevenLabs (optional), Anthropic (optional)

```bash
# .env configuration
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=sk_...        # Optional (not needed if STT_PROVIDER=whisper)
ANTHROPIC_API_KEY=sk-ant-...     # Optional (for Claude summaries/notes)
STT_PROVIDER=elevenlabs          # elevenlabs or whisper
CORRECTION_MODEL=gpt-5.4
MAX_WORKERS=20
```

### Viewer (Docker)

```bash
cd viewer

# Configure viewer/.env
DB_PASSWORD=<secure-password>
JWT_SECRET=<secure-secret>
ANTHROPIC_API_KEY=sk-ant-...
CHAT_MODEL=claude-sonnet-4-6

# Build and run
docker compose up --build -d
```

The service starts at `http://localhost:8000`.

### Viewer (Local Development)

```bash
# Backend
cd viewer/backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8000

# Frontend
cd viewer/frontend
npm install
npm run dev
```

## 4. Database Schema

```
users              # Users (email/password + OAuth)
chat_sessions      # Chat sessions per lecture
chat_messages      # Message history (token tracking, compaction support)
bookmarks          # Timestamped bookmarks (color tags)
qa_insights        # Learning notes (pending/accepted/dismissed)
```

## 5. Project Structure

```
mp4-summary/
├── extract_and_correct.py    # Main pipeline script
├── output/                   # Pipeline output (JSON, MD, MP3)
└── viewer/                   # Web viewer
    ├── Dockerfile
    ├── docker-compose.yml
    ├── backend/
    │   ├── server.py         # FastAPI entrypoint
    │   ├── auth.py           # JWT + OAuth authentication
    │   ├── chat.py           # AI chat (SSE + auto-compaction)
    │   ├── bookmarks.py      # Bookmark CRUD
    │   ├── qa_extraction.py  # Learning note extraction
    │   ├── lecture_data.py   # Lecture data loader
    │   ├── db.py             # DB connection pool
    │   └── migrations/       # PostgreSQL migrations
    └── frontend/
        ├── src/App.tsx       # Main SPA component
        ├── package.json
        └── vite.config.ts
```
