import { useMemo, useState } from 'react'

import type { DomainInfo, LectureCandidate } from '../hooks/useLectures'

interface DomainPickerProps {
  domains: DomainInfo[]
  recommendedId?: string | null
  recommendedConfidence?: number | null
  topCandidates?: LectureCandidate[]
  currentDomainId?: string | null
  busy?: boolean
  onConfirm: (domainId: string) => void
}

export function DomainPicker({
  domains,
  recommendedId,
  recommendedConfidence,
  topCandidates = [],
  currentDomainId,
  busy = false,
  onConfirm,
}: DomainPickerProps) {
  const [moreOpen, setMoreOpen] = useState(false)

  const registered = useMemo(
    () => domains.filter((d) => d.id !== 'generic'),
    [domains],
  )

  // 추천 도메인 + 그 다음 점수 도메인 (중복 제거, generic 제외)
  const primaryIds = useMemo(() => {
    const ids: string[] = []
    if (recommendedId && recommendedId !== 'generic') ids.push(recommendedId)
    for (const c of topCandidates) {
      if (c.domain_id === 'generic') continue
      if (!ids.includes(c.domain_id)) ids.push(c.domain_id)
      if (ids.length >= 2) break
    }
    // 추가로 등록된 도메인 1개 더 (3개 chip 보장)
    for (const d of registered) {
      if (!ids.includes(d.id)) ids.push(d.id)
      if (ids.length >= 3) break
    }
    return ids
  }, [recommendedId, topCandidates, registered])

  const moreDomains = useMemo(
    () => registered.filter((d) => !primaryIds.includes(d.id)),
    [registered, primaryIds],
  )

  const labelOf = (id: string) =>
    domains.find((d) => d.id === id)?.name || id

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-700">
          도메인 컨펌 필요
        </p>
        {recommendedId ? (
          <p className="text-[10px] text-slate-500 truncate">
            자동 감지: <span className="font-medium text-slate-700">{labelOf(recommendedId)}</span>
            {typeof recommendedConfidence === 'number' && (
              <span className="text-slate-400"> · {recommendedConfidence.toFixed(2)}</span>
            )}
          </p>
        ) : (
          <p className="text-[10px] text-slate-400">자동 감지 실패 — 직접 선택</p>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {primaryIds.map((id) => {
          const isRec = id === recommendedId
          const isCurrent = id === currentDomainId
          return (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => onConfirm(id)}
              className={`px-2 py-1 rounded-md text-[11px] border transition ${
                isRec
                  ? 'bg-teal-600 text-white border-teal-700 shadow-sm'
                  : isCurrent
                  ? 'bg-amber-50 text-amber-800 border-amber-300'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-teal-400 hover:text-teal-700'
              } ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={labelOf(id)}
            >
              {labelOf(id)}
              {isRec && <span className="ml-1">✓</span>}
            </button>
          )
        })}
        {moreDomains.length > 0 && (
          <div className="relative">
            <button
              type="button"
              disabled={busy}
              onClick={() => setMoreOpen((v) => !v)}
              className="px-2 py-1 rounded-md text-[11px] border border-slate-200 bg-white text-slate-600 hover:border-slate-300"
            >
              더보기 ▾
            </button>
            {moreOpen && (
              <div className="absolute z-20 mt-1 left-0 min-w-[160px] rounded-md border border-slate-200 bg-white shadow-lg py-1">
                {moreDomains.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setMoreOpen(false)
                      onConfirm(d.id)
                    }}
                    className="block w-full text-left px-3 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50"
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => onConfirm('generic')}
        className="text-[11px] text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50"
      >
        분류 안 함으로 진행
      </button>
    </div>
  )
}
