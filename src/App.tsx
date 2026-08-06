import { Routes, Route, Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './auth'
import Layout from './components/Layout'
import { FullScreenLoader, ToastHost } from './components/ui'
import Login from './views/Login'
import Schedule from './views/Schedule'
import Availability from './views/Availability'
import Generate from './views/Generate'
import Employees from './views/Employees'
import ShiftTypes from './views/ShiftTypes'
import Users from './views/Users'
import Settings from './views/Settings'

// 包裝元件：需要「登入才能看」的頁面。
// 還在確認登入 → 顯示載入；沒登入 → 導去登入頁；已登入 → 用 Layout 外框包住頁面
function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <FullScreenLoader />
  if (!user) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

// 包裝元件：需要「管理員權限」才能看的頁面，非管理員導回首頁
function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}

// =============================================================
// App.tsx —— 路由表：哪個網址顯示哪個頁面
// - /login 只有登入頁；其餘頁面都包一層 Protected（要登入）
// - 管理功能（員工/班別/帳號/設定）再加一層 AdminOnly（要管理員）
// - 最外層 AuthProvider 讓全站都能用登入狀態；ToastHost 是全站的訊息顯示位置
// =============================================================
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Protected><Schedule /></Protected>} />
        <Route path="/availability" element={<Protected><Availability /></Protected>} />
        <Route path="/generate" element={<Protected><AdminOnly><Generate /></AdminOnly></Protected>} />
        <Route path="/employees" element={<Protected><AdminOnly><Employees /></AdminOnly></Protected>} />
        <Route path="/shifts" element={<Protected><AdminOnly><ShiftTypes /></AdminOnly></Protected>} />
        <Route path="/users" element={<Protected><AdminOnly><Users /></AdminOnly></Protected>} />
        <Route path="/settings" element={<Protected><AdminOnly><Settings /></AdminOnly></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </AuthProvider>
  )
}
