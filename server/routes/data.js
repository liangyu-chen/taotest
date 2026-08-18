import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { readTable, replaceRows, appendRows, nextId, TABLES, EMPLOYEE_COLORS } from '../storage.js'
import { requireAuth, requireAdmin, toPublicUser } from '../auth.js'

const router = Router()
const routerAdmin = Router()
routerAdmin.use(requireAuth, requireAdmin)

const USER_HEADERS = TABLES.users

function validateEmployeeColor(rows, color, excludeId) {
  const used = rows.find((e) => e.id !== excludeId && e.color === color)
  if (used) return `顏色已被員工「${used.name}」使用，每位員工需有不同顏色`
  return ''
}

function pickFreeColor(rows, excludeId) {
  const used = new Set(rows.filter((e) => e.id !== excludeId && e.color).map((e) => e.color))
  return EMPLOYEE_COLORS.find((c) => !used.has(c)) || ''
}

router.get('/users', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const users = await readTable('users')
    users.sort((a, b) => Number(a.id) - Number(b.id))
    res.json({ users: users.map(toPublicUser) })
  } catch (e) {
    next(e)
  }
})

router.post('/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { username, password, display_name, role, employee_id } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: '帳號與密碼為必填' })
    const users = await readTable('users')
    if (users.some((u) => u.username.toLowerCase() === String(username).trim().toLowerCase())) {
      return res.status(400).json({ error: '帳號已存在' })
    }
    const row = [
      String(nextId(users)),
      String(username).trim(),
      await bcrypt.hash(String(password), 10),
      display_name || String(username).trim(),
      role === 'user' ? 'user' : 'admin',
      employee_id || '',
      new Date().toISOString(),
    ]
    await appendRows('users', [row])
    const fresh = await readTable('users')
    res.json({ user: toPublicUser(fresh.find((u) => u.id === row[0])) })
  } catch (e) {
    next(e)
  }
})

router.put('/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await readTable('users')
    const idx = users.findIndex((u) => u.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '帳號不存在' })
    const { display_name, role, password, employee_id } = req.body || {}
    if (display_name !== undefined) users[idx].display_name = String(display_name)
    if (role !== undefined) users[idx].role = role === 'admin' ? 'admin' : 'user'
    if (employee_id !== undefined) users[idx].employee_id = String(employee_id)
    if (password) users[idx].password_hash = await bcrypt.hash(String(password), 10)
    const rows = [USER_HEADERS, ...users.map((u) => USER_HEADERS.map((h) => u[h] ?? ''))]
    await replaceRows('users', rows)
    const fresh = await readTable('users')
    res.json({ user: toPublicUser(fresh.find((u) => u.id === req.params.id)) })
  } catch (e) {
    next(e)
  }
})

router.delete('/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await readTable('users')
    const idx = users.findIndex((u) => u.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '帳號不存在' })
    if (users[idx].username === req.user.username) {
      return res.status(400).json({ error: '不能刪除自己目前的帳號' })
    }
    users.splice(idx, 1)
    const rows = [USER_HEADERS, ...users.map((u) => USER_HEADERS.map((h) => u[h] ?? ''))]
    await replaceRows('users', rows)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/employees', requireAuth, async (_req, res, next) => {
  try {
    const [employees, skillRows, workItems] = await Promise.all([
      readTable('employees'),
      readTable('employee_skills'),
      readTable('work_items'),
    ])
    const itemById = Object.fromEntries(workItems.map((w) => [w.id, w]))
    const byEmp = {}
    for (const s of skillRows) {
      if (!s.employee_id) continue
      ;(byEmp[s.employee_id] ||= []).push(s.work_item_id)
    }
    // 技能顯示順序與「工作項目」頁一致：依 work_items.sort，再以名稱排序
    const enriched = employees.map((e) => {
      const known = []
      const unknown = []
      for (const id of byEmp[e.id] || []) {
        const it = itemById[id]
        if (it) known.push(it)
        else unknown.push({ id, name: id, icon: '' })
      }
      known.sort(
        (a, b) =>
          (Number(a.sort) || 0) - (Number(b.sort) || 0) ||
          String(a.name).localeCompare(String(b.name), 'zh-Hant'),
      )
      const skills = [
        ...known.map((it) => ({ id: it.id, name: it.name, icon: it.icon || '' })),
        ...unknown,
      ].filter((s) => s.name)
      return { ...e, skills }
    })
    // 員工名單／行事曆／彙總／匯出統一依「排序」欄位顯示（未設定時依 id）
    enriched.sort((a, b) => {
      const sa = Number(a.sort) || Number(a.id) || 0
      const sb = Number(b.sort) || Number(b.id) || 0
      return sa - sb || String(a.name).localeCompare(String(b.name), 'zh-Hant')
    })
    res.json({ employees: enriched })
  } catch (e) {
    next(e)
  }
})

