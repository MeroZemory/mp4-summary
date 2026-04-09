"""
강의 데이터 로더 — output/ JSON 파일을 메모리에 로드
"""

import glob
import json
import os
import re

LECTURE_DATA: dict[str, dict] = {}  # lecture_id → { "corrected": [...], "summary": {...} }


def _extract_base(filename: str) -> str:
    """파일명에서 base name 추출 (확장자, 해시, 접미사 제거)"""
    name = filename.replace(".json", "")
    name = re.sub(r"_[a-f0-9]{6,}$", "", name)
    name = re.sub(r"_(corrected|raw_transcript|summary)$", "", name)
    return name


def load_lecture_data():
    """서버 시작 시 호출 — lecture_data 디렉토리에서 JSON 로드"""
    data_dir = os.environ.get("LECTURE_DATA_DIR", "./lecture_data")
    if not os.path.isdir(data_dir):
        print(f"[강의 데이터] 디렉토리 없음: {data_dir}")
        return

    for path in glob.glob(os.path.join(data_dir, "*_corrected_*.json")):
        base = _extract_base(os.path.basename(path))
        LECTURE_DATA.setdefault(base, {})["corrected"] = json.loads(
            open(path, encoding="utf-8").read()
        )

    for path in glob.glob(os.path.join(data_dir, "*_summary_*.json")):
        base = _extract_base(os.path.basename(path))
        LECTURE_DATA.setdefault(base, {})["summary"] = json.loads(
            open(path, encoding="utf-8").read()
        )

    print(f"[강의 데이터] {len(LECTURE_DATA)}개 강의 로드 완료")
    for lecture_id, data in LECTURE_DATA.items():
        segs = len(data.get("corrected", []))
        has_summary = "summary" in data
        print(f"  - {lecture_id}: {segs}개 세그먼트, 요약={'있음' if has_summary else '없음'}")


def get_lecture_ids() -> list[str]:
    return list(LECTURE_DATA.keys())


def get_lecture(lecture_id: str) -> dict | None:
    return LECTURE_DATA.get(lecture_id)
