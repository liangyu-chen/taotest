// =============================================================
// api.ts —— 前端「跟後端要資料」的唯一入口
// 所有頁面都要透過 api() 存取資料，不要自己直接寫 fetch，
// 這樣登入憑證、錯誤處理、401 自動登出才能統一管理。
// 後端網址固定掛在 /api 底下（開發時由 vite proxy 轉到 3001）。
// =============================================================

// 登入 token 存放在瀏覽器 localStorage 的這個 key 底下（關瀏覽器也還在）
const TOKEN_KEY = 'shift_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export interface ApiOptions {
  method?: string
  body?: unknown
}

// 通用請求函式：幫所有頁面代處理「帶 token、轉 JSON、401 登出、錯誤訊息」
// 用法：api<回傳型別>('/路徑', { method, body }) → Promise<後端回傳的資料>
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}` // 帶上登入憑證，後端用這個辨識「誰在登入」
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    throw new Error('無法連線到伺服器，請確認後端已啟動')
  }
  if (res.status === 401) {
    // 登入過期／失效：清掉 token，並發出事件讓 auth.tsx 把畫面退回登入頁
    clearToken()
    window.dispatchEvent(new Event('auth:expired'))
    throw new Error('登入已過期')
  }
  const data = await res.json().catch(() => ({}))
  // 後端出錯時統一回傳 { error: '說明' }，這裡把它轉成可顯示的錯誤訊息
  if (!res.ok) throw new Error((data as { error?: string }).error || `請求失敗 (${res.status})`)
  return data as T
}
