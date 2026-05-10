# Claude Design 핸드오프 적용 상태

> 출처: `mp4-summary.zip` (claude-design 핸드오프, 채택안 = D · Hybrid)
> 디자인 파일: `mp4-summary/project/index.html` + `artboards/{shared.css, hybrid-shell.jsx, variant-hybrid.jsx, screens-misc.jsx, icons.jsx, data.jsx}`
> 마지막 갱신: 2026-05-10

본 문서는 디자인 핸드오프의 어떤 부분이 운영 viewer에 적용됐고, 어떤 부분이 아직 미적용인지를 한눈에 보기 위한 추적 문서다. 후속 PR 의 우선순위 결정에 사용한다.

---

## 1. 적용 완료

### 1.1 디자인 시스템 (shared.css)

- ✅ CSS 변수 토큰 (`--bg`, `--surface`, `--surface-2/3`, `--border`, `--text-1~4`, `--accent`, `--accent-soft/deep/tint`, `--amber/indigo/rose`, `--radius/-sm/-lg`, `--shadow/-sm/-lg`)
- ✅ 폰트 패밀리 (Inter / JetBrains Mono / Source Serif Pro / Noto Sans KR) 구글폰트 import + body 적용
- ✅ 유틸리티 클래스: `.ds-pill`, `.ds-pill-ts`, `.ds-btn`, `.ds-nav-item`, `.ds-card`, `.ds-divider`, `.ds-section-heading`
- ✅ `.lecture-html-fragment`, `.reader-article` 스타일 셋업

### 1.2 HybridShell (좌측 사이드바)

- ✅ 232 ↔ 56px collapse 토글 (`localStorage` 영속)
- ✅ 브랜드 + 검색 input
- ✅ Primary nav 4종: 강의 / 학습 노트 / 북마크 / 도메인
- ✅ 도메인 그룹화된 lecture tree
- ✅ 그룹 fold (헤더 클릭으로 collapse, `localStorage` 영속)
- ✅ User footer (이니셜 + 이름 + 로그아웃)

### 1.3 메인 강의 viewer (D · Hybrid)

- ✅ 상단 메타바 (도메인 breadcrumb + 모델 라벨 + 강의 제목 + 북마크/노트 카운트 pill + copy 액션)
- ✅ Sticky AnchorTOC — 칩 스타일 (`Summary` / `강의 정리` / `전사` 3 항목, 활성 칩 highlight, 스크롤 위치 자동 추적)
- ✅ AudioBar 마커 풍부 디자인 (북마크 색상 마커 + 둥근 재생헤드 + 라이트 톤)
- ✅ 강의 전환 즉시 스크롤 (smooth 제거)
- ✅ 타임스탬프 클릭 시 audio seek + 재생 상태 보존

### 1.4 ShowMe / Notes (Claude 단독)

- ✅ HTML 단편 + 인라인 SVG 직접 렌더 (`HtmlFragment` + sanitize)
- ✅ 옛 baseline (마크다운 + ```svg``` / ```mermaid``` 블록) 자동 분기
- ✅ 모듈 버저닝: `module_versions` DB 테이블 + `output/versions/` 파일
- ✅ 슬롯별 재생성 + 글로벌 RegenContext (강의 × 슬롯 단위 polling, 새로고침 후 복구)
- ✅ 프롬프트 라이트 톤 강제 (다크 카드/패널 금지)

### 1.5 Nav 분기 화면 (placeholder)

- ✅ `insights` / `bookmarks` / `domains` nav 클릭 → `NavScreen` 으로 분기 (운영 데이터 기반 간단 리스트)
- ✅ 각 화면에서 강의 ID 클릭 → 강의 viewer 로 점프 + nav 복귀

---

## 2. 부분 적용 / 디자인과 차이 있는 영역

### 2.1 메인 reader 본문 — 인라인 분해 미완

디자인 `variant-hybrid.jsx` 의 reader article 은 7개 섹션 (`overview`, `concepts`, `timeline`, `showme`, `notes`, `qa`, `transcript`) 을 모두 한 페이지에 인라인하고 sticky TOC 가 7항목으로 jump 한다.

운영 viewer 는 **3항목 TOC** (`section-summary` = SummaryPanel 통째 / `section-notes` = NotesSection / `section-transcript` = 전사) 로만 anchor 분리. SummaryPanel 내부의 ShowMe·Concepts·Timeline·Q&A 가 한 덩어리로 묶여 있어 정밀 jump 불가.

**TODO**:
- [ ] SummaryPanel 내부를 `section-overview`, `section-concepts`, `section-timeline`, `section-showme`, `section-qa` 로 분해 (props 또는 컴포넌트 분리).
- [ ] AnchorTOC 항목을 디자인의 7개로 확장.

### 2.2 Reader article max-w 720

디자인은 `<article style="max-width: 720; margin: 0 auto; padding: 32px 32px 96px">` 로 reader 본문 폭을 제한. 운영 viewer 는 미적용 (전사가 너무 좁아지는 문제 우려).

**TODO**:
- [ ] Summary / Notes / Q&A 섹션은 max-w 720 reader article wrapper, transcript 는 더 넓게 (max-w 1100) 분리 적용.

### 2.3 ChatPane (우측 채팅 패널)

디자인 `ChatPaneHybrid` 는 360px 우측 영구 토글 패널 + 헤더 (Sonnet pill + 새 세션 / 히스토리 / 닫기) + accent bubble user / inline assistant + 인용 pill + 토큰 카운터 + send 버튼 + closed 상태 floating bubble.

