import { Router } from 'express'
import { readTable, selectWhere, replaceRows, appendRows, deleteWhere, updateWhere, upsertRow, TABLES } from '../storage.js'
import { requireAuth, requireAdmin } from '../auth.js'
import { generateSchedule } from '../scheduler.js'

const router = Router()
const routerAdmin = Router()
routerAdmin.use(requireAuth, requireAdmin)

function monthBounds(year, month) {
  const y = Number(year)
  const m = Number(month)
  if (!y || !m || m < 1 || m > 12) throw Object.assign(new Error('年份或月份格式錯誤'), { status: 400 })
  return { y, m }
}

// 檢查「HH:mm」格式，並回傳該時間換算成當日分鐘數（24:00 = 1440）
function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim())
  if (!m) return null
  const total = Number(m[1]) * 60 + Number(m[2])
  return total > 1440 ? null : total
}

// 檢查一段時段是否合法（必填、格式正確、結束在開始之後）
function validShiftTime(start_time, end_time) {
  const s = toMin(start_time)
  const e = toMin(end_time)
  if (s === null || e === null) return false
  if (e <= s) return false
  return true
}

// 早班＝開始時間最早的班別（例如 12:00 的 M 班）
function morningShiftCode(shiftTypes) {
  const withTime = shiftTypes.filter((s) => toMin(s.start_time) !== null)
  if (withTime.length === 0) return null
  return withTime.reduce((a, b) => (toMin(a.start_time) < toMin(b.start_time) ? a : b)).code
}

// 檢核排班的「開始時間」是否與班別設定一致：
// 1. 每個班別都不可晚於「下一個班別」的開始時間（例如午班 14:00、晚班 16:00，
//    午班卻 17:00 開始已屬晚班時段）；最後一班沒有上限。
// 2. 非早班：開始時間不可早於該班別設定的開始時間（例如晚班設定 16:00，卻帶 12:00 開始）；
//    早班（開始時間最早的班別）允許比設定更早（例如早於 12:00 也算合理）。
// 回傳 null = 沒問題；回傳字串 = 應阻擋的錯誤訊息
function shiftStartError(shiftTypes, shiftCode, startTime) {
  const shift = shiftTypes.find((s) => s.code === shiftCode)
  if (!shift || !shift.start_time) return null
  const sMin = toMin(startTime)
  const cfg = toMin(shift.start_time)
  if (sMin === null || cfg === null) return null

  // 1. 所有班別：開始時間不可晚於「開始時間比這班晚」的班別中最接近的一班
  const next = shiftTypes
    .map((s) => ({ code: s.code, min: toMin(s.start_time) }))
    .filter((s) => s.min !== null && s.min > cfg)
    .reduce((a, b) => (b.min < a.min ? b : a), { code: null, min: Infinity })
  if (next.min !== Infinity && sMin >= next.min) {
    const nextShift = shiftTypes.find((s) => s.code === next.code)
    return `「${shift.name}」的開始時間不可晚於 ${nextShift?.start_time || ''}（此時段已屬下一班），請調整時間`
  }

  // 2. 非早班：開始時間不可早於設定的開始時間（早班允許提早）
  if (morningShiftCode(shiftTypes) !== shiftCode && sMin < cfg) {
    return `「${shift.name}」的開始時間不可早於設定的 ${shift.start_time}，請調整時間`
  }
  return null
}

async function currentEmployeeId(req) {
  if (req.user.employeeId) return String(req.user.employeeId)
  const users = await readTable('users')
  const u = users.find((x) => x.username === req.user.username)
  return String(u?.employee_id || '')
}

router.get('/availability', requireAuth, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.query.year, req.query.month)
    const prefix = `${y}-${String(m).padStart(2, '0')}`
    const all = await readTable('availability')
    let rows = all.filter((a) => a.date && a.date.startsWith(prefix))
    if (req.user.role !== 'admin') {
      const myEmp = await currentEmployeeId(req)
      rows = rows.filter((a) => a.employee_id === myEmp)
    }
    res.json({ availability: rows })
  } catch (e) {
    next(e)
  }
})

