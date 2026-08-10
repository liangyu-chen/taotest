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
  type WorkItem,
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
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62 ? '#2a2418' : '#ffffff'
}

// 元素進入畫面時回傳 true（只觸發一次）
function useInView<T extends Element>(threshold = 0.3) {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            setInView(true)
            obs.disconnect()
          }
        }
      },
      { threshold },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, inView] as const
}

// 數字從 0 遞增到 target 的動畫（run 為 true 時開始）
function useCountUp(target: number, run: boolean, duration = 900): number {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (!run) return
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(target * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [run, target, duration])
  return val
}

// 本月人力彙總的一列：名稱＋班數在上、彙總明細在中、進度條在下；進場時動畫
function StatRow({
  name,
  color,
  total,
  max,
  meta,
}: {
  name: string
  color: string
  total: number
  max: number
  meta: string
}) {
  const [ref, inView] = useInView<HTMLDivElement>(0.3)
  const shown = useCountUp(total, inView)
  const pct = max > 0 ? Math.min(100, (total / max) * 100) : 0
  return (
    <div ref={ref} className="stat-row">
      <div className="stat-row__head">
        <span className="stat-row__nameline">
          <i className="emp-color-dot" style={{ background: color || '#6b7280' }} />
          {name}
        </span>
        <span className="stat-row__num">
          {shown} <em>班</em>
        </span>
      </div>
      {meta && <div className="stat-row__meta">{meta}</div>}
      <div className="stat-row__bar">
        <div className="stat-row__fill" style={{ width: inView ? `${pct}%` : '0%' }} />
      </div>
    </div>
  )
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
  const [workItems, setWorkItems] = useState<WorkItem[]>([])    // 工作項目（吧台/內場…，判斷工作項目是否滿足用）
  const [lockedDays, setLockedDays] = useState<number[]>([])    // 已鎖定的日期（自動排班會保留原狀）
  const [closedDays, setClosedDays] = useState<number[]>([])    // 公休日（當天不營業，自動排班跳過）
  const [prevAssignments, setPrevAssignments] = useState<Assignment[]>([]) // 上個月的排班（算跨月連續上班天數用）
  const [loading, setLoading] = useState(true)
  const assignmentsRef = useRef<Assignment[]>([])

  // 抓取這個月需要的所有資料（多支 API 同時抓）。silent=true 時不顯示整頁載入。
  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = !!opts?.silent
      if (!silent) setLoading(true)
      try {
        // 上個月（或跨年）的排班：供「跨月連續上班天數」往前回溯用
        const prevYear = month === 1 ? year - 1 : year
        const prevMonth = month === 1 ? 12 : month - 1
        const [a, e, s, av, hc, st, wi, lk, cd, prev] = await Promise.all([
          api<{ assignments: Assignment[] }>(`/schedule?year=${year}&month=${month}`),
          api<{ employees: Employee[] }>('/employees'),
          api<{ shiftTypes: ShiftType[] }>('/shift-types'),
          api<{ availability: Availability[] }>(`/availability?year=${year}&month=${month}`),
          api<{ headcounts: Headcount[] }>('/headcounts'),
          api<{ settings: Setting[] }>('/settings'),
          api<{ workItems: WorkItem[] }>('/work-items'),
          api<{ lockedDays: number[] }>(`/schedule/locks?year=${year}&month=${month}`),
          api<{ closedDays: number[] }>(`/schedule/closed?year=${year}&month=${month}`),
          api<{ assignments: Assignment[] }>(`/schedule?year=${prevYear}&month=${prevMonth}`),
        ])
        // 靜默重整時，避免後端一時回空班表把剛排好的資料洗掉
        if (!(silent && a.assignments.length === 0 && assignmentsRef.current.length > 0)) {
          setAssignments(a.assignments)
        }
        setPrevAssignments(prev.assignments)
        setEmployees(e.employees)
        setShiftTypes(s.shiftTypes)
        setAvailability(av.availability)
        setHeadcounts(hc.headcounts)
        setSettings(st.settings)
        setWorkItems(wi.workItems)
        setLockedDays(lk.lockedDays)
        setClosedDays(cd.closedDays)
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

  return { year, month, setYear, setMonth, assignments, setAssignments, prevAssignments, employees, shiftTypes, availability, headcounts, settings, workItems, lockedDays, setLockedDays, closedDays, setClosedDays, loading, reload: load }
}

export default function Schedule() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const data = useMonthData()
  const { year, month, assignments, prevAssignments, employees, shiftTypes, availability, headcounts, settings, workItems } = data
  const [editing, setEditing] = useState<{ day: number; shiftCode: string | null; employeeId?: string } | null>(null) // 正在編輯哪一天的指派（null = 沒開彈窗）
  const [dropTarget, setDropTarget] = useState<string | null>(null)            // 拖曳中目前停在哪個格子（用來加亮「＋」或班別）
  const [removeDrag, setRemoveDrag] = useState<{ day: number; shift_code: string; employee_id: string } | null>(null) // 拖曳移除中的人員
  const [removeDragOver, setRemoveDragOver] = useState(false) // 拖曳中的人員是否正指在垃圾桶上（用來亮起垃圾桶）
  const [isDragging, setIsDragging] = useState(false)                          // 是否正在拖曳（用來停用其他班別的 hover 效果，只突顯被拖曳者）
  const [generating, setGenerating] = useState(false)                          // 是否正在自動排班
  const [confirmGenerate, setConfirmGenerate] = useState(false)                // 是否顯示「自動排班」確認彈窗
  const [showRules, setShowRules] = useState(false)                            // 是否顯示「排班規則」說明彈窗
  const [confirmClosed, setConfirmClosed] = useState<number[] | null>(null)     // 準備設為公休日的日期（需二次確認）
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set())     // 被選取的日期（點格子選取，可多選）
  const { lockedDays, setLockedDays } = data
  const { closedDays, setClosedDays } = data

  // 切換月份時清掉目前的選取，避免選到舊月份的天數
  useEffect(() => {
    setSelectedDays(new Set())
  }, [year, month])

  // 點格子切換選取狀態（管理員限定；選擇後可用「鎖定/解除鎖定」一次處理多天）
  const toggleSelectDay = (day: number) => {
    if (!isAdmin) return
    setSelectedDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }

  // 鎖定或解除鎖定指定的日期，成功後更新畫面
  const applyLock = async (days: number[], locked: boolean) => {
    if (days.length === 0 || !isAdmin) return
    try {
      await api('/schedule/locks', {
        method: 'PUT',
        body: { year, month, days, locked },
      })
      setLockedDays((prev) => {
        const set = new Set(prev)
        for (const d of days) {
          if (locked) set.add(d)
          else set.delete(d)
        }
        return [...set].sort((a, b) => a - b)
      })
      toast(locked ? `已鎖定 ${days.length} 天（自動排班不會更動）` : `已解除 ${days.length} 天的鎖定`)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // 設定或解除公休日。設為公休日時，後端會一併清空該天的排班人員，
  // 前端也在本地同步移除對應排班，避免畫面殘留。
  const applyClosed = async (days: number[], closed: boolean) => {
    if (days.length === 0 || !isAdmin) return
    try {
      await api('/schedule/closed', {
        method: 'PUT',
        body: { year, month, days, closed },
      })
      setClosedDays((prev) => {
        const set = new Set(prev)
        for (const d of days) {
          if (closed) set.add(d)
          else set.delete(d)
        }
        return [...set].sort((a, b) => a - b)
      })
      if (closed) {
        // 公休日當天不營業：移除該日所有已排人員
        data.setAssignments((prev) => prev.filter((a) => !days.includes(a.day)))
      }
      toast(closed ? `已將 ${days.length} 天設為公休日（自動排班會跳過）` : `已解除 ${days.length} 天的公休日`)
      await data.reload({ silent: true })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // 執行自動排班：叫後端跑演算法，完成後用回傳的班表刷新畫面
  const runGenerate = async () => {
    if (generating) return
    const startedAt = Date.now()
    setGenerating(true)
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
          ? `已產生班表（${res.summary.totalSlots} 班），但有 ${unfilledCount} 個時段人力/工作未滿足`
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
  }

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

  // 上午/下午區域拖曳時的預設班別：
  // 把「1,2」這種逗號分隔的工作項目 id 字串轉成 WorkItem 列表（供姓名後方顯示）。
  // 一律依 workItems 的排序（工作項目管理頁的 sort）顯示，避免存檔順序不同導致圖示亂跳
  const workItemsOf = (raw?: string): WorkItem[] => {
    const ids = new Set(
      String(raw || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    return workItems.filter((w) => ids.has(String(w.id)))
  }

  // 例假日清單（來自排班規則設定）→ Set，供 dayTypeOf 判斷某天是 平日/週末/例假日
  const holidaySet = useMemo(() => {
    const holidays = settingsToMap(settings).holidays || ''
    return new Set(holidays.split(/[\n,;\s]+/).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)))
  }, [settings])

  // 每人每週最多連續工作天數（0 = 不限制）；手動加人時若會超過，彈窗顯示警告
  const maxConsecutiveWorkDays = useMemo(() => {
    const n = Number(settingsToMap(settings).max_consecutive_work_days) || 0
    return n > 0 ? n : 0
  }, [settings])

  // 「員工 → 有排班的日期集合」：含本月與上個月的排班，讓跨月連續上班天數數得準
  const dutyByEmp = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const add = (empId: string, dkey: string) => {
      let set = m.get(empId)
      if (!set) {
        set = new Set()
        m.set(empId, set)
      }
      set.add(dkey)
    }
    for (const a of assignments) add(a.employee_id, dateKey(a.year, a.month, a.day))
    for (const a of prevAssignments) add(a.employee_id, dateKey(a.year, a.month, a.day))
    return m
  }, [assignments, prevAssignments])

  // 計算某員工「以某天為中心」的連續上班天數（含該天）。
  // 該天本身一定算 1 天（即使還沒排班——人力指派彈窗在「新增」人員時那天尚未排，
  // 也要把這天算進去才知道排下去會連續幾天）。
  // 往前數時若一路數到當月 1 號仍連續，會繼續回溯到上個月（含跨年），
  // 讓「上個月連到本月初」的連續天數也能被偵測到。
  // 行事曆上用來在已排班方塊標示「連續工作天數超限」。
  const consecutiveDaysOf = useCallback(
    (empId: string, targetDay: number): number => {
      if (maxConsecutiveWorkDays <= 0) return 0
      const set = dutyByEmp.get(empId)
      const has = (y: number, m: number, d: number) => !!set?.has(dateKey(y, m, d))
      let count = 1
      // 往前數（跨月時切到上個月，資料只回溯一個月，再往前沒有資料自然停止）
      let y = year
      let m = month
      let d = targetDay - 1
      while (has(y, m, d)) {
        count++
        d--
        if (d < 1) {
          if (m === 1) {
            y--
            m = 12
          } else {
            m--
          }
          d = daysInMonth(y, m)
        }
      }
      // 往後數（只數到當月底；未來月份尚未排班）
      for (let d = targetDay + 1; d <= daysInMonth(year, month); d++) {
        if (!has(year, month, d)) break
        count++
      }
      return count
    },
    [year, month, dutyByEmp, maxConsecutiveWorkDays],
  )

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

  // 每月彙總：每位員工有幾次排休（顯示在下方「本月人力彙總」）
  const monthStat = useMemo(() => {
    const map: Record<string, { off: number }> = {}
    for (const a of availability) {
      if (a.status !== 'off') continue
      const st = (map[a.employee_id] = map[a.employee_id] || { off: 0 })
      st.off++
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

  // 本月人力彙總的計算：每人排幾班、每人每班別排幾班、各班別排幾班、長條圖比例
  const stats = useMemo(() => {
    const perEmp: Record<string, number> = {}
    const perEmpShift: Record<string, Record<string, number>> = {}
    const perShift: Record<string, number> = {}
    for (const a of assignments) {
      perEmp[a.employee_id] = (perEmp[a.employee_id] || 0) + 1
      perShift[a.shift_code] = (perShift[a.shift_code] || 0) + 1
      const e = (perEmpShift[a.employee_id] = perEmpShift[a.employee_id] || {})
      e[a.shift_code] = (e[a.shift_code] || 0) + 1
    }
    const rows = employees
      .filter((e) => e.active !== '0')
      .map((e) => ({ employee: e, total: perEmp[e.id] || 0 }))
      .sort((a, b) => b.total - a.total || a.employee.name.localeCompare(b.employee.name, 'zh-Hant'))
    const max = Math.max(1, ...rows.map((r) => r.total))
    return { perEmp, perEmpShift, perShift, rows, max }
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
    if (lockedDays.includes(day)) {
      toast('此日已鎖定，無法新增排班', 'error')
      return
    }
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
    if (lockedDays.includes(target.day)) {
      toast('此日已鎖定，無法移除排班', 'error')
      return
    }
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
      // 直接更新畫面：否則「本月只剩這筆、移除後回空班表」時，
      // 靜默重整的防洗掉保護會把回空結果擋掉，畫面就不會更新
      data.setAssignments((prev) =>
        prev.filter(
          (a) => !(a.day === target.day && a.shift_code === target.shift_code && a.employee_id === target.employee_id),
        ),
      )
      await data.reload({ silent: true })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // 置換：把某員工從原班別「移動」到目標班別（限同一天）。
  // 做法：先從原班別移除，再加到目標班別（備註一併帶過去）；
  // 若第二步失敗會自動還原，避免人員消失。
  const swapAssignment = async (
    src: { day: number; shift_code: string; employee_id: string; note?: string; work_item?: string },
    dst: { day: number; shift_code: string },
  ) => {
    if (src.day !== dst.day) {
      toast('只能在同一日內置換班別', 'error')
      return
    }
    if (lockedDays.includes(src.day)) {
      toast('此日已鎖定，無法更動排班', 'error')
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
          work_item: src.work_item || '',
        },
      })
    } catch (err) {
      // 加入失敗：把剛才移除的排班還原回去
      try {
        await api('/schedule/assign', {
          method: 'PUT',
          body: { year, month, day: src.day, shift_code: src.shift_code, employee_id: src.employee_id, action: 'add', note: src.note || '', work_item: src.work_item || '' },
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
    const isLocked = lockedDays.includes(day)
    const isClosed = closedDays.includes(day)
    const isSelected = selectedDays.has(day)
    const weekday = WEEKDAYS[(offset + day - 1) % 7]
    const scheduledEmpIds = new Set(slots.map((s) => s.assignment!.employee_id))
    // 依班別開始時間判斷上午(<15點)或下午，把格子分成兩半
    const isAm = (shift?: ShiftType) => {
      const h = shift?.start_time ? Number(shift.start_time.split(':')[0]) : NaN
      return Number.isFinite(h) && h < 15
    }
    const amSlots = slots.filter((s) => isAm(shiftById.get(s.assignment!.shift_code)))
    const pmSlots = slots.filter((s) => !isAm(shiftById.get(s.assignment!.shift_code)))

    // 公休日：當天不營業，直接顯示公休標記，不檢查人力/工作項目
    if (isClosed) {
      return (
        <div
          key={day}
          className={`cal-cell cal-cell--closed${isToday ? ' cal-cell--today' : ''}${isSelected ? ' cal-cell--selected' : ''}`}
          onClick={() => toggleSelectDay(day)}
          title={
            isAdmin
              ? '公休日：當天不營業，自動排班會跳過。點格子可選取後解除公休日。'
              : undefined
          }
        >
          <div className="cal-cell__head">
            <span className="cal-cell__day">{month}/{day}</span>
            <span className="cal-cell__week">{weekday}</span>
            <span className="cal-cell__flags">
              {isToday && <span className="cal-cell__today">今天</span>}
            </span>
          </div>
          <div className="cal-cell__closed">
            <span className="cal-cell__closed-badge">💤 公休</span>
            {isAdmin && (
              <button
                type="button"
                className="btn btn--tiny btn--ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  void applyClosed([day], false)
                }}
                title="解除公休日：恢復當天營業，自動排班會重新安排（不會動既有排班）"
              >
                解除公休
              </button>
            )}
          </div>
        </div>
      )
    }

    // 判斷這天「人力/工作未滿足」：
    // 1) 人力不足：逐班別比對 需求人數 > 實際排班人數（需求 0 = 該班當日不開，不算）
    // 2) 工作項目未滿足：有需求人數的班別，每個工作項目都要至少一人負責
    const dayType = dayTypeOf(year, month, day, holidaySet)
    const countByShift: Record<string, number> = {}
    for (const s of slots) {
      const code = s.assignment!.shift_code
      countByShift[code] = (countByShift[code] || 0) + 1
    }
    let headcountShort = false
    let workItemShort = false
    for (const st of shiftTypes) {
      if (st.code === 'OFF') continue
      const need = headcountMap.get(`${st.code}:${dayType}`) || 0
      if (need <= 0) continue
      if ((countByShift[st.code] || 0) < need) {
        headcountShort = true
      }
      if (workItems.length > 0) {
        const shiftSlots = slots.filter((s) => s.assignment!.shift_code === st.code)
        for (const w of workItems) {
          const covered = shiftSlots.some((s) =>
            String(s.assignment!.work_item || '')
              .split(',')
              .map((id) => id.trim())
              .includes(String(w.id)),
          )
          if (!covered) {
            workItemShort = true
            break
          }
        }
      }
      if (headcountShort && workItemShort) break
    }
    const hasShort = headcountShort || workItemShort
    const shortTitle = workItemShort ? '尚有班別人力/工作未滿足' : '尚有班別未達需求人數'

    // 一個「已排班的姓名方塊」（shift-chip）：
    // 底色 = 員工代表色；可點擊編輯；可拖曳到其他班別置換、到下方「移除此人員」區塊移除。
    // 已鎖定的日期完全不可更動（不顯示編輯提示、不可拖曳、不可接收）
    const renderSlot = (slot: ShiftSlot) => {
      const shift = shiftById.get(slot.assignment!.shift_code)
      const name = slot.employee?.name || '?'
      const rec = availByKey.get(`${slot.assignment!.employee_id}:${key}`)
      const conflict = rec?.status === 'off' || rec?.status === 'unavailable'
      const overConsecutive =
        maxConsecutiveWorkDays > 0 && consecutiveDaysOf(slot.assignment!.employee_id, day) > maxConsecutiveWorkDays
      const code = slot.assignment!.shift_code
      return (
        <button
          key={`${code}:${slot.assignment!.employee_id}`}
          type="button"
          draggable={isAdmin && !isLocked}
          className={`shift-chip${conflict ? ' shift-chip--conflict' : ''}${dropTarget === `${day}:${code}` ? ' shift-chip--drop' : ''}${isAdmin ? ' shift-chip--drag' : ''}${isLocked ? ' shift-chip--locked' : ''}${removeDrag && removeDrag.day === day && removeDrag.shift_code === slot.assignment!.shift_code && removeDrag.employee_id === slot.assignment!.employee_id ? ' shift-chip--source' : ''}`}
          style={slot.employee?.color ? { background: slot.employee.color, color: chipTextColor(slot.employee.color), borderColor: 'rgba(0, 0, 0, 0.16)' } : undefined}
          onClick={(e) => {
            e.stopPropagation()
            if (isAdmin && !isLocked) setEditing({ day, shiftCode: code })
          }}
          onDragStart={(ev) => {
            if (!isAdmin || isLocked) return
            // 拖曳開始：寫入「來源班別/人員」資料，並亮出下方的移除區塊。
            // 放到其他班別 = 置換；放到下方區塊 = 移除
            ev.dataTransfer.setData(
              'application/x-remove-shift',
              JSON.stringify({
                day,
                shift_code: slot.assignment!.shift_code,
                employee_id: slot.assignment!.employee_id,
                note: slot.assignment!.note || '',
                work_item: slot.assignment!.work_item || '',
              }),
            )
            ev.dataTransfer.effectAllowed = 'move'
            setRemoveDrag({ day, shift_code: slot.assignment!.shift_code, employee_id: slot.assignment!.employee_id })
            setRemoveDragOver(false)
            setIsDragging(true)
          }}
          onDragEnd={() => {
            setRemoveDrag(null)
            setRemoveDragOver(false)
            setDropTarget(null)
            setIsDragging(false)
          }}
          onDragOver={(ev) => {
            // 接受「員工圓點」拖進來（新增人員），也接受「其他班別的姓名方塊」拖進來（置換）
            if (
              isAdmin &&
              !isLocked &&
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
            if (isLocked) {
              toast('此日已鎖定，無法更動排班', 'error')
              return
            }
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
                  work_item?: string
                }
                void swapAssignment(src, { day, shift_code: slot.assignment!.shift_code })
              } catch {
                toast('置換失敗', 'error')
              }
              return
            }
            dropToAssign(day, slot.assignment!.shift_code, ev)
          }}
          title={`${isAdmin && !isLocked ? '點擊修改此班／拖曳員工圓點到此可新增人員；拖曳此方塊到其他班別可置換、到下方區塊可移除。' : isLocked ? '此日已鎖定，無法更動排班。' : ''}${shift?.name || ''}・${name}${slot.assignment!.note ? `（備註：${slot.assignment!.note}）` : ''}${conflict ? `（注意：當日標記「${statusLabel(rec)}」）` : ''}`}
        >
          {(conflict || overConsecutive) && (
            <span className="shift-chip__warn" title={`${name}${conflict ? ` 當日標記「${statusLabel(rec)}」` : ' 連續上班天數已超過上限'}`}>
              ⚠
            </span>
          )}
          <span className="shift-chip__name">{name}</span>
          {workItemsOf(slot.assignment!.work_item).map((w) => (
            <span key={w.id} className="shift-chip__wi" title={w.name}>
              {w.icon || w.name}
            </span>
          ))}
          {slot.assignment!.note && <span className="shift-chip__note">{slot.assignment!.note}</span>}
        </button>
      )
    }

    return (
      <div
        key={day}
        className={`cal-cell${isToday ? ' cal-cell--today' : ''}${hasShort ? ' cal-cell--short' : ''}${isLocked ? ' cal-cell--locked' : ''}${isSelected ? ' cal-cell--selected' : ''}`}
        onClick={() => toggleSelectDay(day)}
        title={
          isAdmin
            ? isLocked
              ? '此日已鎖定：自動排班不會更動，也無法手動新增/移除排班。點格子可選取後解鎖。'
              : '點一下格子可選取，再用上方「鎖定所選」讓自動排班不更動這天。'
            : undefined
        }
      >
        <div className="cal-cell__head">
          <span className="cal-cell__day">{month}/{day}</span>
          <span className="cal-cell__week">{weekday}</span>
          <span className="cal-cell__flags">
            {hasShort && (
              <span className="cal-cell__short" title={shortTitle}>
                <span className="cal-cell__short-icon">⚠</span>人力/工作未滿足
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
          {/* 「＋」按鈕：點擊開啟人力指派；也可把員工圓點拖到這裡加入新班別。
              已鎖定的日期不顯示「＋」，等同完全不能新增排班 */}
          {isAdmin && !isLocked && (
            <button
              type="button"
              className={`shift-chip shift-chip--add${dropTarget === `${day}:+` ? ' shift-chip--drop' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setEditing({ day, shiftCode: null })
              }}
              onDragOver={(ev) => {
                if (isAdmin && !isLocked && ev.dataTransfer.types.includes('application/x-emp-id')) {
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
                  draggable={isAdmin && !isLocked}
                  className={`cal-emp${onDuty ? ' cal-emp--duty' : ''}${conflict ? ' cal-emp--conflict' : ''}`}
                  style={{ background: pal.bg, color: pal.fg, borderColor: pal.border }}
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(ev) => {
                    if (isLocked) return
                    ev.dataTransfer.setData('application/x-emp-id', emp.id)
                    ev.dataTransfer.effectAllowed = 'move'
                    setDropTarget(null)
                    setIsDragging(true)
                  }}
                  onDragEnd={() => {
                    setDropTarget(null)
                    setIsDragging(false)
                  }}
                  title={`${emp.name}：${statusLabel(rec)}${onDuty ? '（已排班）' : ''}${isLocked ? '（此日已鎖定）' : isAdmin ? '（可拖曳到「＋」或任一班別自動加入）' : ''}`}
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
        {/* 右下角鎖頭：固定不動，方便一眼看出哪幾天被鎖定 */}
        {isAdmin && (
          <span className="cal-cell__corner">
            <button
              type="button"
              className={`cal-cell__lock${isLocked ? ' cal-cell__lock--on' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                void applyLock([day], !isLocked)
              }}
              title={isLocked ? '已鎖定：自動排班不會更動這天。點擊解除鎖定' : '鎖定這天：自動排班不會更動既有人員'}
            >
              {isLocked ? '🔒' : '🔓'}
            </button>
          </span>
        )}
      </div>
    )
  }

  // —— 頁面本體：標題列（月份切換 + 自動排班按鈕）——
  return (
    <div className="view">
      <div className="view__head">
        <MonthNav year={year} month={month} onChange={(y, m) => { data.setYear(y); data.setMonth(m) }} />
        {isAdmin && (
          <div className="view__head-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={generating}
              onClick={() => setConfirmGenerate(true)}
            >
              {generating ? '⟳ 排班中…' : '⟳ 自動排班'}
            </button>
            <button type="button" className="rules-link" onClick={() => setShowRules(true)}>
              自動排班規則說明
            </button>
          </div>
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

      {/* 鎖定工具列：選取格子後出現，可一次鎖定/解除/設公休多天 */}
      {isAdmin && selectedDays.size > 0 && (
        <div className="lock-toolbar">
          <span className="lock-toolbar__info">
            已選取 <b>{selectedDays.size}</b> 天
            {[...selectedDays].some((d) => lockedDays.includes(d)) && '（含已鎖定天）'}
            {[...selectedDays].some((d) => closedDays.includes(d)) && '（含公休日）'}
          </span>
          <button type="button" className="btn btn--small btn--primary" onClick={() => void applyLock([...selectedDays], true)}>
            🔒 鎖定所選
          </button>
          <button type="button" className="btn btn--small" onClick={() => void applyLock([...selectedDays], false)}>
            🔓 解除鎖定
          </button>
          <button
            type="button"
            className="btn btn--small btn--danger"
            onClick={() => setConfirmClosed([...selectedDays])}
            title="設為公休日：當天不營業，自動排班會跳過；既有排班人員會被清空"
          >
            💤 設為公休日
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void applyClosed([...selectedDays], false)}
            title="解除公休日：恢復當天營業，自動排班會重新安排"
          >
            <span className="icon-sq icon-sq--yellow" aria-hidden="true">営</span>
            解除公休日
          </button>
          <button type="button" className="btn btn--small" onClick={() => setSelectedDays(new Set())}>
            取消選取
          </button>
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
              {workShifts.map((s) => (
                <span key={s.code} className="legend__item">
                  <i className="legend-dot--prefer" style={{ background: preferColor(s) }} />
                  <ShiftIcon shift={s} /> 偏好{s.name}
                </span>
              ))}
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
                人力/工作未滿足
              </span>
              <span className="legend__item">
                <i className="legend-closed" />
                公休日（不營業，自動排班跳過）
              </span>
              <span className="legend__item">
                <i className="legend-lock">🔒</i>
                已鎖定（自動排班不更動）
              </span>
              <span className="legend__item">
                <i className="legend-selected" />
                已選取
              </span>
            </div>
          )}

          {/* 月曆本體：星期標題 + 空白填位 + 每一天 */}
          <div className={`cal cal--month${isDragging ? ' drag-active' : ''}`}>
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
                const shiftPart = workShifts
                  .map((s) => `${stats.perEmpShift[employee.id]?.[s.code] || 0}${s.name}`)
                  .filter((t) => !t.startsWith('0'))
                  .join('·')
                const meta = [shiftPart, st?.off ? `${st.off}排休` : ''].filter(Boolean).join('·')
                return (
                  <StatRow
                    key={employee.id}
                    name={employee.name}
                    color={employee.color || '#6b7280'}
                    total={total}
                    max={stats.max}
                    meta={meta}
                  />
                )
              })}
              {stats.rows.length === 0 && <p className="muted">尚未有員工資料</p>}
            </div>
            <div className="stats__shifts">
              {workShifts.map((s) => (
                <span key={s.code} className="stat-shift">
                  <ShiftIcon shift={s} />
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
          workItems={workItems}
          assignedDay={assignments.filter((a) => a.day === editing.day)}
          maxConsecutiveWorkDays={maxConsecutiveWorkDays}
          consecutiveDaysOf={consecutiveDaysOf}
          onClose={(finalLocal) => {
            setEditing(null)
            data.setAssignments((prev) => [...prev.filter((a) => a.day !== editing.day), ...finalLocal])
            window.setTimeout(() => data.reload({ silent: true }), 600)
          }}
        />
      )}

      {isAdmin && (
        <p className="hint">
          提示：班別可直接點擊修改人力；格子下方圓點為各員工當日狀態，<b>拖曳圓點到「＋」或任一班別會跳出視窗選擇要加入的班別</b>。<b>拖曳已排班的姓名方塊到其他班別可直接「置換」班別</b>，<b>拖到下方「移除此人員」區塊則直接移除</b>。有「⚠」代表該員工已排班但當日標記排休或沒空、或連續上班天數已超過上限，請檢查。姓名後方的 {workItems.filter((w) => w.icon).map((w) => `${w.icon}${w.name}`).join('／')} 是該員工當日負責的工作項目。<b>日期格子有紅色虛線外框＋「⚠人力/工作未滿足」標籤</b>代表當日尚有班別未達需求人數，或該班的{workItems.map((w) => w.name).join('／')}工作項目還沒有人負責。<b>斜線底（公休）的日子當天不營業</b>，自動排班會跳過，設為公休日時既有排班會被清空。
        </p>
      )}

      {/* 拖曳移除時浮出的紅色區塊：把姓名方塊拖到這裡放開就移除 */}
      {removeDrag && (
        <div
          className={`remove-dropzone${removeDragOver ? ' remove-dropzone--over' : ''}`}
          onDragOver={(ev) => {
            ev.preventDefault()
            ev.dataTransfer.dropEffect = 'move'
            setRemoveDragOver(true)
          }}
          onDragLeave={() => setRemoveDragOver(false)}
          onDrop={(ev) => {
            ev.preventDefault()
            setRemoveDragOver(false)
            setRemoveDrag(null)
            setDropTarget(null)
            void removeAssignment(removeDrag)
          }}
          title="放開以移除此人員"
        >
          <span className="remove-dropzone__icon">🗑</span>
          移除此人員（{empById.get(removeDrag.employee_id)?.name || '?'}・{shiftById.get(removeDrag.shift_code)?.name || removeDrag.shift_code}）
        </div>
      )}

      {/* 排班規則說明彈窗 */}
      {showRules && (
        <Modal title="自動排班規則說明" onClose={() => setShowRules(false)}>
          <div className="stack rules-list">
            <section>
              <h4>每天怎麼排</h4>
              <ol>
                <li>先排「今天想上這個班」的人。</li>
                <li>還缺人時，讓「這個月還排得比較少」的人優先補上。</li>
                <li>一人一天只能上一個班。</li>
              </ol>
            </section>
            <section>
              <h4>早班怎麼排</h4>
              <ul>
                <li>
                  <b>平日早班</b>：先讓想上的人上；如果還缺人，會優先選「吧台、內場都會」的人來上。
                </li>
                <li>
                  <b>假日早班</b>（週末／例假日）：先讓想上的人上；缺人時就照「這個月排得比較少的人優先」來補。
                </li>
              </ul>
            </section>
            <section>
              <h4>晚班怎麼排</h4>
              <ul>
                <li>
                  <b>平日晚班</b>：先讓想上的人上；缺人時照「這個月排得比較少的人優先」來補。
                </li>
                <li>
                  <b>假日晚班</b>（週末／例假日）：跟平日晚班一樣，先讓想上的人上，缺人時排得比較少的人優先補上。
                </li>
              </ul>
            </section>
            <section>
              <h4>什麼時候不會排到</h4>
              <ul>
                <li>那天排休、或班別時間跟「沒空時段」撞到 → 不排。</li>
                <li>連續上超過設定天數（如 6 天）→ 當天休息。</li>
              </ul>
            </section>
            <section>
              <h4>其他</h4>
              <ul>
                <li>每個班會盡量讓吧台、內場都有人負責；沒人會做的會跳出 ⚠ 提醒。</li>
                <li>條件都一樣時用抽的，所以每次排出來可能略有不同。</li>
              </ul>
            </section>
          </div>
        </Modal>
      )}

      {/* 自動排班確認彈窗：避免誤觸，確認後才執行 */}
      {confirmGenerate && (
        <Modal title="自動排班確認" onClose={() => setConfirmGenerate(false)}>
          <div className="stack">
            <p className="modal-lead">
              確定要執行自動排班？將重新產生 <b>{year}</b> 年 <b>{month}</b> 月的班表，並覆蓋既有排班。
            </p>
            <p className="hint">
              提示：可先用〈批次鎖定〉鎖定不想被更動的日期；已鎖定的天數不會被自動排班變更。公休日當天不營業，自動排班會直接跳過。
            </p>
            <div className="modal__actions">
              <button type="button" className="btn" onClick={() => setConfirmGenerate(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setConfirmGenerate(false)
                  void runGenerate()
                }}
              >
                ⟳ 開始排班
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 公休日確認彈窗：設為公休日會清空當天已排班人員，需先警告 */}
      {confirmClosed && (
        <Modal title="設為公休日確認" onClose={() => setConfirmClosed(null)}>
          <div className="stack">
            <p className="modal-lead">
              確定要將 <b>{confirmClosed.length}</b> 天設為公休日？
            </p>
            <p className="hint">
              ⚠ 設為公休日後，當天<b>不營業</b>：既有已排班的人員<b>會被清空</b>，且自動排班會<b>跳過</b>這些日子。若要讓這些天恢復營業，可再使用〈解除公休日〉。
            </p>
            <div className="modal__actions">
              <button type="button" className="btn" onClick={() => setConfirmClosed(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  const days = confirmClosed
                  setConfirmClosed(null)
                  void applyClosed(days, true)
                }}
              >
                💤 設為公休日
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
// =============================================================
// AssignModal —— 人力指派彈窗
// 顯示某一天某個班別的人員；可新增人員、移除人員、勾選工作項目、填寫備註。
// 所有編輯先存在彈窗內的 local 狀態，按下「完成」才比對差異、一次寫入後端，
// 寫完再關閉並把 local 回傳給父層更新畫面；點「×」或背景關閉則放棄編輯、回復原狀。
// =============================================================
function AssignModal({
  year,
  month,
  day,
  initialShiftCode,
  initialEmployeeId,
  shiftTypes,
  employees,
  workItems,
  assignedDay,
  maxConsecutiveWorkDays,
  consecutiveDaysOf,
  onClose,
}: {
  year: number
  month: number
  day: number
  initialShiftCode: string | null
  initialEmployeeId?: string
  shiftTypes: ShiftType[]
  employees: Employee[]
  workItems: WorkItem[]
  assignedDay: Assignment[]
  maxConsecutiveWorkDays: number
  consecutiveDaysOf: (empId: string, targetDay: number) => number
  onClose: (finalLocal: Assignment[]) => void
}) {
  const workTypes = shiftTypes.filter((s) => s.code !== 'OFF')
  const [shiftCode, setShiftCode] = useState(initialShiftCode || workTypes[0]?.code || '') // 目前選中的班別
  const [local, setLocal] = useState<Assignment[]>(assignedDay)                            // 這天所有已排班（彈窗內即時維護的副本）
  const [newEmployeeId, setNewEmployeeId] = useState(initialEmployeeId || '')              // 「要新增的人員」下拉選到誰
  const [saving, setSaving] = useState(false)                                              // 是否正在把編輯寫入後端
  const initialRef = useRef<Assignment[]>(assignedDay) // 開啟時的原始資料（「完成」時比對有哪些異動）
  const localRef = useRef<Assignment[]>(local)         // 最新 local 的鏡像，供關閉時的 async 讀取
  const closingRef = useRef(false)                     // 避免儲存中的關閉動作重複觸發

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

  // 計算某員工「若在某天排班，會連續工作幾天上限」：以該天為中心往前往後數，
  // 會跨月回溯上個月的排班（由父層傳入的 consecutiveDaysOf 處理）。
  // 若超過 max_consecutive_work_days 設定，就在新增人員處顯示警告。
  const addTargetId = newEmployeeId || (draggedEmp ? draggedEmp.id : '')
  const addTargetEmp = addTargetId ? empById.get(addTargetId) : undefined
  const addConsecutive = addTargetId ? consecutiveDaysOf(addTargetId, day) : 0
  const addOverConsecutive = maxConsecutiveWorkDays > 0 && addConsecutive > maxConsecutiveWorkDays

  // 把「1,2」逗號分隔的工作項目 id 字串轉成陣列（供勾選框比對）
  const workItemIdsOf = (raw?: string): string[] =>
    String(raw || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)

  // 勾選/取消某位員工的工作項目：只更新彈窗內的 local，「完成」時才送後端。
  // 儲存用的 id 字串一律依 workItems 排序產生，確保大家存的順序一致
  const toggleWorkItem = (empId: string, itemId: string) => {
    const person = local.find((a) => a.shift_code === shiftCode && a.employee_id === empId)
    if (!person) return
    const cur = new Set(workItemIdsOf(person.work_item))
    if (cur.has(itemId)) cur.delete(itemId)
    else cur.add(itemId)
    const nextRaw = workItems
      .filter((w) => cur.has(String(w.id)))
      .map((w) => String(w.id))
      .join(',')
    setLocal((prev) => prev.map((a) => (a.shift_code === shiftCode && a.employee_id === empId ? { ...a, work_item: nextRaw } : a)))
  }

  // 切換班別時：若「要新增的人員」下拉目前選的是「拖曳帶入」的員工則保留，
  // 方便直接加到新選的班別；其餘情況清空，避免把選錯的人誤加到其他班別
  const setShift = (code: string) => {
    setShiftCode(code)
    if (newEmployeeId && newEmployeeId !== initialEmployeeId) setNewEmployeeId('')
  }

  // 新增人員：只加入彈窗內的 local，「完成」時才送後端
  const addPerson = () => {
    if (!newEmployeeId) return
    const entry: Assignment = { year, month, day, shift_code: shiftCode, employee_id: newEmployeeId }
    setLocal((prev) => (prev.some((a) => a.shift_code === shiftCode && a.employee_id === newEmployeeId) ? prev : [...prev, entry]))
    setNewEmployeeId('')
  }

  // 移除人員：只從彈窗內的 local 移除，「完成」時才送後端
  const removePerson = (empId: string) => {
    setLocal((prev) => prev.filter((a) => !(a.shift_code === shiftCode && a.employee_id === empId)))
  }

  // 輸入框打字的同時更新備註到 local（即時顯示）
  const updateNoteLocal = (empId: string, note: string) => {
    setLocal((prev) => prev.map((a) => (a.shift_code === shiftCode && a.employee_id === empId ? { ...a, note } : a)))
  }

  // 同一人日的唯一鍵（每人每天只會在一班）
  const keyOf = (a: Assignment) => `${a.shift_code}:${a.employee_id}`

  // 關閉（× 或點背景）：放棄未儲存的編輯，回復成開啟時的原始資料，不送後端
  const handleCancel = () => {
    if (closingRef.current) return
    closingRef.current = true
    onClose(initialRef.current)
  }

  // 儲存：比對「開啟時的資料」與「編輯後的資料」，差異統一拍送後端；成功才關閉
  const handleDone = () => {
    if (closingRef.current) return
    closingRef.current = true
    setSaving(true)
    void (async () => {
      const initial = initialRef.current
      const current = localRef.current
      const initialMap = new Map(initial.map((a) => [keyOf(a), a]))
      const currentMap = new Map(current.map((a) => [keyOf(a), a]))
      const removed = initial.filter((a) => !currentMap.has(keyOf(a))) // 被刪掉的人員
      const upserts: Assignment[] = []                                 // 新增或備註/工作項目有變動的人員
      for (const a of current) {
        const prev = initialMap.get(keyOf(a))
        if (!prev || prev.note !== a.note || prev.work_item !== a.work_item) upserts.push(a)
      }
      try {
        for (const a of removed) {
          await api('/schedule/assign', {
            method: 'PUT',
            body: { year, month, day, shift_code: a.shift_code, employee_id: a.employee_id, action: 'remove' },
          })
        }
        for (const a of upserts) {
          await api('/schedule/assign', {
            method: 'PUT',
            body: { year, month, day, shift_code: a.shift_code, employee_id: a.employee_id, action: 'add', note: a.note || '', work_item: a.work_item || '' },
          })
        }
        onClose(current)
      } catch (e) {
        // 儲存失敗：留在彈窗內讓使用者重試，不關閉
        toast((e as Error).message, 'error')
        closingRef.current = false
        setSaving(false)
      }
    })()
  }

  return (
    <Modal title={`${month} 月 ${day} 日・${draggedEmp ? `加入「${draggedEmp.name}」` : '人力指派'}`} onClose={handleCancel}>
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
            const empSkills = new Set((emp?.skills || []).map((s) => String(s.id)))
            const pConsecutive = consecutiveDaysOf(p.employee_id, day)
            const pOver = maxConsecutiveWorkDays > 0 && pConsecutive > maxConsecutiveWorkDays
            return (
              <div key={p.employee_id} className="assign-person">
                <span className="assign-person__name">{emp?.name || '未知員工'}</span>
                {pOver && (
                  <span className="assign-warn assign-warn--badge" title={`此員工連續工作 ${pConsecutive} 天，超過上限 ${maxConsecutiveWorkDays} 天`}>
                    ⚠ 已連續 {pConsecutive} 天
                  </span>
                )}
                <div className="assign-person__wis">
                  {workItems.map((w) => {
                    const on = workItemIdsOf(p.work_item).includes(String(w.id))
                    const allowed = empSkills.has(String(w.id))
                    return (
                      <label
                        key={w.id}
                        className={`assign-wi ${on ? 'assign-wi--on' : ''} ${allowed ? '' : 'assign-wi--disabled'}`}
                        title={allowed ? `勾選：${w.name}` : `此員工無「${w.name}」技能，無法勾選`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={saving || !allowed}
                          onChange={() => toggleWorkItem(p.employee_id, String(w.id))}
                        />
                        <span>
                          {w.icon} {w.name}
                        </span>
                      </label>
                    )
                  })}
                  {workItems.length === 0 && <span className="muted">（尚未設定任何工作項目）</span>}
                </div>
                <input
                  className="assign-note"
                  value={p.note || ''}
                  placeholder="備註"
                  onChange={(e) => updateNoteLocal(p.employee_id, e.target.value)}
                />
                <button type="button" className="btn btn--danger" disabled={saving} onClick={() => removePerson(p.employee_id)}>
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
          <button type="button" className="btn btn--primary" disabled={saving || !newEmployeeId} onClick={addPerson}>
            新增人員
          </button>
        </div>
        {addTargetEmp && addOverConsecutive && (
          <p className="assign-warn">
            ⚠ <b>{addTargetEmp.name}</b> 排入 {day} 日後將<b>連續上班 {addConsecutive} 天</b>，已超過上限
            {maxConsecutiveWorkDays} 天。請確認是否要繼續，或另選他人。
          </p>
        )}
        <p className="hint">
          勾選工作項目、填寫備註後按「儲存」一次寫入；按「關閉」放棄編輯、回復原狀。每人每天只排一個班別。
        </p>
        <div className="modal__actions">
          <button type="button" className="btn" disabled={saving} onClick={handleCancel}>
            關閉
          </button>
          <button type="button" className="btn btn--primary" disabled={saving} onClick={handleDone}>
            {saving ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
