"""
MP4 → STT(ElevenLabs/Whisper) → GPT-5.4 교정 파이프라인

ElevenLabs Scribe v2 (화자분리 지원) 또는 Whisper를 선택 가능.
최대 20 워커 병렬 처리, 옵션 조합별 캐시 관리.
"""

import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import anthropic
import httpx
import openai

from domain_detector import DomainMatch, detect_domain, _load_prompts as _load_domain_prompts

# ── 설정 로드 ─────────────────────────────────────────────────────────────────

def load_env(env_path: Path) -> dict[str, str]:
    """간단한 .env 파서"""
    env = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


SCRIPT_DIR = Path(__file__).resolve().parent
ENV = load_env(SCRIPT_DIR / ".env")

def _cfg(key: str, default: str = "") -> str:
    """ENV(.env) → os.environ 순으로 조회"""
    return ENV.get(key) or os.environ.get(key, default)


OPENAI_API_KEY = _cfg("OPENAI_API_KEY")
ELEVENLABS_API_KEY = _cfg("ELEVENLABS_API_KEY")
STT_PROVIDER = _cfg("STT_PROVIDER", "elevenlabs")  # "elevenlabs" or "whisper"
MAX_WORKERS = int(_cfg("MAX_WORKERS", "20"))
CORRECTION_MODEL = _cfg("CORRECTION_MODEL", "gpt-5.4")
ANTHROPIC_API_KEY = _cfg("ANTHROPIC_API_KEY")
DOMAIN_DETECTION = _cfg("DOMAIN_DETECTION", "auto")  # "auto", "generic", or a domain ID

if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY를 찾을 수 없습니다. .env를 확인하세요.")

openai_client = openai.OpenAI(api_key=OPENAI_API_KEY)
anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

BASE_DIR = SCRIPT_DIR.parent
REFERENCES_DIR = BASE_DIR / "references"
OUTPUT_DIR = SCRIPT_DIR / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

DOWNLOADS_DIR = SCRIPT_DIR / "downloads"
MP4_FILES = sorted(DOWNLOADS_DIR.glob("*.mp4")) if DOWNLOADS_DIR.exists() else []

# ElevenLabs 파일 크기 제한
ELEVENLABS_MAX_SIZE = 3 * 1024 * 1024 * 1024  # 3GB
WHISPER_MAX_SIZE = 25 * 1024 * 1024             # 25MB
CHUNK_DURATION_MINUTES = 10


# ── 캐시 키 ───────────────────────────────────────────────────────────────────

def make_cache_key(video_stem: str, stt_provider: str, correction_model: str,
                   stage: str, extra: str = "") -> str:
    """옵션 조합이 다르면 캐시 미스되도록 고유 키 생성"""
    opts = f"{stt_provider}_{correction_model}_{extra}".strip("_")
    h = hashlib.md5(opts.encode()).hexdigest()[:8]
    return f"{video_stem}_{stage}_{h}"


def cache_path_for(video_stem: str, stage: str) -> Path:
    """현재 옵션 조합의 캐시 파일 경로"""
    key = make_cache_key(video_stem, STT_PROVIDER, CORRECTION_MODEL, stage)
    return OUTPUT_DIR / f"{key}.json"


# ── 1단계: 오디오 추출 ────────────────────────────────────────────────────────

def extract_audio(mp4_path: Path) -> Path:
    """MP4에서 오디오를 MP3로 추출 (캐시됨)"""
    audio_path = OUTPUT_DIR / f"{mp4_path.stem}.mp3"
    if audio_path.exists():
        print(f"  [캐시] 오디오: {audio_path.name}")
        return audio_path

    print(f"  오디오 추출 중: {mp4_path.name}")
    subprocess.run(
        ["ffmpeg", "-i", str(mp4_path),
         "-vn", "-acodec", "libmp3lame", "-ab", "64k",
         "-ar", "16000", "-ac", "1", "-y", str(audio_path)],
        capture_output=True, check=True,
    )
    size_mb = audio_path.stat().st_size / (1024 * 1024)
    print(f"  오디오 추출 완료: {size_mb:.1f}MB")
    return audio_path


def get_audio_duration(audio_path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(audio_path)],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


# ── 2단계: 오디오 분할 (크기 초과 시에만) ────────────────────────────────────

