import 'dotenv/config'

export const PORT = process.env.PORT || 3001
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-please-change'
export const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || ''
export const GOOGLE_CREDENTIALS_FILE = process.env.GOOGLE_CREDENTIALS_FILE || 'service-account.json'
// 雲端部署（Render 等）無法放憑證檔時，可直接把整份服務帳號 JSON 放進此環境變數
export const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''
export const DEFAULT_ADMIN = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
}
