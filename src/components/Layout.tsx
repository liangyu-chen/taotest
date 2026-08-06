import { NavLink, useLocation, Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth'
import { useChangePassword } from './ui'

// =============================================================
// Layout.tsx —— 全站外框
// 包住每個頁面（App.tsx 的 Protected 裡呼叫）。包含：
//   左側選單（依登入者身份過濾）、上方標題列、字體縮放、修改密碼、登出。
// 字體縮放記錄在 localStorage（key: font-scale），下次開網站仍生效。
// =============================================================

// 三種字體大小，scale 會套到 CSS 變數 --font-scale
const FONT_SIZES: { key: string; label: string; scale: number }[] = [
  { key: 'small', label: '小', scale: 0.9 },
  { key: 'medium', label: '中', scale: 1 },
  { key: 'large', label: '大', scale: 1.15 },
]

// 版型：自動（依螢幕寬度）／強制電腦版／強制手機版。
// 記錄在 localStorage（key: view-mode），並在 <html> 上設 data-view 供 CSS 判斷。
const VIEW_MODES: { key: string; label: string }[] = [
  { key: 'auto', label: '自動' },
  { key: 'desktop', label: '電腦版' },
  { key: 'mobile', label: '手機版' },
]

// 上方標題列依目前網址顯示的標題
const TITLES: Record<string, string> = {
  '/': '班表總覽',
  '/availability': '排休與時段',
  '/employees': '員工管理',
  '/shifts': '班別與人力設定',
  '/users': '帳號管理',
  '/settings': '排班規則設定',
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const passwordModal = useChangePassword()
  const isAdmin = user?.role === 'admin'

  // 字體大小：初始值從 localStorage 讀取，沒有就用「中」
  const [fontSize, setFontSize] = useState<string>(() => {
    const saved = localStorage.getItem('font-scale')
    return FONT_SIZES.some((f) => f.key === saved) ? (saved as string) : 'medium'
  })

  const changeFontSize = (key: string) => {
    const target = FONT_SIZES.find((f) => f.key === key)
    if (!target) return
    setFontSize(key)
    document.documentElement.style.setProperty('--font-scale', String(target.scale))
    localStorage.setItem('font-scale', key)
  }

  // 版型：初始值從 localStorage 讀取，沒有就用「自動」；套用到 <html> 的 data-view
  const [viewMode, setViewMode] = useState<string>(() => {
    const saved = localStorage.getItem('view-mode')
    const key = VIEW_MODES.some((v) => v.key === saved) ? (saved as string) : 'auto'
    const root = document.documentElement
    if (key === 'auto') root.removeAttribute('data-view')
    else root.setAttribute('data-view', key)
    return key
  })

  useEffect(() => {
    const root = document.documentElement
    if (viewMode === 'auto') root.removeAttribute('data-view')
    else root.setAttribute('data-view', viewMode)
    localStorage.setItem('view-mode', viewMode)
  }, [viewMode])

  // 左側選單項目；管理功能只有管理員看得到
  const items = [
    { to: '/', label: '班表總覽', icon: '▦', adminOnly: false },
    { to: '/availability', label: '排休與時段', icon: '☼', adminOnly: false },
    { to: '/employees', label: '員工管理', icon: '☷', adminOnly: true },
    { to: '/shifts', label: '班別與人力', icon: '⌛', adminOnly: true },
    { to: '/settings', label: '排班規則', icon: '⚙', adminOnly: true },
    { to: '/users', label: '帳號管理', icon: '⚿', adminOnly: true },
  ].filter((item) => !item.adminOnly || isAdmin)

  // 如果網址不在選單內（例如被移除的 /generate），直接導回首頁
  if (items.every((i) => i.to !== location.pathname)) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__mark">班</span>
          <div>
            <div className="sidebar__name">排班管理</div>
            <div className="sidebar__sub">ShiftPlanner</div>
          </div>
        </div>
        <nav className="sidebar__nav">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
            >
              <span className="nav-item__icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__foot">
          <div className="sidebar__user">
            <span className="sidebar__avatar">{user?.display_name?.slice(0, 1) || '員'}</span>
            <div className="sidebar__userinfo">
              <div className="sidebar__username">{user?.display_name}</div>
              <div className="sidebar__userrole">{isAdmin ? '管理員' : '員工'}</div>
            </div>
          </div>
          <button type="button" className="sidebar__logout" onClick={logout}>
            登出
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h2 className="topbar__title">{TITLES[location.pathname] || '排班管理系統'}</h2>
          <div className="topbar__actions">
            <div className="font-size view-mode">
              <span className="font-size__label">版型</span>
              <div className="seg">
                {VIEW_MODES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    className={`seg__btn${viewMode === v.key ? ' seg__btn--on' : ''}`}
                    onClick={() => setViewMode(v.key)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="font-size">
              <span className="font-size__label">字體</span>
              <div className="seg">
                {FONT_SIZES.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={`seg__btn${fontSize === f.key ? ' seg__btn--on' : ''}`}
                    onClick={() => changeFontSize(f.key)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="btn btn--ghost topbar__pw" onClick={() => passwordModal.open(true)}>
              修改密碼
            </button>
            <button type="button" className="btn btn--ghost topbar__logout" onClick={logout}>
              登出
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
      {passwordModal.modal}
    </div>
  )
}
