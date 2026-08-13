import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Employee, User } from '../types'
import { Modal, Field, Spinner, toast, useConfirm } from '../components/ui'

// =============================================================
// Users.tsx —— 帳號管理（管理員）
// 帳號清單 + 新增/編輯帳號彈窗。
// 帳號可綁定員工：綁定後該員工登入即可自行設定排休/偏好；
// 角色可分管理員（admin）與一般員工（user）。
// =============================================================

export default function Users() {
  const [rows, setRows] = useState<User[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<User | null>(null)
  const [creating, setCreating] = useState(false)
  const { confirm, dialog } = useConfirm()

  // 抓帳號 + 員工兩份資料（顯示「綁定員工」欄位用）
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [u, e] = await Promise.all([
        api<{ users: User[] }>('/users'),
        api<{ employees: Employee[] }>('/employees'),
      ])
      setRows(u.users)
      setEmployees(e.employees)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(row: User) {
    const ok = await confirm({
      title: '刪除帳號',
      message: `確定要刪除帳號「${row.username}」嗎？`,
      hint: '刪除後該帳號將無法登入。',
    })
    if (!ok) return
    try {
      await api(`/users/${row.id}`, { method: 'DELETE' })
      toast('已刪除')
      await load()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="view">
      <div className="view__head">
        <h3 className="view__title">帳號管理</h3>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          ＋ 新增帳號
        </button>
      </div>

      {loading ? (
        <Spinner label="載入中…" />
      ) : (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>顯示名稱</th>
                <th>登入帳號</th>
                <th>角色</th>
                <th>綁定員工</th>
                <th className="table__actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const emp = employees.find((e) => e.id === row.employee_id)
                return (
                  <tr key={row.id}>
                    <td className="table__strong">{row.display_name}</td>
                    <td>
                      <code className="mono">{row.username}</code>
                    </td>
                    <td>
                      <span className={`badge${row.role === 'admin' ? ' badge--admin' : ' badge--on'}`}>
                        {row.role === 'admin' ? '管理員' : '員工'}
                      </span>
                    </td>
                    <td>{emp ? emp.name : '—'}</td>
                    <td className="table__actions">
                      <button type="button" className="btn btn--small" onClick={() => setEditing(row)}>
                        編輯
                      </button>
                      <button type="button" className="btn btn--small btn--danger" onClick={() => void remove(row)}>
                        刪除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="hint">綁定員工後，該帳號登入時即可自行設定自己的排休、可空出／沒空時段與班別偏好。</p>
        </div>
      )}

      {(creating || editing) && (
        <UserModal
          user={editing}
          employees={employees}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={() => {
            setCreating(false)
            setEditing(null)
            void load()
          }}
        />
      )}

      {dialog}
    </div>
  )
}

// 新增/編輯帳號彈窗（帳號名稱建立後不可改；編輯時密碼留空 = 不變更）
function UserModal({
  user,
  employees,
  onClose,
  onSaved,
}: {
  user: User | null
  employees: Employee[]
  onClose: () => void
  onSaved: () => void
}) {
  const [username, setUsername] = useState(user?.username || '')
  const [displayName, setDisplayName] = useState(user?.display_name || '')
  const [role, setRole] = useState<'admin' | 'user'>(user?.role || 'user')
  const [employeeId, setEmployeeId] = useState(user?.employee_id || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (user) {
      if (!username.trim()) {
        setError('請輸入帳號')
        return
      }
      setBusy(true)
      setError('')
      try {
        const body: Record<string, unknown> = { display_name: displayName || username.trim(), role, employee_id: employeeId }
        if (password) body.password = password
        await api(`/users/${user.id}`, { method: 'PUT', body })
        toast('已更新')
        onSaved()
      } catch (err) {
        setError((err as Error).message)
        setBusy(false)
      }
      return
    }
    if (!username.trim() || !password) {
      setError('帳號與密碼為必填')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api('/users', {
        method: 'POST',
        body: { username: username.trim(), password, display_name: displayName || username.trim(), role, employee_id: employeeId },
      })
      toast('已新增帳號')
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={user ? '編輯帳號' : '新增帳號'} onClose={onClose}>
      <div className="stack">
        <Field label="登入帳號 *">
          <input value={username} onChange={(e) => setUsername(e.target.value)} disabled={!!user} autoFocus={!user} />
        </Field>
        <Field label="顯示名稱">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label={user ? '新密碼（留空則不變更）' : '密碼 *（至少 4 碼）'}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="角色">
          <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}>
            <option value="user">員工（僅限自己的排休與偏好）</option>
            <option value="admin">管理員</option>
          </select>
        </Field>
        <Field label="綁定員工（用於排休自我管理）">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— 不綁定 —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        {error && <p className="form-error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
