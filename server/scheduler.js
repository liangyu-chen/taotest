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
 * - 平日早班優先排「雙技能」員工；其餘班別（平日晚上／假日）隨機挑人
 * - 工作項目（吧台/內場…）：每個有需求人數的班別都要「每個工作項目至少一人負責」，
 *   選人時優先挑具備尚未被覆蓋技能的人；單人班別會優先找能同時勝任所有工作項目的人
 *
 * @param {object} options
 * @param {number} options.year
 * @param {number} options.month
 * @param {Array} options.employees   員工（含 id, active, employee_type, shift_hours）
 * @param {Array} options.shiftTypes  班別（含 code, sort，OFF 不參與）
 * @param {Array} options.headcounts  人力需求 [{shift_code, day_type, count}]
 * @param {Array} options.availability 排休/偏好 [{employee_id, date, status}]
 * @param {Array} options.settings    排班規則 [{key, value}]
 * @param {Array} options.workItems   工作項目 [{id, name, icon}]（每班需各至少一人負責）
 * @param {Array} options.employeeSkills 員工技能 [{employee_id, work_item_id}]
 * @param {Array<number>|Set<number>} options.closedDays 公休日（當天不營業，直接跳過不排班）
 * @param {Array} options.prevAssignments 上個月的排班 [{year, month, day, employee_id, ...}]（跨月連續上班天數用）
 */