def split_audio_if_needed(audio_path: Path, max_size: int) -> list[tuple[Path, float]]:
    """파일이 max_size를 초과할 때만 청크 분할. (path, offset_seconds) 튜플 리스트 반환"""
    file_size = audio_path.stat().st_size
    if file_size <= max_size:
        return [(audio_path, 0.0)]

    duration = get_audio_duration(audio_path)
    chunk_seconds = CHUNK_DURATION_MINUTES * 60
    num_chunks = int(duration // chunk_seconds) + (1 if duration % chunk_seconds > 0 else 0)
    print(f"  파일 크기 {file_size/(1024**3):.2f}GB > {max_size/(1024**3):.1f}GB 제한 → {num_chunks}개 청크 분할")

    chunks_dir = OUTPUT_DIR / f"{audio_path.stem}_chunks"
    chunks_dir.mkdir(exist_ok=True)

    results = []
    for i in range(num_chunks):
        start = i * chunk_seconds
        chunk_path = chunks_dir / f"chunk_{i:03d}.mp3"
        if not chunk_path.exists():
            subprocess.run(
                ["ffmpeg", "-i", str(audio_path),
                 "-ss", str(start), "-t", str(chunk_seconds),
                 "-acodec", "libmp3lame", "-ab", "64k",
                 "-ar", "16000", "-ac", "1", "-y", str(chunk_path)],
                capture_output=True, check=True,
            )
        results.append((chunk_path, start))

    return results


# ── 3단계: STT 트랜스크립션 ───────────────────────────────────────────────────

def _seconds_to_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


# ── ElevenLabs Scribe v2 ─────────────────────────────────────────────────────

def transcribe_elevenlabs(audio_path: Path, offset_seconds: float = 0.0,
                          chunk_label: str = "") -> list[dict]:
    """ElevenLabs Scribe v2로 트랜스크립션 (화자분리 포함)"""
    label = chunk_label or audio_path.name
    print(f"    [ElevenLabs] 트랜스크립션 중: {label}")

    with open(audio_path, "rb") as f:
        file_data = f.read()

    response = httpx.post(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers={"xi-api-key": ELEVENLABS_API_KEY},
        files={"file": (audio_path.name, file_data, "audio/mpeg")},
        data={
            "model_id": "scribe_v2",
            "diarize": "true",
            "timestamps_granularity": "word",
            "tag_audio_events": "false",
            "language_code": "kor",
        },
        timeout=1200.0,  # 20분 (긴 영상 대응)
    )
    response.raise_for_status()
    result = response.json()

    # 워드 레벨 → 세그먼트 레벨 변환 (30초 간격 또는 화자 변경 시 분할)
    segments = _words_to_segments(result.get("words", []), offset_seconds)
    print(f"    [ElevenLabs] 완료: {len(segments)}개 세그먼트 ({label})")
    return segments


def _words_to_segments(words: list[dict], offset: float,
                       max_gap: float = 30.0) -> list[dict]:
    """워드 리스트를 의미 있는 세그먼트로 그룹화"""
    if not words:
        return []

    segments = []
    current_texts = []
    current_start = None
    current_speaker = None

    for w in words:
        if w.get("type") != "word":
            continue
        word_start = w.get("start", 0)
        speaker = w.get("speaker_id")
        text = w.get("text", "")

        # 새 세그먼트 시작 조건: 첫 워드, 화자 변경, 30초 이상 간격
        if current_start is None:
            current_start = word_start
            current_speaker = speaker
            current_texts.append(text)
        elif (speaker != current_speaker) or (word_start - current_start > max_gap):
            # 기존 세그먼트 저장
            seg_text = " ".join(current_texts).strip()
            if seg_text:
                entry = {
                    "time": _seconds_to_timestamp(current_start + offset),
                    "text": seg_text,
                }
                if current_speaker:
                    entry["speaker"] = current_speaker
                segments.append(entry)
            # 새 세그먼트
            current_start = word_start
            current_speaker = speaker
            current_texts = [text]
        else:
            current_texts.append(text)

    # 마지막 세그먼트
    if current_texts:
        seg_text = " ".join(current_texts).strip()
        if seg_text:
            entry = {
                "time": _seconds_to_timestamp(current_start + offset),
                "text": seg_text,
            }
            if current_speaker:
                entry["speaker"] = current_speaker
            segments.append(entry)

    return segments


# ── Whisper ───────────────────────────────────────────────────────────────────

def transcribe_whisper(audio_path: Path, offset_seconds: float = 0.0,
                       chunk_label: str = "") -> list[dict]:
    """OpenAI Whisper로 트랜스크립션"""
    label = chunk_label or audio_path.name
    print(f"    [Whisper] 트랜스크립션 중: {label}")

    with open(audio_path, "rb") as audio_file:
        response = openai_client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )

    segments = []
    if hasattr(response, "segments") and response.segments:
        for seg in response.segments:
            start = seg.start if hasattr(seg, "start") else 0
            text = seg.text if hasattr(seg, "text") else ""
            segments.append({
                "time": _seconds_to_timestamp(start + offset_seconds),
                "text": text.strip(),
            })
    elif hasattr(response, "text") and response.text:
        segments.append({
            "time": _seconds_to_timestamp(offset_seconds),
            "text": response.text.strip(),
        })

    print(f"    [Whisper] 완료: {len(segments)}개 세그먼트 ({label})")
    return segments


# ── 통합 트랜스크립션 (병렬) ──────────────────────────────────────────────────

