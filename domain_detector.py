"""
HyQE 기반 자동 도메인 감지 모듈

STT 결과에서 키워드를 추출 → 임베딩 → 도메인 시그니처와 비교하여
가장 적합한 교정 프롬프트를 자동 선택한다.
"""

import json
import math
from pathlib import Path
from typing import NamedTuple

import openai

# ── 설정 ──────────────────────────────────────────────────────────────────────

KEYWORD_MODEL = "gpt-4.1-nano"
EMBEDDING_MODEL = "text-embedding-3-small"
SAMPLE_HEAD = 15
SAMPLE_MIDDLE = 5

PROMPTS_DIR = Path(__file__).parent / "prompts"
EMBEDDINGS_CACHE_DIR = Path(__file__).parent / "embeddings_cache"


class DomainMatch(NamedTuple):
    domain_id: str        # e.g. "pharmaceutical" or "generic"
    confidence: float     # cosine similarity (0.0 if generic fallback)
    system_prompt: str
    user_prompt: str


# ── Public API ────────────────────────────────────────────────────────────────

def detect_domain(
    raw_segments: list[dict],
    client: openai.OpenAI,
    cache_dir: Path,
    video_stem: str,
    stt_provider: str,
) -> DomainMatch:
    """
    raw_segments에서 도메인을 감지하고 적합한 프롬프트를 반환한다.
    결과는 cache_dir에 캐싱되어 동일 영상 재실행 시 API 호출을 건너뛴다.
    """
    registry = _load_registry()
    threshold = registry.get("similarity_threshold", 0.45)
    domains = registry.get("domains", [])

    if not domains:
        return _generic_match()

    # 캐시 확인
    cached = _load_cache(cache_dir, video_stem, stt_provider)
    if cached is not None:
        domain_id, confidence = cached["domain_id"], cached["confidence"]
        print(f"  [캐시] 도메인: {domain_id} (신뢰도: {confidence:.3f})")
        return DomainMatch(domain_id, confidence, *_load_prompts(domain_id))

    # 세그먼트가 너무 적으면 generic
    if len(raw_segments) < 5:
        result = _generic_match()
        _save_cache(cache_dir, video_stem, stt_provider, result.domain_id, result.confidence)
        return result

    # 1. 샘플링
    sample = _sample_segments(raw_segments)
    sample_text = "\n".join(s["text"] for s in sample)

    # 2. 키워드 추출
    keywords = _extract_keywords(sample_text, client)
    if not keywords:
        result = _generic_match()
        _save_cache(cache_dir, video_stem, stt_provider, result.domain_id, result.confidence)
        return result

    # 3. 키워드 임베딩
    keyword_text = ", ".join(keywords)
    query_vec = _embed(keyword_text, client)

    # 4. 각 도메인 시그니처와 비교 (없으면 자동 생성)
    _ensure_domain_embeddings(domains, client)
    best_id, best_score = "generic", 0.0
    for domain in domains:
        sig_vec = _load_domain_embedding(domain["id"])
        if sig_vec is None:
            continue
        score = _cosine_similarity(query_vec, sig_vec)
        if score > best_score:
            best_id, best_score = domain["id"], score

    # 5. 임계값 판정
    if best_score < threshold:
        best_id, best_score = "generic", 0.0

    _save_cache(cache_dir, video_stem, stt_provider, best_id, best_score)
    return DomainMatch(best_id, best_score, *_load_prompts(best_id))


def precompute_domain_embeddings(client: openai.OpenAI) -> None:
    """domains.json의 각 도메인 키워드를 임베딩하여 embeddings_cache/에 저장한다."""
    EMBEDDINGS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    registry = _load_registry()

    for domain in registry.get("domains", []):
        keyword_text = ", ".join(domain["keywords"])
        vec = _embed(keyword_text, client)
        out = EMBEDDINGS_CACHE_DIR / f"{domain['id']}.json"
        out.write_text(json.dumps(vec), encoding="utf-8")
        print(f"  [임베딩] {domain['id']}: {len(domain['keywords'])}개 키워드 → {out.name}")


# ── Internal ──────────────────────────────────────────────────────────────────

def _ensure_domain_embeddings(domains: list[dict], client: openai.OpenAI) -> None:
    """도메인 임베딩이 없으면 자동으로 생성한다."""
    EMBEDDINGS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for domain in domains:
        path = EMBEDDINGS_CACHE_DIR / f"{domain['id']}.json"
        if path.exists():
            continue
        print(f"    [도메인] 임베딩 생성 중: {domain['id']}")
        keyword_text = ", ".join(domain["keywords"])
        vec = _embed(keyword_text, client)
        path.write_text(json.dumps(vec), encoding="utf-8")
        print(f"    [도메인] 임베딩 생성 완료: {domain['id']}")