async function setEmployeeSkills(employeeId, skillIds) {
  const rows = await readTable('employee_skills')
  const others = rows.filter((r) => r.employee_id !== employeeId)
  const headers = TABLES.employee_skills
  await replaceRows('employee_skills', [
    headers,
    ...others.map((r) => [r.employee_id, r.work_item_id]),
    ...skillIds.map((id) => [employeeId, id]),
  ])
}

function normalizeSkillIds(skills) {
  if (!Array.isArray(skills)) return []
  return [...new Set(skills.map((s) => String(s).trim()).filter(Boolean))]
}

router.post('/employees', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, employee_no, employee_type, shift_hours, weekly_hours, color, sort, priority, skills } = req.body || {}
    if (!name) return res.status(400).json({ error: '員工姓名為必填' })
    const rows = await readTable('employees')
    const colorVal = String(color ?? '').trim()
    const finalColor = colorVal || pickFreeColor(rows)
    const colorErr = finalColor ? validateEmployeeColor(rows, finalColor) : ''
    if (colorErr) return res.status(400).json({ error: colorErr })
    const id = String(nextId(rows))
    const row = [
      id,
      String(name).trim(),
      String(employee_no || '').trim(),
      employee_type === 'fulltime' ? 'fulltime' : 'parttime',
      String(shift_hours ?? ''),
      String(weekly_hours ?? ''),
      finalColor,
      String(sort ?? id).trim(),
      ['priority', 'equal', 'secondary'].includes(priority) ? priority : 'equal',
      '1',
      new Date().toISOString(),
    ]
    const skillIds = normalizeSkillIds(skills)
    if (!skillIds.length) return res.status(400).json({ error: '請至少選擇一項工作技能' })
    await appendRows('employees', [row])
    await setEmployeeSkills(String(row[0]), skillIds)
    const fresh = await readTable('employees')
    res.json({ employee: fresh.find((e) => e.id === row[0]) })
  } catch (e) {
    next(e)
  }
})

router.put('/employees/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await readTable('employees')
    const idx = rows.findIndex((e) => e.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '員工不存在' })
    const { name, employee_no, employee_type, shift_hours, weekly_hours, active, color, sort, priority, skills } = req.body || {}
    if (name !== undefined) rows[idx].name = String(name)
    if (employee_no !== undefined) rows[idx].employee_no = String(employee_no)
    if (employee_type !== undefined) rows[idx].employee_type = employee_type === 'fulltime' ? 'fulltime' : 'parttime'
    if (shift_hours !== undefined) rows[idx].shift_hours = String(shift_hours)
    if (weekly_hours !== undefined) rows[idx].weekly_hours = String(weekly_hours)
    if (sort !== undefined) rows[idx].sort = String(sort)
    if (priority !== undefined) rows[idx].priority = ['priority', 'equal', 'secondary'].includes(priority) ? priority : 'equal'
    if (active !== undefined) rows[idx].active = active ? '1' : '0'
    if (color !== undefined) {
      const colorVal = String(color).trim()
      const colorErr = colorVal ? validateEmployeeColor(rows, colorVal, req.params.id) : ''
      if (colorErr) return res.status(400).json({ error: colorErr })
      rows[idx].color = colorVal
    }
    if (skills !== undefined) {
      const skillIds = normalizeSkillIds(skills)
      if (!skillIds.length) return res.status(400).json({ error: '請至少選擇一項工作技能' })
      await setEmployeeSkills(req.params.id, skillIds)
    }
    const headers = TABLES.employees
    await replaceRows('employees', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    const fresh = await readTable('employees')
    res.json({ employee: fresh.find((e) => e.id === req.params.id) })
  } catch (e) {
    next(e)
  }
})

router.delete('/employees/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await readTable('employees')
    const idx = rows.findIndex((e) => e.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '員工不存在' })
    rows.splice(idx, 1)
    const headers = TABLES.employees
    await replaceRows('employees', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    const skills = await readTable('employee_skills')
    const remaining = skills.filter((r) => r.employee_id !== req.params.id)
    await replaceRows('employee_skills', [
      TABLES.employee_skills,
      ...remaining.map((r) => [r.employee_id, r.work_item_id]),
    ])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/shift-types', requireAuth, async (_req, res, next) => {
  try {
    res.json({ shiftTypes: await readTable('shift_types') })
  } catch (e) {
    next(e)
  }
})

