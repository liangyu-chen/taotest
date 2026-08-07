// =============================================================
// api/index.js —— Vercel Serverless 進入點
// 整支 Express app 由這裡匯出，Vercel 以 Node.js function 執行。
// DATABASE_URL 等環境變數直接在 Vercel 專案設定即可。
// =============================================================

import { app } from '../server/index.js'
import { initDatabase } from '../server/storage.js'

let ready = null

export default async function handler(req, res) {
  if (!ready) ready = initDatabase()
  await ready
  return app(req, res)
}
