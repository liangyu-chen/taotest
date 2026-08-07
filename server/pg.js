// =============================================================
// pg.js —— Neon (PostgreSQL) 資料層（系統唯一的儲存後端）
//
// 提供 readRows / readTable / replaceRows / appendRows /
// selectWhere / deleteWhere / updateWhere / upsertRow /
// ensureTabs / initDatabase 等介面，路由層統一經 storage.js 取用。
//
// 所有欄位皆以 TEXT 儲存，排序/計算仍在 JS 端進行（例如 Number(row.sort)）。
// =============================================================

import pg from 'pg'
import { DATABASE_URL } from './config.js'
import { TABLES, DAY_TYPES, EMPLOYEE_COLORS, DEFAULT_SETTINGS, nextId } from './schema.js'
import { createInitializer } from './init.js'

export { TABLES, DAY_TYPES, EMPLOYEE_COLORS, DEFAULT_SETTINGS, nextId }

const { Pool } = pg

let pool = null

function getPool() {
  if (pool) return pool
  if (!DATABASE_URL || !DATABASE_URL.trim()) {
    throw new Error('缺少 DATABASE_URL（Neon 連接字串），請在 .env 或環境變數中設定')
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: 10,
  })
  return pool
}

export async function closePool() {
  if (pool) {
    await pool.end()
    pool = null
  }
}

function quoteCol(c) {
  return `"${String(c).replaceAll('"', '""')}"`
}

