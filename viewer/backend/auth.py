"""
인증 모듈 — JWT + bcrypt + Google OAuth
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt as _bcrypt
import httpx
from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr


def hash_password(password: str) -> str:
    return _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return _bcrypt.checkpw(password.encode(), hashed.encode())

from db import get_pool

# ── Config ──

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7
COOKIE_NAME = "token"

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.environ.get(
    "GOOGLE_REDIRECT_URI", "https://lecture.agentryx-ai.com/api/auth/google/callback"
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Pydantic models ──

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: str
    email: str
    display_name: str | None


# ── JWT helpers ──

def create_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        return None


def set_auth_cookie(response: Response, token: str):
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=86400 * JWT_EXPIRE_DAYS,
        path="/",
    )


# ── Dependency: get current user ──

async def get_current_user(request: Request) -> dict | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    payload = decode_token(token)
    if not payload:
        return None
    return {"id": payload["sub"], "email": payload["email"]}


async def require_user(request: Request) -> dict:
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return user


# ── Routes ──

@router.post("/register")
async def register(body: RegisterRequest):
    pool = await get_pool()
    async with pool.acquire() as conn:
        existing = await conn.fetchval("SELECT id FROM users WHERE email = $1", body.email)
        if existing:
            raise HTTPException(status_code=409, detail="이미 등록된 이메일입니다")

        user_id = str(uuid.uuid4())
        password_hash = hash_password(body.password)
        display_name = body.display_name or body.email.split("@")[0]

        await conn.execute(
            "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)",
            uuid.UUID(user_id), body.email, password_hash, display_name,
        )

    response = Response(status_code=201)
    token = create_token(user_id, body.email)
    set_auth_cookie(response, token)
    return response


@router.post("/login")
async def login(body: LoginRequest):
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, email, password_hash FROM users WHERE email = $1", body.email
        )

    if not row or not row["password_hash"] or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="이메일 또는 비밀번호가 올바르지 않습니다")

    response = Response(status_code=200)
    token = create_token(str(row["id"]), row["email"])
    set_auth_cookie(response, token)
    return response


@router.post("/logout")
async def logout():
    response = Response(status_code=200)
    response.delete_cookie(COOKIE_NAME, path="/")
    return response


@router.get("/me")
async def me(user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, email, display_name FROM users WHERE id = $1",
            uuid.UUID(user["id"]),
        )
    if not row:
        raise HTTPException(status_code=404)
    return {"id": str(row["id"]), "email": row["email"], "display_name": row["display_name"]}


# ── Google OAuth ──

@router.get("/google")
async def google_login():
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google OAuth가 설정되지 않았습니다")
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account",
    }
    qs = "&".join(f"{k}={httpx.URL('', params={k: v}).params}" for k, v in params.items())
    # Build URL properly
    from urllib.parse import urlencode
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)
    return Response(status_code=307, headers={"Location": url})


@router.get("/google/callback")
async def google_callback(code: str):
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=501, detail="Google OAuth가 설정되지 않았습니다")

    # Exchange code for tokens
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Google 인증에 실패했습니다")
        tokens = token_resp.json()

        # Get user info
        userinfo_resp = await client.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        if userinfo_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Google 사용자 정보를 가져올 수 없습니다")
        userinfo = userinfo_resp.json()

    google_id = userinfo["id"]
    email = userinfo.get("email", "")
    name = userinfo.get("name", email.split("@")[0])

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Check if OAuth user exists
        row = await conn.fetchrow(
            "SELECT id, email FROM users WHERE oauth_provider = 'google' AND oauth_id = $1",
            google_id,
        )
        if row:
            user_id = str(row["id"])
            user_email = row["email"]
        else:
            # Check if email already registered (link accounts)
            row = await conn.fetchrow("SELECT id, email FROM users WHERE email = $1", email)
            if row:
                # Link OAuth to existing account
                await conn.execute(
                    "UPDATE users SET oauth_provider = 'google', oauth_id = $1 WHERE id = $2",
                    google_id, row["id"],
                )
                user_id = str(row["id"])
                user_email = row["email"]
            else:
                # Create new user
                user_id = str(uuid.uuid4())
                await conn.execute(
                    "INSERT INTO users (id, email, display_name, oauth_provider, oauth_id) VALUES ($1, $2, $3, 'google', $4)",
                    uuid.UUID(user_id), email, name, google_id,
                )
                user_email = email

    token = create_token(user_id, user_email)
    response = Response(status_code=307, headers={"Location": "/"})
    set_auth_cookie(response, token)
    return response