def transcribe_audio_parallel(audio_path: Path, provider: str) -> list[dict]:
    """오디오 파일을 트랜스크립션 (필요 시 분할, 병렬 처리, 폴백)"""
    cp = cache_path_for(audio_path.stem, "raw_transcript")
    if cp.exists():
        print(f"  [캐시] 트랜스크립트: {cp.name}")
        return json.loads(cp.read_text(encoding="utf-8"))

    all_segments = _do_transcribe(audio_path, provider)

    # ElevenLabs 실패 시 Whisper로 자동 폴백
    if not all_segments and provider == "elevenlabs":
        print(f"  [폴백] ElevenLabs 실패 → Whisper로 재시도")
        all_segments = _do_transcribe(audio_path, "whisper")

    # 빈 결과는 캐시하지 않음
    if all_segments:
        cp.write_text(json.dumps(all_segments, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  트랜스크립션 완료: {len(all_segments)}개 세그먼트")
    return all_segments


def _do_transcribe(audio_path: Path, provider: str) -> list[dict]:
    """실제 트랜스크립션 수행"""
    max_size = ELEVENLABS_MAX_SIZE if provider == "elevenlabs" else WHISPER_MAX_SIZE
    transcribe_fn = transcribe_elevenlabs if provider == "elevenlabs" else transcribe_whisper

    chunks = split_audio_if_needed(audio_path, max_size)
    num_workers = min(MAX_WORKERS, max(1, len(chunks)))
    print(f"  STT: {provider} | 청크: {len(chunks)}개 | 워커: {num_workers}개")

    if len(chunks) == 1:
        path, offset = chunks[0]
        try:
            return _transcribe_with_retry(transcribe_fn, path, offset, "전체")
        except Exception as e:
            print(f"  [오류] 트랜스크립션 실패: {e}")
            return []
    else:
        results_map = {}
        with ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = {}
            for i, (path, offset) in enumerate(chunks):
                label = f"청크 {i}/{len(chunks)-1}"
                future = executor.submit(_transcribe_with_retry, transcribe_fn, path, offset, label)
                futures[future] = i

            for future in as_completed(futures):
                idx = futures[future]
                try:
                    results_map[idx] = future.result()
                except Exception as e:
                    print(f"    [오류] 청크 {idx} 실패: {e}")
                    results_map[idx] = []

        all_segments = []
        for i in range(len(chunks)):
            all_segments.extend(results_map.get(i, []))
        return all_segments


def _transcribe_with_retry(fn, path: Path, offset: float, label: str,
                           retries: int = 3) -> list[dict]:
    """재시도 로직 포함 트랜스크립션"""
    last_error = None
    for attempt in range(retries):
        try:
            return fn(path, offset, label)
        except (httpx.HTTPStatusError, openai.RateLimitError) as e:
            last_error = e
            status = getattr(e, "response", None)
            status_code = status.status_code if status is not None else "?"
            wait = 30 * (attempt + 1)
            print(f"    HTTP {status_code} ({label}) — {wait}초 대기 후 재시도 ({attempt+1}/{retries})")
            time.sleep(wait)
        except Exception as e:
            last_error = e
            if attempt < retries - 1:
                print(f"    오류 ({label}), 재시도 ({attempt+1}/{retries}): {e}")
                time.sleep(5)
            else:
                raise
    # 모든 재시도 실패 — 예외 전파하여 폴백 가능하게
    raise RuntimeError(f"트랜스크립션 {retries}회 재시도 모두 실패 ({label}): {last_error}")


# ── 4단계: GPT 교정 (병렬) ────────────────────────────────────────────────────


def _correct_chunk(chunk: list[dict], chunk_label: str,
                   system_prompt: str, user_prompt: str) -> list[dict]:
    """단일 교정 청크 처리 (워커에서 호출)"""
    transcript_text = "\n".join(f"{s['time']}: {s['text']}" for s in chunk)
    print(f"    [GPT] 교정 중: {chunk_label} ({len(chunk)}개 세그먼트)")

    for attempt in range(3):
        try:
            response = openai_client.chat.completions.create(
                model=CORRECTION_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt.format(
                        transcript_text=transcript_text
                    )},
                ],
                max_completion_tokens=16000,
            )
            corrected_text = response.choices[0].message.content.strip()
            parsed = _parse_corrected_text(corrected_text)
            print(f"    [GPT] 완료: {chunk_label} → {len(parsed)}개")
            return parsed
        except openai.RateLimitError:
            wait = 60 * (attempt + 1)
            print(f"    [GPT] Rate limit ({chunk_label}) — {wait}초 대기")
            time.sleep(wait)
        except Exception as e:
            if attempt < 2:
                print(f"    [GPT] 오류 ({chunk_label}), 재시도: {e}")
                time.sleep(10)
            else:
                print(f"    [GPT] 교정 실패 ({chunk_label}), 원본 유지: {e}")
                return chunk
    return chunk


def _parse_corrected_text(text: str) -> list[dict]:
    segments = []
    for line in text.split("\n"):
        line = line.strip()
        match = re.match(r"(\d{2}:\d{2}:\d{2}):\s*(.*)", line)
        if match:
            segments.append({
                "time": match.group(1),
                "text": match.group(2).strip(),
            })
    return segments