router.put('/availability', requireAuth, async (req, res, next) => {
  try {
    let { employee_id, date, status, note, start_time, end_time } = req.body || {}
    if (!employee_id || !date) return res.status(400).json({ error: '員工與日期為必填' })
    if (req.user.role !== 'admin' && (await currentEmployeeId(req)) !== employee_id) {
      return res.status(403).json({ error: '只能設定自己的排休偏好' })
    }
    employee_id = String(employee_id)
    date = String(date)
    status = status || 'off'
    note = note || ''
    start_time = String(start_time ?? '')
    end_time = String(end_time ?? '')
    if (status === 'unavailable') {
      if (!/^\d{1,2}:\d{2}$/.test(start_time) || !/^\d{1,2}:\d{2}$/.test(end_time)) {
        return res.status(400).json({ error: '請選擇正確的開始與結束時段' })
      }
    } else {
      start_time = ''
      end_time = ''
    }
    await upsertRow('availability', ['employee_id', 'date'], {
      employee_id,
      date,
      status,
      note,
      start_time,
      end_time,
    })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.delete('/availability', requireAuth, async (req, res, next) => {
  try {
    const { employee_id, date } = req.query
    if (!employee_id || !date) return res.status(400).json({ error: '參數不足' })
    if (req.user.role !== 'admin' && (await currentEmployeeId(req)) !== String(employee_id)) {
      return res.status(403).json({ error: '只能設定自己的排休偏好' })
    }
    await deleteWhere('availability', { employee_id: String(employee_id), date: String(date) })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/schedule', requireAuth, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.query.year, req.query.month)
    // 直接在 SQL 過濾月份，配合 ux_schedule_key 前綴索引，不再整表撈回 JS 端
    const all = await selectWhere('schedule', { year: String(y), month: String(m) })
    const assignments = all.map((a) => ({
      year: Number(a.year),
      month: Number(a.month),
      day: Number(a.day),
      shift_code: a.shift_code,
      employee_id: String(a.employee_id),
      note: a.note || '',
      work_item: a.work_item || '',
      start_time: a.start_time || '',
      end_time: a.end_time || '',
    }))
    res.json({ assignments })
  } catch (e) {
    next(e)
  }
})

router.get('/schedule/locks', requireAuth, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.query.year, req.query.month)
    const rows = await selectWhere('schedule_locks', { year: String(y), month: String(m) })
    const lockedDays = rows.map((r) => Number(r.day)).sort((a, b) => a - b)
    res.json({ lockedDays })
  } catch (e) {
    next(e)
  }
})

// 公休日：查詢某月份哪些天是公休日（當天不營業，自動排班會跳過）
router.get('/schedule/closed', requireAuth, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.query.year, req.query.month)
    const rows = await selectWhere('closed_days', { year: String(y), month: String(m) })
    const closedDays = rows.map((r) => Number(r.day)).sort((a, b) => a - b)
    res.json({ closedDays })
  } catch (e) {
    next(e)
  }
})

// 批次設定/解除公休日；設定為公休日時會同時清空該天既有的排班人員
router.put('/schedule/closed', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.body.year, req.body.month)
    const days = Array.isArray(req.body.days)
      ? [...new Set(req.body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31))]
      : []
    const closed = req.body.closed !== false
    const existing = await selectWhere('closed_days', { year: String(y), month: String(m) })
    const currentDays = new Set(existing.map((r) => Number(r.day)))
    if (closed) {
      // 新增不在清單中的公休日
      const missing = days.filter((d) => !currentDays.has(d))
      if (missing.length) {
        await appendRows('closed_days', missing.map((d) => [String(y), String(m), String(d)]))
      }
      // 清空這些天已排的人員
      for (const d of days) {
        await deleteWhere('schedule', { year: String(y), month: String(m), day: String(d) })
      }
    } else {
      // 解除公休日：僅移除公休標記，不影響既有排班
      for (const d of days) {
        await deleteWhere('closed_days', { year: String(y), month: String(m), day: String(d) })
      }
    }
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.put('/schedule/locks', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.body.year, req.body.month)
    const days = Array.isArray(req.body.days)
      ? [...new Set(req.body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31))]
      : []
    const locked = req.body.locked !== false
    let rows = await readTable('schedule_locks')
    const headers = TABLES.schedule_locks
    if (locked) {
      const existing = new Set(rows.filter((r) => Number(r.year) === y && Number(r.month) === m).map((r) => Number(r.day)))
      const missing = days.filter((d) => !existing.has(d))
      if (missing.length) {
        await appendRows('schedule_locks', missing.map((d) => [String(y), String(m), String(d)]))
      }
    } else {
      const remaining = rows.filter((r) => !(Number(r.year) === y && Number(r.month) === m && days.includes(Number(r.day))))
      await replaceRows('schedule_locks', [headers, ...remaining.map((r) => headers.map((h) => r[h] ?? ''))])
    }
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.post('/schedule/generate', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.body.year, req.body.month)
    const [employees, shiftTypes, headcounts, availability, settings, lockRows, wi, employeeSkills, closedRows] =
      await Promise.all([
        readTable('employees'),
        readTable('shift_types'),
        readTable('headcounts'),
        readTable('availability'),
        readTable('settings'),
        readTable('schedule_locks'),
        readTable('work_items'),
        readTable('employee_skills'),
        readTable('closed_days'),
      ])
    // 上個月的排班：讓「本月初的連續上班天數」能回溯上個月（跨年時自動扣一年）
    const prevY = m === 1 ? y - 1 : y
    const prevM = m === 1 ? 12 : m - 1
    const prevRows = await selectWhere('schedule', { year: String(prevY), month: String(prevM) })
    const prevAssignments = prevRows.map((a) => ({
      year: Number(a.year),
      month: Number(a.month),
      day: Number(a.day),
      shift_code: a.shift_code,
      employee_id: String(a.employee_id),
    }))
    // 工作項目依 sort 排序，讓分配與存檔的圖示順序一致（吧台在前、內場在後）
    const workItems = wi.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    // 已鎖定的日期：自動排班完全保留原狀，不新增、不修改、不移除
    const lockedDays = new Set(
      lockRows.filter((r) => Number(r.year) === y && Number(r.month) === m).map((r) => Number(r.day)),
    )
    // 公休日：當天不營業，自動排班直接跳過（不排任何人）
    const closedDays = new Set(
      closedRows.filter((r) => Number(r.year) === y && Number(r.month) === m).map((r) => Number(r.day)),
    )
    const result = generateSchedule({
      year: y,
      month: m,
      employees,
      shiftTypes,
      headcounts,
      availability,
      settings,
      workItems,
      employeeSkills,
      closedDays,
      prevAssignments,
    })

    const headers = TABLES.schedule
    const existing = await readTable('schedule')
    // 保留「非本月」的舊資料 + 「本月但已鎖定」的既有排班；公休日一併清空
    const keep = existing.filter(
      (a) => !(Number(a.year) === y && Number(a.month) === m) || (lockedDays.has(Number(a.day)) && !closedDays.has(Number(a.day))),
    )
    // 自動排班的結果排除已鎖定與公休日期（那些日期維持原狀）
    const newRows = result.assignments
      .filter((a) => !lockedDays.has(a.day) && !closedDays.has(a.day))
      .map((a) => [
        String(a.year),
        String(a.month),
        String(a.day),
        a.shift_code,
        String(a.employee_id),
        a.note || '',
        a.work_item || '',
        a.start_time || '',
        a.end_time || '',
      ])
    const rows = [
      headers,
      ...keep.map((r) => headers.map((h) => r[h] ?? '')),
      ...newRows.map((r) => r.slice()),
    ]
    await replaceRows('schedule', rows)

    result.unfilled = result.unfilled.filter((u) => !lockedDays.has(u.day) && !closedDays.has(u.day))
    res.json(result)
  } catch (e) {
    next(e)
  }
})