export function generateSchedule({ year, month, employees, shiftTypes, headcounts, availability, settings, workItems = [], employeeSkills = [], closedDays = [], prevAssignments = [] }) {
  const closedSet = closedDays instanceof Set ? closedDays : new Set((closedDays || []).map(Number))
  const cfg = settingsMap(settings)
  const fulltimeShiftHours = toNum(cfg.fulltime_shift_hours, 8)
  const parttimeShiftHours = toNum(cfg.parttime_shift_hours, 6)
  const maxConsecutive = toNum(cfg.max_consecutive_work_days, 0)
  // 上個月的年月（跨年時自動扣一年）
  const prevYear = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
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

  // 早班＝開始時間最早的班別（例如 12:00 的 M 班）；用於「平日早班優先排雙技能者」
  const morningShiftCode = (() => {
    const withTime = workShifts.filter((s) => toMin(s.start_time) !== null)
    if (withTime.length === 0) return workShifts[0]?.code || ''
    return withTime.reduce((a, b) => (toMin(a.start_time) < toMin(b.start_time) ? a : b)).code
  })()

  function isWeekdayMorningShift(dayNum, shiftCode) {
    return dayType(dayNum) === 'weekday' && shiftCode === morningShiftCode
  }

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
  // 先把「上個月的排班」也放進 assigned，這樣本月初的連續上班天數能回溯到上個月
  for (const a of prevAssignments || []) {
    if (!a.employee_id || !a.day) continue
    assigned.set(`${a.employee_id}:${dateKey(prevYear, prevMonth, Number(a.day))}`, a.shift_code || '')
  }

  // —— 工作項目（吧台/內場…）相關狀態 ——
  const skillsByEmp = new Map() // empId → Set<workItemId>
  for (const s of employeeSkills) {
    if (!s.employee_id || !s.work_item_id) continue
    const set = skillsByEmp.get(String(s.employee_id))
    if (set) set.add(String(s.work_item_id))
    else skillsByEmp.set(String(s.employee_id), new Set([String(s.work_item_id)]))
  }
  const workItemIds = workItems.map((w) => String(w.id)).filter(Boolean)
  const shiftPeople = new Map() // `${day}:${shiftCode}` → empId[]（該班已排入的人）
  const coveredByShift = new Map() // `${day}:${shiftCode}` → Set<workItemId>（已被具備技能者覆蓋的工作項目）
  function shiftGroupKey(dayNum, shiftCode) {
    return `${dayNum}:${shiftCode}`
  }
  function markCovered(dayNum, shiftCode, empId) {
    const sks = skillsByEmp.get(String(empId))
    if (!sks || sks.size === 0) return
    const key = shiftGroupKey(dayNum, shiftCode)
    const set = coveredByShift.get(key)
    if (set) {
      for (const id of sks) set.add(id)
    } else {
      coveredByShift.set(key, new Set(sks))
    }
  }
  function uncoveredFor(dayNum, shiftCode) {
    const covered = coveredByShift.get(shiftGroupKey(dayNum, shiftCode))
    if (!covered) return new Set(workItemIds)
    return new Set(workItemIds.filter((id) => !covered.has(id)))
  }

  function consecutiveDaysBefore(empId, dayNum) {
    let streak = 0
    // 往前數，一路數到當月 1 號仍連續就切到上個月繼續（含跨年）；
    // 資料只回溯一個月（back 最多 1），再往前沒有資料自然停止
    let y = year
    let m = month
    let d = dayNum - 1
    let back = 0
    while (true) {
      if (d < 1) {
        back++
        if (back > 1) break
        if (m === 1) {
          y--
          m = 12
        } else {
          m--
        }
        d = daysInMonth(y, m)
      }
      if (!assigned.has(`${empId}:${dateKey(y, m, d)}`)) break
      streak++
      d--
    }
    return streak
  }

  // 是否已連續工作到上限：今天再加一班就會超過「每人每週最多連續工作天數」
  function overConsecutive(empId, dayNum) {
    if (maxConsecutive <= 0) return false
    return consecutiveDaysBefore(empId, dayNum) >= maxConsecutive
  }

  function hasAllSkills(empId) {
    if (workItemIds.length === 0) return false
    const sks = skillsByEmp.get(String(empId))
    if (!sks || sks.size === 0) return false
    return workItemIds.every((id) => sks.has(id))
  }

  function score(empId, shiftCode, dayNum, index, uncovered) {
    let s = 0
    s += (hoursDone[empId] / Math.max(1, targetHours[empId])) * 1000
    s += (codeCount[empId][shiftCode] || 0) * 3
    const streak = consecutiveDaysBefore(empId, dayNum)
    s += streak * streak * 25
    if (preferMap[`${empId}:${dateKey(year, month, dayNum)}`] === shiftCode) s -= 500
    // 平日（一～五）早班：雙技能（會所有工作項目）者優先
    if (isWeekdayMorningShift(dayNum, shiftCode) && hasAllSkills(empId)) s -= 300
    // 具備「尚未被覆蓋的工作項目」技能者優先（讓每班吧台/內場都有人負責）
    if (uncovered && uncovered.size) {
      const sks = skillsByEmp.get(String(empId))
      if (sks && sks.size) {
        let hits = 0
        for (const w of uncovered) if (sks.has(w)) hits++
        if (hits > 0) s -= 200 * hits
      }
    }
    // 隨機值：讓「完全同分」的人選每次略有不同（避免永遠照陣列順序取前面的人）。
    // 平日早班用較小幅度（50）——「偏好 −500」「雙技能 −300」的優先權差距遠大於此，
    // 所以偏好早班仍會優先、雙技能者仍會優先，只是同分時改為隨機。
    // 其餘班別維持較大幅度（250），讓排班每次看起來略有不同。
    if (isWeekdayMorningShift(dayNum, shiftCode)) s += Math.random() * 50
    else s += Math.random() * 250
    s += index * 0.001
    return s
  }

  const unfilled = []

  for (let day = 1; day <= days; day++) {
    if (closedSet.has(day)) continue
    const type = dayType(day)
    const usedToday = new Set()
    const assignedToday = {}

    // Phase 1：有偏好的員工優先排入其偏好班別（依公平性分數取需要的人數）
    for (const shift of workShifts) {
      const need = headcountMap[`${shift.code}:${type}`]
      if (!need) continue
      const dkey = dateKey(year, month, day)
      const uncovered = uncoveredFor(day, shift.code)
      const prefs = activeEmployees
        .filter((emp) => {
          if (usedToday.has(emp.id)) return false
          if (overConsecutive(emp.id, day)) return false
          if (preferMap[`${emp.id}:${dkey}`] !== shift.code) return false
          return canWork(emp.id, day, shift)
        })
        .sort((a, b) => score(a.id, shift.code, day, 0, uncovered) - score(b.id, shift.code, day, 0, uncovered))
      let filled = 0
      for (const emp of prefs) {
        if (filled >= need) break
        usedToday.add(emp.id)
        const key = `${emp.id}:${dkey}`
        assigned.set(key, shift.code)
        hoursDone[emp.id] += hoursPerShift[emp.id]
        codeCount[emp.id][shift.code] = (codeCount[emp.id][shift.code] || 0) + 1
        ;(shiftPeople.get(shiftGroupKey(day, shift.code)) || shiftPeople.set(shiftGroupKey(day, shift.code), []).get(shiftGroupKey(day, shift.code))).push(emp.id)
        markCovered(day, shift.code, emp.id)
        filled++
      }
      if (filled) assignedToday[shift.code] = filled
    }

    // Phase 2：其餘人力依公平性分數補齊
    for (const shift of workShifts) {
      const need = headcountMap[`${shift.code}:${type}`]
      if (!need) continue
      for (let slot = assignedToday[shift.code] || 0; slot < need; slot++) {
        const uncovered = uncoveredFor(day, shift.code)
        const candidates = activeEmployees.filter((emp) => {
          if (usedToday.has(emp.id)) return false
          if (overConsecutive(emp.id, day)) return false
          return canWork(emp.id, day, shift)
        })
        if (candidates.length === 0) {
          unfilled.push({ day, shift_code: shift.code })
          continue
        }
        // 該班還有未覆蓋的工作項目時，優先從「能補上缺漏技能」的人裡選，
        // 避免同班都是同技能、導致吧台/內場沒人負責；真的找不到才退回全部人選
        let pool = candidates
        if (uncovered && uncovered.size) {
          const coverers = candidates.filter((emp) => {
            const sks = skillsByEmp.get(String(emp.id))
            if (!sks || sks.size === 0) return false
            for (const w of uncovered) if (sks.has(w)) return true
            return false
          })
          if (coverers.length > 0) {
            // 剩餘人數不足以讓每個未覆蓋項目都有人負責時（例：單人班卻要顧吧台+內場），
            // 硬性優先選「能覆蓋最多項目」的人——否則明明有雙技能員工，卻因挑單技能者而留下缺漏
            const remainingSlots = need - slot
            if (remainingSlots <= uncovered.size) {
              let maxCov = 0
              const covCount = (emp) => {
                const sks = skillsByEmp.get(String(emp.id))
                let c = 0
                if (sks) for (const w of uncovered) if (sks.has(w)) c++
                return c
              }
              for (const emp of coverers) if (covCount(emp) > maxCov) maxCov = covCount(emp)
              pool = coverers.filter((emp) => covCount(emp) === maxCov)
            } else {
              pool = coverers
            }
          }
        }
        let best = pool[0]
        let bestScore = Infinity
        for (let i = 0; i < pool.length; i++) {
          const s = score(pool[i].id, shift.code, day, i, uncovered)
          if (s < bestScore) {
            bestScore = s
            best = pool[i]
          }
        }
        usedToday.add(best.id)
        const key = `${best.id}:${dateKey(year, month, day)}`
        assigned.set(key, shift.code)
        hoursDone[best.id] += hoursPerShift[best.id]
        codeCount[best.id][shift.code] = (codeCount[best.id][shift.code] || 0) + 1
        ;(shiftPeople.get(shiftGroupKey(day, shift.code)) || shiftPeople.set(shiftGroupKey(day, shift.code), []).get(shiftGroupKey(day, shift.code))).push(best.id)
        markCovered(day, shift.code, best.id)
      }
    }
  }

  // 工作項目分配：每個班別內，依員工技能把工作項目分給負責的人；
  // 若該工作項目無人具備技能，則視為「未被滿足」加入 unfilled
  const workItemByKey = new Map() // `${empId}:${date}` → work_item_id[]（單日單班，所以以人日為鍵）
  for (const [groupKey, people] of shiftPeople) {
    const byEmp = distributeWorkItems(people, workItems, skillsByEmp)
    for (const empId of people) {
      const key = `${empId}:${dateKey(year, month, Number(groupKey.split(':')[0]))}`
      const ids = byEmp[empId] || []
      if (ids.length) workItemByKey.set(key, ids)
    }
    // 檢查是否有工作項目未被滿足
    for (const w of workItems) {
      const any = people.some((id) => {
        const sks = skillsByEmp.get(String(id))
        return sks && sks.has(String(w.id))
      })
      if (!any) {
        const [dayNum, shiftCode] = groupKey.split(':')
        unfilled.push({ day: Number(dayNum), shift_code: shiftCode, work_item: String(w.id) })
      }
    }
  }

  const assignments = []
  for (const [key, shiftCode] of assigned) {
    const [empId, date] = key.split(':')
    const [, m, d] = date.split('-').map(Number)
    const workItemIds = workItemByKey.get(key) || []
    assignments.push({
      year,
      month: m,
      day: d,
      shift_code: shiftCode,
      employee_id: empId,
      work_item: workItemIds.join(','),
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

/**
 * 把工作項目分配給一個班別內的人員（尊重員工技能）。
 *
 * 規則：
 * - 只有一人 → 該人負責「所有」工作項目（一人要同時勝任吧台與內場）
 * - 多人 → 依序為每個工作項目找一位「具備該技能」的人負責（優先挑還沒分配到的人）
 * - 若某工作項目無人具備技能 → 不指派（該項目即「未被滿足」）
 * - 其餘沒分配到的人 → 顯示他的第一個技能（有技能者）
 *
 * @param {Array<string>} people 該班的人員 id 列表
 * @param {Array} workItems 工作項目 [{id, name, icon}]
 * @param {Map<string, Set<string>>} skillsByEmp 員工技能表
 * @returns {Object<string, string[]>} empId → work_item_id[]
 */
export function distributeWorkItems(people, workItems, skillsByEmp) {
  const byEmp = {}
  if (!workItems.length) return byEmp
  if (people.length === 1) {
    // 只有一人 → 只分配「該人具備技能」的工作項目，避免把沒技能的工作（例：內場員工被排吧台）
    // 勾到該人身上；缺少技能而無法覆蓋的項目會由呼叫端視為「未被滿足」
    const pid = String(people[0])
    const sks = skillsByEmp.get(pid)
    const owned = sks && sks.size ? workItems.filter((w) => sks.has(String(w.id))).map((w) => String(w.id)) : []
    if (owned.length) byEmp[pid] = owned
    return byEmp
  }
  const covered = new Set()
  for (const w of workItems) {
    const wid = String(w.id)
    let pick = null
    for (const id of people) {
      const sks = skillsByEmp.get(String(id))
      if (sks && sks.has(wid) && !covered.has(id)) {
        pick = id
        break
      }
    }
    if (!pick) {
      for (const id of people) {
        const sks = skillsByEmp.get(String(id))
        if (sks && sks.has(wid)) {
          pick = id
          break
        }
      }
    }
    if (!pick) continue
    const pid = String(pick)
    byEmp[pid] = byEmp[pid] || []
    if (!byEmp[pid].includes(wid)) byEmp[pid].push(wid)
    covered.add(pid)
  }
  for (const id of people) {
    const pid = String(id)
    if (!byEmp[pid]) {
      const sks = skillsByEmp.get(pid)
      const w = sks ? workItems.find((x) => sks.has(String(x.id))) : undefined
      if (w) byEmp[pid] = [String(w.id)]
    }
  }
  return byEmp
}
