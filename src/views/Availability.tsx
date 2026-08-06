// =============================================================
// Availability.tsx —— 排休與時段
// 讓員工（或管理員代為）設定「某天是否可排班」：
//   正常上班｜排休（整天不排班）｜沒空時段（某時段不排班）｜偏好某班別
// 畫面有兩種模式：
//   管理員選「全部員工」→ 月曆總覽，看所有人每天狀態；
//   選擇單一員工 → 該員工的月曆，點日期編輯狀態。
// 支援 Ctrl+C 複製某天設定、Ctrl+V／點擊日期貼上到其他天。
// =============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import {
  dateKey,
  daysInMonth,
  firstDayOffset,
  statusPalette,
  today,
  WEEKDAYS,
  settingsToMap,
  type Availability,
  type Employee,
  type Setting,
  type ShiftType,
} from '../types'
import { useAuth } from '../auth'
import MonthNav from '../components/MonthNav'
import { Modal, Spinner, toast, Field } from '../components/ui'
import { ShiftIcon } from '../components/icons'

// 時段下拉選單的選項：00:00 ~ 24:00 整點
const TIME_OPTIONS: string[] = []
for (let h = 0; h <= 24; h++) {
  TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:00`)
}

// 總覽畫面右上角的「顯示狀態」篩選選項（正常=綠、排休=紅、沒空=灰、偏好=太陽/紫雙色）
const STATUS_FILTERS: { key: string; label: string; color: string }[] = [
  { key: 'normal', label: '可排班', color: '#16a34a' },
  { key: 'off', label: '排休', color: '#dc2626' },
  { key: 'unavailable', label: '沒空時段', color: '#6b7280' },
  { key: 'prefer', label: '偏好班別', color: 'linear-gradient(135deg, #F59E0B 50%, #a78bfa 50%)' },
]

// 總覽月曆格子內的分區順序（類似班表總覽的上午/下午分區，改成依狀態分）
const AVAIL_SECTIONS: { key: string; label: string }[] = [
  { key: 'normal', label: '可排班' },
  { key: 'prefer', label: '偏好' },
  { key: 'unavailable', label: '沒空時段' },
  { key: 'off', label: '排休' },
]

// 每個分區標題左側的小色條
const SECTION_TICK: Record<string, string> = {
  normal: '#16a34a',
  off: '#dc2626',
  unavailable: '#6b7280',
  prefer: '#F59E0B',
}

// 把記錄的 status 歸類成篩選用的四類（normal/off/unavailable/prefer）
function statusKey(rec: Availability | undefined): string {
  if (!rec) return 'normal'
  if (rec.status === 'available') return 'normal'
  if (rec.status === 'off') return 'off'
  if (rec.status === 'unavailable') return 'unavailable'
  if (rec.status) return 'prefer'
  return 'normal'
}

export default function AvailabilityView() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const t = today()
  const [year, setYear] = useState(t.year)
  const [month, setMonth] = useState(t.month)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([])
  const [records, setRecords] = useState<Availability[]>([])
  const [selected, setSelected] = useState('')        // 目前檢視的員工（'' = 全部）
  const [loading, setLoading] = useState(true)
  const [editingDay, setEditingDay] = useState<number | null>(null) // 正在編輯的日期
  const [timeMode, setTimeMode] = useState<'unavailable' | null>(null) // 彈窗是否在「選時段」模式
  const [startTime, setStartTime] = useState('12:00') // 沒空時段開始
  const [endTime, setEndTime] = useState('24:00')     // 沒空時段結束
  const [defaultStart, setDefaultStart] = useState('12:00') // 上班起始預設（來自排班規則設定）
  const [defaultEnd, setDefaultEnd] = useState('24:00')     // 上班結束預設
  const [showStatus, setShowStatus] = useState<Set<string>>(new Set(['normal', 'off', 'unavailable', 'prefer'])) // 總覽要顯示哪些狀態
  const [showEmps, setShowEmps] = useState<Set<string>>(new Set()) // 總覽要顯示哪些員工（空 = 全部）
  const [copyBuf, setCopyBuf] = useState<{ status: string; start_time: string; end_time: string } | null>(null) // Ctrl+C 複製的設定
  const [pasteMode, setPasteMode] = useState(false)   // 是否在「貼上模式」
  const lastDayRef = useRef<number | null>(null)      // 最近開過的日期（Ctrl+C 找不到當下日期時用它）

  const toggleStatus = (key: string) => {
    setShowStatus((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleEmp = (id: string) => {
    setShowEmps((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 員工是否要顯示：沒選任何員工（showEmps 空）＝全部顯示
  const empShown = (id: string) => showEmps.size === 0 || showEmps.has(id)

  // 進頁面時抓員工、班別、排班規則設定；並依身份決定檢視對象
  // （管理員看全部，一般員工自動鎖定在自己）
  useEffect(() => {
    void (async () => {
      try {
        const [e, s, st] = await Promise.all([
          api<{ employees: Employee[] }>('/employees'),
          api<{ shiftTypes: ShiftType[] }>('/shift-types'),
          api<{ settings: Setting[] }>('/settings'),
        ])
        setEmployees(e.employees)
        setShiftTypes(s.shiftTypes)
        const sm = settingsToMap(st.settings)
        if (sm.work_start) setDefaultStart(sm.work_start)
        if (sm.work_end) setDefaultEnd(sm.work_end)
        setStartTime(sm.work_start || '12:00')
        setEndTime(sm.work_end || '24:00')
        if (isAdmin) {
          setSelected('')
        } else if (user?.employee_id) {
          setSelected(user.employee_id)
        }
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    })()
  }, [isAdmin, user?.employee_id])

  // 抓目前月份＋所選員工的排休記錄；selected 改變時會自動重抓
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ availability: Availability[] }>(`/availability?year=${year}&month=${month}`)
      setRecords(selected ? res.availability.filter((a) => a.employee_id === selected) : res.availability)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }, [year, month, selected])

  useEffect(() => {
    void load()
  }, [load])

  // 「日期 → 記錄」查詢表（單人檢視用；每員工每天只有一筆）
  const statusByDay = useMemo(() => {
    const m = new Map<string, Availability>()
    for (const r of records) m.set(r.date, r)
    return m
  }, [records])

  // 「員工 → 日期 → 記錄」查詢表（總覽畫面用）
  const recordsByEmp = useMemo(() => {
    const m = new Map<string, Map<string, Availability>>()
    for (const r of records) {
      let inner = m.get(r.employee_id)
      if (!inner) {
        inner = new Map()
        m.set(r.employee_id, inner)
      }
      inner.set(r.date, r)
    }
    return m
  }, [records])

  const activeEmployees = employees.filter((e) => e.active !== '0')

  // 狀態說明文字（滑鼠移上去的提示）
  const cellLabel = (rec?: Availability) => {
    if (!rec || rec.status === 'available') return '可排班'
    if (rec.status === 'off') return '排休'
    if (rec.status === 'unavailable') return `沒空 ${rec.start_time}–${rec.end_time}`
    return `偏好 ${shiftTypes.find((s) => s.code === rec.status)?.name || rec.status}`
  }

  const empName = employees.find((e) => e.id === selected)?.name || ''

  const days = daysInMonth(year, month)
  const offset = firstDayOffset(year, month)
  const now = new Date()
  const todayKey = dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate())

  // 儲存某天的狀態。status='clear' 表示清除（恢復正常上班），其餘寫入後端
  const save = async (day: number, status: string, times?: { start: string; end: string }) => {
    const date = dateKey(year, month, day)
    try {
      if (status === 'clear') {
        await api(`/availability?employee_id=${selected}&date=${date}`, { method: 'DELETE' })
      } else {
        await api('/availability', {
          method: 'PUT',
          body: {
            employee_id: selected,
            date,
            status,
            start_time: times?.start ?? '',
            end_time: times?.end ?? '',
          },
        })
      }
      await load()
      toast(status === 'clear' ? '已恢復正常上班' : '已儲存')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // 開啟某一天的編輯彈窗（時間先填預設值）
  const openDay = (day: number) => {
    lastDayRef.current = day
    setEditingDay(day)
    setTimeMode(null)
    setStartTime(defaultStart)
    setEndTime(defaultEnd)
  }

  // 切換到「沒空時段」編輯模式：若這天已有時段則帶入原值
  const openTimeMode = (mode: 'unavailable') => {
    if (!editingDay) return
    const rec = statusByDay.get(dateKey(year, month, editingDay))
    if (rec?.status === mode) {
      setStartTime(rec.start_time || defaultStart)
      setEndTime(rec.end_time || defaultEnd)
    } else {
      setStartTime(defaultStart)
      setEndTime(defaultEnd)
    }
    setTimeMode(mode)
  }

  // 儲存「沒空時段」（先檢查結束必須晚於開始）
  const saveTimeSlot = async () => {
    if (!timeMode || !editingDay) return
    if (startTime >= endTime) {
      toast('結束時段必須晚於開始時段', 'error')
      return
    }
    await save(editingDay, timeMode, { start: startTime, end: endTime })
    setEditingDay(null)
    setTimeMode(null)
  }

  // 顯示複製緩衝區的內容說明（貼上模式橫條用）
  const bufferLabel = (b: { status: string; start_time: string; end_time: string }) => {
    if (!b.status || b.status === 'clear') return '正常上班'
    if (b.status === 'off') return '排休'
    if (b.status === 'unavailable') return `沒空 ${b.start_time}–${b.end_time}`
    return `偏好 ${shiftTypes.find((s) => s.code === b.status)?.name || b.status}`
  }

  // Ctrl+C：複製某天的設定到緩衝區，並進入貼上模式
  const copyFromDay = (day: number) => {
    const rec = statusByDay.get(dateKey(year, month, day))
    const buf = {
      status: rec?.status || 'clear',
      start_time: rec?.start_time || '',
      end_time: rec?.end_time || '',
    }
    setCopyBuf(buf)
    setPasteMode(true)
    toast(`已複製「${bufferLabel(buf)}」：點擊其他日期即可貼上（Esc 結束）`)
  }

  // 把緩衝區的設定套用到某天
  const pasteToDay = async (day: number) => {
    if (!copyBuf) return
    const buf = copyBuf
    await save(day, buf.status, buf.status === 'unavailable' ? { start: buf.start_time, end: buf.end_time } : undefined)
  }

  // 全域鍵盤監聽：Esc 結束貼上模式；Ctrl+C 複製、Ctrl+V 貼上
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pasteMode && !editingDay) {
        setPasteMode(false)
        toast('已結束貼上模式')
        return
      }
      if (!selected || !(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'c') {
        const day = editingDay ?? lastDayRef.current
        if (!day) return
        e.preventDefault()
        copyFromDay(day)
      } else if (k === 'v') {
        if (!copyBuf || !editingDay) return
        e.preventDefault()
        void pasteToDay(editingDay)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 單人檢視：格子內要顯示的狀態標籤
  const renderCellTag = (rec: Availability | undefined) => {
    if (!rec || rec.status === 'available') return null
    if (rec.status === 'off') return <span className="avail-cell__tag">排休</span>
    if (rec.status === 'unavailable') {
      return (
        <span className="avail-cell__tag">
          沒空 {rec.start_time}–{rec.end_time}
        </span>
      )
    }
    const preferShift = shiftTypes.find((s) => s.code === rec.status)
    if (preferShift) {
      const pal = statusPalette(rec, preferShift)
      return (
        <span
          className="avail-cell__tag"
          style={{ background: pal.bg, color: pal.fg, border: `1px solid ${pal.bar}` }}
        >
          <ShiftIcon shift={preferShift} size={12} /> 偏好 {preferShift.name}
        </span>
      )
    }
    return null
  }

  // 單人檢視：格子底色樣式（排休/沒空加特殊底色）
  const cellClass = (rec: Availability | undefined) => {
    if (!rec) return ''
    let cls = ''
    if (rec.status === 'off') cls += ' avail-cell--off'
    else if (rec.status === 'unavailable') cls += ' avail-cell--unavail'
    return cls
  }

  return (
    <div className="view">
      <div className="view__head">
        <MonthNav year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m) }} />
        <label className="field field--inline">
          <span className="field__label">員工</span>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!isAdmin}>
            {isAdmin ? (
              <>
                <option value="">全部員工（總覽）</option>
                {activeEmployees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.department && `（${e.department}）`}
                  </option>
                ))}
              </>
            ) : (
              <option value={selected}>{empName}</option>
            )}
          </select>
        </label>
      </div>

      {isAdmin && !selected ? (
        loading ? (
          <Spinner label="載入中…" />
        ) : activeEmployees.length === 0 ? (
          <p className="empty-note">尚無在職員工，請先到〈員工管理〉新增。</p>
        ) : (
          // —— 管理員總覽模式：所有人的月曆 + 篩選列 ——
          <div className="stack">
            <div className="filter-bar">
              <span className="filter-bar__label">顯示狀態</span>
              {STATUS_FILTERS.map((f) => (
                <label key={f.key} className="check-chip">
                  <input
                    type="checkbox"
                    checked={showStatus.has(f.key)}
                    onChange={() => toggleStatus(f.key)}
                  />
                  <i style={{ background: f.color }} />
                  {f.label}
                </label>
              ))}
            </div>
            <div className="filter-bar">
              <span className="filter-bar__label">員工篩選</span>
              <button
                type="button"
                className={`emp-chip${showEmps.size === 0 ? ' emp-chip--on' : ''}`}
                onClick={() => setShowEmps(new Set())}
              >
                全部
              </button>
              {activeEmployees.map((emp) => (
                <button
                  key={emp.id}
                  type="button"
                  className={`emp-chip${showEmps.has(emp.id) ? ' emp-chip--on' : ''}`}
                  onClick={() => toggleEmp(emp.id)}
                >
                  {emp.name}
                </button>
              ))}
            </div>

            <div className="legend">
              <span className="legend__item">
                <i style={{ background: '#16a34a' }} />
                正常（可排班）
              </span>
              <span className="legend__item">
                <i style={{ background: '#dc2626' }} />
                排休
              </span>
              <span className="legend__item">
                <i style={{ background: '#6b7280' }} />
                沒空時段
              </span>
              {shiftTypes.filter((s) => s.code !== 'OFF').map((s) => {
                const pal = statusPalette(undefined, s)
                return (
                  <span key={s.code} className="legend__item">
                    <i className="legend-dot--prefer" style={{ background: pal.bar }} />
                    <ShiftIcon shift={s} /> 偏好{s.name}
                  </span>
                )
              })}
            </div>

            {/* 總覽月曆：每格列出所有被篩選出員工的狀態圓點，點圓點直接切到該員工編輯 */}
            <div className="cal">
              <div className="cal__grid">
                {WEEKDAYS.map((w, i) => (
                  <div key={w} className={`cal-weekhead${i >= 5 ? ' cal-weekhead--weekend' : ''}`}>
                    {w}
                  </div>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  <div key={`blank-${i}`} className="cal-cell cal-cell--blank" />
                ))}
                {Array.from({ length: days }, (_, i) => {
                  const day = i + 1
                  const date = dateKey(year, month, day)
                  const isToday = date === todayKey
                  const visible = activeEmployees.filter((emp) => empShown(emp.id))
                  return (
                    <div key={day} className={`cal-cell avail-overview${isToday ? ' cal-cell--today' : ''}`}>
                      <div className="cal-cell__head">
                        <span className="cal-cell__day">{month}/{day}</span>
                        <span className="cal-cell__week">{WEEKDAYS[(offset + day - 1) % 7]}</span>
                      </div>
                      <div className="cal-cell__avail">
                        {AVAIL_SECTIONS.map((sec) => {
                          const items = visible.filter(
                            (emp) => statusKey(recordsByEmp.get(emp.id)?.get(date)) === sec.key && showStatus.has(sec.key),
                          )
                          if (items.length === 0) return null
                          return (
                            <div key={sec.key} className="cal-cell__half cal-cell__half--avail">
                              <span className="cal-cell__halflabel">
                                <i className="cal-cell__sectick" style={{ background: SECTION_TICK[sec.key] }} />
                                {sec.label}
                              </span>
                              <div className="cal-cell__halfbody">
                                {items.map((emp) => {
                                  const rec = recordsByEmp.get(emp.id)?.get(date)
                                  const isPrefer = sec.key === 'prefer'
                                  const preferShift = isPrefer ? shiftTypes.find((s) => s.code === rec?.status) : undefined
                                  const pal = statusPalette(rec, preferShift)
                                  return (
                                    <button
                                      key={emp.id}
                                      type="button"
                                      className="cal-emp"
                                      style={{ background: pal.bg, color: pal.fg, borderColor: pal.border }}
                                      title={`${emp.name} ${date}：${cellLabel(rec)}`}
                                      onClick={() => {
                                        setSelected(emp.id)
                                        setEditingDay(day)
                                      }}
                                    >
                                      {isPrefer && preferShift ? (
                                        <ShiftIcon shift={preferShift} size={12} />
                                      ) : (
                                        <span className="cal-emp__dot" style={{ background: pal.bar }} />
                                      )}
                                      {emp.name}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                        {visible.length > 0 && !visible.some((emp) => showStatus.has(statusKey(recordsByEmp.get(emp.id)?.get(date)))) && (
                          <span className="cal-cell__empty">—</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <p className="hint">
              每格依狀態分區（可排班／排休／沒空時段／偏好，可篩選狀態與員工）。點任一方塊即可切換到該員工的單人檢視並編輯。滑鼠移到方塊可看詳細（含時段）。
            </p>
          </div>
        )
      ) : !selected ? (
        <p className="empty-note">你的帳號尚未綁定員工資料，請聯絡管理員設定。</p>
      ) : loading ? (
        <Spinner label="載入中…" />
      ) : (
        <>
          {/* —— 單人檢視模式：該員工的月曆，點日期設定狀態 —— */}
          <div className="legend">
            <span className="legend__item">
              <i style={{ background: '#16a34a' }} />
              正常上班（整天可排班）
            </span>
            <span className="legend__item">
              <i style={{ background: '#dc2626' }} />
              排休（整天不排班）
            </span>
            <span className="legend__item">
              <i style={{ background: '#6b7280' }} />
              沒空時段
            </span>
            {shiftTypes.filter((s) => s.code !== 'OFF').map((s) => {
              const pal = statusPalette(undefined, s)
              return (
                <span key={s.code} className="legend__item">
                  <i className="legend-dot--prefer" style={{ background: pal.bar }} />
                  <ShiftIcon shift={s} /> 偏好{s.name}
                </span>
              )
            })}
          </div>
          {/* 貼上模式提示橫條：複製過設定後顯示，點日期或 Ctrl+V 即可貼上 */}
          {pasteMode && copyBuf && (
            <div className="paste-bar">
              <span className="paste-bar__label">貼上模式：已複製「{bufferLabel(copyBuf)}」</span>
              <span className="paste-bar__hint">點擊日期即可貼上・開啟日期後按 Ctrl+V 貼上・Esc 結束</span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  setPasteMode(false)
                  toast('已結束貼上模式')
                }}
              >
                結束
              </button>
            </div>
          )}
          <div className="cal">
            <div className="cal__grid">
            {WEEKDAYS.map((w, i) => (
              <div key={w} className={`cal-weekhead${i >= 5 ? ' cal-weekhead--weekend' : ''}`}>
                {w}
              </div>
            ))}
            {Array.from({ length: offset }, (_, i) => (
              <div key={`blank-${i}`} className="cal-cell cal-cell--blank" />
            ))}
            {Array.from({ length: days }, (_, i) => {
              const day = i + 1
              const rec = statusByDay.get(dateKey(year, month, day))
              const isToday = dateKey(year, month, day) === todayKey
              return (
                <button
                  key={day}
                  type="button"
                  className={`avail-cell${cellClass(rec)}${isToday ? ' avail-cell--today' : ''}`}
                  onClick={() => {
                    if (pasteMode && copyBuf) {
                      void pasteToDay(day)
                      return
                    }
                    openDay(day)
                  }}
                >
                  <span className="avail-cell__day">{month}/{day}</span>
                  {renderCellTag(rec)}
                  {!rec && <span className="avail-cell__normal">可排班</span>}
                </button>
              )
            })}
          </div>
          <p className="hint">
            點擊日期設定當天狀態：「排休」整天不排班；「沒空時段」表示該時段不排班；也可指定當日偏好安排早班或晚班。設定好某天的狀態後，按 <b>Ctrl+C</b> 複製該設定，再<b>點擊其他日期</b>或<b>按 Ctrl+V</b> 即可一次貼到多天（Esc 結束）。
          </p>
        </div>
        </>
      )}

      {editingDay && (
        <Modal title={`${month} 月 ${editingDay} 日・排休與時段`} onClose={() => setEditingDay(null)}>
          <div className="stack">
            <p className="modal-lead">
              員工：{empName}　日期：{dateKey(year, month, editingDay)}
            </p>
            {/* 第一層：選「沒空時段」的起訖時間 */}
            {timeMode ? (
              <div className="stack">
                <div className="form-row">
                  <Field label="沒空時段開始">
                    <select value={startTime} onChange={(e) => setStartTime(e.target.value)}>
                      {TIME_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="沒空時段結束">
                    <select value={endTime} onChange={(e) => setEndTime(e.target.value)}>
                      {TIME_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <p className="hint">該時段內不安排上班（例：14:00–16:00 沒空，則早/晚班皆無法排）。</p>
                <div className="modal__actions">
                  <button type="button" className="btn" onClick={() => setTimeMode(null)}>
                    返回
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => void saveTimeSlot()}>
                    儲存時段
                  </button>
                </div>
              </div>
            ) : (
              // 第二層：選擇這天的狀態（正常/排休/沒空/偏好某班別），並支援複製貼上
              <div className="option-list">
                {copyBuf && (
                  <button
                    type="button"
                    className="option-item option-item--paste"
                    onClick={async () => {
                      await pasteToDay(editingDay)
                      setEditingDay(null)
                    }}
                  >
                    <span className="option-item__dot" style={{ background: '#0ea5e9' }} />
                    貼上「{bufferLabel(copyBuf)}」到此日期
                  </button>
                )}
                <button
                  type="button"
                  className="option-item"
                  onClick={() => {
                    copyFromDay(editingDay)
                    setEditingDay(null)
                  }}
                >
                  <span
                    className="option-item__dot"
                    style={{ background: 'transparent', border: '1.5px dashed var(--line-strong)' }}
                  />
                  複製此日期的設定（Ctrl+C）
                </button>
                <button
                  type="button"
                  className="option-item"
                  onClick={async () => {
                    await save(editingDay, 'clear')
                    setEditingDay(null)
                  }}
                >
                  <span className="option-item__dot" style={{ background: '#16a34a' }} />
                  正常上班（整天可排班）
                </button>
                <button
                  type="button"
                  className="option-item"
                  onClick={async () => {
                    await save(editingDay, 'off')
                    setEditingDay(null)
                  }}
                >
                  <span className="option-item__dot" style={{ background: '#dc2626' }} />
                  排休（當日整天不排班）
                </button>
                <button
                  type="button"
                  className="option-item"
                  onClick={() => openTimeMode('unavailable')}
                >
                  <span className="option-item__dot" style={{ background: '#6b7280' }} />
                  沒空時段（該時段不排班）
                </button>
                {shiftTypes
                  .filter((s) => s.code !== 'OFF')
                  .map((s) => (
                    <button
                      key={s.code}
                      type="button"
                      className="option-item"
                      onClick={async () => {
                        await save(editingDay, s.code)
                        setEditingDay(null)
                      }}
                    >
                      <span className="option-item__dot" style={{ background: statusPalette(undefined, s).bar }} />
                      <ShiftIcon shift={s} /> 希望安排「{s.name}」
                    </button>
                  ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}