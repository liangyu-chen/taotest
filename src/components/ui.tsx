import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'

// =============================================================
// ui.tsx —— 全站共用的小零件
//    Spinner / FullScreenLoader：載入轉圈與整頁載入
//    Modal：彈窗（點背景關閉）
//    Field：帶標題的輸入框
//    toast / ToastHost：右上角的訊息提示（成功/失敗）
//    useChangePassword：修改密碼彈窗（Layout 使用）
// =============================================================

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" aria-label="載入中" />
      {label && <span className="spinner-label">{label}</span>}
    </div>
  )
}

export function FullScreenLoader() {
  return (
    <div className="fullscreen-loader">
      <Spinner label="載入中…" />
    </div>
  )
}

// 彈窗：標題 + 內容。點擊背景（backdrop）會關閉，點內容本身不會誤關
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  // 記錄滑鼠按下時是否點在「內容」上：若是，放開時即使在背景也不關閉（避免拖曳選取後誤關）
  const pressInside = useRef(false)

  // 開啟時鎖定頁面捲動：避免 iOS 上 fixed 彈窗被捲動中的 .content 擠偏移（右側被蓋住），
  // 也避免背景內容跟著捲動
  useEffect(() => {
    document.documentElement.classList.add('modal-open')
    return () => document.documentElement.classList.remove('modal-open')
  }, [])

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        pressInside.current = e.target !== e.currentTarget
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || pressInside.current) return
        onClose()
      }}
    >
      <div className={`modal ${wide ? 'modal--wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h3 className="modal__title">{title}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  )
}

// —— 訊息提示（toast）——
// 任何地方呼叫 toast('文字', 'ok'|'error') 就會在畫面右上角出現 3.2 秒。
// 實作原理：toast() 把訊息廣播給已註冊的 listeners（ToastHost 在掛載時註冊）。
type ToastItem = { id: number; text: string; kind: 'ok' | 'error' }
let listeners: Array<(t: ToastItem) => void> = []
let nextId = 1

export function toast(text: string, kind: 'ok' | 'error' = 'ok') {
  const item: ToastItem = { id: nextId++, text, kind }
  listeners.forEach((fn) => fn(item))
}

// ToastHost 掛在 App 的最外層（App.tsx），負責收集並顯示所有 toast 訊息
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => {
    // 註冊為訊息接收者；每則訊息顯示 3.2 秒後自動移除
    const fn = (t: ToastItem) => {
      setItems((prev) => [...prev, t])
      window.setTimeout(() => {
        setItems((prev) => prev.filter((i) => i.id !== t.id))
      }, 3200)
    }
    listeners.push(fn)
    return () => {
      listeners = listeners.filter((l) => l !== fn)
    }
  }, [])
  return (
    <div className="toast-host">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

// 修改密碼彈窗（hook）：呼叫後回傳 { open, modal }
// 　- open：把它設成 true 就會顯示彈窗（Layout 的「修改密碼」按鈕用它）
// 　- modal：要把這個彈窗元素掛在自己的 JSX 裡
export function useChangePassword() {
  const [open, setOpen] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const modal = open ? (
    <Modal title="修改密碼" onClose={() => setOpen(false)}>
      <div className="stack">
        <Field label="原密碼">
          <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoFocus />
        </Field>
        <Field label="新密碼（至少 4 碼）">
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !newPw}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await api('/auth/password', { method: 'PUT', body: { old_password: oldPw, new_password: newPw } })
                setOpen(false)
                setOldPw('')
                setNewPw('')
                toast('密碼已更新')
              } catch (e) {
                setError((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
    </Modal>
  ) : null

  return { open: setOpen, modal }
}
