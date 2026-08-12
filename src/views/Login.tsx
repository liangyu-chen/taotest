import { useState, type CSSProperties, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth'
import logoUrl from '../assets/TaoLogo.png'
import bgUrl from '../assets/background.webp'
import louisImage from '../assets/Louis.jpg'

// =============================================================
// Login.tsx —— 登入頁
// 送出帳號密碼給 auth.tsx 的 login()（底層走 POST /api/auth/login）。
// 已登入的人到這頁會自動被導回首頁。
// 視覺：「毛玻璃聚焦揭幕」——背景照片先模糊成一團光，載入後
// 漸進對焦清晰，半透明毛玻璃卡片隨之浮現。
// =============================================================

const delay = (s: string) => ({ animationDelay: s }) as CSSProperties

export default function Login() {
  const { login, user } = useAuth()
  const [username, setUsername] = useState('taosuper')
  const [password, setPassword] = useState('taowucoffee')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [scare, setScare] = useState(false)

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
    // 彩蛋：帳號是 louis 就跳嚇人畫面，不真的登入
    if (u.toLowerCase() === 'louis') {
      setScare(true)
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
    <>
      <div className="login-page">
      <div className="login-bg" aria-hidden="true">
        <div className="login-bg__img" style={{ backgroundImage: `url(${bgUrl})` }} />
        <div className="login-bg__veil" />
        <div className="login-bg__tint" />
      </div>

      <div className="login-card">
        <div className="login-brand">
          <img
            className="login-brand__logo"
            src={logoUrl}
            alt="排班管理系統"
            style={delay('0.48s')}
          />
          <h1 className="login-brand__name" style={delay('0.55s')}>
            排班管理系統
          </h1>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="field" style={delay('0.64s')}>
            <span className="field__label">帳號</span>
            <input
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field" style={delay('0.72s')}>
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
          <button
            type="submit"
            className="btn btn--primary btn--block"
            style={delay('0.8s')}
            disabled={busy}
          >
            {busy ? '登入中…' : '登入'}
          </button>
        </form>
      </div>
      </div>

      {scare && (
        <div className="jump-scare" onClick={() => setScare(false)}>
          <div className="jump-scare__flash" />
          <img className="jump-scare__img" src={louisImage} alt="" />
          <p className="jump-scare__msg">你想盜我帳號嗎!!!</p>
          <span className="jump-scare__dismiss">點擊畫面關閉</span>
        </div>
      )}
    </>
  )
}
