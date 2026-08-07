import 'dotenv/config'

export const PORT = process.env.PORT || 3001
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-please-change'
// Neon (PostgreSQL) 連接字串：系統唯一的儲存後端
export const DATABASE_URL = process.env.DATABASE_URL || ''
export const DEFAULT_ADMIN = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
}
