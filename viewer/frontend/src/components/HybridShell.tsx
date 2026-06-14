/**
 * HybridShell — 모든 메인 화면이 공유하는 좌측 사이드바.
 *
 * 디자인 (claude-design hand-off):
 *  • 좌측 사이드바 232 ↔ 56 토글 (icon rail)
 *  • Primary nav: 강의 / 학습 노트(badge) / 북마크 / 도메인
 *  • 강의 그룹 트리 (도메인별)
 *  • 검색 input (⌘K) + 하단 user pill
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  groupLecturesByDomain,
  type DomainInfo,
  type Lecture,
  type LectureGroup,
} from '../hooks/useLectures'

export type ShellNavKey = 'lectures' | 'insights' | 'bookmarks' | 'domains'

const ICON_PATHS: Record<string, string> = {
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6',
  bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z',
  brain:
    'M9 4a4 4 0 0 0-4 4 3 3 0 0 0-1 5 4 4 0 0 0 1 5 4 4 0 0 0 4 4V4Zm6 16a4 4 0 0 0 4-4 4 4 0 0 0 1-5 3 3 0 0 0-1-5 4 4 0 0 0-4-4v18Z',
  search: 'M21 21l-4.3-4.3M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z',
  chev_l: 'm15 6-6 6 6 6',
  chev_r: 'm9 6 6 6-6 6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.6 7.6 0 0 0-.1-1.4l2-1.6-2-3.4-2.4.8a7.5 7.5 0 0 0-2.4-1.4L14 2.5h-4l-.4 2.5a7.5 7.5 0 0 0-2.4 1.4l-2.4-.8-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.8l-2 1.6 2 3.4 2.4-.8a7.5 7.5 0 0 0 2.4 1.4l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.4-1.4l2.4.8 2-3.4-2-1.6c.1-.5.1-.9.1-1.4Z',
}

interface IconProps {
  name: keyof typeof ICON_PATHS
  size?: number
  className?: string
}

export function ShellIcon({ name, size = 14, className = '' }: IconProps) {
  const d = ICON_PATHS[name]
  if (!d) return null
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d={d} />
    </svg>
  )
}

const NAV_PRIMARY: { k: ShellNavKey; ico: keyof typeof ICON_PATHS; label: string }[] = [
  { k: 'lectures', ico: 'doc', label: '강의' },
  { k: 'insights', ico: 'bulb', label: '학습 노트' },
  { k: 'bookmarks', ico: 'bookmark', label: '북마크' },
  { k: 'domains', ico: 'brain', label: '도메인' },
]

export interface HybridShellProps {
  activeNav?: ShellNavKey
  activeLectureId?: string | null
  lectures: Lecture[]
  domains: DomainInfo[]
  insightsBadge?: number
  userInitials?: string
  userName?: string
  onNavSelect?: (k: ShellNavKey) => void
  onLectureSelect?: (lectureId: string) => void
  onSettingsClick?: () => void
  onLogoutClick?: () => void
  search?: string
  onSearchChange?: (v: string) => void
  /**
   * 사이드바 lecture tree 아래, user footer 위에 들어가는 추가 영역.
   * 운영 패널 (Upload / Bookmarks / Insights 등) 통합용.
   */
  auxiliarySlot?: ReactNode
  children: ReactNode
}

