import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import {
  dateKey,
  dayTypeOf,
  daysInMonth,
  firstDayOffset,
  settingsToMap,
  statusPalette,
  today,
  WEEKDAYS,
  type Assignment,
  type Availability,
  type Employee,
  type Headcount,
  type Setting,
  type ShiftType,
} from '../types'
import { useAuth } from '../auth'
import MonthNav from '../components/MonthNav'
import { Modal, Spinner, toast } from '../components/ui'
import { ShiftIcon } from '../components/icons'

// =============================================================
// Schedule.tsx —— 班表總覽（首頁）
// 月曆式的班表：每一格是一天，上半部顯示已排的班（shift-chip，
// 底色 = 員工代表色），下半部顯示每位員工當日的狀態圓點（avail-dot）。
// 管理員可拖曳操作：圓點 → 班別/「＋」＝新增人員；姓名方塊 → 下方區塊＝移除。
//
// 資料來源：useMonthData() 一次抓齊 班表/員工/班別/排休 四份資料（見下方）。
// =============================================================

// 一格裡的一份「排班」，連同該員工資料（方便直接取姓名、顏色）
interface ShiftSlot {
  assignment?: Assignment
  employee?: Employee
}

// 依背景色亮度決定文字用深色或白色（避免深色底配深色字看不清楚）
function chipTextColor(hex: string): string {
  const h = hex.replace('#', '')
  const r = Number.parseInt(h.slice(0, 2), 16) / 255
  const g = Number.parseInt(h.slice(2, 4), 16) / 255
  const b = Number.parseInt(h.slice(4, 6), 16) / 255
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.5 ? '#2a2418' : '#ffffff'
}

// 自訂 hook：管理「目前顯示的月份」以及該月份所需的所有資料。
// 回傳的 reload() 可重抓資料；切換月份時 load 因依賴 [year, month] 改變而自動重跑。
function useMonthData() {
  const t = today()
  const [year, setYear] = useState(t.year)
  const [month, setMonth] = useState(t.month)
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([])
  const [availability, setAvailability] = useState<Availability[]>([])
  const [headcounts, setHeadcounts] = useState<Headcount[]>([]) // 每班別每種日型的需求人數（判斷人力不足用）
  const [settings, setSettings] = useState<Setting[]>([])       // 含例假日清單（判斷某天是平日/週末/例假日用）
  const [loading, setLoading] = useState(true)
  const assignmentsRef = useRef<Assignment[]>([])

  // 抓取這個月需要的所有資料（多支 API 同時抓）。silent=true 時不顯示整頁載入。
  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = !!opts?.silent
      if (!silent) setLoading(true)
      try {
        const [a, e, s, av, hc, st] = await Promise.all([
          api<{ assignments: Assignment[] }>(`/schedule?year=${year}&month=${month}`),
          api<{ employees: Employee[] }>('/employees'),
          api<{ shiftTypes: ShiftType[] }>('/shift-types'),
          api<{ availability: Availability[] }>(`/availability?year=${year}&month=${month}`),
          api<{ headcounts: Headcount[] }>('/headcounts'),
          api<{ settings: Setting[] }>('/settings'),
        ])
        // 靜默重整時，避免後端一時回空班表把剛排好的資料洗掉
        if (!(silent && a.assignments.length === 0 && assignmentsRef.current.length > 0)) {
          setAssignments(a.assignments)
        }
        setEmployees(e.employees)
        setShiftTypes(s.shiftTypes)
        setAvailability(av.availability)
        setHeadcounts(hc.headcounts)
        setSettings(st.settings)
      } catch (err) {
        toast((err as Error).message, 'error')
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [year, month],
  )

  // 記住最新班表，供上面的「靜默重整防洗掉」比對用
  useEffect(() => {
    assignmentsRef.current = assignments
  }, [assignments])

  // 進頁面（或切換月份）時抓一次資料
  useEffect(() => {
    void load()
  }, [load])

  return { year, month, setYear, setMonth, assignments, setAssignments, employees, shiftTypes, availability, headcounts, settings, loading, reload: load }
}