def correct_transcript_parallel(raw_segments: list[dict], video_name: str,
                                system_prompt: str, user_prompt: str,
                                domain_id: str = "") -> list[dict]:
    """전체 트랜스크립트를 GPT로 병렬 교정"""
    cache_key = make_cache_key(video_name, STT_PROVIDER, CORRECTION_MODEL,
                               "corrected", extra=domain_id)
    cp = OUTPUT_DIR / f"{cache_key}.json"
    if cp.exists():
        print(f"  [캐시] 교정본: {cp.name}")
        return json.loads(cp.read_text(encoding="utf-8"))

    if not raw_segments:
        print("  [경고] 트랜스크립트가 비어있어 교정을 건너뜁니다.")
        return []

    CHUNK_SIZE = 80
    chunks = []
    for i in range(0, len(raw_segments), CHUNK_SIZE):
        chunks.append((i, raw_segments[i:i + CHUNK_SIZE]))

    num_workers = min(MAX_WORKERS, max(1, len(chunks)))
    print(f"  GPT 교정: {len(chunks)}개 청크 | {num_workers}개 워커 | 모델: {CORRECTION_MODEL}")

    results_map = {}
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = {}
        for idx, (start_i, chunk) in enumerate(chunks):
            label = f"세그먼트 {start_i+1}-{start_i+len(chunk)}"
            future = executor.submit(_correct_chunk, chunk, label,
                                     system_prompt, user_prompt)
            futures[future] = idx

        for future in as_completed(futures):
            idx = futures[future]
            try:
                results_map[idx] = future.result()
            except Exception as e:
                print(f"    [오류] 청크 {idx} 교정 실패: {e}")
                results_map[idx] = chunks[idx][1]  # 원본 유지

    # 순서대로 병합
    all_corrected = []
    for i in range(len(chunks)):
        all_corrected.extend(results_map.get(i, []))

    cp.write_text(json.dumps(all_corrected, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  교정 완료: {len(all_corrected)}개 세그먼트")
    return all_corrected


# ── 5단계: 강의 요약 생성 (병렬) ──────────────────────────────────────────────

def _snap_timestamp(target: str, valid_times: list[str]) -> str:
    """생성된 타임스탬프를 실제 세그먼트 타임스탬프 중 가장 가까운 값으로 스냅"""
    if not valid_times or target in valid_times:
        return target

    def to_secs(t: str) -> int:
        parts = t.split(":")
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])

    target_s = to_secs(target)
    best = min(valid_times, key=lambda t: abs(to_secs(t) - target_s))
    return best


def _call_gpt_json(system_prompt: str, user_prompt: str, label: str) -> dict:
    """GPT JSON 모드 호출 + 재시도"""
    for attempt in range(3):
        try:
            response = openai_client.chat.completions.create(
                model=CORRECTION_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                max_completion_tokens=8000,
            )
            return json.loads(response.choices[0].message.content)
        except openai.RateLimitError:
            wait = 60 * (attempt + 1)
            print(f"    [요약] Rate limit ({label}) — {wait}초 대기")
            time.sleep(wait)
        except Exception as e:
            if attempt < 2:
                print(f"    [요약] 오류 ({label}), 재시도: {e}")
                time.sleep(10)
            else:
                print(f"    [요약] 실패 ({label}): {e}")
                return {}
    return {}


def _generate_overview(transcript_text: str) -> dict:
    """강의 개요 생성"""
    system = """당신은 대학 강의 내용을 간결하게 요약하는 전문가입니다.
한국어로 작성하되, 영어 전문 용어는 원문 그대로 유지하세요.
JSON 형식으로 응답하세요: {"title": "강의 제목 (20자 이내)", "summary": "1~2문단 요약"}"""
    user = f"다음 강의 녹취록을 읽고 개요를 작성하세요:\n\n{transcript_text}"
    result = _call_gpt_json(system, user, "overview")
    return {"title": result.get("title", ""), "summary": result.get("summary", "")}


def _generate_notes(transcript_text: str) -> str:
    """강의 정리 — 강의를 안 봐도 핵심 전체를 이해할 수 있는 포괄적 노트"""
    system = r"""당신은 대학 강의를 체계적으로 정리하는 전문가입니다.
강의 녹취록을 읽고, 강의를 직접 듣지 않더라도 모든 핵심 내용을 이해할 수 있는 포괄적인 강의 노트를 작성하세요.

## 핵심 원칙
1. **누락 없음**: 강의에서 언급된 모든 핵심 개념, 방법론, 연구 결과, 데이터셋, 모델을 빠짐없이 포함
2. **자기완결적**: 이 노트만 읽으면 강의 전체 내용을 이해할 수 있어야 함
3. **구조 최적화**: 강의 흐름이 논리적이면 유지하되, 더 나은 이해를 위해 재구성해도 됨
4. **깊이 유지**: 피상적 요약이 아닌, 개념의 원리·배경·적용까지 설명

## 형식
- 마크다운 사용 (##, ###, -, **bold**, `code` 등)
- 한국어로 작성, 영어 전문 용어는 원문 유지
- 관련 타임스탬프를 [HH:MM:SS] 형식으로 인용 (해당 내용이 강의에서 다뤄진 시점)
- 수식, 수치, 구체적 예시가 있으면 반드시 포함
- 분량 제한 없음 — 내용이 많으면 길게 작성"""

    user = f"다음 강의 녹취록을 읽고 포괄적인 강의 노트를 작성하세요:\n\n{transcript_text}"
    return _call_gpt_text(system, user, "notes")


