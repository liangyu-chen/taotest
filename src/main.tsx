import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

// =============================================================
// main.tsx —— 程式入口
// 只在網站啟動時執行一次：把 App 掛到 index.html 的 #root 元素上。
// BrowserRouter 提供網址切換（/、/availability…）；StrictMode 是開發用的檢查工具。
// =============================================================

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
