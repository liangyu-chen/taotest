import fs from 'node:fs'
import path from 'node:path'
import { google } from 'googleapis'
import bcrypt from 'bcryptjs'
import { SPREADSHEET_ID, GOOGLE_CREDENTIALS_FILE, GOOGLE_SERVICE_ACCOUNT_JSON, DEFAULT_ADMIN } from './config.js'

export const TABLES = {
  users: ['id', 'username', 'password_hash', 'display_name', 'role', 'employee_id', 'created_at'],
  employees: ['id', 'name', 'employee_no', 'department', 'employee_type', 'shift_hours', 'weekly_hours', 'color', 'active', 'created_at'],
  shift_types: ['id', 'name', 'code', 'start_time', 'end_time', 'color', 'sort', 'created_at'],
  headcounts: ['shift_code', 'day_type', 'count'],
  availability: ['employee_id', 'date', 'status', 'note', 'start_time', 'end_time'],
  schedule: ['year', 'month', 'day', 'shift_code', 'employee_id', 'note'],
  settings: ['key', 'value', 'desc'],
}

export const DAY_TYPES = ['weekday', 'weekend', 'holiday']

export const EMPLOYEE_COLORS = [
  '#f59e0b',
  '#22d3ee',
  '#a78bfa',
  '#34d399',
  '#fb923c',
  '#60a5fa',
  '#f472b6',
  '#a3e635',
  '#e879f9',
  '#2dd4bf',
  '#f87171',
  '#facc15',
]

export const DEFAULT_SETTINGS = [
  ['work_start', '12:00', '每日開始營業時間'],
  ['work_end', '24:00', '每日結束營業時間'],
  ['fulltime_shift_hours', '8', '正職每班固定時數'],
  ['parttime_shift_hours', '6', '工讀每班預設時數（可依員工個別覆寫）'],
  ['max_consecutive_work_days', '6', '每人每週最多連續工作天數（0 = 不限制）'],
  ['holidays', '', '例假日日期，一行一天（格式 2026-01-01）'],
]

let sheetsClient = null
let writeQueue = Promise.resolve()

function withLock(fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.catch(() => {})
  return run
}

export function getSheets() {
  if (sheetsClient) return sheetsClient
  let creds
  if (GOOGLE_SERVICE_ACCOUNT_JSON && GOOGLE_SERVICE_ACCOUNT_JSON.trim()) {
    creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON)
  } else {
    const credsPath = path.resolve(process.cwd(), GOOGLE_CREDENTIALS_FILE)
    if (!fs.existsSync(credsPath)) {
      throw new Error(
        `找不到 Google 服務帳號憑證：${credsPath}\n` +
          '請依照 README「Google 試算表設定」建立服務帳號並下載 JSON 憑證檔放到專案根目錄，' +
          '或在雲端部署時設定 GOOGLE_SERVICE_ACCOUNT_JSON 環境變數放入整份憑證 JSON。',
      )
    }
    creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  sheetsClient = google.sheets({ version: 'v4', auth })
  return sheetsClient
}

export function requireSpreadsheetId() {
  if (!SPREADSHEET_ID) {
    throw new Error('尚未設定 GOOGLE_SPREADSHEET_ID，請複製 .env.example 為 .env 並填入試算表 ID。')
  }
  return SPREADSHEET_ID
}

export async function ensureTabs(names) {
  const sheets = getSheets()
  const id = requireSpreadsheetId()
  const res = await sheets.spreadsheets.get({ spreadsheetId: id })
  const existing = new Set((res.data.sheets || []).map((s) => s.properties.title))
  for (const name of names) {
    if (!existing.has(name)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: id,
        requestBody: {
          requests: [{ addSheet: { properties: { title: name } } }],
        },
      })
    }
  }
}

export async function readRows(tab) {
  const sheets = getSheets()
  const id = requireSpreadsheetId()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `${tab}!A1:Z100000`,
  })
  return res.data.values || []
}

export async function replaceRows(tab, rows) {
  return withLock(async () => {
    const sheets = getSheets()
    const id = requireSpreadsheetId()
    await sheets.spreadsheets.values.clear({
      spreadsheetId: id,
      range: `${tab}!A1:Z100000`,
    })
    if (rows.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: id,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      })
    }
  })
}

export async function appendRows(tab, rows) {
  if (!rows.length) return
  return withLock(async () => {
    const sheets = getSheets()
    const id = requireSpreadsheetId()
    await sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    })
  })
}

export async function readTable(tab) {
  const rows = await readRows(tab)
  if (rows.length === 0) return []
  const [headers, ...body] = rows
  return body
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) => {
      const obj = {}
      headers.forEach((h, i) => {
        const val = row[i]
        obj[h] = val === undefined || val === null ? '' : typeof val === 'number' ? val : String(val).trim()
      })
      return obj
    })
}

export function nextId(rows, field = 'id') {
  let max = 0
  for (const row of rows) {
    const n = Number.parseInt(String(row[field]), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return max + 1
}

function readHeader(rows) {
  if (rows.length === 0) return []
  return rows[0].map((c) => String(c ?? '').trim())
}

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
      get(r, 'department'),
      get(r, 'employee_type') || 'parttime',
      get(r, 'shift_hours'),
      get(r, 'weekly_hours'),
      get(r, 'color'),
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

async function seedShiftTypes() {
  const shifts = await readTable('shift_types')
  const existing = new Set(shifts.map((s) => s.code))
  const defaults = [
    ['早班', 'M', '12:00', '20:00', '#b45309', 1],
    ['晚班', 'N', '16:00', '24:00', '#1d4ed8', 2],
    ['休假', 'OFF', '', '', '#6b7280', 4],
  ]
  const missing = defaults.filter((d) => !existing.has(d[1]))
  if (missing.length) {
    await appendRows(
      'shift_types',
      missing.map((d, i) => [String(nextId(shifts) + i), ...d, new Date().toISOString()]),
    )
  }
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

export async function initSpreadsheet() {
  await ensureTabs(Object.keys(TABLES))

  await migrateEmployees()
  await seedEmployeeColors()
  await migrateHeadcounts()

  for (const [tab, headers] of Object.entries(TABLES)) {
    if (tab === 'employees' || tab === 'headcounts') continue
    const rows = await readRows(tab)
    const hasHeader = rows.length > 0 && rows[0].some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '')
    if (!hasHeader) {
      await replaceRows(tab, [headers])
    } else if (rows[0].join('|') !== headers.join('|')) {
      await replaceRows(tab, [headers, ...rows.slice(1)])
    }
  }

  await seedShiftTypes()
  await seedHeadcounts()
  await seedSettings()

  const users = await readTable('users')
  const adminExists = users.some((u) => u.username === DEFAULT_ADMIN.username)
  if (!adminExists) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN.password, 10)
    await appendRows('users', [
      [String(nextId(users)), DEFAULT_ADMIN.username, hash, '系統管理員', 'admin', '', new Date().toISOString()],
    ])
  }
}