def _generate_notes_claude(transcript_text: str) -> str:
    """강의 정리 — Claude Opus 버전"""
    if not anthropic_client:
        return ""

    system = r"""당신은 대학 강의를 체계적으로 정리하는 전문가입니다.
강의 녹취록을 읽고, 강의를 직접 듣지 않더라도 모든 핵심 내용을 이해할 수 있는 포괄적인 강의 노트를 작성하세요.

## 핵심 원칙
1. **누락 없음**: 강의에서 언급된 모든 핵심 개념, 방법론, 연구 결과, 데이터셋, 모델을 빠짐없이 포함
2. **자기완결적**: 이 노트만 읽으면 강의 전체 내용을 이해할 수 있어야 함
3. **구조 최적화**: 강의 흐름이 논리적이면 유지하되, 더 나은 이해를 위해 재구성해도 됨
4. **깊이 유지**: 피상적 요약이 아닌, 개념의 원리·배경·적용까지 설명

## 형식
- 마크다운 사용 (##, ###, -, **bold**, `code` 등)
- 한국어로 작성, 영어 전문 용어는 원문 유지
- 관련 타임스탬프를 [HH:MM:SS] 형식으로 인용 (해당 내용이 강의에서 다뤄진 시점)
- 수식, 수치, 구체적 예시가 있으면 반드시 포함
- 분량 제한 없음 — 내용이 많으면 길게 작성"""

    user = f"다음 강의 녹취록을 읽고 포괄적인 강의 노트를 작성하세요:\n\n{transcript_text}"

    for attempt in range(3):
        try:
            response = anthropic_client.messages.create(
                model="claude-opus-4-6",
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            return response.content[0].text.strip()
        except Exception as e:
            if attempt < 2:
                print(f"    [Notes Claude] 오류, 재시도: {e}")
                time.sleep(10)
            else:
                print(f"    [Notes Claude] 실패: {e}")
                return ""
    return ""


def _call_gpt_text(system_prompt: str, user_prompt: str, label: str) -> str:
    """GPT 텍스트 모드 호출 + 재시도 (show_me 등 자유형식 출력용)"""
    for attempt in range(3):
        try:
            response = openai_client.chat.completions.create(
                model=CORRECTION_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                max_completion_tokens=8000,
            )
            return response.choices[0].message.content.strip()
        except openai.RateLimitError:
            wait = 60 * (attempt + 1)
            print(f"    [ShowMe] Rate limit ({label}) — {wait}초 대기")
            time.sleep(wait)
        except Exception as e:
            if attempt < 2:
                print(f"    [ShowMe] 오류 ({label}), 재시도: {e}")
                time.sleep(10)
            else:
                print(f"    [ShowMe] 실패 ({label}): {e}")
                return ""
    return ""


def _generate_show_me(transcript_text: str) -> str:
    """ShowMe 콘텐츠 생성: 마크다운 + Mermaid 다이어그램"""
    system = r"""당신은 학술 강의를 시각적으로 정리하는 전문가입니다.
강의 녹취록을 읽고, 마크다운 텍스트와 Mermaid 다이어그램을 혼합한 시각적 요약을 만드세요.

## 출력 형식 규칙

1. 일반 텍스트는 마크다운 형식 (##, **, -, 등)
2. 다이어그램은 반드시 ```mermaid 코드 블록으로 감쌈
3. 한국어로 작성하되, 영어 전문 용어는 원문 유지

## 필수 포함 섹션

### 1. 강의 개요 (1~2문단 마크다운)
강의 핵심을 간결하게 요약

### 2. 강의 흐름도 (Mermaid flowchart)
강의의 주제 전개를 flowchart TD로 표현. 5~8개 노드.
예시:
```mermaid
flowchart TD
    A["서론: 강의 목표 소개"] --> B["배경: 기존 연구 리뷰"]
    B --> C["방법론: 새로운 접근법"]
    C --> D["결과: 실험 분석"]
    D --> E["결론: 향후 과제"]
```

### 3. 핵심 개념 관계도 (Mermaid graph)
주요 개념 간의 관계를 graph LR 또는 graph TD로 표현. 8~15개 노드.
노드 라벨에 특수문자(괄호, 슬래시 등)가 있으면 반드시 큰따옴표로 감싸세요.
예시:
```mermaid
graph LR
    A["Pharmacogenomics"] --> B["CYP450"]
    A --> C["Drug Response"]
    B --> D["CYP2D6"]
```

## Mermaid 문법 주의사항
- 노드 ID는 영문/숫자만 사용 (A, B, node1 등)
- 노드 라벨은 ["텍스트"] 형식으로 항상 큰따옴표 사용
- 화살표: --> (기본), -.-> (점선), ==> (굵은)
- 괄호, 슬래시, 특수문자는 라벨 안에서만 사용 (큰따옴표 필수)
- subgraph 사용 가능"""

    user = f"다음 강의 녹취록을 분석하고 시각적 요약을 생성하세요:\n\n{transcript_text}"
    return _call_gpt_text(system, user, "show_me_gpt")


def _generate_show_me_claude(transcript_text: str) -> str:
    """ShowMe 콘텐츠 생성 (Claude Opus 4.6)"""
    if not anthropic_client:
        print("    [ShowMe] Anthropic API 키 없음 — 건너뜀")
        return ""

    system = r"""당신은 학술 강의를 시각적으로 정리하는 전문가입니다.
강의 녹취록을 읽고, 마크다운 텍스트와 Mermaid 다이어그램을 혼합한 시각적 요약을 만드세요.

## 출력 형식 규칙

1. 일반 텍스트는 마크다운 형식 (##, **, -, 등)
2. 다이어그램은 반드시 ```mermaid 코드 블록으로 감쌈
3. 한국어로 작성하되, 영어 전문 용어는 원문 유지

## 필수 포함 섹션

### 1. 강의 개요 (1~2문단 마크다운)
강의 핵심을 간결하게 요약

### 2. 강의 흐름도 (Mermaid flowchart)
강의의 주제 전개를 flowchart TD로 표현. 5~8개 노드.
예시:
```mermaid
flowchart TD
    A["서론: 강의 목표 소개"] --> B["배경: 기존 연구 리뷰"]
    B --> C["방법론: 새로운 접근법"]
    C --> D["결과: 실험 분석"]
    D --> E["결론: 향후 과제"]
```

### 3. 핵심 개념 관계도 (Mermaid graph)
주요 개념 간의 관계를 graph LR 또는 graph TD로 표현. 8~15개 노드.
노드 라벨에 특수문자(괄호, 슬래시 등)가 있으면 반드시 큰따옴표로 감싸세요.
예시:
```mermaid
graph LR
    A["Pharmacogenomics"] --> B["CYP450"]
    A --> C["Drug Response"]
    B --> D["CYP2D6"]
```

## Mermaid 문법 주의사항
- 노드 ID는 영문/숫자만 사용 (A, B, node1 등)
- 노드 라벨은 ["텍스트"] 형식으로 항상 큰따옴표 사용
- 화살표: --> (기본), -.-> (점선), ==> (굵은)
- 괄호, 슬래시, 특수문자는 라벨 안에서만 사용 (큰따옴표 필수)
- subgraph 사용 가능"""

    user = f"다음 강의 녹취록을 분석하고 시각적 요약을 생성하세요:\n\n{transcript_text}"

    for attempt in range(3):
        try:
            response = anthropic_client.messages.create(
                model="claude-opus-4-6",
                max_tokens=8000,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            return response.content[0].text.strip()
        except anthropic.RateLimitError:
            wait = 60 * (attempt + 1)
            print(f"    [ShowMe Claude] Rate limit — {wait}초 대기")
            time.sleep(wait)
        except Exception as e:
            if attempt < 2:
                print(f"    [ShowMe Claude] 오류, 재시도: {e}")
                time.sleep(10)
            else:
                print(f"    [ShowMe Claude] 실패: {e}")
                return ""
    return ""


def _generate_key_concepts(transcript_text: str) -> list[dict]:
    """핵심 개념 추출"""
    system = """당신은 학술 강의에서 핵심 개념을 추출하는 전문가입니다.
8~15개의 주요 전문 용어/개념을 추출하고 각각에 대해 간단한 설명을 작성하세요.
한국어로 작성하되, 영어 전문 용어는 원문 그대로 유지하세요.
JSON 형식: {"concepts": [{"term": "용어", "explanation": "1~2문장 설명", "first_mention": "HH:MM:SS"}]}
first_mention은 해당 용어가 강의에서 처음 언급된 타임스탬프입니다."""
    user = f"다음 강의 녹취록에서 핵심 개념을 추출하세요:\n\n{transcript_text}"
    result = _call_gpt_json(system, user, "key_concepts")
    return result.get("concepts", [])


def _generate_timeline(transcript_text: str) -> list[dict]:
    """타임라인/목차 생성"""
    system = """당신은 강의 내용을 주제별 챕터로 구분하는 전문가입니다.
강의를 5~10개의 챕터로 나누세요. 주제가 자연스럽게 전환되는 지점을 찾으세요.
한국어로 작성하되, 영어 전문 용어는 원문 그대로 유지하세요.
JSON 형식: {"chapters": [{"time": "HH:MM:SS", "end_time": "HH:MM:SS", "title": "챕터 제목", "description": "1문장 설명"}]}
time은 반드시 녹취록에 존재하는 타임스탬프를 사용하세요."""
    user = f"다음 강의 녹취록의 타임라인을 작성하세요:\n\n{transcript_text}"
    result = _call_gpt_json(system, user, "timeline")
    return result.get("chapters", [])


def _generate_study_guide(transcript_text: str) -> list[dict]:
    """학습 가이드 Q&A 생성"""
    system = """당신은 대학 시험 문제를 출제하는 교수입니다.
강의 내용을 기반으로 5~8개의 학습용 질문과 포괄적인 답변을 작성하세요.
개념 이해, 사실 확인, 응용 문제를 골고루 포함하세요.
한국어로 작성하되, 영어 전문 용어는 원문 그대로 유지하세요.
JSON 형식: {"questions": [{"question": "질문", "answer": "상세한 답변", "relevant_time": "HH:MM:SS"}]}
relevant_time은 해당 내용이 다뤄진 시점의 타임스탬프입니다."""
    user = f"다음 강의 녹취록을 기반으로 학습 가이드를 작성하세요:\n\n{transcript_text}"
    result = _call_gpt_json(system, user, "study_guide")
    return result.get("questions", [])


def generate_lecture_summary(corrected_segments: list[dict], video_name: str) -> dict:
    """교정된 트랜스크립트로부터 강의 요약 생성 (4개 섹션 병렬)"""
    cp = cache_path_for(video_name, "summary")
    if cp.exists():
        print(f"  [캐시] 요약: {cp.name}")
        return json.loads(cp.read_text(encoding="utf-8"))

    if not corrected_segments:
        print("  [경고] 세그먼트가 비어있어 요약을 건너뜁니다.")
        return {}

    # 트랜스크립트 텍스트 조합
    transcript_text = "\n".join(f"[{s['time']}] {s['text']}" for s in corrected_segments)
    valid_times = [s["time"] for s in corrected_segments]

    print(f"  요약 생성: 8개 섹션 병렬 처리 | 모델: {CORRECTION_MODEL} + Claude Opus 4.6")

    # 8개 섹션 병렬 생성
    results = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(_generate_overview, transcript_text): "overview",
            executor.submit(_generate_key_concepts, transcript_text): "key_concepts",
            executor.submit(_generate_timeline, transcript_text): "timeline",
            executor.submit(_generate_study_guide, transcript_text): "study_guide",
            executor.submit(_generate_show_me, transcript_text): "show_me_gpt",
            executor.submit(_generate_show_me_claude, transcript_text): "show_me_claude",
            executor.submit(_generate_notes, transcript_text): "notes_gpt",
            executor.submit(_generate_notes_claude, transcript_text): "notes_claude",
        }
        for future in as_completed(futures):
            key = futures[future]
            try:
                results[key] = future.result()
                print(f"    [요약] {key} 완료")
            except Exception as e:
                print(f"    [요약] {key} 실패: {e}")
                if key == "overview":
                    results[key] = {"title": "", "summary": ""}
                elif key in ("show_me_gpt", "show_me_claude", "notes_gpt", "notes_claude"):
                    results[key] = ""
                else:
                    results[key] = []

    # 타임스탬프 스냅핑
    for concept in results.get("key_concepts", []):
        if "first_mention" in concept:
            concept["first_mention"] = _snap_timestamp(concept["first_mention"], valid_times)
    for chapter in results.get("timeline", []):
        if "time" in chapter:
            chapter["time"] = _snap_timestamp(chapter["time"], valid_times)
        if "end_time" in chapter:
            chapter["end_time"] = _snap_timestamp(chapter["end_time"], valid_times)
    for qa in results.get("study_guide", []):
        if "relevant_time" in qa:
            qa["relevant_time"] = _snap_timestamp(qa["relevant_time"], valid_times)

    # 최종 조합
    from datetime import datetime, timezone
    summary_data = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "video": video_name,
        "overview": results.get("overview", {"title": "", "summary": ""}),
        "key_concepts": results.get("key_concepts", []),
        "timeline": results.get("timeline", []),
        "study_guide": results.get("study_guide", []),
        "show_me_gpt": results.get("show_me_gpt", ""),
        "show_me_claude": results.get("show_me_claude", ""),
        "notes_gpt": results.get("notes_gpt", ""),
        "notes_claude": results.get("notes_claude", ""),
    }

    cp.write_text(json.dumps(summary_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  요약 생성 완료: {cp.name}")
    return summary_data


# ── 메인 파이프라인 ───────────────────────────────────────────────────────────

def process_single_video(mp4_path: Path, stages: set[str] | None = None) -> dict:
    """단일 비디오 처리. stages가 None이면 전체, 아니면 지정 단계만 실행.
    stages: {"audio", "stt", "correct", "summary"} 중 선택"""
    run_all = stages is None
    video_name = mp4_path.stem
    print(f"\n{'='*70}")
    print(f"처리 시작: {mp4_path.name}")
    stage_names = "전체" if run_all else ", ".join(sorted(stages))
    print(f"  STT: {STT_PROVIDER} | 교정: {CORRECTION_MODEL} | 단계: {stage_names}")
    print(f"{'='*70}")

    start_time = time.time()
    raw_segments = []
    corrected_segments = []
    summary = {}

    # 1. 오디오 추출
    if run_all or "audio" in stages:
        print("\n[오디오] 추출")
        extract_audio(mp4_path)

    # 2. STT 트랜스크립션
    if run_all or "stt" in stages:
        audio_path = OUTPUT_DIR / f"{video_name}.mp3"
        if audio_path.exists():
            print(f"\n[STT] {STT_PROVIDER.upper()} 트랜스크립션")
            raw_segments = transcribe_audio_parallel(audio_path, STT_PROVIDER)
        else:
            print(f"\n[STT] 건너뜀 — 오디오 파일 없음 ({video_name}.mp3)")

    # 3. GPT 교정
    if run_all or "correct" in stages:
        # raw transcript 캐시에서 로드 (stt 단계를 건너뛴 경우)
        if not raw_segments:
            cp = cache_path_for(video_name, "raw_transcript")
            if cp.exists():
                raw_segments = json.loads(cp.read_text(encoding="utf-8"))
        if raw_segments:
            # 도메인 감지
            if DOMAIN_DETECTION == "auto":
                domain = detect_domain(
                    raw_segments, openai_client,
                    cache_dir=OUTPUT_DIR, video_stem=video_name,
                    stt_provider=STT_PROVIDER,
                )
            elif DOMAIN_DETECTION == "generic":
                domain = DomainMatch("generic", 0.0, *_load_domain_prompts("generic"))
            else:
                domain = DomainMatch(
                    DOMAIN_DETECTION, 1.0, *_load_domain_prompts(DOMAIN_DETECTION)
                )
            print(f"\n[교정] {CORRECTION_MODEL} 교정 | 도메인: {domain.domain_id}"
                  f" (신뢰도: {domain.confidence:.3f})")
            corrected_segments = correct_transcript_parallel(
                raw_segments, video_name,
                domain.system_prompt, domain.user_prompt, domain.domain_id,
            )
        else:
            print("\n[교정] 건너뜀 — raw transcript 없음")

    # 4. 강의 요약 생성
    if run_all or "summary" in stages:
        # corrected transcript 캐시에서 로드 (이전 단계를 건너뛴 경우)
        if not corrected_segments:
            # 도메인별 캐시 키가 다를 수 있으므로 glob으로 검색
            candidates = sorted(
                OUTPUT_DIR.glob(f"{video_name}_corrected_*.json"),
                key=lambda p: p.stat().st_mtime, reverse=True,
            )
            if candidates:
                corrected_segments = json.loads(
                    candidates[0].read_text(encoding="utf-8")
                )
        if corrected_segments:
            print(f"\n[요약] 강의 요약 생성")
            summary = generate_lecture_summary(corrected_segments, video_name)
        else:
            print(f"\n[요약] 건너뜀 — corrected transcript 없음")

    elapsed = time.time() - start_time
    print(f"\n완료: {video_name} ({elapsed/60:.1f}분 소요)")

    return {
        "video": mp4_path.name,
        "raw_segments": raw_segments,
        "corrected_segments": corrected_segments,
        "summary": summary,
        "processing_time": elapsed,
    }


def main():
    import argparse
    parser = argparse.ArgumentParser(description="MP4 → STT → GPT 교정 → 요약 파이프라인")
    parser.add_argument("--stages", nargs="+",
                        choices=["audio", "stt", "correct", "summary"],
                        help="실행할 단계 (미지정 시 전체). 예: --stages summary")
    parser.add_argument("--refresh-summary", action="store_true",
                        help="기존 요약 캐시를 삭제하고 재생성")
    parser.add_argument("--parallel", type=int, default=1, metavar="N",
                        help="동시에 처리할 영상 수 (기본: 1)")
    args = parser.parse_args()

    stages = set(args.stages) if args.stages else None

    # --refresh-summary: 요약 캐시 삭제
    if args.refresh_summary:
        for f in OUTPUT_DIR.glob("*_summary_*.json"):
            f.unlink()
            print(f"  [삭제] {f.name}")
        if stages is None:
            stages = {"summary"}

    print("=" * 70)
    print("MP4 스크립트 추출 & GPT 교정 파이프라인 v2")
    print(f"  STT: {STT_PROVIDER} | 교정: {CORRECTION_MODEL} | 워커: {MAX_WORKERS}"
          f" | 도메인: {DOMAIN_DETECTION}")
    if stages:
        print(f"  실행 단계: {', '.join(sorted(stages))}")
    print("=" * 70)

    valid_files = [f for f in MP4_FILES if f.exists()]
    if not valid_files:
        print("처리할 MP4 파일이 없습니다.")
        sys.exit(1)

    print(f"\n처리 대상: {len(valid_files)}개 파일")
    for f in valid_files:
        size_mb = f.stat().st_size / (1024 * 1024)
        print(f"  - {f.name} ({size_mb:.0f}MB)")

    parallel = args.parallel
    if parallel > 1:
        print(f"\n병렬 처리: {parallel}개 영상 동시 진행")
        results_map = {}
        with ThreadPoolExecutor(max_workers=parallel) as executor:
            futures = {
                executor.submit(process_single_video, mp4, stages): i
                for i, mp4 in enumerate(valid_files)
            }
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    results_map[idx] = future.result()
                except Exception as e:
                    print(f"\n[오류] {valid_files[idx].name}: {e}")
                    results_map[idx] = {
                        "video": valid_files[idx].name,
                        "raw_segments": [], "corrected_segments": [],
                        "summary": {}, "processing_time": 0,
                    }
        results = [results_map[i] for i in range(len(valid_files))]
    else:
        results = []
        for mp4_path in valid_files:
            result = process_single_video(mp4_path, stages)
            results.append(result)

    # 통합 결과 JSON
    summary_path = OUTPUT_DIR / (make_cache_key("all", STT_PROVIDER, CORRECTION_MODEL, "transcripts") + ".json")
    summary_data = []
    for r in results:
        summary_data.append({
            "video": r["video"],
            "stt_provider": STT_PROVIDER,
            "correction_model": CORRECTION_MODEL,
            "corrected_segments": r["corrected_segments"],
            "segment_count": len(r["corrected_segments"]),
            "processing_time_minutes": round(r["processing_time"] / 60, 1),
        })
    Path(summary_path).write_text(json.dumps(summary_data, ensure_ascii=False, indent=2), encoding="utf-8")

    # 마크다운 출력
    for r in results:
        stem = Path(r["video"]).stem
        md_key = make_cache_key(stem, STT_PROVIDER, CORRECTION_MODEL, "transcript_md")
        md_path = OUTPUT_DIR / f"{md_key}.md"
        lines = [f"# {r['video']} - 교정 스크립트\n"]
        lines.append(f"> STT: {STT_PROVIDER} | 교정: {CORRECTION_MODEL}\n")
        for seg in r["corrected_segments"]:
            speaker = f" [{seg['speaker']}]" if seg.get("speaker") else ""
            lines.append(f"**[{seg['time']}]**{speaker} {seg['text']}\n")
        md_path.write_text("\n".join(lines), encoding="utf-8")

    print(f"\n{'='*70}")
    print("모든 처리 완료!")
    print(f"출력 디렉토리: {OUTPUT_DIR}")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
