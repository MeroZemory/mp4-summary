"""
강의 녹취록 뷰어 서버
Usage: uvicorn server:app --host 0.0.0.0 --port 8000
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from auth import COOKIE_NAME, GOOGLE_CLIENT_ID, decode_token, router as auth_router
from bookmarks import router as bookmarks_router
from chat import router as chat_router
from db import close_pool, run_migrations
from lecture_data import load_lecture_data
from qa_extraction import router as insights_router

# ── Paths ──

_HERE = os.path.dirname(os.path.abspath(__file__))
_FRONTEND_DIST = os.path.join(_HERE, "..", "frontend", "dist")
DIST = os.environ.get("DIST_DIR") or (
    _FRONTEND_DIST if os.path.isdir(_FRONTEND_DIST) else os.path.join(_HERE, "dist")
)


# ── App lifecycle ──

@asynccontextmanager
async def lifespan(_app: FastAPI):
    database_url = os.environ.get("DATABASE_URL", "")
    if database_url:
        print("[서버] DB 마이그레이션 실행 중...")
        await run_migrations()
        print("[서버] DB 준비 완료")
    else:
        print("[서버] DATABASE_URL 미설정 — DB 없이 실행")
    load_lecture_data()
    yield
    await close_pool()


app = FastAPI(docs_url=None, redoc_url=None, lifespan=lifespan)

# ── Auth routes ──

app.include_router(auth_router)
app.include_router(bookmarks_router)
app.include_router(chat_router)
app.include_router(insights_router)


# ── Login / Register pages (server-rendered HTML) ──

def _page_html(mode: str = "login", error: str = "") -> str:
    is_login = mode == "login"
    title = "로그인" if is_login else "회원가입"
    subtitle = "계정에 로그인해주세요" if is_login else "새 계정을 만들어주세요"
    action_label = "로그인" if is_login else "가입하기"
    switch_text = '계정이 없으신가요? <a href="/register" style="color:#0d9488;font-weight:600;">회원가입</a>' if is_login else '이미 계정이 있으신가요? <a href="/login" style="color:#0d9488;font-weight:600;">로그인</a>'

    error_block = f'<p class="err">{error}</p>' if error else ""

    name_field = "" if is_login else """
    <label for="name">이름</label>
    <input type="text" id="name" name="display_name" placeholder="표시 이름" style="margin-bottom:12px;">
    """

    google_btn = ""
    if GOOGLE_CLIENT_ID:
        google_btn = """
    <div style="margin-top:16px;text-align:center;color:#94a3b8;font-size:12px;">또는</div>
    <a href="/api/auth/google" class="oauth-btn">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#34A853" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#FBBC05" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Google로 계속하기
    </a>"""

    return f"""\
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>강의 녹취록 — {title}</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" rel="stylesheet">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{
  font-family:'Pretendard',-apple-system,BlinkMacSystemFont,sans-serif;
  background:#f8f9fa;height:100vh;height:100dvh;
  display:flex;align-items:center;justify-content:center;
  -webkit-font-smoothing:antialiased;
}}
.card{{
  background:#fff;border:1px solid #e2e8f0;border-radius:16px;
  padding:40px 36px;width:100%;max-width:360px;
  box-shadow:0 4px 24px rgba(0,0,0,.05);
}}
h1{{font-size:17px;font-weight:700;color:#1e293b;letter-spacing:-.01em}}
.sub{{font-size:13px;color:#94a3b8;margin-top:6px;margin-bottom:24px;line-height:1.5}}
label{{
  display:block;font-size:11px;font-weight:600;color:#64748b;
  margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;
}}
input{{
  width:100%;padding:10px 14px;font-size:14px;
  border:1px solid #e2e8f0;border-radius:10px;
  outline:none;transition:all .15s;font-family:inherit;background:#f8fafc;
}}
input:focus{{border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.1);background:#fff}}
.err{{font-size:12px;color:#ef4444;margin-top:8px;margin-bottom:4px}}
button{{
  width:100%;margin-top:16px;padding:11px;font-size:14px;font-weight:600;
  color:#fff;background:#0d9488;border:none;border-radius:10px;
  cursor:pointer;transition:all .15s;font-family:inherit;
}}
button:hover{{background:#0f766e}}
button:active{{transform:scale(.98)}}
.switch{{margin-top:16px;text-align:center;font-size:13px;color:#94a3b8}}
.switch a{{text-decoration:none}}
.oauth-btn{{
  display:flex;align-items:center;justify-content:center;gap:10px;
  margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:10px;
  font-size:13px;font-weight:500;color:#334155;text-decoration:none;
  transition:all .15s;background:#fff;
}}
.oauth-btn:hover{{background:#f8fafc;border-color:#cbd5e1}}
</style>
</head>
<body>
<div class="card">
  <h1>강의 녹취록</h1>
  <p class="sub">{subtitle}</p>
  {error_block}
  <form id="authForm">
    {name_field}
    <label for="email">이메일</label>
    <input type="email" id="email" name="email" placeholder="email@example.com" autocomplete="email" required style="margin-bottom:12px;">
    <label for="pw">비밀번호</label>
    <input type="password" id="pw" name="password" placeholder="비밀번호" autocomplete="{'current-password' if is_login else 'new-password'}" required>
    <button type="submit">{action_label}</button>
  </form>
  {google_btn}
  <div class="switch">{switch_text}</div>
</div>
<script>
document.getElementById('authForm').addEventListener('submit', async (e) => {{
  e.preventDefault();
  const form = e.target;
  const data = {{}};
  new FormData(form).forEach((v, k) => data[k] = v);
  const endpoint = '{"login" if is_login else "register"}';
  try {{
    const res = await fetch('/api/auth/' + endpoint, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify(data),
    }});
    if (res.ok) {{
      window.location.href = '/';
    }} else {{
      const err = await res.json().catch(() => ({{}}));
      const msg = err.detail || '오류가 발생했습니다';
      let errEl = form.querySelector('.err');
      if (!errEl) {{ errEl = document.createElement('p'); errEl.className = 'err'; form.prepend(errEl); }}
      errEl.textContent = msg;
    }}
  }} catch (ex) {{
    alert('네트워크 오류: ' + ex.message);
  }}
}});
</script>
</body>
</html>"""


@app.get("/login", response_class=HTMLResponse)
async def login_page(error: str = ""):
    return _page_html("login", error)


@app.get("/register", response_class=HTMLResponse)
async def register_page():
    return _page_html("register")


# ── Auth middleware ──

@app.middleware("http")
async def auth_guard(request: Request, call_next):
    path = request.url.path
    # Public paths
    if path in ("/login", "/register") or path.startswith("/api/auth/"):
        return await call_next(request)
    # Check JWT
    token = request.cookies.get(COOKIE_NAME)
    if not token or not decode_token(token):
        return RedirectResponse("/login")
    return await call_next(request)


# ── Audio files ──

_LECTURE_DATA_DIR = os.environ.get("LECTURE_DATA_DIR", os.path.join(_HERE, "lecture_data"))
if os.path.isdir(_LECTURE_DATA_DIR):
    app.mount("/api/audio", StaticFiles(directory=_LECTURE_DATA_DIR), name="audio")

# ── Static files (must be last) ──

app.mount("/", StaticFiles(directory=DIST, html=True), name="static")
