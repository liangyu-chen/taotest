import { Router } from 'express'
import { readTable, replaceRows, appendRows, TABLES } from '../sheets.js'
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
    const rows = await readTable('availability')
    const idx = rows.findIndex((r) => r.employee_id === employee_id && r.date === date)
    const headers = TABLES.availability
    if (idx >= 0) {
      rows[idx].status = status
      rows[idx].note = note
      rows[idx].start_time = start_time
      rows[idx].end_time = end_time
    } else {
      rows.push({ employee_id, date, status, note, start_time, end_time })
    }
    await replaceRows('availability', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
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
    const rows = await readTable('availability')
    const idx = rows.findIndex((r) => r.employee_id === String(employee_id) && r.date === String(date))
    if (idx >= 0) {
      rows.splice(idx, 1)
      const headers = TABLES.availability
      await replaceRows('availability', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    }
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/schedule', requireAuth, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.query.year, req.query.month)
    const all = await readTable('schedule')
    const assignments = all
      .filter((a) => Number(a.year) === y && Number(a.month) === m)
      .map((a) => ({
        year: Number(a.year),
        month: Number(a.month),
        day: Number(a.day),
        shift_code: a.shift_code,
        employee_id: String(a.employee_id),
        note: a.note || '',
      }))
    res.json({ assignments })
  } catch (e) {
    next(e)
  }
})

router.post('/schedule/generate', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { y, m } = monthBounds(req.body.year, req.body.month)
    const [employees, shiftTypes, headcounts, availability, settings] = await Promise.all([
      readTable('employees'),
      readTable('shift_types'),
      readTable('headcounts'),
      readTable('availability'),
      readTable('settings'),
    ])
    const result = generateSchedule({ year: y, month: m, employees, shiftTypes, headcounts, availability, settings })

    const headers = TABLES.schedule
    const keep = (await readTable('schedule')).filter(
      (a) => !(Number(a.year) === y && Number(a.month) === m),
    )
    const newRows = result.assignments.map((a) => [
      String(a.year),
      String(a.month),
      String(a.day),
      a.shift_code,
      String(a.employee_id),
      a.note || '',
    ])
    const rows = [
      headers,
      ...keep.map((r) => headers.map((h) => r[h] ?? '')),
      ...newRows.map((r) => r.slice()),
    ]
    await replaceRows('schedule', rows)

    res.json(result)
  } catch (e) {
    next(e)
  }
})

router.put('/schedule/assign', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { year, month, day, shift_code, employee_id, action, note } = req.body || {}
    if (!year || !month || !day || !shift_code) return res.status(400).json({ error: '參數不足' })
    let rows = await readTable('schedule')
    const headers = TABLES.schedule
    const same = (r) =>
      Number(r.year) === Number(year) &&
      Number(r.month) === Number(month) &&
      Number(r.day) === Number(day) &&
      r.shift_code === String(shift_code)
    const isAdd = action !== 'remove'
    if (isAdd) {
      if (!employee_id) return res.status(400).json({ error: '請選擇人員' })
      const key = String(employee_id)
      const idx = rows.findIndex((r) => same(r) && String(r.employee_id) === key)
      if (idx >= 0) {
        if (note !== undefined) rows[idx].note = note
      } else {
        rows.push({
          year: String(year),
          month: String(month),
          day: String(day),
          shift_code: String(shift_code),
          employee_id: key,
          note: note || '',
        })
      }
    } else if (employee_id) {
      const key = String(employee_id)
      rows = rows.filter((r) => !(same(r) && String(r.employee_id) === key))
    } else {
      rows = rows.filter((r) => !same(r))
    }
    await replaceRows('schedule', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

export default router
