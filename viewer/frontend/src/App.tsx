import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { DomainPicker } from './components/DomainPicker'
import { HybridShell, type ShellNavKey } from './components/HybridShell'
import {
  groupLecturesByDomain,
  postLectureDomain,
  type DomainInfo,
  type Lecture,
} from './hooks/useLectures'

// ─── Types ──────────────────────────────────────────────

type TranscriptSegment = { time: string; text: string }

type JsonValue = TranscriptSegment[] | Record<string, unknown> | unknown[]

type RawFile = {
  key: string
  name: string
  data: JsonValue
  isSegments: boolean
  segmentCount: number
}

type LectureSummary = {
  version: number
  generated_at: string
  video: string
  models?: {
    correction?: string
    gpt_summary?: string
    claude_summary?: string
  }
  overview: {
    title: string
    summary: string
  }
  key_concepts: {
    term: string
    explanation: string
    first_mention: string
  }[]
  timeline: {
    time: string
    end_time: string
    title: string
    description: string
  }[]
  study_guide: {
    question: string
    answer: string
    relevant_time: string
  }[]
  show_me_gpt?: string
  show_me_claude?: string
  notes_gpt?: string
  notes_claude?: string
}

type TranscriptEntry = {
  id: string
  label: string
  corrected: RawFile | null
  raw: RawFile | null
  summary: LectureSummary | null
}

type Bookmark = {
  id: string
  lecture_id: string
  time: string
  segment_idx: number | null
  note: string
  color: string
  created_at: string
}

type QaInsight = {
  id: string
  question: string
  answer_summary: string
  tags: string[]
  action?: 'new' | 'merge'
  merge_target_id?: string
  lecture_id?: string
  created_at?: string
}

type ViewMode = 'corrected' | 'raw' | 'json'

type ChatSession = {
  id: string
  lecture_id: string
  title: string
  created_at: string
  updated_at: string
}

type ChatMessage = {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  model?: string
  is_compaction?: boolean
  created_at?: string
}

// ─── Data Loading ───────────────────────────────────────

const modules = import.meta.glob('../../../output/*.json', { eager: true }) as Record<
  string,
  { default: JsonValue }
>

const summaryModules = import.meta.glob('../../../output/*_summary_*.json', { eager: true }) as Record<
  string,
  { default: LectureSummary }
>

function isSegments(data: JsonValue): boolean {
  if (!Array.isArray(data) || data.length === 0) return false
  const first = data[0] as Record<string, unknown>
  return typeof first?.time === 'string' && typeof first?.text === 'string'
}

function extractBase(filename: string): string {
  return filename
    .replace(/\.json$/, '')
    .replace(/_[a-f0-9]{6,}$/, '')
    .replace(/_corrected$/, '')
    .replace(/_raw_transcript$/, '')
    .replace(/_summary$/, '')
}

function toRawFile(path: string, data: JsonValue): RawFile {
  const name = path.split('/').pop()!
  const seg = isSegments(data)
  return {
    key: path,
    name,
    data,
    isSegments: seg,
    segmentCount: seg ? (data as TranscriptSegment[]).length : 0,
  }
}

// Build summary map keyed by base name
const summaryMap = new Map<string, LectureSummary>()
for (const [path, mod] of Object.entries(summaryModules)) {
  const name = path.split('/').pop()!
  const base = extractBase(name)
  summaryMap.set(base, mod.default)
}

// Build paired entries — skip bundle files and summary files
const entries: TranscriptEntry[] = (() => {
  const map = new Map<string, { corrected?: RawFile; raw?: RawFile }>()

  for (const [path, mod] of Object.entries(modules)) {
    const name = path.split('/').pop()!

    // skip bundle files and summary files
    if (name.includes('all_transcripts')) continue
    if (name.includes('_summary_')) continue

    const base = extractBase(name)
    const file = toRawFile(path, mod.default)

    if (!map.has(base)) map.set(base, {})
    const pair = map.get(base)!

    if (name.includes('_corrected')) {
      pair.corrected = file
    } else if (name.includes('_raw_transcript')) {
      pair.raw = file
    } else {
      // standalone file — treat as corrected
      pair.corrected = file
    }
  }

  return Array.from(map.entries())
    .map(([base, pair]) => ({
      id: base,
      label: base.replace(/_/g, ' '),
      corrected: pair.corrected ?? null,
      raw: pair.raw ?? null,
      summary: summaryMap.get(base) ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
})()

// ─── Icons ──────────────────────────────────────────────

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-teal-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  )
}

// 모바일 햄버거 — 디자인 3/3 단계에서 메인 영역 메타바로 옮겨질 예정
export function MenuIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
    </svg>
  )
}

function CodeBracketIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function ChevronDownIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  )
}

function ChatBubbleIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.364.466.037.893.281 1.153.671L12 21l2.652-3.978c.26-.39.687-.634 1.153-.671a49.125 49.125 0 003.238-.364c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  )
}

function BookmarkIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
    </svg>
  )
}

function LightBulbIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
    </svg>
  )
}

const BOOKMARK_COLORS = [
  { name: 'teal', value: '#0d9488' },
  { name: 'amber', value: '#d97706' },
  { name: 'violet', value: '#7c3aed' },
  { name: 'rose', value: '#e11d48' },
  { name: 'blue', value: '#2563eb' },
]

// ─── Helpers ────────────────────────────────────────────

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlightText(text: string, query: string) {
  if (!query) return text
  const parts = text.split(new RegExp(`(${escapeRegex(query)})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="bg-yellow-200/70 text-yellow-900 rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Parse a timestamp like "00:01:02" to total seconds */
function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

/** Format a timestamp badge */
function TimeBadge({ time, onClick }: { time: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center font-mono text-[11px] text-amber-700/80 bg-amber-50 hover:bg-amber-100 rounded px-1.5 py-0.5 transition-colors cursor-pointer shrink-0"
      title={`${time}으로 이동`}
    >
      {time}
    </button>
  )
}

// ─── Segment Row ────────────────────────────────────────

function SegmentRow({
  seg,
  index,
  query,
  dataTime,
  bookmark,
  onContextMenu,
  onBookmarkClick,
}: {
  seg: TranscriptSegment
  index: number
  query: string
  dataTime: number
  bookmark?: Bookmark | null
  onContextMenu?: (e: React.MouseEvent) => void
  onBookmarkClick?: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className="seg-row flex gap-3 px-5 py-2.5 transition-colors duration-500 relative"
      data-time={dataTime}
      onContextMenu={onContextMenu}
    >
      {/* Bookmark indicator dot */}
      {bookmark && (
        <button
          onClick={onBookmarkClick}
          className="absolute left-1 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ring-2 ring-white shadow-sm cursor-pointer hover:scale-125 transition-transform"
          style={{ backgroundColor: bookmark.color || '#0d9488' }}
          title={bookmark.note || '북마크'}
        />
      )}
      <span className="shrink-0 w-7 pt-[3px] text-right font-mono text-[11px] text-slate-300 select-none">
        {index}
      </span>
      <code className="shrink-0 w-[72px] pt-[2px] font-mono text-[12px] text-amber-600/80 select-all">
        {seg.time}
      </code>
      <p className="min-w-0 text-[14px] leading-[1.8] text-slate-700">
        {query ? highlightText(seg.text, query) : seg.text}
      </p>
    </div>
  )
}

// ─── Summary Components ─────────────────────────────────

function OverviewCard({ overview }: { overview: LectureSummary['overview'] }) {
  return (
    <div className="px-5 py-4">
      <h3 className="text-[15px] font-semibold text-slate-800 mb-2">{overview.title}</h3>
      <p className="text-[13px] leading-[1.9] text-slate-600 whitespace-pre-line">{overview.summary}</p>
    </div>
  )
}

// ─── Mermaid global type ─────────────────────────────────

declare global {
  interface Window {
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void
      render: (id: string, code: string) => Promise<{ svg: string }>
    }
  }
}

type ShowMeBlock =
  | { type: 'markdown'; content: string }
  | { type: 'mermaid'; code: string }
  | { type: 'svg'; code: string }
  | { type: 'csv'; data: string[][] }

const DIAGRAM_LANGS = ['mermaid', 'svg', 'csv'] as const

function parseShowMeContent(raw: string): ShowMeBlock[] {
  const blocks: ShowMeBlock[] = []
  const lines = raw.split('\n')
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trimStart()

    // ``` 코드블록 감지
    const fenceMatch = trimmed.match(/^```(\w*)/)
    if (fenceMatch) {
      const lang = fenceMatch[1].toLowerCase()
      i++
      const codeLines: string[] = []
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // skip closing fence

      if (lang === 'mermaid') {
        blocks.push({ type: 'mermaid', code: codeLines.join('\n') })
      } else if (lang === 'svg') {
        blocks.push({ type: 'svg', code: codeLines.join('\n') })
      } else if (lang === 'csv') {
        const data = codeLines
          .filter((l) => l.trim())
          .map((l) => l.split(',').map((c) => c.trim()))
        blocks.push({ type: 'csv', data })
      } else {
        // 일반 코드블록은 markdown으로 처리
        blocks.push({ type: 'markdown', content: '```' + lang + '\n' + codeLines.join('\n') + '\n```' })
      }
    } else {
      const mdLines: string[] = []
      while (i < lines.length) {
        const t = lines[i].trimStart()
        const m = t.match(/^```(\w+)/)
        if (m && (DIAGRAM_LANGS as readonly string[]).includes(m[1].toLowerCase())) break
        mdLines.push(lines[i])
        i++
      }
      const content = mdLines.join('\n').trim()
      if (content) blocks.push({ type: 'markdown', content })
    }
  }

  return blocks
}

// LLM 이 생성한 SVG/HTML 단편을 기본 sanitize: <script>, on* 핸들러, javascript: URI 제거
function sanitizeSvg(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*\/?\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:xlink:href|href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '')
}

// LLM 응답이 HTML 단편 형태인지 판별. 옛 baseline (마크다운 + ```svg``` 코드 블록) 과 자동 분기.
function isHtmlFragment(raw: string): boolean {
  return /^\s*</.test(raw)
}

function HtmlFragment({ html }: { html: string }) {
  const safe = useMemo(() => sanitizeSvg(html), [html])
  return (
    <div
      className="lecture-html-fragment my-4 rounded-xl border border-slate-200 bg-white overflow-x-auto p-5"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  )
}