export default function Schedule() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const data = useMonthData()
  const { year, month, assignments, employees, shiftTypes, availability, headcounts, settings } = data
  const [editing, setEditing] = useState<{ day: number; shiftCode: string | null; employeeId?: string } | null>(null) // 正在編輯哪一天的指派（null = 沒開彈窗）
  const [dropTarget, setDropTarget] = useState<string | null>(null)            // 拖曳中目前停在哪個格子（用來加亮「＋」或班別）
  const [removeDrag, setRemoveDrag] = useState<{ day: number; shift_code: string; employee_id: string } | null>(null) // 拖曳移除中的人員
  const [generating, setGenerating] = useState(false)                          // 是否正在自動排班

  // 把「員工陣列」轉成「ID → 員工」的查詢表，方便直接查姓名/顏色
  const empById = useMemo(() => {
    const m = new Map<string, Employee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  // 把「班別陣列」轉成「code → 班別」的查詢表
  const shiftById = useMemo(() => {
    const m = new Map<string, ShiftType>()
    for (const s of shiftTypes) m.set(s.code, s)
    return m
  }, [shiftTypes])

  // 例假日清單（來自排班規則設定）→ Set，供 dayTypeOf 判斷某天是 平日/週末/例假日
  const holidaySet = useMemo(() => {
    const holidays = settingsToMap(settings).holidays || ''
    return new Set(holidays.split(/[\n,;\s]+/).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)))
  }, [settings])

  // 「班別代碼:日型」→ 需求人數 查詢表（判斷每個班別這天需要幾人）
  const headcountMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of headcounts) m.set(`${h.shift_code}:${h.day_type}`, Number(h.count) || 0)
    return m
  }, [headcounts])

  // 「哪一天有哪些已排的班」查詢表（含員工資料），renderCell 用它畫出每格
  const slotsByDay = useMemo(() => {
    const map: Record<number, ShiftSlot[]> = {}
    for (const a of assignments) {
      const slots = (map[a.day] = map[a.day] || [])
      slots.push({ assignment: a, employee: empById.get(a.employee_id) })
    }
    return map
  }, [assignments, empById])

  // 「員工ID:日期」→ 排休記錄 的查詢表，判斷某員工當天狀態（排休/沒空/偏好）
  const availByKey = useMemo(() => {
    const m = new Map<string, Availability>()
    for (const a of availability) m.set(`${a.employee_id}:${a.date}`, a)
    return m
  }, [availability])

  // 只算還在職的員工（active !== '0'）
  const activeEmployees = useMemo(() => employees.filter((e) => e.active !== '0'), [employees])

  // 每月彙總：每位員工有幾次排休/沒空/偏好（顯示在下方「本月人力彙總」）
  const monthStat = useMemo(() => {
    const map: Record<string, { off: number; unavail: number; prefer: number }> = {}
    for (const a of availability) {
      const st = (map[a.employee_id] = map[a.employee_id] || { off: 0, unavail: 0, prefer: 0 })
      if (a.status === 'off') st.off++
      else if (a.status === 'unavailable') st.unavail++
      else if (a.status) st.prefer++
    }
    return map
  }, [availability])

  // 狀態文字（圓點滑鼠移上去的說明）與狀態顏色
  const statusLabel = (rec?: Availability) => {
    if (!rec || rec.status === 'available') return '可排班'
    if (rec.status === 'off') return '排休'
    if (rec.status === 'unavailable') return `沒空 ${rec.start_time}–${rec.end_time}`
    return `偏好 ${shiftById.get(rec.status)?.name || rec.status}`
  }

  // 偏好班別圓點色：早班（開始 <15:00）= 琥珀色（太陽），晚/夜班 = 淡紫
  const preferColor = (shift?: ShiftType): string => {
    if (!shift?.start_time) return '#6b7280'
    const h = Number(shift.start_time.split(':')[0])
    return Number.isFinite(h) && h < 15 ? '#F59E0B' : '#a78bfa'
  }

  // 本月人力彙總的計算：每人排幾班、各班別排幾班、長條圖比例
  const stats = useMemo(() => {
    const perEmp: Record<string, number> = {}
    const perShift: Record<string, number> = {}
    for (const a of assignments) {
      perEmp[a.employee_id] = (perEmp[a.employee_id] || 0) + 1
      perShift[a.shift_code] = (perShift[a.shift_code] || 0) + 1
    }
    const rows = employees
      .filter((e) => e.active !== '0')
      .map((e) => ({ employee: e, total: perEmp[e.id] || 0 }))
      .sort((a, b) => b.total - a.total || a.employee.name.localeCompare(b.employee.name, 'zh-Hant'))
    const max = Math.max(1, ...rows.map((r) => r.total))
    return { perEmp, perShift, rows, max }
  }, [assignments, employees])

  const days = daysInMonth(year, month)
  const offset = firstDayOffset(year, month)
  const now = new Date()
  const todayKey = dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate())
  const workShifts = shiftTypes.filter((s) => s.code !== 'OFF')

  // 把「拖曳中的員工」放進某天某班別：檢查當日是否已排班，然後打開指派彈窗（shiftCode 已預選）
  const dropToAssign = (day: number, shiftCode: string | null, e: React.DragEvent) => {
    const empId = e.dataTransfer.getData('application/x-emp-id')
    if (!empId || !isAdmin) return
    const todayAssignments = assignments.filter((a) => a.day === day)
    const empIdsToday = new Set(todayAssignments.map((a) => a.employee_id))
    if (empIdsToday.has(empId)) {
      toast('該員工當日已排班', 'error')
      return
    }
    setDropTarget(null)
    setEditing({ day, shiftCode, employeeId: empId })
  }

  // 移除一筆排班：送 PUT /schedule/assign 帶 action:'remove'，成功後靜默重整
  const removeAssignment = async (target: { day: number; shift_code: string; employee_id: string }) => {
    const emp = empById.get(target.employee_id)
    try {
      await api('/schedule/assign', {
        method: 'PUT',
        body: {
          year,
          month,
          day: target.day,
          shift_code: target.shift_code,
          employee_id: target.employee_id,
          action: 'remove',
        },
      })
      toast(`已移除「${emp?.name || '該員工'}」`)
      await data.reload({ silent: true })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // 置換：把某員工從原班別「移動」到目標班別（限同一天）。
  // 做法：先從原班別移除，再加到目標班別（備註一併帶過去）；
  // 若第二步失敗會自動還原，避免人員消失。
  const swapAssignment = async (
    src: { day: number; shift_code: string; employee_id: string; note?: string },
    dst: { day: number; shift_code: string },
  ) => {
    if (src.day !== dst.day) {
      toast('只能在同一日內置換班別', 'error')
      return
    }
    if (src.shift_code === dst.shift_code) {
      setRemoveDrag(null)
      return
    }
    const emp = empById.get(src.employee_id)
    try {
      await api('/schedule/assign', {
        method: 'PUT',
        body: { year, month, day: src.day, shift_code: src.shift_code, employee_id: src.employee_id, action: 'remove' },
      })
    } catch (err) {
      toast((err as Error).message, 'error')
      return
    }
    try {
      await api('/schedule/assign', {
        method: 'PUT',
        body: {
          year,
          month,
          day: src.day,
          shift_code: dst.shift_code,
          employee_id: src.employee_id,
          action: 'add',
          note: src.note || '',
        },
      })
    } catch (err) {
      // 加入失敗：把剛才移除的排班還原回去
      try {
        await api('/schedule/assign', {
          method: 'PUT',
          body: { year, month, day: src.day, shift_code: src.shift_code, employee_id: src.employee_id, action: 'add', note: src.note || '' },
        })
      } catch {
        /* 還原失敗則忽略 */
      }
      toast((err as Error).message, 'error')
      return
    }
    toast(`已將「${emp?.name || '該員工'}」置換到 ${shiftById.get(dst.shift_code)?.name || dst.shift_code}`)
    await data.reload({ silent: true })
  }

  // 畫「月曆的每一格」＝一天。上半部是已排的班，下半部是每位員工的狀態圓點
  function renderCell(day: number) {
    const slots = slotsByDay[day] || []
    const key = dateKey(year, month, day)
    const isToday = key === todayKey
    const weekday = WEEKDAYS[(offset + day - 1) % 7]
    const scheduledEmpIds = new Set(slots.map((s) => s.assignment!.employee_id))
    // 依班別開始時間判斷上午(<15點)或下午，把格子分成兩半
    const isAm = (shift?: ShiftType) => {
      const h = shift?.start_time ? Number(shift.start_time.split(':')[0]) : NaN
      return Number.isFinite(h) && h < 15
    }
    const amSlots = slots.filter((s) => isAm(shiftById.get(s.assignment!.shift_code)))
    const pmSlots = slots.filter((s) => !isAm(shiftById.get(s.assignment!.shift_code)))

    // 判斷這天「人力不足」：逐班別比對 需求人數 > 實際排班人數。
    // 需求 0 = 該班當日不開，不算不足；完全沒排到人的班別也會被算進去
    const dayType = dayTypeOf(year, month, day, holidaySet)
    const countByShift: Record<string, number> = {}
    for (const s of slots) {
      const code = s.assignment!.shift_code
      countByShift[code] = (countByShift[code] || 0) + 1
    }
    let hasShort = false
    for (const st of shiftTypes) {
      if (st.code === 'OFF') continue
      const need = headcountMap.get(`${st.code}:${dayType}`) || 0
      if (need > 0 && (countByShift[st.code] || 0) < need) {
        hasShort = true
        break
      }
    }

    // 一個「已排班的姓名方塊」（shift-chip）：
    // 底色 = 員工代表色；可點擊編輯；可拖曳到其他班別置換、到下方「移除此人員」區塊移除
    const renderSlot = (slot: ShiftSlot) => {
      const shift = shiftById.get(slot.assignment!.shift_code)
      const name = slot.employee?.name || '?'
      const rec = availByKey.get(`${slot.assignment!.employee_id}:${key}`)
      const conflict = rec?.status === 'off' || rec?.status === 'unavailable'
      const code = slot.assignment!.shift_code
      return (
        <button
          key={`${code}:${slot.assignment!.employee_id}`}
          type="button"
          draggable={isAdmin}
          className={`shift-chip${conflict ? ' shift-chip--conflict' : ''}${dropTarget === `${day}:${code}` ? ' shift-chip--drop' : ''}${isAdmin ? ' shift-chip--drag' : ''}`}
          style={slot.employee?.color ? { background: slot.employee.color, color: chipTextColor(slot.employee.color), borderColor: 'rgba(0, 0, 0, 0.16)' } : undefined}
          onClick={() => isAdmin && setEditing({ day, shiftCode: code })}
          onDragStart={(ev) => {
            if (!isAdmin) return
            // 拖曳開始：寫入「來源班別/人員」資料，並亮出下方的移除區塊。
            // 放到其他班別 = 置換；放到下方區塊 = 移除
            ev.dataTransfer.setData(
              'application/x-remove-shift',
              JSON.stringify({
                day,
                shift_code: slot.assignment!.shift_code,
                employee_id: slot.assignment!.employee_id,
                note: slot.assignment!.note || '',
              }),
            )
            ev.dataTransfer.effectAllowed = 'move'
            setRemoveDrag({ day, shift_code: slot.assignment!.shift_code, employee_id: slot.assignment!.employee_id })
          }}
          onDragEnd={() => setRemoveDrag(null)}
          onDragOver={(ev) => {
            // 接受「員工圓點」拖進來（新增人員），也接受「其他班別的姓名方塊」拖進來（置換）
            if (
              isAdmin &&
              (ev.dataTransfer.types.includes('application/x-emp-id') ||
                ev.dataTransfer.types.includes('application/x-remove-shift'))
            ) {
              ev.preventDefault()
              ev.dataTransfer.dropEffect = 'move'
              setDropTarget(`${day}:${slot.assignment!.shift_code}`)
            }
          }}
          onDrop={(ev) => {
            ev.preventDefault()
            setDropTarget(null)
            const srcRaw = ev.dataTransfer.getData('application/x-remove-shift')
            if (srcRaw) {
              // 拖來的是「別的班別的姓名方塊」→ 置換到這個班別
              setRemoveDrag(null)
              try {
                const src = JSON.parse(srcRaw) as {
                  day: number
                  shift_code: string
                  employee_id: string
                  note?: string
                }
                void swapAssignment(src, { day, shift_code: slot.assignment!.shift_code })
              } catch {
                toast('置換失敗', 'error')
              }
              return
            }
            dropToAssign(day, slot.assignment!.shift_code, ev)
          }}
          title={`${isAdmin ? '點擊修改此班／拖曳員工圓點到此可新增人員；拖曳此方塊到其他班別可置換、到下方區塊可移除。' : ''}${shift?.name || ''}・${name}${slot.assignment!.note ? `（備註：${slot.assignment!.note}）` : ''}${conflict ? `（注意：當日標記「${statusLabel(rec)}」）` : ''}`}
        >
          {conflict && (
            <span className="shift-chip__warn" title={`${name} 當日標記「${statusLabel(rec)}」`}>
              ⚠
            </span>
          )}
          <span className="shift-chip__name">{name}</span>
          {slot.assignment!.note && <span className="shift-chip__note">{slot.assignment!.note}</span>}
        </button>
      )
    }

    return (
      <div key={day} className={`cal-cell${isToday ? ' cal-cell--today' : ''}${hasShort ? ' cal-cell--short' : ''}`}>
        <div className="cal-cell__head">
          <span className="cal-cell__day">{day}</span>
          <span className="cal-cell__week">{weekday}</span>
          <span className="cal-cell__flags">
            {hasShort && (
              <span className="cal-cell__short" title="尚有班別未達需求人數">
                <span className="cal-cell__short-icon">⚠</span>人力不足
              </span>
            )}
            {isToday && <span className="cal-cell__today">今天</span>}
          </span>
        </div>
        <div className="cal-cell__shifts">
          {slots.length > 0 ? (
            <>
              {amSlots.length > 0 && (
                <div className="cal-cell__half">
                  <span className="cal-cell__halflabel">上午</span>
                  {amSlots.map(renderSlot)}
                </div>
              )}
              {pmSlots.length > 0 && (
                <div className="cal-cell__half">
                  <span className="cal-cell__halflabel">下午</span>
                  {pmSlots.map(renderSlot)}
                </div>
              )}
            </>
          ) : null}
          {/* 「＋」按鈕：點擊開啟人力指派；也可把員工圓點拖到這裡加入新班別 */}
          {isAdmin && (
            <button
              type="button"
              className={`shift-chip shift-chip--add${dropTarget === `${day}:+` ? ' shift-chip--drop' : ''}`}
              onClick={() => setEditing({ day, shiftCode: null })}
              onDragOver={(ev) => {
                if (isAdmin && ev.dataTransfer.types.includes('application/x-emp-id')) {
                  ev.preventDefault()
                  ev.dataTransfer.dropEffect = 'move'
                  setDropTarget(`${day}:+`)
                }
              }}
              onDrop={(ev) => {
                ev.preventDefault()
                setDropTarget(null)
                dropToAssign(day, null, ev)
              }}
              title="點擊開啟人力指派；拖曳員工圓點到這裡可選擇班別加入"
            >
              ＋
            </button>
          )}
        </div>
        {/* 格子下半部：每位員工的姓名方塊（狀態底色，有排班者以勾勾標示，可拖曳） */}
        {isAdmin && (
          <div className="cal-cell__avail cal-cell__avail--flow">
            {activeEmployees.map((emp) => {
              const rec = availByKey.get(`${emp.id}:${key}`)
              const onDuty = scheduledEmpIds.has(emp.id)
              const conflict = onDuty && (rec?.status === 'off' || rec?.status === 'unavailable')
              const isPrefer = !!rec && rec.status !== 'available' && rec.status !== 'off' && rec.status !== 'unavailable'
              const preferShift = isPrefer ? shiftTypes.find((s) => s.code === rec.status) : undefined
              const pal = statusPalette(rec, preferShift)
              return (
                <button
                  key={emp.id}
                  type="button"
                  draggable={isAdmin}
                  className={`cal-emp${onDuty ? ' cal-emp--duty' : ''}${conflict ? ' cal-emp--conflict' : ''}`}
                  style={{ background: pal.bg, color: pal.fg, borderColor: pal.border }}
                  onDragStart={(ev) => {
                    ev.dataTransfer.setData('application/x-emp-id', emp.id)
                    ev.dataTransfer.effectAllowed = 'move'
                    setDropTarget(null)
                  }}
                  onDragEnd={() => setDropTarget(null)}
                  title={`${emp.name}：${statusLabel(rec)}${onDuty ? '（已排班）' : ''}${isAdmin ? '（可拖曳到「＋」或任一班別自動加入）' : ''}`}
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
        )}
        {!isAdmin && slots.length === 0 && <div className="cal-cell__empty">—</div>}
      </div>
    )
  }

  // —— 頁面本體：標題列（月份切換 + 自動排班按鈕）——
  return (
    <div className="view">
      <div className="view__head">
        <MonthNav year={year} month={month} onChange={(y, m) => { data.setYear(y); data.setMonth(m) }} />
        {isAdmin && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={generating}
            onClick={() => {
              // 按下「自動排班」：叫後端跑演算法，完成後用回傳的班表刷新畫面
              const startedAt = Date.now()
              setGenerating(true)
              void (async () => {
                try {
                  const res = await api<{ assignments: Assignment[]; unfilled: { day: number; shift_code: string }[]; summary: { totalSlots: number; employees: number } }>('/schedule/generate', {
                    method: 'POST',
                    body: { year, month },
                  })
                  data.setAssignments(res.assignments)
                  data.reload()
                  const unfilledCount = res.unfilled.length
                  toast(
                    unfilledCount > 0
                      ? `已產生班表（${res.summary.totalSlots} 班），但有 ${unfilledCount} 個時段人力不足`
                      : `已產生班表：共 ${res.summary.totalSlots} 班`,
                    unfilledCount > 0 ? 'error' : 'ok',
                  )
                } catch (e) {
                  toast((e as Error).message, 'error')
                } finally {
                  // 至少顯示 1 秒的「排班中」動畫，避免一閃而過
                  const remain = 1000 - (Date.now() - startedAt)
                  setTimeout(() => setGenerating(false), Math.max(0, remain))
                }
              })()
            }}
          >
            {generating ? '⟳ 排班中…' : '⟳ 自動排班'}
          </button>
        )}
      </div>

      {generating && (
        <div className="gen-progress" aria-label="正在自動排班">
          <div className="gen-progress__track">
            <div className="gen-progress__bar" />
          </div>
          <span className="gen-progress__label">正在自動排班…</span>
        </div>
      )}

      {data.loading ? (
        <Spinner label="載入班表中…" />
      ) : (
        <>
          {/* 圖例：說明排休、沒空、當日已排班、衝突、人力不足、偏好的顯示方式 */}
          {isAdmin && (
            <div className="legend">
              <span className="legend__item">
                <i style={{ background: '#16a34a' }} />
                可排班
              </span>
              <span className="legend__item">
                <i style={{ background: '#dc2626' }} />
                排休
              </span>
              <span className="legend__item">
                <i style={{ background: '#6b7280' }} />
                沒空時段
              </span>
              <span className="legend__item">
                <i className="legend-stroke" />
                當日已排班
              </span>
              <span className="legend__item">
                <i className="legend-warn">⚠</i>
                衝突
              </span>
              <span className="legend__item">
                <i className="legend-short" />
                人力不足
              </span>
              {workShifts.map((s) => (
                <span key={s.code} className="legend__item">
                  <i className="legend-dot--prefer" style={{ background: preferColor(s) }} />
                  <ShiftIcon shift={s} /> 偏好{s.name}
                </span>
              ))}
            </div>
          )}

          {/* 月曆本體：星期標題 + 空白填位 + 每一天 */}
          <div className="cal cal--month">
            <div className="cal__grid">
              {WEEKDAYS.map((w, i) => (
                <div key={w} className={`cal-weekhead${i >= 5 ? ' cal-weekhead--weekend' : ''}`}>
                  {w}
                </div>
              ))}
              {Array.from({ length: offset }, (_, i) => (
                <div key={`blank-${i}`} className="cal-cell cal-cell--blank" />
              ))}
              {Array.from({ length: days }, (_, i) => renderCell(i + 1))}
            </div>
          </div>

          {/* 本月人力彙總：每人排班數（長條圖）+ 各班別總數 */}
          <section className="panel stats">
            <h3 className="panel__title">本月人力彙總</h3>
            <div className="stats__grid">
              {stats.rows.map(({ employee, total }) => {
                const st = monthStat[employee.id]
                const extra = st
                  ? [
                      st.off ? `${st.off} 排休` : '',
                      st.unavail ? `${st.unavail} 沒空` : '',
                      st.prefer ? `${st.prefer} 偏好` : '',
                    ]
                      .filter(Boolean)
                      .join('・')
                  : ''
                return (
                  <div key={employee.id} className="stat-row">
                    <span className="stat-row__name">
                      <span className="stat-row__nameline">
                        <i className="emp-color-dot" style={{ background: employee.color || '#6b7280' }} />
                        {employee.name}
                      </span>
                      <em>{employee.department}{extra && `・${extra}`}</em>
                    </span>
                    <div className="stat-row__bar">
                      <div className="stat-row__fill" style={{ width: `${(total / stats.max) * 100}%` }} />
                    </div>
                    <span className="stat-row__num">{total} 班</span>
                  </div>
                )
              })}
              {stats.rows.length === 0 && <p className="muted">尚未有員工資料</p>}
            </div>
            <div className="stats__shifts">
              {workShifts.map((s) => (
                <span key={s.code} className="stat-shift">
                  <i style={{ background: s.color }} />
                  {s.name} 共 {stats.perShift[s.code] || 0} 班
                </span>
              ))}
            </div>
          </section>
        </>
      )}

      {/* 人力指派彈窗：關閉後用彈窗內的 local 資料更新畫面（避免閃跳），再靜默重整對齊後端 */}
      {editing && (
        <AssignModal
          year={year}
          month={month}
          day={editing.day}
          initialShiftCode={editing.shiftCode}
          initialEmployeeId={editing.employeeId}
          shiftTypes={shiftTypes}
          employees={employees}
          assignedDay={assignments.filter((a) => a.day === editing.day)}
          onClose={(finalLocal) => {
            setEditing(null)
            data.setAssignments((prev) => [...prev.filter((a) => a.day !== editing.day), ...finalLocal])
            window.setTimeout(() => data.reload({ silent: true }), 600)
          }}
        />
      )}

      {isAdmin && (
        <p className="hint">
          提示：班別可直接點擊修改人力；格子下方圓點為各員工當日狀態，<b>拖曳圓點到「＋」或任一班別會跳出視窗選擇要加入的班別</b>。<b>拖曳已排班的姓名方塊到其他班別可直接「置換」班別</b>，<b>拖到下方「移除此人員」區塊則直接移除</b>。有「⚠」代表該員工已排班但當日標記排休或沒空，請檢查。<b>日期格子有紅色虛線外框＋「⚠人力不足」標籤</b>代表當日尚有班別未達〈班別與人力〉的需求人數。
          {(() => {
            const offCount = availability.filter((a) => a.status === 'off').length
            return offCount > 0 ? ` 本月共有 ${offCount} 個排休記錄。` : ''
          })()}
        </p>
      )}

      {/* 拖曳移除時浮出的紅色區塊：把姓名方塊拖到這裡放開就移除 */}
      {removeDrag && (
        <div
          className="remove-dropzone"
          onDragOver={(ev) => {
            ev.preventDefault()
            ev.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(ev) => {
            ev.preventDefault()
            setRemoveDrag(null)
            void removeAssignment(removeDrag)
          }}
          title="放開以移除此人員"
        >
          <span className="remove-dropzone__icon">🗑</span>
          移除此人員（{empById.get(removeDrag.employee_id)?.name || '?'}・{shiftById.get(removeDrag.shift_code)?.name || removeDrag.shift_code}）
        </div>
      )}
    </div>
  )
}
// =============================================================
// AssignModal —— 人力指派彈窗
// 顯示某一天某個班別的人員；可新增人員、移除人員、填寫備註。
// 每次操作都會即時寫入後端（PUT /schedule/assign），同時更新彈窗內的
// local 狀態；關閉時把 local 回傳給父層更新畫面。
// =============================================================
function AssignModal({
  year,
  month,
  day,
  initialShiftCode,
  initialEmployeeId,
  shiftTypes,
  employees,
  assignedDay,
  onClose,
}: {
  year: number
  month: number
  day: number
  initialShiftCode: string | null
  initialEmployeeId?: string
  shiftTypes: ShiftType[]
  employees: Employee[]
  assignedDay: Assignment[]
  onClose: (finalLocal: Assignment[]) => void
}) {
  const workTypes = shiftTypes.filter((s) => s.code !== 'OFF')
  const [shiftCode, setShiftCode] = useState(initialShiftCode || workTypes[0]?.code || '') // 目前選中的班別
  const [local, setLocal] = useState<Assignment[]>(assignedDay)                            // 這天所有已排班（彈窗內即時維護的副本）
  const [newEmployeeId, setNewEmployeeId] = useState(initialEmployeeId || '')              // 「要新增的人員」下拉選到誰
  const [busy, setBusy] = useState(false)                                                  // 是否正在送後端
  const pendingRef = useRef(0)   // 還在進行中的儲存請求數（關閉時要等它們跑完）
  const localRef = useRef<Assignment[]>(local) // 最新 local 的鏡像，供關閉時的 async 讀取
  const closingRef = useRef(false) // 避免關閉動作重複觸發

  useEffect(() => {
    localRef.current = local
  }, [local])
  const empById = useMemo(() => {
    const m = new Map<string, Employee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  const people = local.filter((a) => a.shift_code === shiftCode) // 目前班別下的人員
  const usedToday = new Set(local.map((a) => a.employee_id))     // 當天已排過的人（每人每天只能一班）
  // 可新增的人選：在職、當天還沒排、且不在目前班別中
  const candidates = employees.filter(
    (e) => e.active !== '0' && !usedToday.has(e.id) && !people.some((p) => p.employee_id === e.id),
  )
  const draggedEmp = initialEmployeeId ? empById.get(initialEmployeeId) : undefined

  // 切換班別時：若「要新增的人員」下拉目前選的是「拖曳帶入」的員工則保留，
  // 方便直接加到新選的班別；其餘情況清空，避免把選錯的人誤加到其他班別
  const setShift = (code: string) => {
    setShiftCode(code)
    if (newEmployeeId && newEmployeeId !== initialEmployeeId) setNewEmployeeId('')
  }

  // 新增人員：送後端成功後，也同步更新彈窗內的 local 狀態
  const addPerson = async () => {
    if (!newEmployeeId || busy) return
    setBusy(true)
    pendingRef.current += 1
    try {
      await api('/schedule/assign', {
        method: 'PUT',
        body: { year, month, day, shift_code: shiftCode, employee_id: newEmployeeId, action: 'add' },
      })
      const entry: Assignment = { year, month, day, shift_code: shiftCode, employee_id: newEmployeeId }
      setLocal((prev) => (prev.some((a) => a.shift_code === shiftCode && a.employee_id === newEmployeeId) ? prev : [...prev, entry]))
      setNewEmployeeId('')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      pendingRef.current -= 1
      setBusy(false)
    }
  }

  // 移除人員：送後端成功後更新 local
  const removePerson = async (empId: string) => {
    if (busy) return
    setBusy(true)
    pendingRef.current += 1
    try {
      await api('/schedule/assign', {
        method: 'PUT',
        body: { year, month, day, shift_code: shiftCode, employee_id: empId, action: 'remove' },
      })
      const next = local.filter((a) => !(a.shift_code === shiftCode && a.employee_id === empId))
      setLocal(next)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      pendingRef.current -= 1
      setBusy(false)
    }
  }

  // 輸入框打字的同時，先把備註更新到 local（即時顯示）；真正儲存交給 saveNote
  const updateNoteLocal = (empId: string, note: string) => {
    setLocal((prev) => prev.map((a) => (a.shift_code === shiftCode && a.employee_id === empId ? { ...a, note } : a)))
  }

  // 備註儲存：離開輸入框（blur）時自動送後端
  const saveNote = async (empId: string, note: string) => {
    if (busy) return
    setBusy(true)
    pendingRef.current += 1
    try {
      await api('/schedule/assign', {
        method: 'PUT',
        body: { year, month, day, shift_code: shiftCode, employee_id: empId, action: 'add', note },
      })
      const next = local.map((a) => (a.shift_code === shiftCode && a.employee_id === empId ? { ...a, note } : a))
      setLocal(next)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      pendingRef.current -= 1
      setBusy(false)
    }
  }

  // 關閉：先觸發備註輸入框的 blur 儲存，等所有進行中的請求完成後，把 local 結果回傳給父層
  const handleDone = () => {
    if (closingRef.current) return
    closingRef.current = true
    const active = document.activeElement
    if (active instanceof HTMLInputElement && active.classList.contains('assign-note')) {
      active.blur()
    }
    void (async () => {
      while (pendingRef.current > 0) {
        await new Promise((r) => setTimeout(r, 80))
      }
      onClose(localRef.current)
    })()
  }

  return (
    <Modal title={`${month} 月 ${day} 日・${draggedEmp ? `加入「${draggedEmp.name}」` : '人力指派'}`} onClose={handleDone}>
      <div className="stack">
        {draggedEmp && (
          <p className="assign-target">
            將為 <b>{draggedEmp.name}</b> 選擇要加入的班別，再按「新增人員」。
          </p>
        )}
        <label className="field">
          <span className="field__label">班別</span>
          <select value={shiftCode} onChange={(e) => setShift(e.target.value)}>
            {workTypes.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}（{s.code}）{s.start_time && `${s.start_time}–${s.end_time}`}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="field__label">當日人員（可多人）</span>
          {people.length === 0 && <p className="muted">此班別目前無人。</p>}
          {/* 目前班別下的人員列：姓名 + 備註輸入框 + 移除按鈕 */}
          {people.map((p) => {
            const emp = empById.get(p.employee_id)
            return (
              <div key={p.employee_id} className="assign-person">
                <span className="assign-person__name">{emp?.name || '未知員工'}</span>
                <input
                  className="assign-note"
                  value={p.note || ''}
                  placeholder="備註"
                  onChange={(e) => updateNoteLocal(p.employee_id, e.target.value)}
                  onBlur={(e) => void saveNote(p.employee_id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <button type="button" className="btn btn--danger" disabled={busy} onClick={() => removePerson(p.employee_id)}>
                  移除
                </button>
              </div>
            )
          })}
        </div>
        <div className="assign-add">
          <select value={newEmployeeId} onChange={(e) => setNewEmployeeId(e.target.value)}>
            <option value="">— 選擇要新增的人員 —</option>
            {candidates.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--primary" disabled={busy || !newEmployeeId} onClick={addPerson}>
            新增人員
          </button>
        </div>
        <p className="hint">
          每位員工可填寫當天排班備註，會顯示在班表姓名後方（離開輸入框即自動儲存）。同一員工當天只會排一個班別；同一班別可安排多人，手動指派不受人數上限限制（上限僅套用於自動排班）。
        </p>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={handleDone}>
            完成
          </button>
        </div>
      </div>
    </Modal>
  )
}
