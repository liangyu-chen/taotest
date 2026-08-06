import jwt from 'jsonwebtoken'
import { JWT_SECRET } from './config.js'

export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, displayName: user.display_name, employeeId: user.employee_id || '' },
    JWT_SECRET,
    { expiresIn: '12h' },
  )
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: '未登入' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: '登入已過期，請重新登入' })
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '此操作需要管理員權限' })
  next()
}

export function toPublicUser(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    employee_id: row.employee_id || '',
    created_at: row.created_at,
  }
}