router.put('/schedule/assign', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { year, month, day, shift_code, to_shift_code, employee_id, action, note, work_item, start_time, end_time } = req.body || {}
    if (!year || !month || !day || !shift_code) return res.status(400).json({ error: '參數不足' })
    const y = String(year)
    const m = String(month)
    const d = String(day)
    const sc = String(shift_code)
    // 後端防線：已鎖定的日期不可新增/修改/移除排班
    const lockRows = await readTable('schedule_locks')
    const isLocked = lockRows.some((r) => Number(r.year) === Number(y) && Number(r.month) === Number(m) && Number(r.day) === Number(d))
    if (isLocked) return res.status(409).json({ error: `此日（${Number(m)}/${Number(d)}）已鎖定，無法更動排班` })
    // 檢核開始時間是否與目標班別設定一致（早班允許更早，晚班不得早於設定開始）
    const shiftTypes = await readTable('shift_types')
    // 置換班別：同一天的同一人直接改 shift_code（不刪不新增，note/work_item 留在原列）。
    // 置換時需帶上新班別時段（前端會彈窗要求填寫）
    if (action === 'move') {
      if (!to_shift_code || !employee_id) return res.status(400).json({ error: '參數不足' })
      if (!validShiftTime(start_time, end_time)) {
        return res.status(400).json({ error: '請填寫正確的排班時段' })
      }
      if (String(to_shift_code) === sc) return res.json({ ok: true })
      const startErr = shiftStartError(shiftTypes, String(to_shift_code), start_time)
      if (startErr) return res.status(400).json({ error: startErr })
      const changed = await updateWhere(
        'schedule',
        { year: y, month: m, day: d, shift_code: sc, employee_id: String(employee_id) },
        { shift_code: String(to_shift_code), start_time: String(start_time), end_time: String(end_time) },
      )
      if (!changed) return res.status(404).json({ error: '找不到該筆排班，無法置換' })
      return res.json({ ok: true })
    }
    const isAdd = action !== 'remove'
    if (isAdd) {
      if (!employee_id) return res.status(400).json({ error: '請選擇人員' })
      if (!validShiftTime(start_time, end_time)) {
        return res.status(400).json({ error: '請填寫正確的排班時段' })
      }
      const startErr = shiftStartError(shiftTypes, sc, start_time)
      if (startErr) return res.status(400).json({ error: startErr })
      // UPSERT：存在就更新備註/工作項目/時段、不存在就新增，單一 SQL 搞定
      const upsert = { year: y, month: m, day: d, shift_code: sc, employee_id: String(employee_id) }
      if (note !== undefined) upsert.note = note || ''
      if (work_item !== undefined) upsert.work_item = work_item || ''
      if (start_time !== undefined) upsert.start_time = String(start_time)
      if (end_time !== undefined) upsert.end_time = String(end_time)
      await upsertRow('schedule', ['year', 'month', 'day', 'shift_code', 'employee_id'], upsert)
    } else if (employee_id) {
      await deleteWhere('schedule', { year: y, month: m, day: d, shift_code: sc, employee_id: String(employee_id) })
    } else {
      await deleteWhere('schedule', { year: y, month: m, day: d, shift_code: sc })
    }
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

export default router
