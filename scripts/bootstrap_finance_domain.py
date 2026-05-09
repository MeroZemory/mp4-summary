"""
finance 도메인의 키워드 시그니처와 코렉션 프롬프트 초안을 자동 생성하는 일회성 스크립트.

사용법:
    python scripts/bootstrap_finance_domain.py <base_name1> <base_name2> ...

각 base_name 은 output/ 디렉토리의 *_raw_transcript_*.json 파일명에서 파생된
강의 식별자 (예: "KB증권_분석") 이다. 스크립트는:

1. 각 강의의 raw transcript 를 샘플링 (앞 15 + 중간 5 세그먼트)
2. gpt-4.1-nano 로 키워드 추출
3. 모든 강의 키워드를 빈도순으로 정렬, 상위 ~40개 출력
4. system.md / user.md 의 LLM 초안을 출력

결과는 stdout 으로만 나오며, 운영자가 검토 후 수동으로
prompts/finance/system.md, user.md, prompts/domains.json 을 갱신한다.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

import openai

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = Path(os.environ.get("LECTURE_DATA_DIR", PROJECT_ROOT / "output"))
SAMPLE_HEAD = 15
SAMPLE_MIDDLE = 5
KEYWORD_MODEL = "gpt-4.1-nano"
DRAFT_MODEL = "gpt-5.4"


def _load_api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return key
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("OPENAI_API_KEY 가 설정되어 있지 않습니다 (.env 또는 환경변수)")


def _find_raw_transcript(base_name: str) -> Path | None:
    candidates = sorted(OUTPUT_DIR.glob(f"{base_name}_raw_transcript_*.json"))
    return candidates[-1] if candidates else None


def _sample_text(segments: list[dict]) -> str:
    head = segments[:SAMPLE_HEAD]
    remaining = segments[SAMPLE_HEAD:]
    middle: list[dict] = []
    if remaining and SAMPLE_MIDDLE > 0:
        step = max(1, len(remaining) // (SAMPLE_MIDDLE + 1))
        for i in range(1, SAMPLE_MIDDLE + 1):
            idx = i * step
            if idx < len(remaining):
                middle.append(remaining[idx])
    return "\n".join(s.get("text", "") for s in head + middle)


def _extract_keywords(client: openai.OpenAI, text: str) -> list[str]:
    resp = client.chat.completions.create(
        model=KEYWORD_MODEL,
        messages=[
            {"role": "system", "content": (
                "You analyze Korean financial / capital-markets lecture transcripts to identify domain-specific terminology. "
                "Extract 15-25 domain keywords and phrases.\n\n"
                "Focus on: 종목명, 지수명, 파생상품, 거시지표, 회계 항목, 통화/환율 약어, 주요 인물 (Powell 등), 정책 약어 (FOMC 등).\n"
                "Do NOT include: 일반 명사, 한국어 조사, 강의 형식 문구.\n"
                'Return JSON: {"keywords": ["keyword1", "keyword2", ...]}'
            )},
            {"role": "user", "content": text},
        ],
        response_format={"type": "json_object"},
        max_completion_tokens=400,
    )
    data = json.loads(resp.choices[0].message.content or "{}")
    keywords = data.get("keywords", [])
    if isinstance(keywords, list):
        return [k.strip() for k in keywords if isinstance(k, str) and k.strip()]
    return []


def _draft_prompts(client: openai.OpenAI, sample_keywords: list[str]) -> tuple[str, str]:
    """system.md, user.md 초안을 LLM 으로 생성. pharmaceutical 템플릿을 참고."""
    pharma_system = (PROJECT_ROOT / "prompts" / "pharmaceutical" / "system.md").read_text(encoding="utf-8")
    pharma_user = (PROJECT_ROOT / "prompts" / "pharmaceutical" / "user.md").read_text(encoding="utf-8")
    keyword_text = ", ".join(sample_keywords[:40])

    prompt = (
        "다음 system.md / user.md 는 pharmaceutical 도메인 강의 ASR 코렉션용 프롬프트다. "
        "이 구조를 그대로 차용해서 한국어 finance / 자본시장 강의용 system.md 와 user.md 를 작성해라. "
        "도메인 컨텍스트, 자주 망가지는 어휘 사례, 한영 코드 스위칭 처리, 숫자/단위 정규화에 대한 지침을 포함해라.\n\n"
        f"## pharmaceutical/system.md\n{pharma_system}\n\n"
        f"## pharmaceutical/user.md\n{pharma_user}\n\n"
        f"## 강의에서 실제로 등장한 finance 도메인 키워드 (참고)\n{keyword_text}\n\n"
        "출력은 정확히 다음 JSON 포맷:\n"
        '{"system": "...", "user": "..."}'
    )
    resp = client.chat.completions.create(
        model=DRAFT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
    )
    data = json.loads(resp.choices[0].message.content or "{}")
    return data.get("system", ""), data.get("user", "")


def main(base_names: list[str]) -> None:
    if not base_names:
        raise SystemExit("사용법: python scripts/bootstrap_finance_domain.py <base_name1> [<base_name2> ...]")

    api_key = _load_api_key()
    client = openai.OpenAI(api_key=api_key)

    all_keywords: Counter[str] = Counter()
    used_lectures: list[str] = []

    for base in base_names:
        path = _find_raw_transcript(base)
        if path is None:
            print(f"  [스킵] raw transcript 없음: {base}", file=sys.stderr)
            continue
        try:
            segments = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  [스킵] 로드 실패 {base}: {e}", file=sys.stderr)
            continue
        sample = _sample_text(segments)
        if not sample.strip():
            print(f"  [스킵] 빈 샘플: {base}", file=sys.stderr)
            continue
        print(f"  [추출] {base} (segments={len(segments)})", file=sys.stderr)
        kws = _extract_keywords(client, sample)
        for k in kws:
            all_keywords[k] += 1
        used_lectures.append(base)

    if not all_keywords:
        raise SystemExit("키워드를 한 개도 추출하지 못했습니다.")

    top = [k for k, _ in all_keywords.most_common(40)]

    print("\n" + "=" * 60, file=sys.stderr)
    print(f"  {len(used_lectures)} 개 강의 분석 완료, {len(all_keywords)} 종 키워드", file=sys.stderr)
    print("=" * 60 + "\n", file=sys.stderr)

    print("## prompts/domains.json 의 finance.keywords 제안 (상위 40개, 빈도순)\n")
    print(json.dumps(top, ensure_ascii=False, indent=2))

    print("\n## prompts/finance/system.md 와 user.md 초안 생성 중 ...\n", file=sys.stderr)
    system_md, user_md = _draft_prompts(client, top)

    print("\n## prompts/finance/system.md (제안)\n")
    print(system_md)
    print("\n## prompts/finance/user.md (제안)\n")
    print(user_md)


if __name__ == "__main__":
    main(sys.argv[1:])
