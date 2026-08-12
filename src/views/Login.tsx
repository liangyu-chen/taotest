import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth'
import logoUrl from '../assets/TaoLogo.png'
import bgUrl from '../assets/background.webp'

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
  const pageRef = useRef<HTMLDivElement>(null)
  const [username, setUsername] = useState('taosuper')
  const [password, setPassword] = useState('taowucoffee')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // iOS Safari 一進入時網頁內容會被切在動態島下方（unsafe 區域不渲染內容）。
  // 版面其實從 y=0 開始排（getBoundingClientRect().top 會是 0），所以不能
  // 只靠 top>0 判斷；以 CSS 傳出的 --sat（env(safe-area-inset-top)）為準，
  // 一進入就把視窗往下捲一個動態島高度，讓背景照片頂到畫面上緣。
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      const sat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0
      const top = Math.max(el.getBoundingClientRect().top, sat)
      if (top > 0) window.scrollTo(0, top)
    })
    return () => cancelAnimationFrame(raf)
  }, [])

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
    <div className="login-page" ref={pageRef}>
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
  )
}