router.post('/shift-types', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, code, start_time, end_time, color, sort } = req.body || {}
    if (!name || !code) return res.status(400).json({ error: '班別名稱與代碼為必填' })
    const rows = await readTable('shift_types')
    if (rows.some((s) => s.code === String(code).trim())) {
      return res.status(400).json({ error: '班別代碼重複' })
    }
    const row = [
      String(nextId(rows)),
      String(name).trim(),
      String(code).trim().toUpperCase(),
      start_time || '',
      end_time || '',
      color || '#2563eb',
      String(sort ?? rows.length + 1),
      new Date().toISOString(),
    ]
    await appendRows('shift_types', [row])
    const fresh = await readTable('shift_types')
    res.json({ shiftType: fresh.find((s) => s.id === row[0]) })
  } catch (e) {
    next(e)
  }
})

router.put('/shift-types/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await readTable('shift_types')
    const idx = rows.findIndex((s) => s.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '班別不存在' })
    const { name, code, start_time, end_time, color, sort } = req.body || {}
    if (name !== undefined) rows[idx].name = String(name)
    if (code !== undefined) rows[idx].code = String(code).trim().toUpperCase()
    if (start_time !== undefined) rows[idx].start_time = String(start_time)
    if (end_time !== undefined) rows[idx].end_time = String(end_time)
    if (color !== undefined) rows[idx].color = String(color)
    if (sort !== undefined) rows[idx].sort = String(sort)
    const headers = TABLES.shift_types
    await replaceRows('shift_types', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    const fresh = await readTable('shift_types')
    res.json({ shiftType: fresh.find((s) => s.id === req.params.id) })
  } catch (e) {
    next(e)
  }
})

router.delete('/shift-types/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await readTable('shift_types')
    const idx = rows.findIndex((s) => s.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '班別不存在' })
    rows.splice(idx, 1)
    const headers = TABLES.shift_types
    await replaceRows('shift_types', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/headcounts', requireAuth, async (_req, res, next) => {
  try {
    res.json({ headcounts: await readTable('headcounts') })
  } catch (e) {
    next(e)
  }
})

router.put('/headcounts', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const list = req.body?.headcounts || []
    const headers = TABLES.headcounts
    const valid = ['weekday', 'weekend', 'holiday']
    const rows = [
      headers,
      ...list.map((h) => [
        String(h.shift_code),
        valid.includes(String(h.day_type)) ? String(h.day_type) : 'weekday',
        Math.max(0, Number(h.count) || 0),
      ]),
    ]
    await replaceRows('headcounts', rows)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/settings', requireAuth, async (_req, res, next) => {
  try {
    res.json({ settings: await readTable('settings') })
  } catch (e) {
    next(e)
  }
})

router.put('/settings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const list = req.body?.settings || []
    const headers = TABLES.settings
    const rows = [headers, ...list.map((s) => [String(s.key), String(s.value ?? ''), String(s.desc ?? '')])]
    await replaceRows('settings', rows)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/work-items', requireAuth, async (_req, res, next) => {
  try {
    const items = await readTable('work_items')
    items.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    res.json({ workItems: items })
  } catch (e) {
    next(e)
  }
})

router.post('/work-items', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, icon, sort } = req.body || {}
    if (!name) return res.status(400).json({ error: '工作項目名稱為必填' })
    const rows = await readTable('work_items')
    if (rows.some((w) => w.name === String(name).trim())) {
      return res.status(400).json({ error: '工作項目名稱重複' })
    }
    const row = [
      String(nextId(rows)),
      String(name).trim(),
      String(icon ?? '').trim(),
      String(sort ?? rows.length + 1),
      new Date().toISOString(),
    ]
    await appendRows('work_items', [row])
    const fresh = await readTable('work_items')
    res.json({ workItem: fresh.find((w) => w.id === row[0]) })
  } catch (e) {
    next(e)
  }
})

router.put('/work-items/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await readTable('work_items')
    const idx = rows.findIndex((w) => w.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '工作項目不存在' })
    const { name, icon, sort } = req.body || {}
    if (name !== undefined) {
      const trimmed = String(name).trim()
      if (rows.some((w) => w.id !== req.params.id && w.name === trimmed)) {
        return res.status(400).json({ error: '工作項目名稱重複' })
      }
      rows[idx].name = trimmed
    }
    if (icon !== undefined) rows[idx].icon = String(icon)
    if (sort !== undefined) rows[idx].sort = String(sort)
    const headers = TABLES.work_items
    await replaceRows('work_items', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    const fresh = await readTable('work_items')
    res.json({ workItem: fresh.find((w) => w.id === req.params.id) })
  } catch (e) {
    next(e)
  }
})

router.delete('/work-items/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await readTable('work_items')
    const idx = rows.findIndex((w) => w.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '工作項目不存在' })
    rows.splice(idx, 1)
    const headers = TABLES.work_items
    await replaceRows('work_items', [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

export default router
