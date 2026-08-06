import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, setToken, clearToken } from './api'
import type { User } from './types'

// =============================================================
// auth.tsx —— 登入狀態管理（誰在登入、登入/登出）
// 用 React 的 Context 把「目前登入者」放在最外層（App.tsx 的 AuthProvider），
// 任何頁面呼叫 useAuth() 就能拿到 user / login / logout，不必逐層傳 props。
// =============================================================

// Context 提供的「值」的形狀：誰在登入、是否還在確認登入、登入/登出/直接設定
interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  setUser: (user: User | null) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)   // 目前登入者（null = 未登入）
  const [loading, setLoading] = useState(true)          // 剛開啟網站時先「確認登入」，期間顯示全螢幕載入

  // 開啟網站時：問後端「我存著的 token 還有效嗎」，有效就自動登入
  useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  // 監聽「401 登入過期」事件（由 api.ts 觸發），收到就把登入者清掉、退回登入頁
  useEffect(() => {
    const onExpired = () => setUser(null)
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [])

  // 登入：送帳號密碼給後端 → 後端回 token 與使用者資料 → 存起來
  async function login(username: string, password: string) {
    const res = await api<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { username, password },
    })
    setToken(res.token)  // token 存進 localStorage，之後每次請求由 api.ts 自動帶上
    setUser(res.user)
  }

  // 登出：清掉 token 並清空登入者
  function logout() {
    clearToken()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  )
}

// 給各頁面用的 hook：直接取用登入狀態
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必須在 AuthProvider 內使用')
  return ctx
}
