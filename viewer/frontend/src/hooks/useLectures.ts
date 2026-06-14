import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ── 타입 ──────────────────────────────────────────────────

export type DomainStatus = 'pending' | 'confirmed' | 'overridden'

export interface DomainInfo {
  id: string
  name: string
  description?: string | null
}

export interface LectureCandidate {
  domain_id: string
  score: number
}

export interface Lecture {
  id: string
  original_name: string
  domain_id: string | null
  domain_status: DomainStatus
  domain_source: string | null
  detected_domain_id: string | null
  detected_confidence: number | null
  detected_top_candidates: LectureCandidate[]
  has_corrected: boolean
  has_summary: boolean
  latest_job_status: string | null
  latest_job_type: string | null
  latest_job_id: string | null
  created_at: string
  updated_at: string
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'processing', 'awaiting_domain'])
const POLL_MS = 5000

// ── 데이터 fetch + 폴링 ────────────────────────────────────

export function useLectures() {
  const [lectures, setLectures] = useState<Lecture[]>([])
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const [lecRes, domRes] = await Promise.all([
        fetch('/api/lectures'),
        fetch('/api/domains'),
      ])
      if (!lecRes.ok) throw new Error(`/api/lectures HTTP ${lecRes.status}`)
      if (!domRes.ok) throw new Error(`/api/domains HTTP ${domRes.status}`)
      const lec: Lecture[] = await lecRes.json()
      const dom: DomainInfo[] = await domRes.json()
      if (!mountedRef.current) return
      setLectures(lec)
      setDomains(dom)
      setError(null)
    } catch (e) {
      if (!mountedRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  // 초기 로드
  useEffect(() => {
    mountedRef.current = true
    refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh, version])

  // active job 있을 때 5초 폴링
  useEffect(() => {
    const hasActive = lectures.some(
      (l) => l.latest_job_status && ACTIVE_JOB_STATUSES.has(l.latest_job_status),
    )
    if (!hasActive) return
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [lectures, refresh])

  const reload = useCallback(() => setVersion((n) => n + 1), [])

  return { lectures, domains, error, loading, refresh, reload }
}

// ── 도메인별 그룹화 ─────────────────────────────────────────

export interface LectureGroup {
  key: string                 // 'finance' | 'pharmaceutical' | '__pending__' | 'generic'
  label: string
  lectures: Lecture[]
  hasAwaitingConfirm: boolean
  isPending: boolean
  isGeneric: boolean
}

const PENDING_KEY = '__pending__'

export function groupLecturesByDomain(
  lectures: Lecture[],
  domains: DomainInfo[],
): LectureGroup[] {
  // 등록된 도메인 (generic 제외) 의 ID → name 맵
  const domainNameMap = new Map<string, string>()
  for (const d of domains) {
    if (d.id !== 'generic') domainNameMap.set(d.id, d.name)
  }

  const buckets = new Map<string, Lecture[]>()
  const ensure = (k: string) => {
    if (!buckets.has(k)) buckets.set(k, [])
    return buckets.get(k)!
  }

  for (const lec of lectures) {
    if (lec.domain_status === 'pending') {
      ensure(PENDING_KEY).push(lec)
      continue
    }
    if (lec.domain_id === 'generic' || !lec.domain_id) {
      ensure('generic').push(lec)
      continue
    }
    ensure(lec.domain_id).push(lec)
  }

  // 등록된 도메인 그룹들을 강의 수 내림차순으로 정렬
  const registered: LectureGroup[] = []
  for (const [key, lecs] of buckets) {
    if (key === PENDING_KEY || key === 'generic') continue
    const name = domainNameMap.get(key) || key
    registered.push({
      key,
      label: name,
      lectures: lecs,
      hasAwaitingConfirm: lecs.some(
        (l) => l.latest_job_status === 'awaiting_domain',
      ),
      isPending: false,
      isGeneric: false,
    })
  }
  registered.sort((a, b) => b.lectures.length - a.lectures.length)

  // 그룹 내 강의 정렬: 최신순
  const sortLectures = (group: LectureGroup) => ({
    ...group,
    lectures: [...group.lectures].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    ),
  })

  const result: LectureGroup[] = registered.map(sortLectures)

  if (buckets.has(PENDING_KEY)) {
    result.push(
      sortLectures({
        key: PENDING_KEY,
        label: '분류 보류',
        lectures: buckets.get(PENDING_KEY)!,
        hasAwaitingConfirm: buckets
          .get(PENDING_KEY)!
          .some((l) => l.latest_job_status === 'awaiting_domain'),
        isPending: true,
        isGeneric: false,
      }),
    )
  }
  if (buckets.has('generic')) {
    result.push(
      sortLectures({
        key: 'generic',
        label: '분류 안 함',
        lectures: buckets.get('generic')!,
        hasAwaitingConfirm: false,
        isPending: false,
        isGeneric: true,
      }),
    )
  }
  return result
}

// useMemo 래퍼 — 호출 사이트에서 자주 쓰임
export function useLectureGroups(lectures: Lecture[], domains: DomainInfo[]) {
  return useMemo(() => groupLecturesByDomain(lectures, domains), [lectures, domains])
}

// ── 도메인 confirm POST ───────────────────────────────────

export async function postLectureDomain(
  lectureId: string,
  domainId: string,
): Promise<void> {
  const res = await fetch(
    `/api/lectures/${encodeURIComponent(lectureId)}/domain`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain_id: domainId, source: 'user' }),
    },
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
}
