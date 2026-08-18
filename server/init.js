// =============================================================
// init.js —— 共用的資料庫初始化與種子資料邏輯
// 建表 + 遷移 + 補種子資料都在這裡，最底層的 I/O 函式由
// 資料層（pg.js）提供，透過 createInitializer(db) 注入。
// =============================================================

import bcrypt from 'bcryptjs'
import { TABLES, EMPLOYEE_COLORS, DEFAULT_SETTINGS, nextId } from './schema.js'
import { DEFAULT_ADMIN } from './config.js'
import { distributeWorkItems } from './scheduler.js'

// schema 版本：任何「建表/遷移/種子」邏輯有改動時請 +1，冷啟動才會重新執行初始化
const SCHEMA_VERSION = '4'

function readHeader(rows) {
  if (rows.length === 0) return []
  return rows[0].map((c) => String(c ?? '').trim())
}

export function createInitializer(db) {
  const { ensureTabs, readRows, readTable, replaceRows, appendRows, updateWhere } = db

  async function migrateEmployees() {
    const rows = await readRows('employees')
    const header = readHeader(rows)
    if (header.join('|') === TABLES.employees.join('|')) return
    if (rows.length === 0) {
      await replaceRows('employees', [TABLES.employees])
      return
    }
    const idx = {}
    header.forEach((h, i) => {
      idx[h] = i
    })
    const get = (r, key) => (idx[key] === undefined ? '' : r[idx[key]] ?? '')
    const out = [
      TABLES.employees,
      ...rows.slice(1).map((r) => [
        get(r, 'id'),
        get(r, 'name'),
        get(r, 'employee_no'),
        get(r, 'employee_type') || 'parttime',
        get(r, 'shift_hours'),
        get(r, 'weekly_hours'),
        get(r, 'color'),
        get(r, 'sort'),
        get(r, 'priority') || 'equal',
        get(r, 'active') === '' ? '1' : get(r, 'active'),
        get(r, 'created_at'),
      ]),
    ]
    await replaceRows('employees', out)
  }

  async function seedEmployeeColors() {
    const emps = await readTable('employees')
    const used = new Set(emps.map((e) => e.color).filter(Boolean))
    const missing = emps.filter((e) => !e.color)
    if (missing.length === 0) return
    const out = emps.map((e) => {
      if (e.color) return e
      const free = EMPLOYEE_COLORS.find((c) => !used.has(c))
      if (free) used.add(free)
      return { ...e, color: free || '' }
    })
    await replaceRows('employees', [TABLES.employees, ...out.map((r) => TABLES.employees.map((h) => r[h] ?? ''))])
  }

  // 既有員工的「排序」欄位預設值：直接以各自的 id 填入資料庫
  // （此後名單／行事曆／彙總／匯出都依這個 sort 排序）
  async function seedEmployeeSorts() {
    const emps = await readTable('employees')
    const missing = emps.filter((e) => !String(e.sort || '').trim())
    if (missing.length === 0) return
    const out = emps.map((e) => {
      if (String(e.sort || '').trim()) return e
      return { ...e, sort: e.id }
    })
    await replaceRows('employees', [TABLES.employees, ...out.map((r) => TABLES.employees.map((h) => r[h] ?? ''))])
  }

  async function migrateHeadcounts() {
    const rows = await readRows('headcounts')
    const header = readHeader(rows)
    if (header.includes('day_type')) return
    if (rows.length === 0) {
      await replaceRows('headcounts', [TABLES.headcounts])
      return
    }
    const idx = {}
    header.forEach((h, i) => {
      idx[h] = i
    })
    const agg = {}
    for (const r of rows.slice(1)) {
      const code = r[idx.shift_code] ?? ''
      const dow = Number(r[idx.day_of_week])
      const count = Number(r[idx.count]) || 0
      if (!code) continue
      const type = Number.isNaN(dow) || dow < 5 ? 'weekday' : 'weekend'
      const key = `${code}:${type}`
      agg[key] = Math.max(agg[key] || 0, count)
    }
    const out = [TABLES.headcounts]
    for (const [key, count] of Object.entries(agg)) {
      const [code, type] = key.split(':')
      out.push([code, type, count])
      if (type === 'weekend') out.push([code, 'holiday', count])
    }
    if (out.length === 1) out.push(...[['M', 'weekday', 1], ['M', 'weekend', 2], ['M', 'holiday', 2], ['N', 'weekday', 1], ['N', 'weekend', 1], ['N', 'holiday', 1]])
    await replaceRows('headcounts', out)
  }

  async function migrateWorkItems() {
    const rows = await readRows('work_items')
    const header = readHeader(rows)
    if (header.join('|') === TABLES.work_items.join('|')) return
    if (rows.length === 0) {
      await replaceRows('work_items', [TABLES.work_items])
      return
    }
    const idx = {}
    header.forEach((h, i) => {
      idx[h] = i
    })
    const get = (r, key) => (idx[key] === undefined ? '' : r[idx[key]] ?? '')
    const defaultIcons = { '吧台': '🍸', '內場': '🍳' }
    const out = [
      TABLES.work_items,
      ...rows.slice(1).map((r) => {
        const name = get(r, 'name')
        return [
          get(r, 'id'),
          name,
          get(r, 'icon') || defaultIcons[name] || '',
          get(r, 'sort'),
          get(r, 'created_at'),
        ]
      }),
    ]
    await replaceRows('work_items', out)
  }

  async function seedShiftTypes() {
    const shifts = await readTable('shift_types')
    const existing = new Set(shifts.map((s) => s.code))
    const defaults = [
      ['早班', 'M', '12:00', '20:00', '#b45309', 1],
      ['晚班', 'N', '16:00', '24:00', '#1d4ed8', 2],
    ]
    const missing = defaults.filter((d) => !existing.has(d[1]))
    if (missing.length) {
      await appendRows(
        'shift_types',
        missing.map((d, i) => [String(nextId(shifts) + i), ...d, new Date().toISOString()]),
      )
    }
  }

  async function removeLegacyRestShift() {
    const items = await readTable('shift_types')
    const remaining = items.filter((s) => String(s.code).toUpperCase() !== 'OFF')
    if (remaining.length === items.length) return
    await replaceRows('shift_types', [TABLES.shift_types, ...remaining.map((r) => TABLES.shift_types.map((h) => r[h] ?? ''))])
  }

  async function seedHeadcounts() {
    const hc = await readTable('headcounts')
    if (hc.length > 0) return
    const rows = [
      ['M', 'weekday', 1],
      ['M', 'weekend', 2],
      ['M', 'holiday', 2],
      ['N', 'weekday', 1],
      ['N', 'weekend', 1],
      ['N', 'holiday', 1],
    ]
    await appendRows('headcounts', rows)
  }

  async function seedSettings() {
    const s = await readTable('settings')
    if (s.length > 0) return
    await appendRows('settings', DEFAULT_SETTINGS)
  }

  async function seedWorkItems() {
    const items = await readTable('work_items')
    if (items.length > 0) return
    const defaults = [
      ['吧台', '🍸', 1],
      ['內場', '🍳', 2],
    ]
    await appendRows(
      'work_items',
      defaults.map((d, i) => [String(nextId(items) + i), ...d, new Date().toISOString()]),
    )
  }

  // 既有班表沒有「工作項目」欄位時自動回填：
  // 一天 1 人 → 該人負責他具備技能的所有工作項目；多人 → 依技能分配，確保每班每項目有人
  async function backfillScheduleWorkItems() {
    const rows = await readTable('schedule')
    const todo = rows.filter((r) => !String(r.work_item || '').trim())
    if (!todo.length) return
    const [wi, skillRows] = await Promise.all([readTable('work_items'), readTable('employee_skills')])
    // 依 sort 排序，確保回填的圖示順序一致（吧台在前、內場在後）
    const workItems = wi.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    const skillsByEmp = new Map()
    for (const s of skillRows) {
      if (!s.employee_id || !s.work_item_id) continue
      const set = skillsByEmp.get(String(s.employee_id))
      if (set) set.add(String(s.work_item_id))
      else skillsByEmp.set(String(s.employee_id), new Set([String(s.work_item_id)]))
    }
    const groups = {}
    for (const r of todo) {
      const gk = `${r.year}|${r.month}|${r.day}|${r.shift_code}`
      ;(groups[gk] = groups[gk] || []).push(r)
    }
    for (const group of Object.values(groups)) {
      const byEmp = distributeWorkItems(group.map((r) => r.employee_id), workItems, skillsByEmp)
      for (const r of group) {
        const ids = byEmp[r.employee_id] || []
        await updateWhere(
          'schedule',
          { year: r.year, month: r.month, day: r.day, shift_code: r.shift_code, employee_id: r.employee_id },
          { work_item: ids.join(',') },
        )
      }
    }
  }

  return async function initDatabase() {
    // 建表永遠執行（單筆查詢，很快），其餘遷移/種子只在 schema 版本變更時跑
    await ensureTabs(Object.keys(TABLES))

    const settings = await readTable('settings')
    const version = settings.find((s) => s.key === 'schema_version')?.value
    if (version === SCHEMA_VERSION) return

    await migrateEmployees()
    await seedEmployeeColors()
    await seedEmployeeSorts()
    await migrateHeadcounts()
    await migrateWorkItems()

    for (const [tab, headers] of Object.entries(TABLES)) {
      if (tab === 'employees' || tab === 'headcounts' || tab === 'work_items') continue
      const rows = await readRows(tab)
      const hasHeader = rows.length > 0 && rows[0].some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '')
      if (!hasHeader) {
        await replaceRows(tab, [headers])
      } else if (rows[0].join('|') !== headers.join('|')) {
        await replaceRows(tab, [headers, ...rows.slice(1)])
      }
    }

    await seedShiftTypes()
    await removeLegacyRestShift()
    await seedHeadcounts()
    await seedSettings()
    await seedWorkItems()
    await backfillScheduleWorkItems()

    const users = await readTable('users')
    const adminExists = users.some((u) => u.username === DEFAULT_ADMIN.username)
    if (!adminExists) {
      const hash = await bcrypt.hash(DEFAULT_ADMIN.password, 10)
      await appendRows('users', [
        [String(nextId(users)), DEFAULT_ADMIN.username, hash, '系統管理員', 'admin', '', new Date().toISOString()],
      ])
    }

    // 初始化完成，寫入版本號（下次冷啟動直接略過）
    const settingsAfter = await readTable('settings')
    if (settingsAfter.some((s) => s.key === 'schema_version')) {
      await updateWhere('settings', { key: 'schema_version' }, { value: SCHEMA_VERSION })
    } else {
      await appendRows('settings', [['schema_version', SCHEMA_VERSION, '資料庫 schema 版本，遷移用']])
    }
  }
}
