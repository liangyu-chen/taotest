function pad(n) {
  return String(n).padStart(2, '0')
}

function dateKey(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

function toNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function toMin(t) {
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim())
  if (!m) return null
  const total = Number(m[1]) * 60 + Number(m[2])
  return total > 1440 ? null : total
}

function settingsMap(settings) {
  const map = {}
  for (const s of settings || []) map[s.key] = s.value ?? ''
  return map
}

/**
 * 自動排班演算法
 *
 * 規則由「排班規則設定」頁與人力需求表驅動：
 * - 每日區分 weekday（平日）/ weekend（週末）/ holiday（例假日）
 * - 正職每班固定時數、工讀每班時數可自由設定（員工個別覆寫）
 * - 正職目標＝平日天數×每班時數；工讀無每週時數上限，目標＝每班時數×當月天數
 * - 依各員工「目標時數」比例分配，公平且尊重排休 / 可空出與沒空時段 / 連續上班上限
 * - 有「偏好班別」的員工在該日優先排入偏好班別（在公平分配之前先處理）
 *
 * @param {object} options
 * @param {number} options.year
 * @param {number} options.month
 * @param {Array} options.employees   員工（含 id, active, employee_type, shift_hours）
 * @param {Array} options.shiftTypes  班別（含 code, sort，OFF 不參與）
 * @param {Array} options.headcounts  人力需求 [{shift_code, day_type, count}]
 * @param {Array} options.availability 排休/偏好 [{employee_id, date, status}]
 * @param {Array} options.settings    排班規則 [{key, value}]
 */