export async function ensureTabs(names) {
  const client = await getPool().connect()
  try {
    for (const name of names) {
      const cols = TABLES[name]
      if (!cols) continue
      const colsSql = cols.map((c) => `${quoteCol(c)} text`).join(', ')
      await client.query(`CREATE TABLE IF NOT EXISTS ${quoteCol(name)} (${colsSql})`)
      // 既有表缺欄位時補上（例如 schedule 新增 work_item）——遷移用
      for (const c of cols) {
        await client.query(`ALTER TABLE ${quoteCol(name)} ADD COLUMN IF NOT EXISTS ${quoteCol(c)} text`)
      }
    }
    // 唯一索引：防止同一天同一班別同一員工出現重複排班（也加速鎖定/指派查詢）
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_schedule_key ON "schedule" (year, month, day, shift_code, employee_id)`,
    )
  } finally {
    client.release()
  }
}

export async function readRows(tab) {
  const cols = TABLES[tab]
  if (!cols) throw new Error(`未知的資料表：${tab}`)
  const res = await getPool().query(
    `SELECT ${cols.map(quoteCol).join(', ')} FROM ${quoteCol(tab)}`,
  )
  return [cols, ...res.rows.map((r) => cols.map((c) => (r[c] == null ? '' : String(r[c]))))]
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
        obj[h] = row[i] ?? ''
      })
      return obj
    })
}

async function insertOne(client, tab, cols, values) {
  const colSql = cols.map(quoteCol).join(', ')
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
  await client.query(
    `INSERT INTO ${quoteCol(tab)} (${colSql}) VALUES (${placeholders})`,
    values,
  )
}

// 單筆 SQL 批次插入（VALUES 一段搞定），避免逐列往返
async function insertMany(client, tab, cols, rows) {
  const colSql = cols.map(quoteCol).join(', ')
  const rowPlaceholders = rows
    .map(
      (_, r) => `(${cols.map((_, i) => `$${r * cols.length + i + 1}`).join(', ')})`,
    )
    .join(', ')
  const flat = rows.flatMap((row) => cols.map((_, i) => (row[i] == null ? '' : String(row[i]))))
  await client.query(`INSERT INTO ${quoteCol(tab)} (${colSql}) VALUES ${rowPlaceholders}`, flat)
}

// 把「條件物件」轉成 WHERE 子句（全部 TEXT 精確比對），回傳 SQL 片段與參數
function whereClause(conditions, startIdx = 1) {
  const clauses = []
  const values = []
  let i = startIdx
  for (const [col, val] of Object.entries(conditions)) {
    if (val === undefined || val === null) continue
    clauses.push(`${quoteCol(col)} = $${i}`)
    values.push(String(val))
    i++
  }
  return { clauses, values }
}

// 查詢符合條件（所有欄位精確比對）的列，回傳物件陣列（同 readTable 格式）
export async function selectWhere(tab, conditions) {
  const cols = TABLES[tab]
  if (!cols) throw new Error(`未知的資料表：${tab}`)
  const { clauses, values } = whereClause(conditions)
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const res = await getPool().query(
    `SELECT ${cols.map(quoteCol).join(', ')} FROM ${quoteCol(tab)}${where}`,
    values,
  )
  return res.rows.map((r) => {
    const obj = {}
    cols.forEach((c) => {
      obj[c] = r[c] == null ? '' : String(r[c])
    })
    return obj
  })
}

// 只刪除符合條件的列（不整表重寫），回傳刪除筆數
export async function deleteWhere(tab, conditions) {
  const { clauses, values } = whereClause(conditions)
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const res = await getPool().query(`DELETE FROM ${quoteCol(tab)}${where}`, values)
  return res.rowCount ?? 0
}

// 只更新符合條件的列（不整表重寫），回傳更新筆數
export async function updateWhere(tab, conditions, changes) {
  const cols = TABLES[tab]
  if (!cols) throw new Error(`未知的資料表：${tab}`)
  const setEntries = Object.entries(changes).filter(([, v]) => v !== undefined)
  if (!setEntries.length) return 0
  const set = setEntries.map(([c], i) => `${quoteCol(c)} = $${i + 1}`).join(', ')
  const setVals = setEntries.map(([, v]) => String(v))
  const where = whereClause(conditions, setEntries.length + 1)
  const res = await getPool().query(
    `UPDATE ${quoteCol(tab)} SET ${set}${where.clauses.length ? ` WHERE ${where.clauses.join(' AND ')}` : ''}`,
    [...setVals, ...where.values],
  )
  return res.rowCount ?? 0
}

export async function replaceRows(tab, rows) {
  const cols = TABLES[tab]
  if (!cols) throw new Error(`未知的資料表：${tab}`)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM ${quoteCol(tab)}`)
    const body = rows.slice(1)
    if (body.length) await insertMany(client, tab, cols, body)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function appendRows(tab, rows) {
  if (!rows.length) return
  const cols = TABLES[tab]
  if (!cols) throw new Error(`未知的資料表：${tab}`)
  // 單一 multi-row INSERT 本身就是原子操作，不需要包交易（省下 2 次往返）
  const colSql = cols.map(quoteCol).join(', ')
  const rowPlaceholders = rows
    .map(
      (_, r) => `(${cols.map((_, i) => `$${r * cols.length + i + 1}`).join(', ')})`,
    )
    .join(', ')
  const flat = rows.flatMap((row) => cols.map((_, i) => (row[i] == null ? '' : String(row[i]))))
  await getPool().query(`INSERT INTO ${quoteCol(tab)} (${colSql}) VALUES ${rowPlaceholders}`, flat)
}

// UPSERT：以 keyCols 為唯一鍵，存在就更新（只更新 obj 內非 key 欄位），否則插入
export async function upsertRow(tab, keyCols, obj) {
  const cols = TABLES[tab]
  if (!cols) throw new Error(`未知的資料表：${tab}`)
  const insertCols = cols.filter((c) => obj[c] !== undefined)
  if (!insertCols.length) return
  const keySet = new Set(keyCols)
  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ')
  const values = insertCols.map((c) => String(obj[c]))
  const keySql = keyCols.map(quoteCol).join(', ')
  const updateCols = insertCols.filter((c) => !keySet.has(c))
  const onConflict =
    updateCols.length > 0
      ? ` DO UPDATE SET ${updateCols.map((c) => `${quoteCol(c)} = EXCLUDED.${quoteCol(c)}`).join(', ')}`
      : ' DO NOTHING'
  await getPool().query(
    `INSERT INTO ${quoteCol(tab)} (${insertCols.map(quoteCol).join(', ')}) VALUES (${placeholders}) ON CONFLICT (${keySql})${onConflict}`,
    values,
  )
}

export function initDatabase() {
  return createInitializer({
    ensureTabs,
    readRows,
    readTable,
    replaceRows,
    appendRows,
    selectWhere,
    deleteWhere,
    updateWhere,
    upsertRow,
    nextId,
  })()
}
