"""
강의 데이터 로더 — output/ JSON 파일을 메모리에 로드
"""

import glob
import json
import os
import re
import threading

LECTURE_DATA: dict[str, dict] = {}  # lecture_id → { "corrected": [...], "summary": {...} }

_reload_lock = threading.Lock()


def _extract_base(filename: str) -> str:
    """파일명에서 base name 추출 (확장자, 해시, 접미사 제거)"""
    name = filename.replace(".json", "")
    name = re.sub(r"_[a-f0-9]{6,}$", "", name)
    name = re.sub(r"_(corrected|raw_transcript|summary)$", "", name)
    return name


def _data_dir() -> str:
    return os.environ.get("LECTURE_DATA_DIR", "./lecture_data")


def load_lecture_data(verbose: bool = True) -> int:
    """lecture_data 디렉토리를 스캔해 메모리에 반영. 재호출 시 누적 갱신.
    반환값: 현재 메모리에 보유한 강의 수."""
    with _reload_lock:
        data_dir = _data_dir()
        if not os.path.isdir(data_dir):
            if verbose:
                print(f"[강의 데이터] 디렉토리 없음: {data_dir}")
            return len(LECTURE_DATA)

        for path in glob.glob(os.path.join(data_dir, "*_corrected_*.json")):
            base = _extract_base(os.path.basename(path))
            try:
                LECTURE_DATA.setdefault(base, {})["corrected"] = json.loads(
                    open(path, encoding="utf-8").read()
                )
            except (OSError, json.JSONDecodeError) as e:
                if verbose:
                    print(f"[강의 데이터] 로드 실패 {path}: {e}")

        for path in glob.glob(os.path.join(data_dir, "*_summary_*.json")):
            base = _extract_base(os.path.basename(path))
            try:
                LECTURE_DATA.setdefault(base, {})["summary"] = json.loads(
                    open(path, encoding="utf-8").read()
                )
            except (OSError, json.JSONDecodeError) as e:
                if verbose:
                    print(f"[강의 데이터] 로드 실패 {path}: {e}")

        if verbose:
            print(f"[강의 데이터] {len(LECTURE_DATA)}개 강의 로드 완료")
            for lecture_id, data in LECTURE_DATA.items():
                segs = len(data.get("corrected", []))
                has_summary = "summary" in data
                print(f"  - {lecture_id}: {segs}개 세그먼트, 요약={'있음' if has_summary else '없음'}")

        return len(LECTURE_DATA)


def refresh_lecture(lecture_id: str) -> bool:
    """특정 lecture_id에 해당하는 JSON만 다시 로드. 완료된 job 처리 후 사용."""
    with _reload_lock:
        data_dir = _data_dir()
        if not os.path.isdir(data_dir):
            return False

        found = False
        for path in glob.glob(os.path.join(data_dir, f"{lecture_id}_corrected_*.json")):
            try:
                LECTURE_DATA.setdefault(lecture_id, {})["corrected"] = json.loads(
                    open(path, encoding="utf-8").read()
                )
                found = True
            except (OSError, json.JSONDecodeError):
                pass

        for path in glob.glob(os.path.join(data_dir, f"{lecture_id}_summary_*.json")):
            try:
                LECTURE_DATA.setdefault(lecture_id, {})["summary"] = json.loads(
                    open(path, encoding="utf-8").read()
                )
                found = True
            except (OSError, json.JSONDecodeError):
                pass

        return found


def get_lecture_ids() -> list[str]:
    return list(LECTURE_DATA.keys())


def get_lecture(lecture_id: str) -> dict | None:
    return LECTURE_DATA.get(lecture_id)