export function generateSchedule({ year, month, employees, shiftTypes, headcounts, availability, settings }) {
  const cfg = settingsMap(settings)
  const fulltimeShiftHours = toNum(cfg.fulltime_shift_hours, 8)
  const parttimeShiftHours = toNum(cfg.parttime_shift_hours, 6)
  const maxConsecutive = toNum(cfg.max_consecutive_work_days, 0)
  const holidays = new Set(
    String(cfg.holidays || '')
      .split(/[\n,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
  )

  const days = daysInMonth(year, month)
  const activeEmployees = employees.filter((e) => String(e.active) !== '0' && String(e.active) !== 'false' && e.active !== '')

  const workShifts = shiftTypes
    .filter((s) => s.code && s.code !== 'OFF')
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))

  const headcountMap = {}
  for (const h of headcounts) {
    headcountMap[`${h.shift_code}:${h.day_type}`] = Number(h.count) || 0
  }

  function dayType(dayNum) {
    const ds = dateKey(year, month, dayNum)
    if (holidays.has(ds)) return 'holiday'
    const dow = (new Date(year, month - 1, dayNum).getDay() + 6) % 7
    return dow >= 5 ? 'weekend' : 'weekday'
  }

  const offMap = {}
  const preferMap = {}
  const unavailRange = {}
  for (const a of availability) {
    if (!a.employee_id || !a.date) continue
    const key = `${a.employee_id}:${a.date}`
    if (a.status === 'off') offMap[key] = true
    else if (a.status === 'unavailable') {
      const s = toMin(a.start_time)
      const e = toMin(a.end_time)
      if (s !== null && e !== null && e > s) unavailRange[key] = [s, e]
    } else if (a.status) preferMap[key] = a.status
  }

  function canWork(empId, dayNum, shift) {
    const key = `${empId}:${dateKey(year, month, dayNum)}`
    if (offMap[key]) return false
    const sMin = toMin(shift.start_time)
    const eMin = toMin(shift.end_time)
    const hasShiftTime = sMin !== null && eMin !== null
    if (hasShiftTime) {
      const un = unavailRange[key]
      if (un) {
        if (sMin < un[1] && eMin > un[0]) return false
      }
    }
    return true
  }

  const hoursPerShift = {}
  const targetHours = {}
  const weekdays = []
  for (let d = 1; d <= days; d++) {
    if (dayType(d) === 'weekday') weekdays.push(d)
  }
  for (const emp of activeEmployees) {
    if (emp.employee_type === 'fulltime') {
      hoursPerShift[emp.id] = fulltimeShiftHours
      targetHours[emp.id] = weekdays.length * fulltimeShiftHours
    } else {
      const own = toNum(emp.shift_hours, 0)
      hoursPerShift[emp.id] = own || parttimeShiftHours
      targetHours[emp.id] = hoursPerShift[emp.id] * days
    }
    if (targetHours[emp.id] <= 0) targetHours[emp.id] = hoursPerShift[emp.id] * days
  }

  const assigned = new Map()
  const hoursDone = {}
  const codeCount = {}
  for (const emp of activeEmployees) {
    hoursDone[emp.id] = 0
    codeCount[emp.id] = {}
  }

  function consecutiveDaysBefore(empId, dayNum) {
    let streak = 0
    for (let d = dayNum - 1; d >= 1; d--) {
      if (assigned.has(`${empId}:${dateKey(year, month, d)}`)) streak++
      else break
    }
    return streak
  }

  // 是否已連續工作到上限：今天再加一班就會超過「每人每週最多連續工作天數」
  function overConsecutive(empId, dayNum) {
    if (maxConsecutive <= 0) return false
    return consecutiveDaysBefore(empId, dayNum) >= maxConsecutive
  }

  function score(empId, shiftCode, dayNum, index) {
    let s = 0
    s += (hoursDone[empId] / Math.max(1, targetHours[empId])) * 1000
    s += (codeCount[empId][shiftCode] || 0) * 3
    const streak = consecutiveDaysBefore(empId, dayNum)
    s += streak * streak * 25
    if (preferMap[`${empId}:${dateKey(year, month, dayNum)}`] === shiftCode) s -= 500
    s += index * 0.001
    return s
  }

  const unfilled = []

  for (let day = 1; day <= days; day++) {
    const type = dayType(day)
    const usedToday = new Set()
    const assignedToday = {}

    // Phase 1：有偏好的員工優先排入其偏好班別（依公平性分數取需要的人數）
    for (const shift of workShifts) {
      const need = headcountMap[`${shift.code}:${type}`]
      if (!need) continue
      const dkey = dateKey(year, month, day)
      const prefs = activeEmployees
        .filter((emp) => {
          if (usedToday.has(emp.id)) return false
          if (overConsecutive(emp.id, day)) return false
          if (preferMap[`${emp.id}:${dkey}`] !== shift.code) return false
          return canWork(emp.id, day, shift)
        })
        .sort((a, b) => score(a.id, shift.code, day, 0) - score(b.id, shift.code, day, 0))
      let filled = 0
      for (const emp of prefs) {
        if (filled >= need) break
        usedToday.add(emp.id)
        const key = `${emp.id}:${dkey}`
        assigned.set(key, shift.code)
        hoursDone[emp.id] += hoursPerShift[emp.id]
        codeCount[emp.id][shift.code] = (codeCount[emp.id][shift.code] || 0) + 1
        filled++
      }
      if (filled) assignedToday[shift.code] = filled
    }

    // Phase 2：其餘人力依公平性分數補齊
    for (const shift of workShifts) {
      const need = headcountMap[`${shift.code}:${type}`]
      if (!need) continue
      for (let slot = assignedToday[shift.code] || 0; slot < need; slot++) {
        const candidates = activeEmployees.filter((emp) => {
          if (usedToday.has(emp.id)) return false
          if (overConsecutive(emp.id, day)) return false
          return canWork(emp.id, day, shift)
        })
        if (candidates.length === 0) {
          unfilled.push({ day, shift_code: shift.code })
          continue
        }
        let best = candidates[0]
        let bestScore = Infinity
        for (let i = 0; i < candidates.length; i++) {
          const s = score(candidates[i].id, shift.code, day, i)
          if (s < bestScore) {
            bestScore = s
            best = candidates[i]
          }
        }
        usedToday.add(best.id)
        const key = `${best.id}:${dateKey(year, month, day)}`
        assigned.set(key, shift.code)
        hoursDone[best.id] += hoursPerShift[best.id]
        codeCount[best.id][shift.code] = (codeCount[best.id][shift.code] || 0) + 1
      }
    }
  }

  const assignments = []
  for (const [key, shiftCode] of assigned) {
    const [empId, date] = key.split(':')
    const [, m, d] = date.split('-').map(Number)
    assignments.push({
      year,
      month: m,
      day: d,
      shift_code: shiftCode,
      employee_id: empId,
    })
  }
  assignments.sort((a, b) => a.day - b.day)

  const perEmployee = activeEmployees.map((emp) => ({
    employee_id: emp.id,
    total: assignments.filter((a) => a.employee_id === emp.id).length,
    hours: Math.round(hoursDone[emp.id]),
    targetHours: Math.round(targetHours[emp.id]),
    perShift: codeCount[emp.id] || {},
  }))

  return {
    assignments,
    unfilled,
    summary: {
      year,
      month,
      days,
      totalSlots: assignments.length,
      employees: activeEmployees.length,
      perEmployee,
    },
  }
}
