import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth'

// =============================================================
// Login.tsx —— 登入頁
// 送出帳號密碼給 auth.tsx 的 login()（底層走 POST /api/auth/login）。
// 已登入的人到這頁會自動被導回首頁。
// =============================================================

export default function Login() {
  const { login, user } = useAuth()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin123')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 若已登入，直接離開登入頁
  if (user) return <Navigate to="/" replace />

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    const fd = new FormData(e.currentTarget)
    const u = String(fd.get('username') ?? '').trim()
    const p = String(fd.get('password') ?? '')
    if (!u || !p) {
      setError('請在兩個欄位輸入帳號與密碼')
      return
    }
    setBusy(true)
    try {
      await login(u, p) // 成功後 auth.tsx 的 user 更新，這裡自動觸發「已登入 → 導回首頁」
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-brand__mark">班</span>
          <h1 className="login-brand__name">排班管理系統</h1>
          <p className="login-brand__sub">自動排班 · 人力管理 · Google 試算表</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="field">
            <span className="field__label">帳號</span>
            <input
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span className="field__label">密碼</span>
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? '登入中…' : '登入'}
          </button>
        </form>
      </div>
    </div>
  )
}
