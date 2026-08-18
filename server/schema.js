// =============================================================
// schema.js —— 資料表定義與共用常數
// 資料層（pg.js / storage.js）從這裡取表格結構與常數，
// 確保欄位定義只有一份來源。
// =============================================================

export const TABLES = {
  users: ['id', 'username', 'password_hash', 'display_name', 'role', 'employee_id', 'created_at'],
  employees: ['id', 'name', 'employee_no', 'employee_type', 'shift_hours', 'weekly_hours', 'color', 'sort', 'priority', 'active', 'created_at'],
  employee_skills: ['employee_id', 'work_item_id'],
  shift_types: ['id', 'name', 'code', 'start_time', 'end_time', 'color', 'sort', 'created_at'],
  headcounts: ['shift_code', 'day_type', 'count'],
  availability: ['employee_id', 'date', 'status', 'note', 'start_time', 'end_time'],
  schedule: ['year', 'month', 'day', 'shift_code', 'employee_id', 'note', 'work_item', 'start_time', 'end_time'],
  schedule_locks: ['year', 'month', 'day'],
  closed_days: ['year', 'month', 'day'],
  settings: ['key', 'value', 'desc'],
  work_items: ['id', 'name', 'icon', 'sort', 'created_at'],
}

export const DAY_TYPES = ['weekday', 'weekend', 'holiday']

export const EMPLOYEE_COLORS = [
  '#f87171',
  '#fb923c',
  '#f59e0b',
  '#facc15',
  '#a3e635',
  '#4ade80',
  '#16a34a',
  '#34d399',
  '#2dd4bf',
  '#0d9488',
  '#22d3ee',
  '#38bdf8',
  '#94a3b8',
  '#60a5fa',
  '#4f46e5',
  '#a78bfa',
  '#c084fc',
  '#e879f9',
  '#f472b6',
  '#f43f5e',
]

export const DEFAULT_SETTINGS = [
  ['max_consecutive_work_days', '6', '每人每週最多連續工作天數（0 = 不限制）'],
  ['holidays', '', '例假日日期，一行一天（格式 2026-01-01）'],
]

// 產生下一個 id（傳入某張表的資料列，回傳目前最大 id + 1）
export function nextId(rows, field = 'id') {
  let max = 0
  for (const row of rows) {
    const n = Number.parseInt(String(row[field]), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return max + 1
}