def _sample_segments(raw_segments: list[dict]) -> list[dict]:
    """앞 SAMPLE_HEAD개 + 중간에서 균등하게 SAMPLE_MIDDLE개 선택."""
    head = raw_segments[:SAMPLE_HEAD]

    remaining = raw_segments[SAMPLE_HEAD:]
    middle = []
    if remaining and SAMPLE_MIDDLE > 0:
        step = max(1, len(remaining) // (SAMPLE_MIDDLE + 1))
        for i in range(1, SAMPLE_MIDDLE + 1):
            idx = i * step
            if idx < len(remaining):
                middle.append(remaining[idx])

    return head + middle


def _extract_keywords(sample_text: str, client: openai.OpenAI) -> list[str]:
    """gpt-4.1-nano로 도메인 키워드 15-25개를 추출한다."""
    try:
        resp = client.chat.completions.create(
            model=KEYWORD_MODEL,
            messages=[
                {"role": "system", "content": (
                    "You analyze raw speech-to-text transcripts to identify the academic domain. "
                    "Extract 15-25 domain-specific keywords and phrases.\n\n"
                    "Focus on: technical terminology, named entities (proteins, drugs, algorithms, "
                    "theories, etc.), domain-specific abbreviations, proper nouns of methods/tools.\n\n"
                    "Do NOT include: common words, generic academic terms (연구, 분석, example), "
                    "Korean grammatical particles or fillers.\n\n"
                    'Return JSON: {"keywords": ["keyword1", "keyword2", ...]}'
                )},
                {"role": "user", "content": sample_text},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=300,
        )
        data = json.loads(resp.choices[0].message.content)
        keywords = data.get("keywords", [])
        if isinstance(keywords, list):
            return [k for k in keywords if isinstance(k, str)]
    except Exception as e:
        print(f"    [도메인] 키워드 추출 실패, generic 사용: {e}")
    return []


def _embed(text: str, client: openai.OpenAI) -> list[float]:
    """text-embedding-3-small로 임베딩 벡터를 반환한다."""
    resp = client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    return resp.data[0].embedding


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """두 벡터의 코사인 유사도를 계산한다 (순수 Python)."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _load_registry() -> dict:
    """prompts/domains.json을 로드한다."""
    path = PROMPTS_DIR / "domains.json"
    if not path.exists():
        return {"domains": [], "similarity_threshold": 0.45}
    return json.loads(path.read_text(encoding="utf-8"))


def _load_domain_embedding(domain_id: str) -> list[float] | None:
    """embeddings_cache/{domain_id}.json에서 사전 계산된 임베딩을 로드한다."""
    path = EMBEDDINGS_CACHE_DIR / f"{domain_id}.json"
    if not path.exists():
        print(f"    [도메인] 임베딩 없음: {domain_id} (python domain_detector.py --precompute 실행 필요)")
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _load_prompts(domain_id: str) -> tuple[str, str]:
    """prompts/{domain_id}/system.md와 user.md를 로드한다."""
    domain_dir = PROMPTS_DIR / domain_id
    if not domain_dir.exists():
        domain_dir = PROMPTS_DIR / "generic"

    system = (domain_dir / "system.md").read_text(encoding="utf-8").strip()
    user = (domain_dir / "user.md").read_text(encoding="utf-8").strip()
    return system, user


def _generic_match() -> DomainMatch:
    """generic 프롬프트를 반환한다."""
    return DomainMatch("generic", 0.0, *_load_prompts("generic"))


def _cache_key(video_stem: str, stt_provider: str) -> str:
    return f".domain_cache_{video_stem}_{stt_provider}"


def _load_cache(cache_dir: Path, video_stem: str, stt_provider: str) -> dict | None:
    path = cache_dir / f"{_cache_key(video_stem, stt_provider)}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_cache(
    cache_dir: Path, video_stem: str, stt_provider: str,
    domain_id: str, confidence: float,
) -> None:
    path = cache_dir / f"{_cache_key(video_stem, stt_provider)}.json"
    path.write_text(
        json.dumps({"domain_id": domain_id, "confidence": confidence}),
        encoding="utf-8",
    )


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys as _sys

    if "--precompute" in _sys.argv:
        api_key = None
        # .env에서 키 로드 시도
        env_path = Path(__file__).parent / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("OPENAI_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
                    break
        if not api_key:
            import os as _os
            api_key = _os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            print("OPENAI_API_KEY를 찾을 수 없습니다.")
            _sys.exit(1)

        _client = openai.OpenAI(api_key=api_key)
        precompute_domain_embeddings(_client)
        print("도메인 임베딩 사전 계산 완료.")
    else:
        print("사용법: python domain_detector.py --precompute")