export function HybridShell({
  activeNav = 'lectures',
  activeLectureId,
  lectures,
  domains,
  insightsBadge,
  userInitials = 'U',
  userName,
  onNavSelect,
  onLectureSelect,
  onSettingsClick,
  onLogoutClick,
  search = '',
  onSearchChange,
  auxiliarySlot,
  children,
}: HybridShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('hybridShell.collapsed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('hybridShell.collapsed', collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [collapsed])

  // 도메인 그룹별 fold 상태 (key 단위) — localStorage 영속화
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('hybridShell.collapsedGroups')
      return stored ? new Set<string>(JSON.parse(stored)) : new Set<string>()
    } catch {
      return new Set<string>()
    }
  })
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem('hybridShell.collapsedGroups', JSON.stringify(Array.from(next)))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  // Search filter (sidebar 내부 강의 트리)
  const q = search.trim().toLowerCase()
  const filteredLectures = useMemo(
    () => (q ? lectures.filter((l) => (l.original_name || l.id).toLowerCase().includes(q)) : lectures),
    [lectures, q],
  )
  const groups: LectureGroup[] = useMemo(
    () => groupLecturesByDomain(filteredLectures, domains),
    [filteredLectures, domains],
  )

  const navW = collapsed ? 56 : 232

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${navW}px 1fr`,
        height: '100%',
        transition: 'grid-template-columns 0.18s ease',
        background: 'var(--bg)',
        color: 'var(--text-1)',
      }}
    >
      <aside
        style={{
          borderRight: '1px solid var(--border)',
          background: 'var(--surface)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        {/* Brand row */}
        <div style={{ padding: '12px 12px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: 'var(--accent)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            M
          </div>
          {!collapsed && <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>MP4 Summary</div>}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="ds-btn ghost sm"
            style={{ marginLeft: 'auto', padding: '0 4px' }}
            title={collapsed ? '펼치기' : '접기'}
            aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          >
            <ShellIcon name={collapsed ? 'chev_r' : 'chev_l'} />
          </button>
        </div>

        {/* Search */}
        {!collapsed && (
          <div style={{ padding: '4px 12px 10px' }}>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 8, top: 7, color: 'var(--text-4)', pointerEvents: 'none' }}>
                <ShellIcon name="search" />
              </span>
              <input
                placeholder="강의 검색"
                value={search}
                onChange={(e) => onSearchChange?.(e.target.value)}
                style={{
                  width: '100%',
                  height: 28,
                  padding: '0 8px 0 28px',
                  borderRadius: 7,
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  fontSize: 12,
                  color: 'var(--text-2)',
                  outline: 'none',
                }}
              />
            </div>
          </div>
        )}

        {/* Nav body */}
        <div className="scrollbar-thin" style={{ flex: 1, padding: collapsed ? '4px 8px 10px' : '0 8px 10px', minHeight: 0, overflowY: 'auto' }}>
          {NAV_PRIMARY.map((it) => {
            const active = activeNav === it.k
            return (
              <button
                key={it.k}
                onClick={() => onNavSelect?.(it.k)}
                title={it.label}
                className={'ds-nav-item' + (active ? ' active' : '')}
                style={{
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  padding: collapsed ? '8px 0' : '6px 10px',
                }}
              >
                <ShellIcon name={it.ico} />
                {!collapsed && <span style={{ flex: 1 }}>{it.label}</span>}
                {!collapsed && it.k === 'insights' && (insightsBadge ?? 0) > 0 && (
                  <span className="ds-pill amber" style={{ fontSize: 9, padding: '0 6px' }}>
                    {insightsBadge}
                  </span>
                )}
              </button>
            )
          })}

          {/* Lecture tree (lectures nav 활성일 때) */}
          {!collapsed && activeNav === 'lectures' && (
            <div style={{ marginTop: 6 }}>
              {groups.map((g) => {
                const groupCollapsed = collapsedGroups.has(g.key)
                return (
                <div key={g.key}>
                  <button
                    onClick={() => toggleGroup(g.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      width: '100%',
                      padding: '12px 8px 4px',
                      fontSize: 10,
                      color: 'var(--text-4)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      fontWeight: 600,
                      background: 'transparent',
                      border: 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    title={groupCollapsed ? '펼치기' : '접기'}
                  >
                    <ShellIcon name={groupCollapsed ? 'chev_r' : 'chev_l'} size={10} />
                    <span style={{ flex: 1 }}>{g.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-4)' }}>
                      {g.lectures.length}
                    </span>
                  </button>
                  {!groupCollapsed && g.lectures.map((l) => {
                    const active = l.id === activeLectureId
                  const displayName = (l.original_name || l.id).replace(/\.(mp3|mp4)$/i, '')
                    return (
                      <button
                        key={l.id}
                        onClick={() => onLectureSelect?.(l.id)}
                        className={'ds-nav-item' + (active ? ' active' : '')}
                        style={{ alignItems: 'flex-start', padding: '7px 10px' }}
                        title={displayName}
                      >
                        <span className="ds-nav-dot" style={{ marginTop: 6 }} />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12,
                              fontWeight: active ? 600 : 500,
                              lineHeight: 1.4,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {displayName}
                          </span>
                          {l.latest_job_status && l.latest_job_status !== 'completed' && (
                            <span
                              style={{
                                display: 'block',
                                fontSize: 10,
                                color:
                                  l.latest_job_status === 'failed'
                                    ? '#dc2626'
                                    : l.latest_job_status === 'awaiting_domain'
                                      ? 'var(--amber)'
                                      : 'var(--text-4)',
                                marginTop: 2,
                                fontFamily: 'var(--font-mono)',
                              }}
                            >
                              {l.latest_job_status}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
                )
              })}
              {groups.length === 0 && (
                <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-4)' }}>
                  {q ? '검색 결과 없음' : '아직 강의가 없습니다'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Auxiliary slot — 운영 패널 (Upload / Bookmarks / Insights) */}
        {!collapsed && auxiliarySlot && (
          <div style={{ borderTop: '1px solid var(--border)', maxHeight: '50%', overflowY: 'auto' }} className="scrollbar-thin">
            {auxiliarySlot}
          </div>
        )}

        {/* User footer */}
        <div
          style={{
            padding: '8px 10px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: 'var(--surface-3)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--text-2)',
            }}
            title={userName || ''}
          >
            {userInitials}
          </div>
          {!collapsed && (
            <>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-2)',
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {userName ?? '사용자'}
              </div>
              {onSettingsClick && (
                <button
                  onClick={onSettingsClick}
                  className="ds-btn ghost sm"
                  style={{ padding: '0 4px' }}
                  title="설정"
                  aria-label="설정"
                >
                  <ShellIcon name="settings" />
                </button>
              )}
              {onLogoutClick && (
                <button
                  onClick={onLogoutClick}
                  className="ds-btn ghost sm"
                  style={{ padding: '0 4px' }}
                  title="로그아웃"
                  aria-label="로그아웃"
                >
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                  </svg>
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Main content area */}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', minHeight: 0 }}>
        {children}
      </div>
    </div>
  )
}