운영 viewer 는 기존 `ChatPanel` (modal-like 컴포넌트) 그대로 사용. 동작은 OK 지만 디자인 톤·구도와 맞지 않음.

**TODO**:
- [ ] `ChatPanel` 을 `ChatPaneHybrid` 패턴으로 재작성 또는 디자인 wrapping (헤더·메시지 버블·인용 pill·토큰 카운터 노출 + closed 시 floating bubble).

### 2.4 Nav 화면들 (insights / bookmarks / domains)

운영 viewer 는 `NavScreen` 하나로 운영 데이터를 list 로 보여주는 placeholder 수준. 디자인은 화면별로 더 정교하다:

- **`ScreenInsights`** (디자인): 좌측 filter rail (태그·도메인·status 필터) + 우측 카드 그리드. "모두 승인" / "검토 시작" 강한 CTA.
- **`ScreenDomains`** (디자인): 좌측 도메인 list + 우측 도메인 상세 (HyQE 검출 임계값, 키워드 30~40개 chip, 프롬프트 미리보기, 강의 통계).
- **`ScreenHome`** (디자인, 강의 라이브러리): 통계 카드 4종 (총 강의 / 완독률 / 북마크 / 학습 노트) + 이어서 보기 카드 그리드 + 도메인별 테이블 + 영상 업로드 primary CTA.

**TODO**:
- [ ] `NavScreenInsights` 를 `ScreenInsights` 디자인으로 (filter rail + 카드 그리드).
- [ ] `NavScreenBookmarks` 의 카드/그리드 정돈 (현재는 lecture 별 단순 list).
- [ ] `NavScreenDomains` 를 `ScreenDomains` 디자인으로 (좌측 list + 우측 상세, HyQE 표기).
- [ ] 새 nav 추가: `home` (강의 라이브러리 = `ScreenHome` 디자인) — 현재 사이드바 lecture tree 가 이 역할을 일부 수행하지만 디자인 의도는 별도 풀 페이지.

### 2.5 로그인 화면

디자인 `ScreenLogin` 은 좌우 2-pane:
- 좌측: **다크 brand 패널** (#0f1410) — Source Serif heading, accent gradient, KPI 3종 (요약 모듈 8 / 도메인 4 / HyQE 0.45)
- 우측: 라이트 form — Google OAuth 버튼 + 이메일/비밀번호 + 회원가입 link

운영 `/login` (server-rendered HTML) 는 디자인 미적용 — 단순 form.

**TODO**:
- [ ] `/login` 페이지를 React SPA 또는 server-rendered HTML 로 디자인 적용. **다만 좌측 브랜드는 다크인데 사용자가 'SVG 라이트 톤' 가이드를 명시했으므로, 라이트 톤으로 바꾸는 것을 권장** (off-white 배경 + 서브틀 accent gradient).

### 2.6 헤더 (top bar)

운영 viewer 는 상단 12px 흰색 헤더 (`강의 녹취록` 타이틀 + ⌘K 안내 + 사용자 정보 + 로그아웃). 디자인은 별도 top bar 없음 — 사이드바 brand 가 그 역할.

**TODO**:
- [ ] 운영 헤더 제거 또는 사이드바 brand + 메인 메타바로 정보 분산. ⌘K 검색은 사이드바 검색 또는 글로벌 단축키로.
- [ ] 로그아웃은 사이드바 user footer 에 이미 있음.

---

## 3. 미적용 (디자인 의도와 다른 운영 동작)

### 3.1 디자인 캔버스 / Tweaks 패널

`design-canvas.jsx` + `tweaks-panel.jsx` (type_scale + accent 컬러 변경 UI) 는 **mockup 캔버스용** 이라 운영에 옮기지 않음.

대신 운영에서 사용자가 accent 컬러나 typo 스케일을 바꾸고 싶으면 별도 사용자 설정 메뉴가 필요할 수 있음. 현재는 미구현 — accent 는 teal 고정.

### 3.2 강의 정보 메타데이터

디자인 sample data 에는 `progress`, `chapters`, `chatSessions`, `updated` 가 있으나 운영 `Lecture` 타입에는 일부만 존재. 통계 / 진행률 표시는 backend 추가 작업이 필요.

**TODO**:
- [ ] `lectures` 테이블에 `progress` / `last_played_at` / `chapter_count` / `chat_session_count` 등 추가 메타.
- [ ] AudioBar 또는 lecture 카드에서 progress 활용.

---

## 4. 다음 PR 우선순위 제안

1. **메인 reader 7항목 anchor 분해** — SummaryPanel 내부 분리 (Overview / Concepts / Timeline / ShowMe / Q&A) + AnchorTOC 7항목 확장.
2. **ChatPane 디자인 적용** — `ChatPaneHybrid` 패턴 (Sonnet pill, accent 버블, 인용 pill, 토큰 카운터, closed floating bubble).
3. **NavScreens 디자인 — Insights / Domains** (filter rail + 카드/상세 패턴).
4. **로그인 페이지 디자인** (라이트 톤 브랜드 패널 + form).
5. **Reader article max-w wrapper** (Summary/Notes 만 720, transcript 별도).
6. **새 nav `home` (강의 라이브러리)** — 통계 + 이어서 보기 + 도메인 테이블.
7. **헤더 정리** — 사이드바 + 메타바 통합.
