import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { PORT } from './config.js'
import { initDatabase } from './storage.js'
import authRoutes from './routes/auth.js'
import dataRoutes from './routes/data.js'
import scheduleRoutes from './routes/schedule.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const __filename = fileURLToPath(import.meta.url)
export const app = express()

app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))
app.use('/api/auth', authRoutes)
app.use('/api', dataRoutes)
app.use('/api', scheduleRoutes)

const distDir = path.resolve(__dirname, '../dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(distDir, 'index.html'))
    }
    next()
  })
}

app.use((req, res) => {
  res.status(404).json({ error: '找不到此路徑' })
})

app.use((err, _req, res, _next) => {
  console.error(err)
  const status = err.status || 500
  res.status(status).json({ error: err.message || '伺服器錯誤' })
})

export async function startServer() {
  await initDatabase()
  app.listen(PORT, () => {
    console.log('')
    console.log('  排班排程系統已啟動')
    console.log(`  本機: http://localhost:${PORT}`)
    console.log('')
  })
}

// 直接以 node 執行本檔時才啟動監聽（Vercel 透過 api/index.js 以 app 匯入，不會重複啟動）
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer().catch((err) => {
    console.error('啟動失敗：', err.message)
    process.exit(1)
  })
}
