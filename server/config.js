import 'dotenv/config'

export const PORT = process.env.PORT || 3001
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-please-change'
export const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || ''
export const GOOGLE_CREDENTIALS_FILE = process.env.GOOGLE_CREDENTIALS_FILE || 'service-account.json'
export const DEFAULT_ADMIN = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
}
