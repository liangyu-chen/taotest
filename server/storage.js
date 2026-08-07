// =============================================================
// storage.js —— 儲存後端門面（Facade）
// 系統一律使用 Neon (PostgreSQL) 當儲存後端，
// 路由層從這裡統一取用資料層函式，不用直接碰 pg.js。
// =============================================================

import * as backend from './pg.js'
import { TABLES, DAY_TYPES, EMPLOYEE_COLORS, DEFAULT_SETTINGS, nextId } from './schema.js'

export { TABLES, DAY_TYPES, EMPLOYEE_COLORS, DEFAULT_SETTINGS, nextId }
export const readTable = backend.readTable
export const readRows = backend.readRows
export const replaceRows = backend.replaceRows
export const appendRows = backend.appendRows
export const selectWhere = backend.selectWhere
export const deleteWhere = backend.deleteWhere
export const updateWhere = backend.updateWhere
export const upsertRow = backend.upsertRow
export const ensureTabs = backend.ensureTabs
export const initDatabase = backend.initDatabase
export const closePool = backend.closePool
