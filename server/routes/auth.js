import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { readTable, appendRows, replaceRows, nextId } from '../storage.js'
import { signToken, requireAuth, toPublicUser } from '../auth.js'

const router = Router()

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: '請輸入帳號與密碼' })
    const users = await readTable('users')
    const user = users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase())
    if (!user) return res.status(401).json({ error: '帳號或密碼錯誤' })
    const ok = await bcrypt.compare(String(password), user.password_hash)
    if (!ok) return res.status(401).json({ error: '帳號或密碼錯誤' })
    const publicUser = toPublicUser(user)
    const token = signToken(publicUser)
    res.json({ token, user: publicUser })
  } catch (e) {
    next(e)
  }
})

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const users = await readTable('users')
    const user = users.find((u) => u.username === req.user.username)
    if (!user) return res.status(401).json({ error: '帳號不存在' })
    res.json({ user: toPublicUser(user) })
  } catch (e) {
    next(e)
  }
})

router.put('/password', requireAuth, async (req, res, next) => {
  try {
    const { old_password, new_password } = req.body || {}
    if (!new_password || new_password.length < 4) {
      return res.status(400).json({ error: '新密碼至少 4 個字元' })
    }
    const users = await readTable('users')
    const idx = users.findIndex((u) => u.username === req.user.username)
    if (idx === -1) return res.status(401).json({ error: '帳號不存在' })
    const user = users[idx]
    if (old_password) {
      const ok = await bcrypt.compare(String(old_password), user.password_hash)
      if (!ok) return res.status(400).json({ error: '原密碼錯誤' })
    }
    user.password_hash = await bcrypt.hash(String(new_password), 10)
    const headers = ['id', 'username', 'password_hash', 'display_name', 'role', 'employee_id', 'created_at']
    const rows = [headers, ...users.map((u) => headers.map((h) => u[h] ?? ''))]
    await replaceRows('users', rows)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

export default router