function CsvTable({ data }: { data: string[][] }) {
  if (data.length === 0) return null
  const [header, ...rows] = data
  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {header.map((h, i) => (
              <th key={i} className="px-4 py-2.5 text-left font-semibold text-slate-700">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-slate-100 last:border-0">
              {row.map((cell, ci) => (
                <td key={ci} className="px-4 py-2 text-slate-600">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h2 className="text-[17px] font-bold text-slate-900 mt-6 mb-3 tracking-tight">{children}</h2>,
        h2: ({ children }) => <h3 className="text-[15px] font-bold text-slate-800 mt-5 mb-2">{children}</h3>,
        h3: ({ children }) => <h4 className="text-[14px] font-semibold text-slate-700 mt-4 mb-2">{children}</h4>,
        p: ({ children }) => <p className="text-[14px] leading-[1.8] text-slate-600 my-2">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-slate-800">{children}</strong>,
        em: ({ children }) => <em className="text-slate-500">{children}</em>,
        ul: ({ children }) => <ul className="my-2 pl-5 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 pl-5 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-[14px] leading-[1.8] text-slate-600">{children}</li>,
        table: ({ children }) => (
          <div className="my-4 overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-[13px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-slate-50 border-b border-slate-200">{children}</thead>,
        th: ({ children }) => <th className="px-4 py-2.5 text-left font-semibold text-slate-700">{children}</th>,
        td: ({ children }) => <td className="px-4 py-2 text-slate-600 border-b border-slate-100">{children}</td>,
        code: ({ children, className }) => {
          if (className) {
            return <pre className="my-3 rounded-lg bg-slate-900 p-4 text-[12px] text-slate-200 overflow-x-auto"><code>{children}</code></pre>
          }
          return <code className="bg-slate-100 text-teal-700 text-[13px] px-1.5 py-0.5 rounded">{children}</code>
        },
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-3 border-teal-300 pl-4 text-slate-500 italic">{children}</blockquote>
        ),
        hr: () => <hr className="my-5 border-slate-200" />,
      }}
    >
      {content}
    </Markdown>
  )
}

// Mermaid CDN loader — loads once globally
let mermaidLoadPromise: Promise<void> | null = null

function loadMermaid(): Promise<void> {
  if (window.mermaid) return Promise.resolve()
  if (mermaidLoadPromise) return mermaidLoadPromise

  mermaidLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
    script.onload = () => {
      window.mermaid?.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' })
      resolve()
    }
    script.onerror = () => reject(new Error('Failed to load Mermaid'))
    document.head.appendChild(script)
  })

  return mermaidLoadPromise
}

let mermaidIdCounter = 0

function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const idRef = useRef(`mermaid-${++mermaidIdCounter}`)

  // Calculate display width cap based on SVG aspect ratio
  const MAX_ASPECT = 1.8
  const displayStyle = useMemo(() => {
    if (!svg) return {}
    const match = svg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/)
    if (!match) return { width: '100%', maxWidth: '100%' }
    const vbW = parseFloat(match[1])
    const vbH = parseFloat(match[2])
    if (!vbW || !vbH) return { width: '100%', maxWidth: '100%' }
    const aspect = vbH / vbW
    if (aspect <= MAX_ASPECT) return { width: '100%', maxWidth: '100%' }
    const pct = Math.max(30, Math.round((MAX_ASPECT / aspect) * 100))
    return { width: `${pct}%`, maxWidth: `${pct}%`, margin: '0 auto' }
  }, [svg])

  useEffect(() => {
    let cancelled = false

    loadMermaid()
      .then(async () => {
        if (cancelled) return
        try {
          const result = await window.mermaid!.render(idRef.current, code)
          if (!cancelled) {
            setSvg(result.svg)
            setLoading(false)
          }
        } catch {
          if (!cancelled) {
            setError(true)
            setLoading(false)
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [code])

  if (loading) {
    return (
      <div className="my-4 flex items-center justify-center py-12 bg-slate-50 rounded-xl border border-slate-200">
        <div className="flex items-center gap-3 text-slate-400 text-[13px]">
          <div className="w-4 h-4 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
          다이어그램 로딩 중...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="my-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-[12px] text-amber-600 font-medium mb-2">다이어그램 렌더링 실패</p>
        <pre className="text-[12px] font-mono text-slate-600 whitespace-pre-wrap bg-white rounded-lg p-3 border border-slate-200">{code}</pre>
      </div>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        className="my-4 relative group rounded-xl border border-slate-200 bg-white p-4 overflow-x-auto mermaid-wide"
      >
        <div style={displayStyle} dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
        <button
          onClick={() => setFullscreen(true)}
          className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-white/80 border border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-white shadow-sm opacity-0 group-hover:opacity-100 transition-all"
          title="전체 화면으로 보기"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
          </svg>
        </button>
      </div>
      {fullscreen && <DiagramModal svg={svg ?? ''} onClose={() => setFullscreen(false)} />}
    </>
  )
}

function SvgDiagram({ code }: { code: string }) {
  const safeSvg = useMemo(() => sanitizeSvg(code), [code])
  const [fullscreen, setFullscreen] = useState(false)

  const MAX_ASPECT = 1.8
  const displayStyle = useMemo(() => {
    const match = safeSvg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/)
    if (!match) return { width: '100%', maxWidth: '100%' } as const
    const vbW = parseFloat(match[1])
    const vbH = parseFloat(match[2])
    if (!vbW || !vbH) return { width: '100%', maxWidth: '100%' } as const
    const aspect = vbH / vbW
    if (aspect <= MAX_ASPECT) return { width: '100%', maxWidth: '100%' } as const
    const pct = Math.max(30, Math.round((MAX_ASPECT / aspect) * 100))
    return { width: `${pct}%`, maxWidth: `${pct}%`, margin: '0 auto' } as const
  }, [safeSvg])

  if (!safeSvg.includes('<svg')) {
    return (
      <div className="my-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-[12px] text-amber-600 font-medium mb-2">SVG 다이어그램 파싱 실패</p>
        <pre className="text-[12px] font-mono text-slate-600 whitespace-pre-wrap bg-white rounded-lg p-3 border border-slate-200">{code}</pre>
      </div>
    )
  }

  return (
    <>
      <div className="my-4 relative group rounded-xl border border-slate-200 bg-white p-4 overflow-x-auto mermaid-wide">
        <div style={displayStyle} dangerouslySetInnerHTML={{ __html: safeSvg }} />
        <button
          onClick={() => setFullscreen(true)}
          className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-white/80 border border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-white shadow-sm opacity-0 group-hover:opacity-100 transition-all"
          title="전체 화면으로 보기"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
          </svg>
        </button>
      </div>
      {fullscreen && <DiagramModal svg={safeSvg} onClose={() => setFullscreen(false)} />}
    </>
  )
}

function DiagramModal({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setScale((s) => Math.min(5, Math.max(0.2, s - e.deltaY * 0.001)))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    setPos((p) => ({
      x: p.x + e.clientX - lastPos.current.x,
      y: p.y + e.clientY - lastPos.current.y,
    }))
    lastPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleMouseUp = useCallback(() => { dragging.current = false }, [])

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex flex-col" onClick={onClose}>
      {/* Toolbar */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-slate-900/80" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <button onClick={() => setScale((s) => Math.min(5, s + 0.25))} className="px-2.5 py-1 rounded-md bg-white/10 text-white text-[13px] hover:bg-white/20 transition">+</button>
          <button onClick={() => setScale((s) => Math.max(0.2, s - 0.25))} className="px-2.5 py-1 rounded-md bg-white/10 text-white text-[13px] hover:bg-white/20 transition">-</button>
          <span className="text-[12px] text-slate-400 ml-1">{Math.round(scale * 100)}%</span>
          <button onClick={() => { setScale(1); setPos({ x: 0, y: 0 }) }} className="px-2.5 py-1 rounded-md bg-white/10 text-white text-[12px] hover:bg-white/20 transition ml-2">초기화</button>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition">
          <XIcon />
        </button>
      </div>
      {/* Canvas */}
      <div
        className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-full h-full flex items-center justify-center"
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, transformOrigin: 'center center', transition: dragging.current ? 'none' : 'transform 0.1s ease-out' }}
        >
          <div className="bg-white rounded-2xl p-8 shadow-2xl" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      </div>
    </div>
  )
}

// ─── Module versioning (ShowMe / Notes 재생성) ─────────────

type ModuleName = 'show_me' | 'notes'
type ModelKindName = 'gpt' | 'claude'

type VersionMeta = {
  version: number
  model_id: string
  created_at: string
  is_baseline: boolean
  job_id: string | null
}

type VersionsResponse = {
  show_me: { gpt: VersionMeta[]; claude: VersionMeta[] }
  notes: { gpt: VersionMeta[]; claude: VersionMeta[] }
}

// ─── Global Regen store ─────────────────────────────────
// 강의 × (module, model_kind) 슬롯 단위 polling. 컴포넌트 unmount 또는
// 모델 토글 변경에도 진행 중인 재생성 작업을 잃지 않는다.

type RegenKey = string  // `${lectureId}|${module}|${modelKind}`

function regenKeyOf(lectureId: string, module: ModuleName, modelKind: ModelKindName): RegenKey {
  return `${lectureId}|${module}|${modelKind}`
}

type ActiveRegen = { lectureId: string; module: ModuleName; modelKind: ModelKindName; jobId: string }

type RegenContextValue = {
  active: ReadonlyMap<RegenKey, ActiveRegen>
  errors: ReadonlyMap<RegenKey, string>
  // 슬롯이 완료될 때마다 카운터 증가 → 컴포넌트가 versions refetch 트리거로 사용
  completionCounters: ReadonlyMap<RegenKey, number>
  start: (lectureId: string, module: ModuleName, modelKind: ModelKindName) => Promise<void>
  clearError: (lectureId: string, module: ModuleName, modelKind: ModelKindName) => void
}

const RegenContext = createContext<RegenContextValue | null>(null)

export function RegenProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Map<RegenKey, ActiveRegen>>(() => new Map())
  const [errors, setErrors] = useState<Map<RegenKey, string>>(() => new Map())
  const [completionCounters, setCompletionCounters] = useState<Map<RegenKey, number>>(() => new Map())

  // 마운트 시 backend 에서 진행 중인 regen jobs 를 시드 — 새로고침 후 polling 재개
  useEffect(() => {
    let cancelled = false
    fetch('/api/regen/active')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { job_id: string; lecture_id: string; module: ModuleName; model_kind: ModelKindName }[]) => {
        if (cancelled || list.length === 0) return
        setActive((prev) => {
          const next = new Map(prev)
          for (const item of list) {
            const key = regenKeyOf(item.lecture_id, item.module, item.model_kind)
            // 이미 추적 중이면 덮어쓰지 않음 (start() 가 set 한 게 우선)
            if (!next.has(key)) {
              next.set(key, {
                lectureId: item.lecture_id,
                module: item.module,
                modelKind: item.model_kind,
                jobId: item.job_id,
              })
            }
          }
          return next
        })
      })
      .catch(() => { /* 인증 미완료 등 — 무시 */ })
    return () => { cancelled = true }
  }, [])

  // active 가 하나라도 있으면 단일 polling interval 로 모두 확인
  useEffect(() => {
    if (active.size === 0) return
    let cancelled = false
    const tick = async () => {
      const snapshot = Array.from(active.entries())
      for (const [key, regen] of snapshot) {
        try {
          const res = await fetch(`/api/jobs/${regen.jobId}`)
          if (!res.ok) continue
          const j: { status: string; error_message: string | null } = await res.json()
          if (cancelled) return
          if (j.status === 'completed') {
            setActive((prev) => {
              if (!prev.has(key)) return prev
              const next = new Map(prev); next.delete(key); return next
            })
            setCompletionCounters((prev) => {
              const next = new Map(prev); next.set(key, (prev.get(key) ?? 0) + 1); return next
            })
            setErrors((prev) => {
              if (!prev.has(key)) return prev
              const next = new Map(prev); next.delete(key); return next
            })
          } else if (j.status === 'failed' || j.status === 'canceled') {
            setActive((prev) => {
              if (!prev.has(key)) return prev
              const next = new Map(prev); next.delete(key); return next
            })
            setErrors((prev) => {
              const next = new Map(prev)
              next.set(key, j.error_message || `재생성 ${j.status}`)
              return next
            })
          }
        } catch {
          // 네트워크 일시 오류 — 다음 tick 에 재시도
        }
      }
    }
    const interval = window.setInterval(tick, 2000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [active])

  const start = useCallback(async (lectureId: string, module: ModuleName, modelKind: ModelKindName) => {
    const key = regenKeyOf(lectureId, module, modelKind)
    setErrors((prev) => {
      if (!prev.has(key)) return prev
      const next = new Map(prev); next.delete(key); return next
    })
    try {
      const res = await fetch(`/api/lectures/${encodeURIComponent(lectureId)}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module, model_kind: modelKind }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { detail?: string }
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const data: { job_id: string } = await res.json()
      setActive((prev) => {
        const next = new Map(prev)
        next.set(key, { lectureId, module, modelKind, jobId: data.job_id })
        return next
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      setErrors((prev) => {
        const next = new Map(prev); next.set(key, message); return next
      })
    }
  }, [])

  const clearError = useCallback((lectureId: string, module: ModuleName, modelKind: ModelKindName) => {
    const key = regenKeyOf(lectureId, module, modelKind)
    setErrors((prev) => {
      if (!prev.has(key)) return prev
      const next = new Map(prev); next.delete(key); return next
    })
  }, [])

  const value = useMemo(
    () => ({ active, errors, completionCounters, start, clearError }),
    [active, errors, completionCounters, start, clearError],
  )
  return <RegenContext.Provider value={value}>{children}</RegenContext.Provider>
}

function useRegen(): RegenContextValue {
  const ctx = useContext(RegenContext)
  if (!ctx) throw new Error('useRegen must be used inside <RegenProvider>')
  return ctx
}

// ─── Slot hook (글로벌 store 위에서 동작) ──────────────

type SlotLocalState = {
  versions: VersionMeta[]
  selectedVersion: number | null
  content: string
  isLoading: boolean
}

function useModuleVersions(
  lectureId: string,
  module: ModuleName,
  modelKind: ModelKindName,
  fallbackContent: string,
) {
  const ctx = useRegen()
  const key = regenKeyOf(lectureId, module, modelKind)
  const isRegenerating = ctx.active.has(key)
  const regenError = ctx.errors.get(key) ?? null
  const completionCounter = ctx.completionCounters.get(key) ?? 0

  const [state, setState] = useState<SlotLocalState>({
    versions: [],
    selectedVersion: null,
    content: fallbackContent,
    isLoading: false,
  })

  // versions 메타 fetch — 슬롯 식별자나 완료 카운터가 바뀌면 재조회 (재생성 직후 새 v 가 노출되도록)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/lectures/${encodeURIComponent(lectureId)}/versions`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: VersionsResponse) => {
        if (cancelled) return
        const slot = data[module][modelKind] ?? []
        const latest = slot.length > 0 ? slot[0].version : null
        setState((s) => ({
          ...s,
          versions: slot,
          selectedVersion: latest,
          content: latest === null ? fallbackContent : s.content,
        }))
      })
      .catch(() => {
        if (cancelled) return
        setState((s) => ({ ...s, versions: [], selectedVersion: null, content: fallbackContent }))
      })
    return () => { cancelled = true }
  }, [lectureId, module, modelKind, fallbackContent, completionCounter])

  // 선택 버전 콘텐츠 fetch
  useEffect(() => {
    if (state.selectedVersion === null) return
    let cancelled = false
    setState((s) => ({ ...s, isLoading: true }))
    fetch(
      `/api/lectures/${encodeURIComponent(lectureId)}/versions/${module}/${modelKind}/${state.selectedVersion}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { content: string }) => {
        if (cancelled) return
        setState((s) => ({ ...s, content: data.content, isLoading: false }))
      })
      .catch(() => {
        if (cancelled) return
        setState((s) => ({ ...s, isLoading: false }))
      })
    return () => { cancelled = true }
  }, [lectureId, module, modelKind, state.selectedVersion])

  const triggerRegen = useCallback(async (): Promise<void> => {
    await ctx.start(lectureId, module, modelKind)
  }, [ctx, lectureId, module, modelKind])

  const setSelectedVersion = useCallback((v: number | null) => {
    setState((s) => ({ ...s, selectedVersion: v }))
  }, [])

  const dismissError = useCallback(() => {
    ctx.clearError(lectureId, module, modelKind)
  }, [ctx, lectureId, module, modelKind])

  return {
    versions: state.versions,
    selectedVersion: state.selectedVersion,
    content: state.content,
    isLoading: state.isLoading,
    isRegenerating,
    regenError,
    triggerRegen,
    setSelectedVersion,
    dismissError,
  }
}

function VersionDropdown({
  versions, selectedVersion, onSelect, disabled,
}: {
  versions: VersionMeta[]
  selectedVersion: number | null
  onSelect: (v: number) => void
  disabled?: boolean
}) {
  if (versions.length === 0) return null
  return (
    <select
      disabled={disabled}
      value={selectedVersion ?? versions[0].version}
      onChange={(e) => onSelect(parseInt(e.target.value, 10))}
      className="text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md px-2 py-1 border-0 focus:ring-1 focus:ring-teal-400 disabled:opacity-50"
      title="버전 선택"
    >
      {versions.map((v) => (
        <option key={v.version} value={v.version}>
          v{v.version}{v.is_baseline ? ' (기준)' : ''} · {v.model_id}
        </option>
      ))}
    </select>
  )
}

function RegenButton({
  isRegenerating, onTrigger,
}: {
  isRegenerating: boolean
  onTrigger: () => Promise<void>
}) {
  return (
    <button
      onClick={() => { void onTrigger() }}
      disabled={isRegenerating}
      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition flex items-center gap-1.5 ${
        isRegenerating
          ? 'bg-amber-100 text-amber-700 cursor-wait'
          : 'bg-teal-50 text-teal-700 hover:bg-teal-100'
      }`}
      title="현재 토글된 모델로 새 버전 생성"
    >
      {isRegenerating ? (
        <>
          <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <span>재생성 중…</span>
        </>
      ) : (
        <>
          <span>↻</span>
          <span>재생성</span>
        </>
      )}
    </button>
  )
}

function ShowMe({
  lectureId,
  showMeClaude,
  models,
}: {
  lectureId: string
  // GPT 변형은 임시 중단되어 props 에서 제거 — Claude (Opus) 단독.
  showMeClaude: string
  models?: LectureSummary['models']
}) {
  const slot = useModuleVersions(lectureId, 'show_me', 'claude', showMeClaude)

  const currentMeta = slot.versions.find((v) => v.version === slot.selectedVersion)
  const activeModelId = currentMeta?.model_id ?? models?.claude_summary
  const isHtml = useMemo(() => isHtmlFragment(slot.content), [slot.content])
  const blocks = useMemo(
    () => (isHtml ? [] : parseShowMeContent(slot.content)),
    [isHtml, slot.content],
  )
  const renderKey = `${slot.selectedVersion ?? 'fb'}`

  return (
    <div className="px-5 py-4">
      {/* Header row with version dropdown + regen button */}
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-slate-800">강의 시각화</h3>
          {activeModelId && (
            <p className="mt-0.5 text-[11px] text-slate-400">
              {activeModelId}
              {currentMeta?.is_baseline && <span className="ml-1 text-amber-500">기준</span>}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <VersionDropdown
            versions={slot.versions}
            selectedVersion={slot.selectedVersion}
            onSelect={slot.setSelectedVersion}
          />

          <RegenButton
            isRegenerating={slot.isRegenerating}
            onTrigger={slot.triggerRegen}
          />
        </div>
      </div>

      {slot.regenError && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[12px] text-red-700">
          재생성 실패: {slot.regenError}
        </div>
      )}

      <div className={slot.isLoading ? 'opacity-60 transition-opacity' : ''}>
        {isHtml ? (
          <HtmlFragment key={renderKey} html={slot.content} />
        ) : (
          blocks.map((block, i) => {
            if (block.type === 'svg') return <SvgDiagram key={`${renderKey}-${i}`} code={block.code} />
            if (block.type === 'mermaid') return <MermaidDiagram key={`${renderKey}-${i}`} code={block.code} />
            if (block.type === 'csv') return <CsvTable key={`${renderKey}-${i}`} data={block.data} />
            return <MarkdownContent key={`${renderKey}-${i}`} content={block.content} />
          })
        )}
      </div>
    </div>
  )
}

function KeyConceptsList({
  concepts,
  onTimestampClick,
}: {
  concepts: LectureSummary['key_concepts']
  onTimestampClick: (time: string) => void
}) {
  return (
    <div>
      <h4 className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-3 px-1">
        Key Concepts
      </h4>
      <div className="space-y-3">
        {concepts.map((c, i) => (
          <div key={i} className="flex gap-2 items-start">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <span className="text-[13px] font-semibold text-slate-800">{c.term}</span>
                <TimeBadge time={c.first_mention} onClick={() => onTimestampClick(c.first_mention)} />
              </div>
              <p className="text-[12.5px] leading-[1.7] text-slate-500">{c.explanation}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TimelineList({
  timeline,
  onTimestampClick,
}: {
  timeline: LectureSummary['timeline']
  onTimestampClick: (time: string) => void
}) {
  return (
    <div>
      <h4 className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-3 px-1">
        Timeline
      </h4>
      <div className="space-y-2.5">
        {timeline.map((item, i) => (
          <div key={i} className="relative pl-4 border-l-2 border-slate-100">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <TimeBadge time={item.time} onClick={() => onTimestampClick(item.time)} />
              <span className="text-[11px] text-slate-300 font-mono">~{item.end_time}</span>
              <span className="text-[13px] font-medium text-slate-700">{item.title}</span>
            </div>
            <p className="text-[12.5px] leading-[1.6] text-slate-500">{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function StudyGuide({
  items,
  onTimestampClick,
}: {
  items: LectureSummary['study_guide']
  onTimestampClick: (time: string) => void
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  return (
    <div>
      <h4 className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-3 px-1">
        Study Guide
      </h4>
      <div className="space-y-1">
        {items.map((item, i) => {
          const isOpen = openIdx === i
          return (
            <div key={i} className="border border-slate-100 rounded-lg overflow-hidden">
              <button
                onClick={() => setOpenIdx(isOpen ? null : i)}
                className="w-full text-left px-4 py-2.5 flex items-start gap-2 hover:bg-slate-50/80 transition-colors"
              >
                <ChevronDownIcon
                  className={`shrink-0 mt-0.5 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-0' : '-rotate-90'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2 flex-wrap">
                    <span className="text-[13px] font-medium text-slate-700 leading-snug">{item.question}</span>
                    <TimeBadge time={item.relevant_time} onClick={() => onTimestampClick(item.relevant_time)} />
                  </div>
                </div>
              </button>
              {isOpen && (
                <div className="px-4 pb-3 pl-10">
                  <p className="text-[12.5px] leading-[1.8] text-slate-600 whitespace-pre-line">{item.answer}</p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SummaryPanel({
  lectureId,
  summary,
  onTimestampClick,
  collapsed,
  onToggleCollapse,
}: {
  lectureId: string
  summary: LectureSummary
  onTimestampClick: (time: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  return (
    <div className="border-b border-slate-200/80">
      {/* Toggle header */}
      <button
        onClick={onToggleCollapse}
        className="w-full flex items-center gap-2 px-5 py-2.5 text-left hover:bg-slate-50/60 transition-colors"
      >
        <ChevronDownIcon
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
        />
        <span className="text-[13px] font-semibold text-teal-700">강의 요약</span>
        <span className="text-[11px] text-slate-400 font-medium">{summary.overview.title}</span>
      </button>

      {!collapsed && (
        <div>
          {/* Overview / ShowMe — anchor: section-overview + section-showme (같은 영역) */}
          <div id="section-overview" style={{ scrollMarginTop: 50 }} className="border-t border-slate-100">
            <div id="section-showme" />
            {(summary.show_me_gpt || summary.show_me_claude) ? (
              <ShowMe
                lectureId={lectureId}
                showMeClaude={summary.show_me_claude ?? ''}
                models={summary.models}
              />
            ) : (
              <OverviewCard overview={summary.overview} />
            )}
          </div>

          {/* Two-column grid: Key Concepts (id=section-concepts) + Timeline (id=section-timeline) */}
          <div className="border-t border-slate-100 px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div id="section-concepts" style={{ scrollMarginTop: 50 }}>
              <KeyConceptsList concepts={summary.key_concepts} onTimestampClick={onTimestampClick} />
            </div>
            <div id="section-timeline" style={{ scrollMarginTop: 50 }}>
              <TimelineList timeline={summary.timeline} onTimestampClick={onTimestampClick} />
            </div>
          </div>

          {/* Study Guide — anchor: section-qa */}
          <div id="section-qa" style={{ scrollMarginTop: 50 }} className="border-t border-slate-100 px-5 py-4">
            <StudyGuide items={summary.study_guide} onTimestampClick={onTimestampClick} />
          </div>

        </div>
      )}
    </div>
  )
}

function NotesSection({
  lectureId, notesClaude, models,
}: {
  lectureId: string
  // GPT 변형은 임시 중단 — Claude (Opus) 단독.
  notesClaude: string
  models?: LectureSummary['models']
}) {
  const [expanded, setExpanded] = useState(false)
  const slot = useModuleVersions(lectureId, 'notes', 'claude', notesClaude)
  const currentMeta = slot.versions.find((v) => v.version === slot.selectedVersion)
  const activeModelId = currentMeta?.model_id ?? models?.claude_summary

  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 text-left min-w-0">
          <ChevronDownIcon className={`shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-0' : '-rotate-90'}`} />
          <h3 className="text-[14px] font-semibold text-slate-800">강의 정리</h3>
          <span className="text-[11px] text-slate-400 hidden sm:inline">강의를 대체할 수 있는 포괄적 노트</span>
          {activeModelId && (
            <span className="text-[11px] text-slate-400">
              {activeModelId}
              {currentMeta?.is_baseline && <span className="ml-1 text-amber-500">기준</span>}
            </span>
          )}
        </button>

        {expanded && (
          <div className="flex items-center gap-2 shrink-0">
            <VersionDropdown
              versions={slot.versions}
              selectedVersion={slot.selectedVersion}
              onSelect={slot.setSelectedVersion}
            />

            <RegenButton
              isRegenerating={slot.isRegenerating}
              onTrigger={slot.triggerRegen}
            />
          </div>
        )}
      </div>

      {slot.regenError && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[12px] text-red-700">
          재생성 실패: {slot.regenError}
        </div>
      )}

      {expanded && (
        <div className={`rounded-xl border border-slate-200 bg-white p-5 ${slot.isLoading ? 'opacity-60' : ''}`}>
          <MarkdownContent content={slot.content} />
        </div>
      )}
    </div>
  )
}

// ─── Learning Notes Section (본문 독립 섹션) ────────────

function LearningNotesSection({
  insights,
  pendingCount,
  onOpenBatchReview,
  onDelete,
  onRefresh,
}: {
  insights: QaInsight[]
  pendingCount: number
  onOpenBatchReview: () => void
  onDelete: (id: string) => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState({ question: '', answer_summary: '', tags: '' })

  const startEdit = (ins: QaInsight) => {
    setEditingId(ins.id)
    setEditDraft({ question: ins.question, answer_summary: ins.answer_summary, tags: ins.tags.join(', ') })
  }

  const saveEdit = async (id: string) => {
    try {
      await fetch('/api/insights/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edits: [{ id, question: editDraft.question, answer_summary: editDraft.answer_summary, tags: editDraft.tags.split(',').map((t: string) => t.trim()).filter(Boolean) }],
          accept: [id],
        }),
      })
      setEditingId(null)
      onRefresh()
    } catch { /* ignore */ }
  }

  return (
    <div className="border-b border-slate-200/80">
      <div className="px-5 py-2.5 bg-slate-50/80 border-t border-slate-200/80 flex items-center gap-2">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2">
          <ChevronDownIcon className={`shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-0' : '-rotate-90'}`} />
          <LightBulbIcon className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-[12px] font-semibold text-slate-700">학습 노트</span>
        </button>
        <span className="text-[11px] text-slate-400">{insights.length}개</span>
        {pendingCount > 0 && (
          <button
            onClick={onOpenBatchReview}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 hover:bg-amber-100 text-amber-700 text-[11px] font-medium transition-colors"
          >
            리뷰
            <span className="bg-amber-500 text-white text-[10px] rounded-full min-w-[18px] px-1 inline-flex items-center justify-center font-semibold">
              {pendingCount}
            </span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-5 py-4">
          {insights.length === 0 ? (
            <p className="text-[13px] text-slate-400 py-6 text-center">
              채팅에서 질문하면 학습 노트가 자동으로 추가됩니다
            </p>
          ) : (
            <div className="space-y-3">
              {insights.map((ins) => (
                <div key={ins.id} className="group rounded-xl border border-slate-200 bg-white p-4 hover:border-slate-300 transition-colors">
                  {editingId === ins.id ? (
                    <div className="space-y-2.5">
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">질문</label>
                        <input
                          value={editDraft.question}
                          onChange={(e) => setEditDraft((d) => ({ ...d, question: e.target.value }))}
                          className="w-full text-[13px] border border-slate-200 rounded-lg px-3 py-2 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">답변 요약</label>
                        <textarea
                          value={editDraft.answer_summary}
                          onChange={(e) => setEditDraft((d) => ({ ...d, answer_summary: e.target.value }))}
                          rows={4}
                          className="w-full text-[13px] border border-slate-200 rounded-lg px-3 py-2 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 resize-none"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">태그 (쉼표 구분)</label>
                        <input
                          value={editDraft.tags}
                          onChange={(e) => setEditDraft((d) => ({ ...d, tags: e.target.value }))}
                          className="w-full text-[13px] border border-slate-200 rounded-lg px-3 py-2 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100"
                        />
                      </div>
                      <div className="flex justify-end gap-2 pt-1">
                        <button onClick={() => setEditingId(null)} className="px-3 py-1.5 text-[12px] text-slate-500 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition">취소</button>
                        <button onClick={() => saveEdit(ins.id)} className="px-3 py-1.5 text-[12px] bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition">저장</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-[14px] font-semibold text-slate-800 leading-snug">{ins.question}</p>
                          <p className="text-[13px] text-slate-600 leading-relaxed mt-2 whitespace-pre-wrap">{ins.answer_summary}</p>
                        </div>
                        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => startEdit(ins)} className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition" title="수정">
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                            </svg>
                          </button>
                          <button onClick={() => onDelete(ins.id)} className="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition" title="삭제">
                            <XIcon />
                          </button>
                        </div>
                      </div>
                      {ins.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {ins.tags.map((tag) => (
                            <span key={tag} className="bg-slate-100 text-slate-600 text-[11px] px-2 py-0.5 rounded-full">{tag}</span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Chat Markdown with Timestamp Links ────────────────

function ChatMarkdown({
  content,
  onTimestampClick,
}: {
  content: string
  onTimestampClick: (seconds: number) => void
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h2 className="text-[15px] font-bold text-slate-900 mt-4 mb-2 tracking-tight">{children}</h2>,
        h2: ({ children }) => <h3 className="text-[14px] font-bold text-slate-800 mt-3 mb-1.5">{children}</h3>,
        h3: ({ children }) => <h4 className="text-[13px] font-semibold text-slate-700 mt-3 mb-1.5">{children}</h4>,
        p: ({ children }) => {
          // Intercept paragraph content to inject timestamp badges
          const processChildren = (child: React.ReactNode): React.ReactNode => {
            if (typeof child === 'string') {
              const tsParts = child.split(/(\[\d{2}:\d{2}:\d{2}\])/)
              if (tsParts.length <= 1) return child
              return tsParts.map((part, i) => {
                const tsMatch = part.match(/^\[(\d{2}:\d{2}:\d{2})\]$/)
                if (tsMatch) {
                  const ts = tsMatch[1]
                  const seconds = parseTimestamp(ts)
                  return (
                    <button
                      key={i}
                      onClick={() => onTimestampClick(seconds)}
                      className="inline-flex items-center font-mono text-[11px] text-teal-700 bg-teal-50 hover:bg-teal-100 rounded px-1.5 py-0.5 mx-0.5 transition-colors cursor-pointer"
                      title={`${ts}(으)로 이동`}
                    >
                      {ts}
                    </button>
                  )
                }
                return part
              })
            }
            return child
          }
          const processed = Array.isArray(children)
            ? children.map((c, i) => <span key={i}>{processChildren(c)}</span>)
            : processChildren(children)
          return <p className="text-[13px] leading-[1.7] text-slate-700 my-1.5">{processed}</p>
        },
        strong: ({ children }) => <strong className="font-semibold text-slate-800">{children}</strong>,
        em: ({ children }) => <em className="text-slate-500">{children}</em>,
        ul: ({ children }) => <ul className="my-1.5 pl-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 pl-4 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-[13px] leading-[1.7] text-slate-700">{children}</li>,
        code: ({ children, className }) => {
          if (className) {
            return <pre className="my-2 rounded-lg bg-slate-900 p-3 text-[11px] text-slate-200 overflow-x-auto"><code>{children}</code></pre>
          }
          return <code className="bg-slate-100 text-teal-700 text-[12px] px-1 py-0.5 rounded">{children}</code>
        },
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-teal-300 pl-3 text-slate-500 italic text-[13px]">{children}</blockquote>
        ),
      }}
    >
      {content}
    </Markdown>
  )
}

// ─── Typing Indicator ──────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <div className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '0ms' }} />
      <div className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '150ms' }} />
      <div className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}

// ─── Chat Panel ────────────────────────────────────────

function ChatPanel({
  lectureId,
  open,
  onClose,
  scrollToSegment,
  onInsightAction,
}: {
  lectureId: string
  open: boolean
  onClose: () => void
  scrollToSegment: (time: string) => void
  onInsightAction?: () => void
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Auto-scroll to bottom only if already near bottom
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  useEffect(() => {
    if (isNearBottom.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Fetch sessions when panel opens or lecture changes
  useEffect(() => {
    if (!open || !lectureId) return
    let cancelled = false

    const fetchSessions = async () => {
      try {
        const res = await fetch(`/api/chat/sessions?lecture_id=${encodeURIComponent(lectureId)}`)
        if (!res.ok) throw new Error('Failed to fetch sessions')
        const data: ChatSession[] = await res.json()
        if (cancelled) return
        setSessions(data)

        if (data.length > 0) {
          // pick most recently updated
          const sorted = [...data].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          setActiveSessionId(sorted[0].id)
        } else {
          // auto-create a session
          const createRes = await fetch('/api/chat/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lecture_id: lectureId }),
          })
          if (!createRes.ok) throw new Error('Failed to create session')
          const newSession: ChatSession = await createRes.json()
          if (cancelled) return
          setSessions([newSession])
          setActiveSessionId(newSession.id)
        }
      } catch (e) {
        if (!cancelled) setError('세션을 불러오는데 실패했습니다')
      }
    }

    fetchSessions()
    return () => { cancelled = true }
  }, [open, lectureId])

  // Fetch messages when active session changes
  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/chat/sessions/${activeSessionId}/messages`)
        if (!res.ok) throw new Error('Failed to fetch messages')
        const data: ChatMessage[] = await res.json()
        if (!cancelled) setMessages(data)
      } catch {
        if (!cancelled) setError('메시지를 불러오는데 실패했습니다')
      }
    }

    setMessages([])
    fetchMessages()
    return () => { cancelled = true }
  }, [activeSessionId])

  // Create new session
  const createNewSession = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lecture_id: lectureId }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      const newSession: ChatSession = await res.json()
      setSessions((prev) => [newSession, ...prev])
      setActiveSessionId(newSession.id)
      setMessages([])
    } catch {
      setError('새 대화를 만들지 못했습니다')
    }
  }, [lectureId])

  // Delete session
  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' })
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sessionId)
        if (activeSessionId === sessionId) {
          // Switch to the next remaining session, or null
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null)
          if (remaining.length === 0) setMessages([])
        }
        return remaining
      })
    } catch {
      setError('세션 삭제에 실패했습니다')
    }
  }, [activeSessionId])

  // Rename session
  const renameSession = useCallback(async (newTitle: string) => {
    if (!activeSessionId || !newTitle.trim()) { setEditingTitle(false); return }
    try {
      await fetch(`/api/chat/sessions/${activeSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      })
      setSessions((prev) => prev.map((s) => s.id === activeSessionId ? { ...s, title: newTitle.trim() } : s))
    } catch {
      setError('이름 변경에 실패했습니다')
    }
    setEditingTitle(false)
  }, [activeSessionId])

  // Send message
  const sendMessage = useCallback(async () => {
    if (!input.trim() || !activeSessionId || streaming) return

    const userMsg: ChatMessage = { role: 'user', content: input.trim() }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setStreaming(true)
    setError(null)

    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
    setMessages((prev) => [...prev, assistantMsg])

    try {
      const controller = new AbortController()
      abortRef.current = controller

      const res = await fetch(`/api/chat/sessions/${activeSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMsg.content }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'Unknown error' }))
        throw new Error(errData.detail || `HTTP ${res.status}`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const event = JSON.parse(jsonStr)

            if (event.compacted) {
              // Auto-compact 발생 — 메시지 목록 새로고침
              try {
                const refreshRes = await fetch(`/api/chat/sessions/${activeSessionId}/messages`)
                if (refreshRes.ok) {
                  const refreshed: ChatMessage[] = await refreshRes.json()
                  setMessages([...refreshed, { role: 'assistant', content: '' }])
                }
              } catch { /* ignore */ }
              continue
            }

            if (event.error) {
              setError(event.error)
              setStreaming(false)
              return
            }

            if (event.done) {
              setStreaming(false)
              if (event.insight) {
                onInsightAction?.()  // refresh pending count + insights
              }
              return
            }

            if (event.text) {
              setMessages((prev) => {
                const updated = [...prev]
                const lastIdx = updated.length - 1
                if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
                  updated[lastIdx] = { ...updated[lastIdx], content: updated[lastIdx].content + event.text }
                }
                return updated
              })
            }
          } catch {
            // skip unparseable lines
          }
        }
      }

      setStreaming(false)
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setStreaming(false)
        return
      }
      setError(e instanceof Error ? e.message : '메시지 전송에 실패했습니다')
      setStreaming(false)
      // Remove the empty assistant message on error
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && !last.content) return prev.slice(0, -1)
        return prev
      })
    } finally {
      abortRef.current = null
    }
  }, [input, activeSessionId, streaming])

  // Handle textarea auto-resize
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 96) + 'px' // max ~4 lines
  }, [])

  // Handle keyboard
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  // Handle timestamp click in chat messages
  const handleTimestampClick = useCallback((seconds: number) => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    const ts = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    scrollToSegment(ts)
  }, [scrollToSegment])

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-[1px] z-50 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={`
          fixed lg:static inset-y-0 right-0 z-50
          w-full sm:w-[380px] bg-white border-l border-slate-200/80
          flex flex-col overflow-hidden
          transition-all duration-200 ease-out
          ${open ? 'translate-x-0' : 'translate-x-full'}
          ${open ? 'lg:w-[380px] lg:min-w-[380px]' : 'lg:w-0 lg:min-w-0 lg:border-l-0'}
        `}
      >
        {/* Header */}
        <div className="shrink-0 h-12 border-b border-slate-200/80 px-4 flex items-center justify-between bg-white">
          <h3 className="text-[14px] font-semibold text-slate-800">강의 채팅</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <XIcon />
          </button>
        </div>

        {/* Session bar */}
        <div className="shrink-0 px-3 py-2 border-b border-slate-100 flex items-center gap-2 bg-slate-50/60">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => renameSession(titleDraft)}
              onKeyDown={(e) => { if (e.key === 'Enter') renameSession(titleDraft); if (e.key === 'Escape') setEditingTitle(false) }}
              className="flex-1 min-w-0 text-[12px] bg-white border border-teal-300 rounded-lg px-2.5 py-1.5 outline-none ring-1 ring-teal-100"
              autoFocus
            />
          ) : (
            <>
              <select
                value={activeSessionId ?? ''}
                onChange={(e) => { const v = e.target.value; setActiveSessionId(v || null) }}
                className="flex-1 min-w-0 text-[12px] bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition truncate"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title || `대화 #${s.id}`}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  const current = sessions.find((s) => s.id === activeSessionId)
                  setTitleDraft(current?.title || '')
                  setEditingTitle(true)
                }}
                className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                title="이름 변경"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                </svg>
              </button>
            </>
          )}
          <button
            onClick={createNewSession}
            className="shrink-0 p-1.5 rounded-lg text-teal-600 hover:bg-teal-50 transition-colors"
            title="새 대화"
          >
            <PlusIcon />
          </button>
          {activeSessionId && sessions.length > 1 && (
            <button
              onClick={() => activeSessionId && deleteSession(activeSessionId)}
              className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              title="대화 삭제"
            >
              <TrashIcon />
            </button>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="shrink-0 px-4 py-2 bg-red-50 border-b border-red-100 text-[12px] text-red-600 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 ml-2">
              <XIcon />
            </button>
          </div>
        )}

        {/* Messages area */}
        <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto px-3 py-4 space-y-3 scrollbar-thin">
          {messages.length === 0 && !streaming && (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 text-[13px] gap-2 px-6 text-center">
              <ChatBubbleIcon />
              <p>강의에 대해 질문해 보세요</p>
              <p className="text-[11px] text-slate-300">타임스탬프를 클릭하면 해당 위치로 이동합니다</p>
            </div>
          )}

          {messages.map((msg, i) => {
            // Compaction summary card
            if (msg.is_compaction || msg.role === 'system') {
              return (
                <div key={i} className="flex justify-center">
                  <div className="max-w-[90%] rounded-xl border border-violet-200 bg-violet-50/50 px-3.5 py-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-violet-600 mb-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
                      </svg>
                      이전 대화가 압축되었습니다
                    </div>
                    <div className="text-[12px] text-violet-700/70 leading-relaxed chat-markdown">
                      <ChatMarkdown content={msg.content.replace(/^\[이전 대화 요약\][\s\S]*?답변하세요\.\s*/m, '')} onTimestampClick={handleTimestampClick} />
                    </div>
                  </div>
                </div>
              )
            }

            return (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
                    msg.role === 'user'
                      ? 'bg-teal-600 text-white rounded-br-md'
                      : 'bg-slate-100 text-slate-800 rounded-bl-md'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <p className="text-[13px] leading-[1.7] whitespace-pre-wrap">{msg.content}</p>
                  ) : msg.content ? (
                    <div className="chat-markdown">
                      <ChatMarkdown content={msg.content} onTimestampClick={handleTimestampClick} />
                    </div>
                  ) : streaming && i === messages.length - 1 ? (
                    <TypingIndicator />
                  ) : null}
                </div>
              </div>
            )
          })}

          {/* Streaming typing indicator when last message already has content */}
          {streaming && messages.length > 0 && messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1].content && (
            <div className="flex justify-start">
              <TypingIndicator />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="shrink-0 border-t border-slate-200/80 p-3 bg-white">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={streaming ? '응답 생성 중...' : '메시지를 입력하세요...'}
              disabled={streaming}
              rows={1}
              className="flex-1 min-w-0 resize-none text-[13px] bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 outline-none focus:bg-white focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition placeholder:text-slate-400 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ maxHeight: '96px' }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || streaming}
              className="shrink-0 p-2.5 rounded-xl bg-teal-600 text-white hover:bg-teal-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Context Menu ──────────────────────────────────────

type ContextMenuState = {
  x: number
  y: number
  seg: TranscriptSegment
  segIndex: number
} | null

function ContextMenu({
  state,
  onClose,
  onAddBookmark,
  onPlayAudio,
}: {
  state: ContextMenuState
  onClose: () => void
  onAddBookmark: () => void
  onPlayAudio: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!state) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [state, onClose])

  if (!state) return null

  // Adjust position to stay within viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(state.x, window.innerWidth - 180),
    top: Math.min(state.y, window.innerHeight - 100),
    zIndex: 9999,
  }

  return (
    <div ref={menuRef} style={style} className="bg-white rounded-lg shadow-lg border border-slate-200 py-1 min-w-[160px]">
      <button
        onClick={() => { onAddBookmark(); onClose() }}
        className="w-full px-3 py-1.5 text-[13px] text-left text-slate-700 hover:bg-slate-50 cursor-pointer flex items-center gap-2"
      >
        <BookmarkIcon className="w-3.5 h-3.5 text-teal-500" />
        북마크 추가
      </button>
      <button
        onClick={() => { onPlayAudio(); onClose() }}
        className="w-full px-3 py-1.5 text-[13px] text-left text-slate-700 hover:bg-slate-50 cursor-pointer flex items-center gap-2"
      >
        <svg className="w-3.5 h-3.5 text-amber-500" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        오디오 재생
      </button>
    </div>
  )
}

// ─── Bookmark Add Dialog ──────────────────────────────

function BookmarkAddDialog({
  seg,
  segIndex,
  lectureId,
  position,
  onClose,
  onCreated,
}: {
  seg: TranscriptSegment
  segIndex: number
  lectureId: string
  position: { x: number; y: number }
  onClose: () => void
  onCreated: () => void
}) {
  const [note, setNote] = useState('')
  const [color, setColor] = useState(BOOKMARK_COLORS[0].value)
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onClose()
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [onClose])

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lecture_id: lectureId,
          time: seg.time,
          segment_idx: segIndex,
          note: note.trim(),
          color,
        }),
      })
      if (!res.ok) throw new Error('Failed to create bookmark')
      onCreated()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(position.x, window.innerWidth - 260),
    top: Math.min(position.y, window.innerHeight - 160),
    zIndex: 9999,
  }

  return (
    <div ref={dialogRef} style={style} className="bg-white rounded-lg shadow-lg border border-slate-200 p-3 w-[240px]">
      <div className="flex items-center gap-2 mb-2">
        <BookmarkIcon className="w-3.5 h-3.5 text-teal-500" />
        <span className="text-[12px] font-semibold text-slate-700">북마크 추가</span>
        <span className="text-[11px] font-mono text-amber-600 ml-auto">{seg.time}</span>
      </div>
      <input
        ref={inputRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave()
          if (e.key === 'Escape') onClose()
        }}
        placeholder="메모 (선택사항)..."
        className="w-full text-[12px] border border-slate-200 rounded-md px-2.5 py-1.5 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition placeholder:text-slate-400 mb-2"
      />
      <div className="flex items-center gap-1.5 mb-3">
        {BOOKMARK_COLORS.map((c) => (
          <button
            key={c.value}
            onClick={() => setColor(c.value)}
            className={`w-5 h-5 rounded-full transition-all ${color === c.value ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : 'hover:scale-110'}`}
            style={{ backgroundColor: c.value }}
            title={c.name}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-2.5 py-1 text-[11px] text-slate-500 hover:text-slate-700 transition-colors"
        >
          취소
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1 text-[11px] font-medium bg-teal-600 text-white rounded-md hover:bg-teal-700 transition-colors disabled:opacity-50"
        >
          {saving ? '저장 중...' : '저장'}
        </button>
      </div>
    </div>
  )
}

// ─── Bookmark Popover (shown when clicking a bookmark dot) ──

function BookmarkPopover({
  bookmark,
  position,
  onClose,
  onUpdate,
  onDelete,
}: {
  bookmark: Bookmark
  position: { x: number; y: number }
  onClose: () => void
  onUpdate: (id: string, note: string, color: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(bookmark.note)
  const [color, setColor] = useState(bookmark.color || BOOKMARK_COLORS[0].value)
  const popRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [onClose])

  const handleSave = () => {
    onUpdate(bookmark.id, note.trim(), color)
    setEditing(false)
  }

  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(position.x, window.innerWidth - 240),
    top: Math.min(position.y, window.innerHeight - 180),
    zIndex: 9999,
  }

  return (
    <div ref={popRef} style={style} className="bg-white rounded-lg shadow-lg border border-slate-200 p-3 w-[220px]">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: bookmark.color || '#0d9488' }} />
        <span className="text-[11px] font-mono text-amber-600">{bookmark.time}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            title="수정"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
            </svg>
          </button>
          <button
            onClick={() => { onDelete(bookmark.id); onClose() }}
            className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            title="삭제"
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {editing ? (
        <>
          <input
            ref={inputRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') { setEditing(false); setNote(bookmark.note); setColor(bookmark.color || BOOKMARK_COLORS[0].value) }
            }}
            placeholder="메모..."
            className="w-full text-[12px] border border-slate-200 rounded-md px-2.5 py-1.5 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition placeholder:text-slate-400 mb-2"
          />
          <div className="flex items-center gap-1.5 mb-2">
            {BOOKMARK_COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => setColor(c.value)}
                className={`w-4 h-4 rounded-full transition-all ${color === c.value ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : 'hover:scale-110'}`}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setEditing(false); setNote(bookmark.note) }} className="px-2 py-0.5 text-[11px] text-slate-500">취소</button>
            <button onClick={handleSave} className="px-2.5 py-0.5 text-[11px] font-medium bg-teal-600 text-white rounded-md hover:bg-teal-700 transition-colors">저장</button>
          </div>
        </>
      ) : (
        <p className="text-[12px] text-slate-600 leading-relaxed">
          {bookmark.note || <span className="text-slate-400 italic">메모 없음</span>}
        </p>
      )}
    </div>
  )
}

// ─── Bookmarks Panel (sidebar section) ────────────────

function BookmarksPanel({
  bookmarks,
  onScrollTo,
  onDelete,
}: {
  bookmarks: Bookmark[]
  onScrollTo: (time: string) => void
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)

  if (bookmarks.length === 0) return null

  const sorted = [...bookmarks].sort((a, b) => {
    const aS = parseTimestamp(a.time)
    const bS = parseTimestamp(b.time)
    return aS - bS
  })

  return (
    <div className="border-t border-slate-100">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50/60 transition-colors"
      >
        <ChevronDownIcon
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-0' : '-rotate-90'}`}
        />
        <BookmarkIcon className="w-3.5 h-3.5 text-teal-500" />
        <span className="text-[12px] font-semibold text-slate-600">북마크</span>
        <span className="text-[11px] text-slate-400 ml-auto">{bookmarks.length}</span>
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-px">
          {sorted.map((bm) => (
            <div
              key={bm.id}
              className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer transition-colors"
              onClick={() => onScrollTo(bm.time)}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: bm.color || '#0d9488' }}
              />
              <span className="text-[11px] font-mono text-amber-600 shrink-0">{bm.time}</span>
              <span className="text-[11px] text-slate-500 truncate min-w-0 flex-1">
                {bm.note || '메모 없음'}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(bm.id) }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-300 hover:text-red-500 transition-all shrink-0"
                title="삭제"
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Batch Review Panel (modal) ─────────────────────────

type PendingInsight = QaInsight & { lecture_id?: string; created_at?: string }

function BatchReviewPanel({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [pendingItems, setPendingItems] = useState<PendingInsight[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<{ question: string; answer_summary: string; tags: string }>({ question: '', answer_summary: '', tags: '' })
  const [edits, setEdits] = useState<Map<string, { question: string; answer_summary: string; tags: string[] }>>(new Map())
  const [loading, setLoading] = useState(false)

  // Fetch pending items
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetch('/api/insights/pending')
      .then((r) => r.ok ? r.json() : [])
      .then((data: PendingInsight[]) => {
        if (!cancelled) {
          setPendingItems(data)
          setSelected(new Set())
          setEditingId(null)
          setEdits(new Map())
        }
      })
      .catch(() => { if (!cancelled) setPendingItems([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const sendBatch = useCallback(async (payload: {
    accept?: string[]
    dismiss?: string[]
    merges?: { id: string; merge_target_id: string }[]
    edits?: { id: string; question: string; answer_summary: string; tags: string[] }[]
  }) => {
    try {
      await fetch('/api/insights/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch { /* ignore */ }
  }, [])

  const getDisplayItem = useCallback((item: PendingInsight) => {
    const edited = edits.get(item.id)
    if (edited) return { ...item, question: edited.question, answer_summary: edited.answer_summary, tags: edited.tags }
    return item
  }, [edits])

  const removeItems = useCallback((ids: string[]) => {
    const idSet = new Set(ids)
    setPendingItems((prev) => prev.filter((it) => !idSet.has(it.id)))
    setSelected((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }, [])

  // Individual actions
  const handleAccept = useCallback(async (item: PendingInsight) => {
    const display = getDisplayItem(item)
    const editPayload = edits.has(item.id) ? [{ id: item.id, question: display.question, answer_summary: display.answer_summary, tags: display.tags }] : []
    const mergePayload = item.action === 'merge' && item.merge_target_id ? [{ id: item.id, merge_target_id: item.merge_target_id }] : []
    await sendBatch({
      accept: [item.id],
      merges: mergePayload,
      edits: editPayload,
    })
    removeItems([item.id])
  }, [getDisplayItem, edits, sendBatch, removeItems])

  const handleDismiss = useCallback(async (item: PendingInsight) => {
    await sendBatch({ dismiss: [item.id] })
    removeItems([item.id])
  }, [sendBatch, removeItems])

  const handleAcceptAll = useCallback(async () => {
    const ids = pendingItems.map((it) => it.id)
    const editPayloads = Array.from(edits.entries()).map(([id, e]) => ({ id, question: e.question, answer_summary: e.answer_summary, tags: e.tags }))
    const mergePayloads = pendingItems
      .filter((it) => it.action === 'merge' && it.merge_target_id)
      .map((it) => ({ id: it.id, merge_target_id: it.merge_target_id! }))
    await sendBatch({ accept: ids, merges: mergePayloads, edits: editPayloads })
    setPendingItems([])
    setSelected(new Set())
    setEdits(new Map())
    onDone()
  }, [pendingItems, edits, sendBatch, onDone])

  const handleBatchAccept = useCallback(async () => {
    const ids = Array.from(selected)
    const items = pendingItems.filter((it) => selected.has(it.id))
    const editPayloads = ids.filter((id) => edits.has(id)).map((id) => {
      const e = edits.get(id)!
      return { id, question: e.question, answer_summary: e.answer_summary, tags: e.tags }
    })
    const mergePayloads = items
      .filter((it) => it.action === 'merge' && it.merge_target_id)
      .map((it) => ({ id: it.id, merge_target_id: it.merge_target_id! }))
    await sendBatch({ accept: ids, merges: mergePayloads, edits: editPayloads })
    removeItems(ids)
  }, [selected, pendingItems, edits, sendBatch, removeItems])

  const handleBatchDismiss = useCallback(async () => {
    const ids = Array.from(selected)
    await sendBatch({ dismiss: ids })
    removeItems(ids)
  }, [selected, sendBatch, removeItems])

  // Edit mode
  const startEdit = useCallback((item: PendingInsight) => {
    const display = getDisplayItem(item)
    setEditingId(item.id)
    setEditDraft({ question: display.question, answer_summary: display.answer_summary, tags: display.tags.join(', ') })
  }, [getDisplayItem])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
  }, [])

  const saveEdit = useCallback(() => {
    if (!editingId) return
    const tags = editDraft.tags.split(',').map((t) => t.trim()).filter(Boolean)
    setEdits((prev) => {
      const next = new Map(prev)
      next.set(editingId, { question: editDraft.question, answer_summary: editDraft.answer_summary, tags })
      return next
    })
    setEditingId(null)
  }, [editingId, editDraft])

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Close handler: refresh parent data
  const handleClose = useCallback(() => {
    onDone()
    onClose()
  }, [onDone, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm flex items-start justify-center" onClick={handleClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full mx-auto my-8 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
          <h2 className="text-[15px] font-semibold text-slate-800">
            학습 노트 리뷰 ({pendingItems.length}건)
          </h2>
          <div className="flex items-center gap-2">
            {pendingItems.length > 0 && (
              <button
                onClick={handleAcceptAll}
                className="text-[12px] px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors shadow-sm font-medium"
              >
                전체 수락
              </button>
            )}
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            >
              <XIcon />
            </button>
          </div>
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2.5 scrollbar-thin">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-400 text-[13px]">
              <div className="w-4 h-4 border-2 border-slate-300 border-t-transparent rounded-full animate-spin mr-2" />
              불러오는 중...
            </div>
          ) : pendingItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 text-[13px] gap-2">
              <LightBulbIcon className="w-6 h-6 text-slate-300" />
              <p>대기 중인 학습 노트가 없습니다</p>
            </div>
          ) : (
            pendingItems.map((item) => {
              const display = getDisplayItem(item)
              const isEditing = editingId === item.id
              const isSelected = selected.has(item.id)

              return (
                <div
                  key={item.id}
                  className={`rounded-xl border px-4 py-3 transition-colors ${
                    isSelected ? 'border-teal-300 bg-teal-50/30' : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(item.id)}
                      className="mt-1 w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 accent-teal-600 cursor-pointer shrink-0"
                    />

                    <div className="flex-1 min-w-0">
                      {/* Badge + question */}
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        {item.action === 'merge' ? (
                          <span className="bg-violet-100 text-violet-700 text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0">
                            merge &rarr; 기존노트
                          </span>
                        ) : (
                          <span className="bg-teal-100 text-teal-700 text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0">
                            new
                          </span>
                        )}
                      </div>

                      {isEditing ? (
                        /* Edit mode */
                        <div className="space-y-2">
                          <input
                            value={editDraft.question}
                            onChange={(e) => setEditDraft((d) => ({ ...d, question: e.target.value }))}
                            placeholder="질문"
                            className="w-full text-[13px] border border-slate-200 rounded-lg px-3 py-2 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition"
                          />
                          <textarea
                            value={editDraft.answer_summary}
                            onChange={(e) => setEditDraft((d) => ({ ...d, answer_summary: e.target.value }))}
                            placeholder="답변 요약"
                            rows={3}
                            className="w-full text-[13px] border border-slate-200 rounded-lg px-3 py-2 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition resize-none"
                          />
                          <input
                            value={editDraft.tags}
                            onChange={(e) => setEditDraft((d) => ({ ...d, tags: e.target.value }))}
                            placeholder="태그 (쉼표로 구분)"
                            className="w-full text-[13px] border border-slate-200 rounded-lg px-3 py-2 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition"
                          />
                          <div className="flex justify-end gap-2 pt-1">
                            <button
                              onClick={cancelEdit}
                              className="text-[12px] px-3 py-1.5 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors"
                            >
                              취소
                            </button>
                            <button
                              onClick={saveEdit}
                              className="text-[12px] px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors shadow-sm font-medium"
                            >
                              저장
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Display mode */
                        <>
                          <p className="text-[13px] font-medium text-slate-800 leading-snug">
                            Q: {display.question}
                          </p>
                          <p className="text-[12px] text-slate-600 mt-1 leading-relaxed">
                            A: {display.answer_summary}
                          </p>
                          {display.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {display.tags.map((tag) => (
                                <span key={tag} className="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded-full">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                          {edits.has(item.id) && (
                            <span className="inline-block mt-1.5 text-[10px] text-amber-600 font-medium">수정됨</span>
                          )}
                          {/* Action buttons */}
                          <div className="flex items-center gap-2 mt-2.5">
                            <button
                              onClick={() => startEdit(item)}
                              className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                            >
                              수정
                            </button>
                            <button
                              onClick={() => handleAccept(item)}
                              className="text-[11px] px-2.5 py-1 rounded-md bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 transition-colors"
                            >
                              수락
                            </button>
                            <button
                              onClick={() => handleDismiss(item)}
                              className="text-[11px] px-2.5 py-1 rounded-md bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-colors"
                            >
                              거절
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-200 px-5 py-3 flex items-center justify-end gap-2 bg-slate-50/60 rounded-b-2xl">
          <button
            onClick={handleBatchAccept}
            disabled={selected.size === 0}
            className="text-[12px] px-4 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors shadow-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            선택 항목 일괄 수락
          </button>
          <button
            onClick={handleBatchDismiss}
            disabled={selected.size === 0}
            className="text-[12px] px-4 py-2 rounded-lg bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            선택 항목 일괄 거절
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Insights Panel (sidebar section) ──────────────────

function InsightsPanel({
  insights,
  onDelete,
  pendingCount,
  onOpenBatchReview,
}: {
  insights: QaInsight[]
  onDelete: (id: string) => void
  pendingCount: number
  onOpenBatchReview: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="border-t border-slate-100">
      <div className="flex items-center">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50/60 transition-colors"
        >
          <ChevronDownIcon
            className={`shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-0' : '-rotate-90'}`}
          />
          <LightBulbIcon className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-[12px] font-semibold text-slate-600">학습 노트</span>
          <span className="text-[11px] text-slate-400 ml-auto">{insights.length}</span>
        </button>
        {pendingCount > 0 && (
          <button
            onClick={onOpenBatchReview}
            className="shrink-0 mr-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-50 hover:bg-amber-100 text-amber-700 text-[11px] font-medium transition-colors"
            title="대기 중인 학습 노트 리뷰"
          >
            리뷰
            <span className="bg-amber-500 text-white text-[10px] rounded-full w-4.5 h-4.5 min-w-[18px] px-1 inline-flex items-center justify-center font-semibold leading-none">
              {pendingCount}
            </span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-2 pb-2 space-y-1">
          {insights.length === 0 ? (
            <p className="text-[11px] text-slate-400 px-2 py-3 text-center leading-relaxed">
              채팅에서 질문하면 학습 노트가<br />자동으로 추가됩니다
            </p>
          ) : (
            insights.map((ins) => {
              const isExpanded = expandedId === ins.id
              return (
                <div
                  key={ins.id}
                  className="group rounded-lg border border-slate-100 bg-slate-50/40 hover:bg-slate-50 px-2.5 py-2 cursor-pointer transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : ins.id)}
                >
                  <div className="flex items-start gap-1.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-medium text-slate-700 truncate">
                        Q: {ins.question}
                      </p>
                      <p className={`text-[11px] text-slate-500 mt-0.5 ${isExpanded ? '' : 'line-clamp-2'}`}>
                        A: {ins.answer_summary}
                      </p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(ins.id) }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-300 hover:text-red-500 transition-all shrink-0 mt-0.5"
                      title="삭제"
                    >
                      <XIcon />
                    </button>
                  </div>
                  {ins.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {ins.tags.map((tag) => (
                        <span key={tag} className="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded-full">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ─── Lecture Domain Badge (강의 페이지 헤더) ─────────────

interface LectureDomainBadgeProps {
  lecture: Lecture | null
  domains: DomainInfo[]
  onConfirm: (domainId: string) => Promise<void>
}

function LectureDomainBadge({ lecture, domains, onConfirm }: LectureDomainBadgeProps) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!lecture) return null

  const labelOf = (id: string | null | undefined) => {
    if (!id) return '미분류'
    return domains.find((d) => d.id === id)?.name || id
  }

  const isPending = lecture.domain_status === 'pending'
  const isAwaiting = lecture.latest_job_status === 'awaiting_domain'
  const isMigrated = lecture.domain_source === 'migration'

  const handleConfirm = async (domainId: string) => {
    if (domainId === lecture.domain_id && !isPending && !isAwaiting) {
      setEditing(false)
      return
    }
    if (
      lecture.domain_id &&
      domainId !== lecture.domain_id &&
      !confirm(
        '도메인을 바꾸면 코렉션과 요약이 다시 생성됩니다. 진행하시겠습니까?',
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await onConfirm(domainId)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  if (isMigrated) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium bg-slate-50 text-slate-500 border-slate-200"
        title="마이그레이션된 강의는 도메인 변경(재코렉션)을 지원하지 않습니다"
      >
        <span>🏷</span>
        <span>{labelOf(lecture.domain_id)}</span>
        <span className="text-slate-300 text-[10px]">migrated</span>
      </span>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setEditing((v) => !v)}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium transition ${
          isPending
            ? 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-300'
            : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-300'
        }`}
        title="도메인 변경"
      >
        <span>🏷</span>
        <span>{labelOf(lecture.domain_id)}</span>
        <span className="text-slate-400">▾</span>
      </button>
      {editing && (
        <div className="absolute z-30 mt-2 left-0 min-w-[260px]">
          <DomainPicker
            domains={domains}
            recommendedId={lecture.detected_domain_id}
            recommendedConfidence={lecture.detected_confidence}
            topCandidates={lecture.detected_top_candidates}
            currentDomainId={lecture.domain_id}
            busy={busy}
            onConfirm={handleConfirm}
          />
        </div>
      )}
    </div>
  )
}

// ─── Lecture Groups (sidebar section) ──────────────────

type LectureGroupView = ReturnType<typeof groupLecturesByDomain>[number]

interface LectureGroupsProps {
  groups: LectureGroupView[]
  entries: TranscriptEntry[]
  search: string
  selectedId: string
  collapsedGroups: Set<string>
  onToggleGroup: (key: string) => void
  onSelect: (id: string) => void
}

// TODO(design 3/3): HybridShell 의 lecture tree 가 대체. 다음 단계에서 제거.
export function LectureGroups({
  groups,
  entries,
  search,
  selectedId,
  collapsedGroups,
  onToggleGroup,
  onSelect,
}: LectureGroupsProps) {
  const entryById = useMemo(() => {
    const m = new Map<string, TranscriptEntry>()
    for (const e of entries) m.set(e.id, e)
    return m
  }, [entries])

  const q = search.trim().toLowerCase()

  const filteredGroups = useMemo(() => {
    if (!q) return groups
    return groups
      .map((g) => ({
        ...g,
        lectures: g.lectures.filter((l) => {
          const label = (entryById.get(l.id)?.label ?? l.original_name).toLowerCase()
          return label.includes(q) || l.original_name.toLowerCase().includes(q)
        }),
      }))
      .filter((g) => g.lectures.length > 0)
  }, [groups, q, entryById])

  if (filteredGroups.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-slate-400">
        {q ? `"${search}" 결과 없음` : '아직 등록된 강의가 없습니다'}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {filteredGroups.map((group) => {
        const isCollapsed = collapsedGroups.has(group.key)
        return (
          <div key={group.key}>
            <button
              type="button"
              onClick={() => onToggleGroup(group.key)}
              className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] font-semibold uppercase tracking-wider transition ${
                group.isPending
                  ? 'text-amber-700 hover:bg-amber-50'
                  : group.isGeneric
                  ? 'text-slate-500 hover:bg-slate-50'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="text-slate-400">{isCollapsed ? '▸' : '▾'}</span>
                <span>{group.label}</span>
                <span className="text-slate-400 font-normal">({group.lectures.length})</span>
                {group.hasAwaitingConfirm && (
                  <span title="컨펌 대기 중인 강의가 있습니다" className="text-amber-500">⚠</span>
                )}
              </span>
            </button>
            {!isCollapsed && (
              <div className="mt-1 space-y-px">
                {group.lectures.map((lec) => {
                  const entry = entryById.get(lec.id)
                  const label = entry?.label ?? lec.original_name.replace(/\.mp4$/i, '')
                  const isActive = lec.id === selectedId
                  const count = entry?.corrected?.segmentCount ?? entry?.raw?.segmentCount ?? 0
                  const hasContent = !!entry
                  const isAwaiting = lec.latest_job_status === 'awaiting_domain'
                  const isProcessing =
                    lec.latest_job_status === 'queued' ||
                    lec.latest_job_status === 'processing'
                  return (
                    <button
                      key={lec.id}
                      onClick={() => onSelect(lec.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-100 ${
                        isActive
                          ? 'bg-teal-600 text-white font-medium shadow-sm shadow-teal-600/20'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                      }`}
                      title={label}
                    >
                      <div className="truncate leading-snug">{label}</div>
                      <div
                        className={`flex items-center gap-2 text-[11px] mt-0.5 ${
                          isActive ? 'text-teal-200' : 'text-slate-400'
                        }`}
                      >
                        {hasContent && count > 0 && <span>{count}개 세그먼트</span>}
                        {isAwaiting && (
                          <span className={isActive ? 'text-amber-200' : 'text-amber-600'}>
                            컨펌 대기
                          </span>
                        )}
                        {isProcessing && (
                          <span className={isActive ? 'text-teal-200' : 'text-slate-500'}>
                            {lec.latest_job_type === 'stt' ? 'STT 진행 중'
                              : lec.latest_job_type === 'correct' ? '코렉션 중'
                              : lec.latest_job_type === 'summary' ? '요약 생성 중'
                              : '처리 중'}
                          </span>
                        )}
                        {!hasContent && !isAwaiting && !isProcessing && (
                          <span className={isActive ? 'text-teal-200' : 'text-slate-400'}>
                            (콘텐츠 미빌드)
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Upload Panel (sidebar section) ─────────────────────

type JobStatus = 'queued' | 'processing' | 'awaiting_domain' | 'completed' | 'failed' | 'canceled'
type JobType = 'full' | 'stt' | 'correct' | 'summary' | 'regen'
type Job = {
  id: string
  filename: string
  original_name: string
  file_size: number | null
  lecture_id: string | null
  status: JobStatus
  stage: string | null
  job_type: JobType
  parent_job_id: string | null
  progress_message: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  processing_ms: number | null
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['completed', 'failed', 'canceled'])

function formatSize(bytes: number | null): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(0)}MB`
  return `${(mb / 1024).toFixed(1)}GB`
}

interface UploadPanelProps {
  lectures: Lecture[]
  domains: DomainInfo[]
  onConfirmDomain: (lectureId: string, domainId: string) => Promise<void>
  onJobChanged: () => void
}

function UploadPanel({
  lectures,
  domains,
  onConfirmDomain,
  onJobChanged,
}: UploadPanelProps) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [expanded, setExpanded] = useState(true)
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [completedSinceLoad, setCompletedSinceLoad] = useState(0)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const knownCompletedRef = useRef<Set<string>>(new Set())
  const initialLoadRef = useRef(true)

  const lectureById = useMemo(() => {
    const m = new Map<string, Lecture>()
    for (const l of lectures) m.set(l.id, l)
    return m
  }, [lectures])

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs')
      if (!res.ok) return
      const data: Job[] = await res.json()
      setJobs(data)
      // 초기 로드의 completed는 새 완료로 카운트하지 않음.
      // regen 은 업로드와 무관하므로 "새 강의 완료" 배너 카운트에서도 제외.
      const nextCompletedSet = new Set(knownCompletedRef.current)
      let newCompletions = 0
      for (const j of data) {
        if (j.status === 'completed' && j.job_type !== 'regen' && !nextCompletedSet.has(j.id)) {
          nextCompletedSet.add(j.id)
          if (!initialLoadRef.current) newCompletions += 1
        }
      }
      knownCompletedRef.current = nextCompletedSet
      if (newCompletions > 0) {
        setCompletedSinceLoad((n) => n + newCompletions)
      }
      initialLoadRef.current = false
    } catch {
      /* 네트워크 오류 무시 — 다음 폴링에서 재시도 */
    }
  }, [])

  // 최초 로드 + 활성 job 있을 때 5초 폴링
  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  useEffect(() => {
    const hasActive = jobs.some((j) => !TERMINAL_STATUSES.has(j.status))
    if (!hasActive) return
    const id = setInterval(loadJobs, 5000)
    return () => clearInterval(id)
  }, [jobs, loadJobs])

  const handleConfirm = useCallback(
    async (lectureId: string, domainId: string) => {
      setConfirmingId(lectureId)
      try {
        await onConfirmDomain(lectureId, domainId)
        await loadJobs()
        onJobChanged()
      } finally {
        setConfirmingId(null)
      }
    },
    [onConfirmDomain, loadJobs, onJobChanged],
  )

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setUploadError(null)
    const list = Array.from(files).filter((f) => {
      const name = f.name.toLowerCase()
      return name.endsWith('.mp4') || name.endsWith('.mp3')
    })
    if (list.length === 0) {
      setUploadError('MP4 또는 MP3 파일만 업로드할 수 있습니다')
      return
    }
    setUploading((n) => n + list.length)
    for (const file of list) {
      try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch('/api/jobs/upload', { method: 'POST', body: form })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          setUploadError(err.detail || `${file.name}: 업로드 실패`)
        }
      } catch (e) {
        setUploadError(`${file.name}: 네트워크 오류`)
      } finally {
        setUploading((n) => Math.max(0, n - 1))
      }
    }
    await loadJobs()
    onJobChanged()
  }, [loadJobs, onJobChanged])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }, [handleFiles])

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
      await loadJobs()
    } catch {}
  }, [loadJobs])

  // 업로드 패널은 업로드 파이프라인(full/stt/correct/summary)만 다룸.
  // 'regen' 은 강의+모델 단위의 ShowMe/Notes 재생성이라 별개 — 카운트·list 모두 제외.
  const uploadJobs = jobs.filter((j) => j.job_type !== 'regen')
  const activeCount = uploadJobs.filter((j) => !TERMINAL_STATUSES.has(j.status)).length
  // 완료/취소된 작업은 list 에서 숨김 (완료는 배너로 안내, 실패는 표시 유지)
  const displayJobs = uploadJobs
    .filter((j) => j.status !== 'completed' && j.status !== 'canceled')
    .slice(0, 8)

  return (
    <div className="border-t border-slate-100">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50/60 transition-colors"
      >
        <ChevronDownIcon
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-0' : '-rotate-90'}`}
        />
        <span className="text-[12px] font-semibold text-slate-600">MP4 / MP3 업로드</span>
        {activeCount > 0 && (
          <span className="ml-auto bg-teal-500 text-white text-[10px] rounded-full min-w-[18px] px-1.5 py-0.5 inline-flex items-center justify-center font-semibold leading-none">
            {activeCount}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-2 pb-3 space-y-2">
          {/* Drop zone */}
          <div
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg px-3 py-4 text-center cursor-pointer transition-colors ${
              dragOver
                ? 'border-teal-400 bg-teal-50'
                : 'border-slate-200 hover:border-teal-300 hover:bg-slate-50'
            }`}
          >
            <p className="text-[11px] text-slate-500 leading-relaxed">
              MP4 또는 MP3 파일을<br />드래그하거나 클릭
              <br />
              <span className="text-[10px] text-slate-400">MP3는 음성 추출 단계 자동 스킵</span>
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,.mp4,audio/mpeg,.mp3"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          {uploading > 0 && (
            <p className="text-[11px] text-teal-600 text-center">
              업로드 중... ({uploading}개 남음)
            </p>
          )}
          {uploadError && (
            <p className="text-[11px] text-red-500 break-words">{uploadError}</p>
          )}

          {completedSinceLoad > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-2.5 py-2 flex items-start gap-2">
              <p className="text-[11px] text-amber-800 leading-snug flex-1">
                새 강의 {completedSinceLoad}개 완료. 목록에 반영하려면 새로고침하세요.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="shrink-0 text-[11px] font-semibold text-amber-700 hover:text-amber-900 underline"
              >
                새로고침
              </button>
            </div>
          )}

          {/* Job list */}
          {displayJobs.length > 0 && (
            <div className="space-y-1">
              {displayJobs.map((job) => {
                const isFailed = job.status === 'failed'
                const isDone = job.status === 'completed'
                const isAwaiting = job.status === 'awaiting_domain'
                const lec = job.lecture_id ? lectureById.get(job.lecture_id) : undefined
                const stageLabel =
                  job.job_type === 'stt'     ? 'STT'
                  : job.job_type === 'correct' ? '코렉션'
                  : job.job_type === 'summary' ? '요약'
                  : ''
                return (
                  <div
                    key={job.id}
                    className="rounded-md border border-slate-100 bg-slate-50/40 px-2.5 py-2"
                  >
                    <div className="flex items-start gap-1.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-medium text-slate-700 truncate" title={job.original_name}>
                          {job.original_name}
                          {stageLabel && (
                            <span className="ml-1 text-slate-400">· {stageLabel}</span>
                          )}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${
                              isDone ? 'bg-teal-500'
                              : isFailed ? 'bg-red-500'
                              : isAwaiting ? 'bg-amber-400'
                              : job.status === 'processing' ? 'bg-amber-500 animate-pulse'
                              : job.status === 'canceled' ? 'bg-slate-300'
                              : 'bg-slate-400'
                            }`}
                          />
                          <span className="text-[10px] text-slate-500">
                            {job.status === 'queued' && '대기 중'}
                            {job.status === 'processing' && (job.progress_message || '처리 중')}
                            {isAwaiting && '도메인 컨펌 대기'}
                            {job.status === 'completed' && `완료 · ${formatSize(job.file_size)}`}
                            {job.status === 'failed' && '실패'}
                            {job.status === 'canceled' && '취소됨'}
                          </span>
                        </div>
                        {isFailed && job.error_message && (
                          <p className="text-[10px] text-red-500 mt-1 line-clamp-2" title={job.error_message}>
                            {job.error_message}
                          </p>
                        )}
                        {isAwaiting && lec && (
                          <div className="mt-2">
                            <DomainPicker
                              domains={domains}
                              recommendedId={lec.detected_domain_id}
                              recommendedConfidence={lec.detected_confidence}
                              topCandidates={lec.detected_top_candidates}
                              currentDomainId={lec.domain_id}
                              busy={confirmingId === lec.id}
                              onConfirm={(id) => handleConfirm(lec.id, id)}
                            />
                          </div>
                        )}
                      </div>
                      {job.status === 'queued' && (
                        <button
                          onClick={() => cancelJob(job.id)}
                          className="shrink-0 p-0.5 rounded text-slate-300 hover:text-red-500 transition-colors"
                          title="취소"
                        >
                          <XIcon />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}


// ─── App ────────────────────────────────────────────────

// ─── Sticky Anchor TOC (design D · Hybrid) ───────────────────────
//
// 강의 reader 의 sticky 칩 nav. 클릭 시 해당 섹션으로 부드럽게 점프하고
// 스크롤 위치에 따라 활성 칩이 자동 변경.

const READER_TOC_ITEMS = [
  { k: 'overview',   label: 'Overview',  ico: 'sparkle' },
  { k: 'concepts',   label: '핵심 개념',  ico: 'tag' },
  { k: 'timeline',   label: '타임라인',   ico: 'clock' },
  { k: 'showme',     label: 'ShowMe',     ico: 'diagram' },
  { k: 'qa',         label: 'Q&A',        ico: 'bulb' },
  { k: 'notes',      label: '강의 정리',  ico: 'list' },
  { k: 'transcript', label: '전사',       ico: 'doc' },
] as const

type ReaderTocKey = typeof READER_TOC_ITEMS[number]['k']

function TocChipIcon({ name }: { name: string }) {
  const ICONS: Record<string, string> = {
    sparkle: 'M12 3v6M12 15v6M3 12h6M15 12h6M5 5l4 4M15 15l4 4M5 19l4-4M15 9l4-4',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6',
    tag: 'M20 12 12 20l-9-9V3h8l9 9ZM7 7h.01',
    clock: 'M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    diagram: 'M5 7h4v4H5zM15 7h4v4h-4zM10 17h4v4h-4zM7 11v4h10v-4',
    bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z',
  }
  const d = ICONS[name] || ICONS.sparkle
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  )
}

function AnchorToc({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const [active, setActive] = useState<ReaderTocKey>('overview')

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const y = root.scrollTop + 80
      let current: ReaderTocKey = READER_TOC_ITEMS[0].k
      for (const t of READER_TOC_ITEMS) {
        const el = root.querySelector<HTMLElement>('#section-' + t.k)
        if (el && el.offsetTop <= y) current = t.k
      }
      setActive(current)
    }
    onScroll()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [scrollRef])

  const jumpTo = (k: ReaderTocKey) => {
    const root = scrollRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>('#section-' + k)
    if (!el) return
    root.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' })
    setActive(k)
  }

  return (
    <div
      className="shrink-0"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        padding: '0 24px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 36,
      }}
    >
      {READER_TOC_ITEMS.map((t) => {
        const isActive = active === t.k
        return (
          <button
            key={t.k}
            onClick={() => jumpTo(t.k)}
            style={{
              height: 28,
              padding: '0 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? 'var(--accent-deep)' : 'var(--text-3)',
              background: isActive ? 'var(--accent-tint)' : 'transparent',
              borderRadius: 6,
              border: 0,
              cursor: 'pointer',
            }}
          >
            <TocChipIcon name={t.ico} />
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Nav placeholder 화면 (강의 / 학습 노트 / 북마크 / 도메인) ──────
//
// 메인 viewer 의 D · Hybrid reader 재구성은 다음 PR. 그 전까지 4개 nav
// 가 헷갈리지 않도록 lectures 외에는 운영 데이터 기반 간단 화면을 노출.

interface NavScreenProps {
  navKey: ShellNavKey
  insights: QaInsight[]
  bookmarks: Bookmark[]
  domains: DomainInfo[]
  pendingCount: number
  onOpenBatchReview: () => void
  onDeleteInsight: (id: string) => void
  onDeleteBookmark: (id: string) => void
  onSelectLecture: (lectureId: string) => void
  onBack: () => void
}

function NavScreen({
  navKey,
  insights,
  bookmarks,
  domains,
  pendingCount,
  onOpenBatchReview,
  onDeleteInsight,
  onDeleteBookmark,
  onSelectLecture,
  onBack,
}: NavScreenProps) {
  const title =
    navKey === 'insights' ? '학습 노트' :
    navKey === 'bookmarks' ? '북마크' :
    navKey === 'domains' ? '도메인' : ''

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: 'var(--bg)' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 32px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <button
            onClick={onBack}
            className="ds-btn ghost sm"
            title="강의 화면으로 돌아가기"
          >
            ← 강의로
          </button>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
            {title}
          </h1>
        </div>

        {navKey === 'insights' && (
          <NavInsights
            insights={insights}
            pendingCount={pendingCount}
            onOpenBatchReview={onOpenBatchReview}
            onDelete={onDeleteInsight}
            onSelectLecture={onSelectLecture}
          />
        )}
        {navKey === 'bookmarks' && (
          <NavBookmarks
            bookmarks={bookmarks}
            onDelete={onDeleteBookmark}
            onSelectLecture={onSelectLecture}
          />
        )}
        {navKey === 'domains' && <NavDomains domains={domains} />}
      </div>
    </div>
  )
}

function NavInsights({
  insights,
  pendingCount,
  onOpenBatchReview,
  onDelete,
  onSelectLecture,
}: {
  insights: QaInsight[]
  pendingCount: number
  onOpenBatchReview: () => void
  onDelete: (id: string) => void
  onSelectLecture: (lectureId: string) => void
}) {
  return (
    <div className="ds-card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-3)' }}>
          전체 <strong style={{ color: 'var(--text-1)' }}>{insights.length}</strong>개 ·
          승인 대기 <strong style={{ color: 'var(--amber)' }}>{pendingCount}</strong>개
        </p>
        {pendingCount > 0 && (
          <button onClick={onOpenBatchReview} className="ds-btn primary sm">일괄 검토 시작</button>
        )}
      </div>
      {insights.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-4)' }}>아직 학습 노트가 없습니다.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
          {insights.slice(0, 50).map((it) => (
            <li key={it.id} style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                {it.action && (
                  <span className={`ds-pill ${it.action === 'merge' ? '' : 'amber'}`} style={{ fontSize: 10 }}>
                    {it.action}
                  </span>
                )}
                {it.lecture_id && (
                  <button onClick={() => onSelectLecture(it.lecture_id!)} className="ds-btn ghost sm" style={{ height: 22, padding: '0 6px' }}>
                    {it.lecture_id}
                  </button>
                )}
                <span style={{ marginLeft: 'auto' }}>
                  <button onClick={() => onDelete(it.id)} className="ds-btn ghost sm" style={{ height: 22, padding: '0 6px' }}>삭제</button>
                </span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', marginBottom: 4 }}>{it.question}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>{it.answer_summary}</div>
              {it.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                  {it.tags.map((t) => (
                    <span key={t} className="ds-pill" style={{ fontSize: 10 }}>{t}</span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NavBookmarks({
  bookmarks,
  onDelete,
  onSelectLecture,
}: {
  bookmarks: Bookmark[]
  onDelete: (id: string) => void
  onSelectLecture: (lectureId: string) => void
}) {
  // 강의별 그룹화
  const byLecture = new Map<string, Bookmark[]>()
  for (const b of bookmarks) {
    const k = b.lecture_id || '__no_lecture__'
    if (!byLecture.has(k)) byLecture.set(k, [])
    byLecture.get(k)!.push(b)
  }
  const groups = Array.from(byLecture.entries())

  if (groups.length === 0) {
    return (
      <div className="ds-card" style={{ padding: 20 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-4)' }}>아직 북마크가 없습니다.</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {groups.map(([lectureId, items]) => (
        <div key={lectureId} className="ds-card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <button onClick={() => onSelectLecture(lectureId)} className="ds-btn ghost sm">
              <span style={{ fontWeight: 600 }}>{lectureId}</span>
              <span style={{ color: 'var(--text-4)', marginLeft: 6 }}>{items.length}개</span>
            </button>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {items.map((b) => (
              <li key={b.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: b.color, marginTop: 4, flexShrink: 0 }} />
                <span className="ds-pill-ts">{b.time}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {b.note ? (
                    <div style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 500 }}>{b.note}</div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-4)', fontStyle: 'italic' }}>(메모 없음)</div>
                  )}
                </div>
                <button onClick={() => onDelete(b.id)} className="ds-btn ghost sm" style={{ height: 22, padding: '0 6px', flexShrink: 0 }}>삭제</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function NavDomains({ domains }: { domains: DomainInfo[] }) {
  if (domains.length === 0) {
    return (
      <div className="ds-card" style={{ padding: 20 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-4)' }}>등록된 도메인이 없습니다.</p>
      </div>
    )
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {domains.map((d) => (
        <div key={d.id} className="ds-card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)' }}>{d.name}</span>
            <span className="ds-pill" style={{ fontSize: 10 }}>{d.id}</span>
          </div>
          {d.description && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>{d.description}</p>
          )}
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [selectedId, setSelectedId] = useState(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1))
    return entries.some((e) => e.id === hash) ? hash : entries[0]?.id ?? ''
  })
  const [search, setSearch] = useState('')
  const [contentSearch, setContentSearch] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('corrected')
  const [copied, setCopied] = useState(false)
  const [activeNav, setActiveNav] = useState<ShellNavKey>('lectures')
  const [summaryCollapsed, setSummaryCollapsed] = useState(false)
  const [transcriptCollapsed, setTranscriptCollapsed] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState<{ email: string; display_name: string | null } | null>(null)

  // Bookmark state
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  // Insight state
  const [insights, setInsights] = useState<QaInsight[]>([])
  // Pending review state
  const [pendingCount, setPendingCount] = useState(0)
  const [batchReviewOpen, setBatchReviewOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [bookmarkAddDialog, setBookmarkAddDialog] = useState<{ seg: TranscriptSegment; segIndex: number; position: { x: number; y: number } } | null>(null)
  const [bookmarkPopover, setBookmarkPopover] = useState<{ bookmark: Bookmark; position: { x: number; y: number } } | null>(null)

  // Fetch current user on mount
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(setCurrentUser).catch(() => {})
  }, [])

  // Lectures + domains fetched from server (도메인 그루핑용)
  const [lectures, setLectures] = useState<Lecture[]>([])
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const refreshLecturesAndDomains = useCallback(async () => {
    try {
      const [lr, dr] = await Promise.all([
        fetch('/api/lectures'),
        fetch('/api/domains'),
      ])
      if (lr.ok) setLectures(await lr.json())
      if (dr.ok) setDomains(await dr.json())
    } catch {
      /* 다음 폴링에서 재시도 */
    }
  }, [])
  useEffect(() => { refreshLecturesAndDomains() }, [refreshLecturesAndDomains])
  useEffect(() => {
    const ACTIVE = new Set(['queued', 'processing', 'awaiting_domain'])
    const hasActive = lectures.some(
      (l) => l.latest_job_status && ACTIVE.has(l.latest_job_status),
    )
    if (!hasActive) return
    const id = setInterval(refreshLecturesAndDomains, 5000)
    return () => clearInterval(id)
  }, [lectures, refreshLecturesAndDomains])

  const handleDomainConfirm = useCallback(
    async (lectureId: string, domainId: string) => {
      try {
        await postLectureDomain(lectureId, domainId)
        await refreshLecturesAndDomains()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        alert(`도메인 컨펌 실패: ${msg}`)
      }
    },
    [refreshLecturesAndDomains],
  )

  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => entries.find((e) => e.id === selectedId) ?? entries[0], [selectedId])
  const selectedLecture = useMemo(
    () => lectures.find((l) => l.id === selectedId) ?? null,
    [lectures, selectedId],
  )

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? entries.filter((e) => e.label.toLowerCase().includes(q)) : entries
  }, [search])

  // The active file to display based on view mode
  const activeFile = useMemo(() => {
    if (!selected) return null
    if (viewMode === 'raw') return selected.raw ?? selected.corrected
    return selected.corrected ?? selected.raw
  }, [selected, viewMode])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const idx = filteredEntries.findIndex((entry) => entry.id === selectedId)
      if (e.key === 'ArrowDown' && idx < filteredEntries.length - 1) {
        e.preventDefault()
        setSelectedId(filteredEntries[idx + 1].id)
      }
      if (e.key === 'ArrowUp' && idx > 0) {
        e.preventDefault()
        setSelectedId(filteredEntries[idx - 1].id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedId, filteredEntries])

  // Sync selectedId → URL hash
  useEffect(() => {
    window.history.replaceState(null, '', `#${encodeURIComponent(selectedId)}`)
  }, [selectedId])

  // Reset on entry change
  useEffect(() => {
    // 강의 전환 시 즉시 상단으로 — smooth 는 긴 스크롤일 때 시간이 너무 걸림
    contentRef.current?.scrollTo({ top: 0 })
    setContentSearch('')
    setViewMode('corrected')
    setSummaryCollapsed(false)
    setTranscriptCollapsed(true)
    setContextMenu(null)
    setBookmarkAddDialog(null)
    setBookmarkPopover(null)
  }, [selectedId])

  // ─── Bookmark data fetching ──────────────────────
  const fetchBookmarks = useCallback(async () => {
    if (!selected) { setBookmarks([]); return }
    try {
      const res = await fetch(`/api/bookmarks?lecture_id=${encodeURIComponent(selected.id)}`)
      if (!res.ok) throw new Error('Failed')
      const data: Bookmark[] = await res.json()
      setBookmarks(data)
    } catch {
      setBookmarks([])
    }
  }, [selected])

  useEffect(() => {
    fetchBookmarks()
  }, [fetchBookmarks])

  // ─── Insight data fetching ──────────────────────
  const fetchInsights = useCallback(async () => {
    if (!selected) { setInsights([]); return }
    try {
      const res = await fetch(`/api/insights?lecture_id=${encodeURIComponent(selected.id)}`)
      if (!res.ok) throw new Error('Failed')
      const data: QaInsight[] = await res.json()
      setInsights(data)
    } catch {
      setInsights([])
    }
  }, [selected])

  // ─── Pending count fetching ──────────────────────
  const fetchPendingCount = useCallback(async () => {
    try {
      const res = await fetch('/api/insights/pending')
      if (!res.ok) throw new Error('Failed')
      const data: QaInsight[] = await res.json()
      setPendingCount(data.length)
    } catch {
      setPendingCount(0)
    }
  }, [])

  useEffect(() => {
    fetchInsights()
    fetchPendingCount()
  }, [fetchInsights, fetchPendingCount])

  const handleBatchReviewDone = useCallback(() => {
    fetchInsights()
    fetchPendingCount()
  }, [fetchInsights, fetchPendingCount])

  const handleInsightDelete = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/insights/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      fetchInsights()
    } catch { /* ignore */ }
  }, [fetchInsights])

  // Bookmark by time map for quick lookup
  const bookmarkByTime = useMemo(() => {
    const m = new Map<string, Bookmark>()
    for (const bm of bookmarks) {
      m.set(bm.time, bm)
    }
    return m
  }, [bookmarks])

  const handleBookmarkUpdate = useCallback(async (id: string, note: string, color: string) => {
    try {
      const res = await fetch(`/api/bookmarks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note, color }),
      })
      if (!res.ok) throw new Error('Failed')
      fetchBookmarks()
      setBookmarkPopover(null)
    } catch { /* ignore */ }
  }, [fetchBookmarks])

  const handleBookmarkDelete = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/bookmarks/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      fetchBookmarks()
      setBookmarkPopover(null)
    } catch { /* ignore */ }
  }, [fetchBookmarks])

  // ─── Audio player ──────────────────────────────
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioTime, setAudioTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)

  const audioSrc = selected ? `/api/audio/${encodeURIComponent(selected.id + '.mp3')}` : ''

  const playAudioAt = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = seconds
    audio.play().catch(() => {})
  }, [])

  // 타임스탬프 클릭용 — 시점만 옮기고 재생 상태(play / pause) 는 그대로 유지
  const seekAudioAt = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = seconds
  }, [])

  const copyTranscript = useCallback(() => {
    if (!activeFile?.isSegments) {
      if (activeFile) navigator.clipboard.writeText(JSON.stringify(activeFile.data, null, 2))
      return
    }
    const segs = activeFile.data as TranscriptSegment[]
    const text = segs.map((s) => `[${s.time}] ${s.text}`).join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }, [activeFile])

  // Scroll to segment by timestamp
  const scrollToSegment = useCallback((time: string) => {
    const container = contentRef.current
    if (!container) return
    const targetSeconds = parseTimestamp(time)

    // Find the closest segment at or before the target time
    const rows = container.querySelectorAll<HTMLElement>('[data-time]')
    let bestRow: HTMLElement | null = null
    let bestDiff = Infinity

    rows.forEach((row) => {
      const rowTime = Number(row.dataset.time)
      const diff = targetSeconds - rowTime
      // prefer closest at-or-before, but accept closest-after if nothing before
      if (diff >= 0 && diff < bestDiff) {
        bestDiff = diff
        bestRow = row
      }
    })

    // fallback: closest regardless
    if (!bestRow) {
      rows.forEach((row) => {
        const rowTime = Number(row.dataset.time)
        const diff = Math.abs(targetSeconds - rowTime)
        if (diff < bestDiff) {
          bestDiff = diff
          bestRow = row
        }
      })
    }

    if (bestRow) {
      (bestRow as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
      ;(bestRow as HTMLElement).classList.add('seg-highlight')
      setTimeout(() => {
        ;(bestRow as HTMLElement).classList.remove('seg-highlight')
      }, 1500)
    }

    // 타임스탬프 클릭은 시점만 이동하고 재생 상태는 보존 (재생 중이면 그대로 재생, 일시정지면 일시정지 유지)
    seekAudioAt(targetSeconds)
  }, [seekAudioAt])

  // ─── Content rendering ──────────────────────────────

  function renderContent() {
    if (!selected || !activeFile) {
      return (
        <div className="h-full flex items-center justify-center text-slate-400 text-sm">
          파일을 선택해주세요
        </div>
      )
    }

    const showSummary = !!selected.summary

    if (activeFile.isSegments) {
      const segs = activeFile.data as TranscriptSegment[]
      const q = contentSearch.trim().toLowerCase()
      const filtered = q ? segs.filter((s) => s.text.toLowerCase().includes(q)) : segs

      return (
        <div>
          {/* Summary panel — inner sections 에 section-overview/showme/concepts/timeline/qa anchor.
              collapsed 시 TOC 클릭하면 자동 expand. */}
          {showSummary && (
            <SummaryPanel
              lectureId={selected.id}
              summary={selected.summary!}
              onTimestampClick={scrollToSegment}
              collapsed={summaryCollapsed}
              onToggleCollapse={() => setSummaryCollapsed((v) => !v)}
            />
          )}

          {/* No summary banner */}
          {!selected.summary && (
            <div className="px-5 py-3 bg-slate-50 border-b border-slate-100 text-[12px] text-slate-400 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
              요약이 아직 생성되지 않았습니다
            </div>
          )}

          {/* Comprehensive Notes (강의 정리) — anchor: section-notes. Claude 단독 */}
          {selected.summary && (selected.summary.notes_claude || selected.summary.notes_gpt) && (
            <div id="section-notes" style={{ scrollMarginTop: 50 }}>
              <NotesSection
                lectureId={selected.id}
                notesClaude={selected.summary.notes_claude ?? ''}
                models={selected.summary.models}
              />
            </div>
          )}

          {/* Learning Notes (학습 노트) — standalone section */}
          <LearningNotesSection
            insights={insights}
            pendingCount={pendingCount}
            onOpenBatchReview={() => setBatchReviewOpen(true)}
            onDelete={handleInsightDelete}
            onRefresh={fetchInsights}
          />

          {/* Transcript section header — anchor: section-transcript */}
          <div id="section-transcript" className="shrink-0 px-5 py-2 bg-slate-50/80 border-y border-slate-200/80 flex items-center gap-2" style={{ scrollMarginTop: 50 }}>
            <button
              onClick={() => setTranscriptCollapsed((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-700 mr-auto transition-colors"
              aria-expanded={!transcriptCollapsed}
            >
              <svg
                className={`w-3 h-3 transition-transform ${transcriptCollapsed ? '' : 'rotate-90'}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              녹취록 &middot; {filtered.length}개 세그먼트
              {contentSearch && viewMode !== 'json' && (
                <span className="text-yellow-600 ml-2">
                  &ldquo;{contentSearch}&rdquo; 검색 중
                </span>
              )}
            </button>

            {/* Corrected / Raw / JSON segmented control */}
            <div className="hidden sm:flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5">
              {hasBoth && (
                <>
                  <button
                    onClick={() => setViewMode('corrected')}
                    className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                      viewMode === 'corrected'
                        ? 'bg-white text-teal-700 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    교정본
                  </button>
                  <button
                    onClick={() => setViewMode('raw')}
                    className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                      viewMode === 'raw'
                        ? 'bg-white text-amber-700 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    원본
                  </button>
                </>
              )}
              <button
                onClick={() => setViewMode('json')}
                className={`px-1.5 py-0.5 rounded-md transition-all ${
                  viewMode === 'json'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
                title="JSON 보기"
              >
                <CodeBracketIcon />
              </button>
            </div>

            {/* Mobile toggle */}
            <div className="flex sm:hidden items-center gap-1">
              {hasBoth && (
                <button
                  onClick={() => setViewMode(viewMode === 'raw' ? 'corrected' : 'raw')}
                  className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                    viewMode === 'raw'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-teal-50 text-teal-700'
                  }`}
                >
                  {viewMode === 'raw' ? '원본' : '교정본'}
                </button>
              )}
              <button
                onClick={() => setViewMode(viewMode === 'json' ? 'corrected' : 'json')}
                className={`p-1 rounded-md transition-colors ${
                  viewMode === 'json' ? 'bg-slate-800 text-white' : 'text-slate-400'
                }`}
              >
                <CodeBracketIcon />
              </button>
            </div>

            {/* Content search — only in transcript mode */}
            {viewMode !== 'json' && (
              <div className="relative hidden sm:block">
                <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 w-3.5 h-3.5" />
                <input
                  value={contentSearch}
                  onChange={(e) => setContentSearch(e.target.value)}
                  placeholder="내용 검색..."
                  className="pl-7 pr-7 py-1 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-100 transition w-36 placeholder:text-slate-400"
                />
                {contentSearch && (
                  <button
                    onClick={() => setContentSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500"
                  >
                    <XIcon />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* JSON view */}
          {transcriptCollapsed ? null : viewMode === 'json' ? (
            <pre className="p-6 text-[12px] font-mono leading-relaxed text-emerald-400/90 bg-[#0f1419] min-h-full selection:bg-emerald-900/40">
              {JSON.stringify(activeFile.data, null, 2)}
            </pre>
          ) : filtered.length === 0 && q ? (
            <div className="h-64 flex items-center justify-center text-slate-400 text-sm">
              &ldquo;{contentSearch}&rdquo;에 대한 결과가 없습니다
            </div>
          ) : (
            filtered.map((seg, i) => (
              <SegmentRow
                key={`${seg.time}-${i}`}
                seg={seg}
                index={i + 1}
                query={contentSearch}
                dataTime={parseTimestamp(seg.time)}
                bookmark={bookmarkByTime.get(seg.time) ?? null}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ x: e.clientX, y: e.clientY, seg, segIndex: i })
                  setBookmarkAddDialog(null)
                  setBookmarkPopover(null)
                }}
                onBookmarkClick={(e) => {
                  e.stopPropagation()
                  const bm = bookmarkByTime.get(seg.time)
                  if (bm) {
                    setBookmarkPopover({ bookmark: bm, position: { x: e.clientX, y: e.clientY } })
                    setContextMenu(null)
                    setBookmarkAddDialog(null)
                  }
                }}
              />
            ))
          )}
        </div>
      )
    }

    return (
      <pre className="p-6 text-[13px] leading-relaxed text-slate-600 font-mono">
        {JSON.stringify(activeFile.data, null, 2)}
      </pre>
    )
  }

  // ─── View mode helpers ──────────────────────────────

  const hasBoth = selected?.corrected && selected?.raw

  // ─── Main render ────────────────────────────────────

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Top header 제거 — 디자인 D · Hybrid 의 사이드바 brand + 메인 메타바 가
          역할을 분담. 로그아웃은 사이드바 user footer, 강의 제목·카운트는 메타바.
          ⌘K 검색은 사이드바 검색 input 으로 통합 (별도 단축키는 후속 PR). */}

      <div className="flex-1 overflow-hidden relative">
        <HybridShell
          activeNav={activeNav}
          onNavSelect={setActiveNav}
          activeLectureId={selected?.id ?? null}
          lectures={lectures}
          domains={domains}
          insightsBadge={pendingCount}
          userInitials={
            currentUser?.display_name
              ? currentUser.display_name.trim().charAt(0).toUpperCase()
              : currentUser?.email
                ? currentUser.email.charAt(0).toUpperCase()
                : 'U'
          }
          userName={currentUser?.display_name || currentUser?.email}
          onLectureSelect={setSelectedId}
          onLogoutClick={async () => {
            await fetch('/api/auth/logout', { method: 'POST' })
            window.location.href = '/login'
          }}
          search={search}
          onSearchChange={setSearch}
          auxiliarySlot={
            <>
              <UploadPanel
                lectures={lectures}
                domains={domains}
                onConfirmDomain={handleDomainConfirm}
                onJobChanged={refreshLecturesAndDomains}
              />
              <BookmarksPanel
                bookmarks={bookmarks}
                onScrollTo={scrollToSegment}
                onDelete={handleBookmarkDelete}
              />
              <InsightsPanel
                insights={insights}
                onDelete={handleInsightDelete}
                pendingCount={pendingCount}
                onOpenBatchReview={() => setBatchReviewOpen(true)}
              />
            </>
          }
        >
        {/* Nav 분기 — 'lectures' 외 nav 는 별도 placeholder 화면.
            메인 강의 viewer 의 D · Hybrid 재구성은 다음 PR. 여기는 기존 동작 보존. */}
        {activeNav !== 'lectures' ? (
          <NavScreen
            navKey={activeNav}
            insights={insights}
            bookmarks={bookmarks}
            domains={domains}
            pendingCount={pendingCount}
            onOpenBatchReview={() => setBatchReviewOpen(true)}
            onDeleteInsight={handleInsightDelete}
            onDeleteBookmark={handleBookmarkDelete}
            onSelectLecture={(id) => { setSelectedId(id); setActiveNav('lectures') }}
            onBack={() => setActiveNav('lectures')}
          />
        ) : (
        <>
        {/* Content row — main viewer + 우측 chat panel */}
        <div className="flex-1 flex overflow-hidden relative" style={{ minHeight: 0 }}>
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {/* Meta bar — design D · Hybrid: 도메인 / 모델 라벨 / 강의 제목 / 카운트 + 액션 */}
          {selected && (
            <div
              className="shrink-0"
              style={{
                padding: '12px 24px 10px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)', marginBottom: 3, flexWrap: 'wrap' }}>
                  <LectureDomainBadge
                    lecture={selectedLecture}
                    domains={domains}
                    onConfirm={(domainId) =>
                      handleDomainConfirm(selectedLecture!.id, domainId)
                    }
                  />
                  {selected.summary?.models?.claude_summary && (
                    <span className="mono" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-4)' }}>
                      · {selected.summary.models.claude_summary}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selected.label}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                <span className="ds-pill" title="북마크 개수" style={{ fontSize: 11 }}>
                  <BookmarkIcon className="w-3 h-3" /> {bookmarks.length}
                </span>
                <span className="ds-pill" title="학습 노트 개수" style={{ fontSize: 11 }}>
                  <LightBulbIcon className="w-3 h-3" /> {insights.length}
                </span>
                <button
                  onClick={copyTranscript}
                  className="ds-btn ghost sm"
                  style={{ padding: '0 6px' }}
                  title={copied ? '복사됨!' : '클립보드에 복사'}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>
            </div>
          )}

          {/* 코렉션 재생성 배너 */}
          {selectedLecture && (
            selectedLecture.latest_job_status === 'queued' ||
            selectedLecture.latest_job_status === 'processing'
          ) && selectedLecture.latest_job_type !== 'stt' && (
            <div className="shrink-0 bg-amber-50 border-b border-amber-200 px-5 py-2 text-[12px] text-amber-800">
              {selectedLecture.latest_job_type === 'correct' && '도메인 변경에 따라 코렉션을 다시 생성하는 중입니다...'}
              {selectedLecture.latest_job_type === 'summary' && '요약을 생성하는 중입니다...'}
            </div>
          )}

          {/* Sticky anchor TOC — design D · Hybrid */}
          {selected && selected.summary && (
            <AnchorToc scrollRef={contentRef} />
          )}

          {/* Scrollable content */}
          <div ref={contentRef} className="flex-1 overflow-y-auto scrollbar-thin" style={{ background: 'var(--bg)' }}>
            {renderContent()}
          </div>

          {/* Audio player — design D · Hybrid: 북마크 색상 마커 + 재생헤드 */}
          {selected && (
            <div
              className="shrink-0"
              style={{
                height: 52,
                borderTop: '1px solid var(--border)',
                background: 'var(--surface)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '0 24px',
              }}
            >
              <audio
                ref={audioRef}
                src={audioSrc}
                preload="metadata"
                onPlay={() => setAudioPlaying(true)}
                onPause={() => setAudioPlaying(false)}
                onTimeUpdate={(e) => setAudioTime((e.target as HTMLAudioElement).currentTime)}
                onLoadedMetadata={(e) => setAudioDuration((e.target as HTMLAudioElement).duration)}
                onEnded={() => setAudioPlaying(false)}
              />
              <button
                onClick={() => {
                  const a = audioRef.current
                  if (!a) return
                  audioPlaying ? a.pause() : a.play().catch(() => {})
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 0,
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
                title={audioPlaying ? '일시정지' : '재생'}
              >
                {audioPlaying ? (
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
                ) : (
                  <svg className="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                )}
              </button>
              <span
                className="mono"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-3)',
                  minWidth: 44,
                  flexShrink: 0,
                }}
              >
                {formatTime(audioTime)}
              </span>
              {/* Marker-rich progress track */}
              <div
                style={{
                  flex: 1,
                  height: 18,
                  position: 'relative',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
                onClick={(e) => {
                  if (!audioDuration) return
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                  const t = ratio * audioDuration
                  setAudioTime(t)
                  if (audioRef.current) audioRef.current.currentTime = t
                }}
              >
                {/* track */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    height: 4,
                    background: 'var(--surface-3)',
                    borderRadius: 2,
                  }}
                />
                {/* progress */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    height: 4,
                    width: audioDuration > 0 ? `${(audioTime / audioDuration) * 100}%` : '0%',
                    background: 'var(--accent)',
                    borderRadius: 2,
                  }}
                />
                {/* bookmark markers */}
                {audioDuration > 0 &&
                  bookmarks.map((b) => {
                    const sec = parseTimestamp(b.time)
                    const pct = Math.max(0, Math.min(100, (sec / audioDuration) * 100))
                    return (
                      <div
                        key={b.id}
                        title={`${b.time}${b.note ? ' · ' + b.note : ''}`}
                        style={{
                          position: 'absolute',
                          left: `${pct}%`,
                          top: 'calc(50% - 7px)',
                          width: 2,
                          height: 14,
                          background: b.color,
                          transform: 'translateX(-1px)',
                          pointerEvents: 'none',
                        }}
                      />
                    )
                  })}
                {/* play head */}
                {audioDuration > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${(audioTime / audioDuration) * 100}%`,
                      top: 'calc(50% - 6px)',
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      boxShadow: '0 0 0 3px rgba(13, 148, 136, 0.2)',
                      transform: 'translateX(-6px)',
                      pointerEvents: 'none',
                    }}
                  />
                )}
              </div>
              <span
                className="mono"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-3)',
                  minWidth: 44,
                  flexShrink: 0,
                }}
              >
                {formatTime(audioDuration)}
              </span>
              <select
                defaultValue={1}
                onChange={(e) => { if (audioRef.current) audioRef.current.playbackRate = Number(e.target.value) }}
                className="ds-btn sm"
                style={{ padding: '0 6px', appearance: 'none' }}
              >
                <option value={0.75}>0.75x</option>
                <option value={1}>1x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
                <option value={2}>2x</option>
              </select>
            </div>
          )}

        </main>

        {/* Chat panel + edge tab handle */}
        {selected && (
          <>
            {!chatOpen && (
              <button
                onClick={() => setChatOpen(true)}
                className="shrink-0 w-7 flex flex-col items-center justify-center gap-1.5 border-l border-slate-200/80 bg-slate-50 hover:bg-teal-50 text-slate-400 hover:text-teal-600 transition-colors cursor-pointer"
                title="강의 채팅"
              >
                <ChatBubbleIcon />
                <span className="text-[10px] font-medium tracking-tight" style={{ writingMode: 'vertical-rl' }}>채팅</span>
              </button>
            )}
            <ChatPanel
              lectureId={selected.id}
              open={chatOpen}
              onClose={() => setChatOpen(false)}
              scrollToSegment={scrollToSegment}
              onInsightAction={handleBatchReviewDone}
            />
          </>
        )}
        </div>
        </>
        )}
        </HybridShell>
      </div>

      {/* Context menu */}
      <ContextMenu
        state={contextMenu}
        onClose={() => setContextMenu(null)}
        onAddBookmark={() => {
          if (contextMenu) {
            setBookmarkAddDialog({
              seg: contextMenu.seg,
              segIndex: contextMenu.segIndex,
              position: { x: contextMenu.x, y: contextMenu.y },
            })
          }
        }}
        onPlayAudio={() => {
          if (contextMenu) {
            playAudioAt(parseTimestamp(contextMenu.seg.time))
          }
        }}
      />

      {/* Bookmark add dialog */}
      {bookmarkAddDialog && selected && (
        <BookmarkAddDialog
          seg={bookmarkAddDialog.seg}
          segIndex={bookmarkAddDialog.segIndex}
          lectureId={selected.id}
          position={bookmarkAddDialog.position}
          onClose={() => setBookmarkAddDialog(null)}
          onCreated={fetchBookmarks}
        />
      )}

      {/* Bookmark popover */}
      {bookmarkPopover && (
        <BookmarkPopover
          bookmark={bookmarkPopover.bookmark}
          position={bookmarkPopover.position}
          onClose={() => setBookmarkPopover(null)}
          onUpdate={handleBookmarkUpdate}
          onDelete={handleBookmarkDelete}
        />
      )}

      {/* Batch review panel */}
      <BatchReviewPanel
        open={batchReviewOpen}
        onClose={() => setBatchReviewOpen(false)}
        onDone={handleBatchReviewDone}
      />

      {/* Fixed bottom-left toast for pending insights */}
      {pendingCount > 0 && !batchReviewOpen && (
        <div className="fixed bottom-5 left-5 z-[80] animate-slide-up">
          <button
            onClick={() => setBatchReviewOpen(true)}
            className="flex items-center gap-2.5 pl-3.5 pr-4 py-2.5 rounded-xl bg-amber-500 text-white shadow-lg shadow-amber-500/25 hover:bg-amber-600 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <LightBulbIcon className="w-4 h-4" />
            <span className="text-[13px] font-medium">학습 노트 {pendingCount}건 대기</span>
          </button>
        </div>
      )}
    </div>
  )
}
