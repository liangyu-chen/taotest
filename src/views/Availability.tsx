// =============================================================
// Availability.tsx —— 排休與時段
// 讓員工（或管理員代為）設定「某天是否可排班」：
//   正常上班｜排休（整天不排班）｜沒空時段（某時段不排班）｜偏好某班別
// 畫面有兩種模式：
//   管理員選「全部員工」→ 月曆總覽，看所有人每天狀態；
//   選擇單一員工 → 該員工的月曆，點日期編輯狀態。
// 單人檢視可開啟「批次設定」：一次選取多天，統一設為同一樣態。
// =============================================================

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
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
  const [batchMode, setBatchMode] = useState(false)          // 是否在批次設定模式
  const [batchDays, setBatchDays] = useState<Set<number>>(new Set()) // 批次設定已選取的日期
  const [batchConfirm, setBatchConfirm] = useState<string | null>(null) // 等待確認的批次樣態（null = 無）

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

  // 批次樣態的說明文字（確認彈窗用）
  const batchStatusLabel = (status: string) => {
    if (status === 'clear') return '正常上班（恢復可排班）'
    if (status === 'off') return '排休'
    if (status === 'unavailable') return '沒空時段'
    return `希望安排「${shiftTypes.find((s) => s.code === status)?.name || status}」`
  }

  // 點批次樣態按鈕：先跳出確認視窗；「沒空時段」先帶入預設起訖時間
  const requestBatch = (status: string) => {
    if (batchDays.size === 0) {
      toast('請先選取要設定的日期', 'error')
      return
    }
    if (status === 'unavailable') {
      setStartTime(defaultStart)
      setEndTime(defaultEnd)
    }
    setBatchConfirm(status)
  }

  // 把選取的所有日期一次套用同一樣態（只重新載入一次）
  const batchSave = async (status: string, times?: { start: string; end: string }) => {
    const days = [...batchDays].sort((a, b) => a - b)
    try {
      for (const day of days) {
        const date = dateKey(year, month, day)
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
      }
      await load()
      toast(`已將 ${days.length} 天設定為「${batchStatusLabel(status)}」`)
      setBatchDays(new Set())
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // 結束批次設定模式
  const exitBatch = () => {
    setBatchMode(false)
    setBatchDays(new Set())
    setBatchConfirm(null)
  }

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
        <MonthNav
          year={year}
          month={month}
          onChange={(y, m) => {
            setYear(y)
            setMonth(m)
            setBatchDays(new Set())
          }}
        />
        <label className="field field--inline">
          <span className="field__label">員工</span>
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value)
              setBatchDays(new Set())
            }}
            disabled={!isAdmin}
          >
            {isAdmin ? (
              <>
                <option value="">全部員工（總覽）</option>
                {activeEmployees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </>
            ) : (
              <option value={selected}>{empName}</option>
            )}
          </select>
        </label>
        {selected && (
          <button
            type="button"
            className={`btn btn--small${batchMode ? ' btn--primary' : ''}`}
            onClick={() => {
              if (batchMode) exitBatch()
              else setBatchMode(true)
            }}
          >
            {batchMode ? '結束批次設定' : '批次設定'}
          </button>
        )}
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
          {/* 批次設定浮動工具列：選取多天，一次套用同一樣態 */}
          {batchMode && (
            <div className="batch-bar">
              <span className="batch-bar__info">
                批次設定・已選取 <b>{batchDays.size}</b> 天
              </span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setBatchDays(new Set(Array.from({ length: days }, (_, i) => i + 1)))}
              >
                全選
              </button>
              <button type="button" className="btn btn--small" onClick={() => setBatchDays(new Set())}>
                取消全選
              </button>
              <button type="button" className="batch-btn batch-btn--clear" onClick={() => requestBatch('clear')}>
                <i className="batch-btn__dot" />
                正常上班
              </button>
              <button type="button" className="batch-btn batch-btn--off" onClick={() => requestBatch('off')}>
                <i className="batch-btn__dot" />
                排休
              </button>
              <button
                type="button"
                className="batch-btn batch-btn--unavailable"
                onClick={() => requestBatch('unavailable')}
              >
                <i className="batch-btn__dot" />
                沒空時段
              </button>
              {shiftTypes
                .filter((s) => s.code !== 'OFF')
                .map((s) => {
                  const pal = statusPalette(undefined, s)
                  return (
                    <button
                      key={s.code}
                      type="button"
                      className="batch-btn"
                      style={{ '--batch': pal.bar } as CSSProperties}
                      onClick={() => requestBatch(s.code)}
                    >
                      <ShiftIcon shift={s} size={12} />
                      希望安排「{s.name}」
                      </button>
                    )
                  })}
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
                  className={`avail-cell${cellClass(rec)}${isToday ? ' avail-cell--today' : ''}${batchMode && batchDays.has(day) ? ' avail-cell--batch' : ''}`}
                  onClick={() => {
                    if (batchMode) {
                      setBatchDays((prev) => {
                        const next = new Set(prev)
                        if (next.has(day)) next.delete(day)
                        else next.add(day)
                        return next
                      })
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
            點擊日期可單獨設定當天狀態：「排休」整天不排班；「沒空時段」表示該時段不排班；也可指定當日偏好安排早班或晚班。若要一次設定多天，按右上角〈批次設定〉選取日期後，即可統一設為同一樣態。
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
              // 第二層：選擇這天的狀態（正常/排休/沒空/偏好某班別）
              <div className="option-list">
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

      {batchConfirm && (
        <Modal title="批次設定確認" onClose={() => setBatchConfirm(null)}>
          <div className="stack">
            <p className="modal-lead">
              您將在{month} 月份，對 <b>{batchDays.size}</b> 天設定為「{batchStatusLabel(batchConfirm)}」，是否確定？
            </p>
            <div className="batch-dates">
              {[...batchDays].sort((a, b) => a - b).map((d) => (
                <span key={d} className="batch-date-chip">
                  {month}/{d}
                </span>
              ))}
            </div>
            {batchConfirm === 'unavailable' && (
              <>
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
                <p className="hint">選取的所有日期都會使用同一個沒空時段（該時段內不排班）。</p>
              </>
            )}
            <div className="modal__actions">
              <button type="button" className="btn" onClick={() => setBatchConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={async () => {
                  const status = batchConfirm
                  if (status === 'unavailable' && startTime >= endTime) {
                    toast('結束時段必須晚於開始時段', 'error')
                    return
                  }
                  setBatchConfirm(null)
                  await batchSave(status, status === 'unavailable' ? { start: startTime, end: endTime } : undefined)
                }}
              >
                確認設定
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}