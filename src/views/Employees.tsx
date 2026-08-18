import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Employee, EmployeePriority, User, WorkItem } from '../types'
import { EMPLOYEE_COLORS } from '../types'
import { Modal, Field, Spinner, toast, useConfirm } from '../components/ui'

// =============================================================
// Employees.tsx —— 員工管理（管理員）
// 員工名單表格 + 三個彈窗：
//   新增/編輯員工（含代表色挑選，每人顏色須不同；工作技能可複選）、
//   為員工建立登入帳號。
// =============================================================

export default function Employees() {
  const [rows, setRows] = useState<Employee[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Employee | null>(null) // 正在編輯的員工（null = 沒開）
  const [creating, setCreating] = useState(false)               // 是否開「新增員工」
  const [accountFor, setAccountFor] = useState<Employee | null>(null) // 正在建帳號的員工
  const { confirm, dialog } = useConfirm()

  // 抓員工 + 帳號 + 工作項目三份資料（工作項目供「工作技能」選取用）
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [e, u, w] = await Promise.all([
        api<{ employees: Employee[] }>('/employees'),
        api<{ users: User[] }>('/users'),
        api<{ workItems: WorkItem[] }>('/work-items'),
      ])
      setRows(e.employees)
      setUsers(u.users)
      setWorkItems(w.workItems)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(row: Employee) {
    const ok = await confirm({
      title: '刪除員工',
      message: `確定要刪除員工「${row.name}」嗎？`,
      hint: '此操作無法復原。',
    })
    if (!ok) return
    try {
      await api(`/employees/${row.id}`, { method: 'DELETE' })
      toast('已刪除')
      await load()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // 找出某員工綁定的登入帳號（沒有的話顯示「建立登入帳號」按鈕）
  const linkedUser = (emp: Employee) => users.find((u) => u.employee_id === emp.id)

  return (
    <div className="view">
      <div className="view__head">
        <h3 className="view__title">員工名單</h3>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          ＋ 新增員工
        </button>
      </div>

      {loading ? (
        <Spinner label="載入中…" />
      ) : rows.length === 0 ? (
        <p className="empty-note">尚未有員工，請點右上「新增員工」。</p>
      ) : (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>員工編號</th>
                <th>排序</th>
                <th>工作技能</th>
                <th>排班優先權</th>
                <th>類型</th>
                <th>每班時數</th>
                <th>登入帳號</th>
                <th>狀態</th>
                <th className="table__actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const acc = linkedUser(row)
                return (
                  <tr key={row.id} className={row.active === '0' ? 'row--inactive' : ''}>
                    <td className="table__strong">
                      <span className="emp-color-dot" style={{ background: row.color || '#6b7280' }} />
                      {row.name}
                    </td>
                    <td>{row.employee_no || '—'}</td>
                    <td className="mono">{row.sort || '—'}</td>
                    <td>
                      {row.skills?.length > 0 ? (
                        <span className="skills-cell">
                          {row.skills.map((s) => (
                            <span key={s.id} className="badge badge--on">
                              {s.icon && <span className="wi-icon">{s.icon}</span>}
                              {s.name}
                            </span>
                          ))}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {row.priority === 'priority' ? (
                        <span className="badge badge--on">優先</span>
                      ) : row.priority === 'secondary' ? (
                        <span className="badge badge--admin">次要</span>
                      ) : (
                        <span className="badge" style={{ background: '#e5e7eb', color: '#6b7280' }}>平等</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge${row.employee_type === 'fulltime' ? ' badge--admin' : ' badge--on'}`}>
                        {row.employee_type === 'fulltime' ? '正職' : '工讀'}
                      </span>
                    </td>
                    <td>{row.shift_hours ? `${row.shift_hours} 小時` : '—'}</td>
                    <td>
                      {acc ? (
                        <code className="mono">{acc.username}</code>
                      ) : (
                        <button type="button" className="btn btn--small" onClick={() => setAccountFor(row)}>
                          ＋ 建立登入帳號
                        </button>
                      )}
                    </td>
                    <td>
                      <span className={`badge${row.active === '0' ? ' badge--off' : ' badge--on'}`}>
                        {row.active === '0' ? '停用' : '在職'}
                      </span>
                    </td>
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
        </div>
      )}

      {(creating || editing) && (
        <EmployeeModal
          employee={editing}
          workItems={workItems}
          takenColors={rows.filter((r) => r.id !== editing?.id).map((r) => r.color).filter(Boolean)}
          takenNames={Object.fromEntries(
            rows
              .filter((r) => r.id !== editing?.id && r.color)
              .map((r) => [r.color, r.name]),
          )}
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

      {accountFor && (
        <AccountModal
          employee={accountFor}
          onClose={() => setAccountFor(null)}
          onSaved={() => {
            setAccountFor(null)
            void load()
          }}
        />
      )}

      {dialog}
    </div>
  )
}

// 為員工建立登入帳號的彈窗：送出後員工即可登入並自行設定排休/偏好
function AccountModal({
  employee,
  onClose,
  onSaved,
}: {
  employee: Employee
  onClose: () => void
  onSaved: () => void
}) {
  const [username, setUsername] = useState(employee.employee_no || '')
  const [password, setPassword] = useState('1234')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!username.trim() || !password) {
      setError('請輸入帳號與密碼')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api('/users', {
        method: 'POST',
        body: {
          username: username.trim(),
          password,
          display_name: employee.name,
          role: 'user',
          employee_id: employee.id,
        },
      })
      toast(`已建立帳號：${username.trim()} / ${password}`)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`建立登入帳號・${employee.name}`} onClose={onClose}>
      <div className="stack">
        <p className="modal-lead">員工建立帳號後即可登入系統，自行設定可空出／沒空時段與排休。</p>
        <Field label="登入帳號 *">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </Field>
        <Field label="密碼 *（至少 4 碼）">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '儲存中…' : '建立'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// 新增/編輯員工彈窗。takenColors 是其他員工已使用的顏色（會被停用，避免撞色）
function EmployeeModal({
  employee,
  workItems,
  takenColors,
  takenNames,
  onClose,
  onSaved,
}: {
  employee: Employee | null
  workItems: WorkItem[]
  takenColors: string[]
  takenNames: Record<string, string>
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(employee?.name || '')
  const [no, setNo] = useState(employee?.employee_no || '')
  const [sort, setSort] = useState(employee?.sort || '')
  const [empType, setEmpType] = useState<'fulltime' | 'parttime'>(employee?.employee_type || 'parttime')
  const [shiftHours, setShiftHours] = useState(employee?.shift_hours || '')
  // 工作技能：可複選（一個員工可同時具備 吧台、內場 等多個工作項目）；必填
  const [skills, setSkills] = useState<string[]>(employee?.skills?.map((s) => s.id) || [])
  // 代表色：編輯時沿用原色；新增時自動挑一個還沒被用的顏色
  const [color, setColor] = useState(
    employee?.color || EMPLOYEE_COLORS.find((c) => !takenColors.includes(c)) || '',
  )
  const [active, setActive] = useState(employee ? employee.active !== '0' : true)
  const [priority, setPriority] = useState<EmployeePriority>(employee?.priority || 'equal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!name.trim()) {
      setError('請輸入員工姓名')
      return
    }
    if (!color) {
      setError('請選擇代表顏色')
      return
    }
    if (takenColors.includes(color)) {
      setError('此顏色已被其他員工使用，每位員工需有不同顏色')
      return
    }
    // 工作技能必填
    if (!skills.length) {
      setError('請至少選擇一項工作技能')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = {
        name: name.trim(),
        employee_no: no.trim(),
        sort: sort.trim(),
        employee_type: empType,
        shift_hours: shiftHours.trim(),
        color,
        active,
        priority,
        skills,
      }
      if (employee) {
        await api(`/employees/${employee.id}`, { method: 'PUT', body })
      } else {
        await api('/employees', { method: 'POST', body })
      }
      toast(employee ? '已更新' : '已新增員工')
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={employee ? '編輯員工' : '新增員工'} onClose={onClose}>
      <div className="stack">
        <Field label="姓名 *">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="員工編號">
          <input value={no} onChange={(e) => setNo(e.target.value)} />
        </Field>
        <Field label="排序（數字越小越前面，留空預設依員工編號排序）">
          <input
            type="number"
            min={0}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            placeholder={employee ? `預設 ${employee.id}` : '自動依編號'}
          />
        </Field>
        <Field label="工作技能 *（必填）">
          {workItems.length === 0 ? (
            <p className="form-hint">尚未有工作項目，請先到「工作項目」頁新增。</p>
          ) : (
            <div className="skill-grid">
              {workItems.map((w) => {
                const on = skills.includes(w.id)
                return (
                  <label key={w.id} className={`skill-chip${on ? ' skill-chip--on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setSkills((prev) =>
                          e.target.checked ? [...prev, w.id] : prev.filter((id) => id !== w.id),
                        )
                      }
                    />
                    <span className="skill-chip__toggle" aria-hidden="true" />
                    <span>
                      {w.icon && <span className="wi-icon">{w.icon}</span>}
                      {w.name}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </Field>
        <Field label="排班優先權">
          <select value={priority} onChange={(e) => setPriority(e.target.value as EmployeePriority)}>
            <option value="priority">優先排班</option>
            <option value="equal">平等（隨機）</option>
            <option value="secondary">次要排班</option>
          </select>
          <p className="form-hint">自動排班時，條件相同的情況下，優先排班者會先被排入，次要排班者最後。</p>
        </Field>
        <Field label="人員類型">
          <select value={empType} onChange={(e) => setEmpType(e.target.value as 'fulltime' | 'parttime')}>
            <option value="fulltime">正職（每班固定時數）</option>
            <option value="parttime">工讀（時數可自由安排）</option>
          </select>
        </Field>
        <div className="form-row">
          <Field label={empType === 'fulltime' ? '每班時數（由排班規則決定）' : '每班時數（留空用預設值）'}>
            <input
              type="number"
              min={1}
              max={24}
              value={shiftHours}
              onChange={(e) => setShiftHours(e.target.value)}
              disabled={empType === 'fulltime'}
              placeholder={empType === 'fulltime' ? '規則設定值' : '例如 6'}
            />
          </Field>
        </div>
        <Field label="代表顏色 *（每位員工需不同，班表會以顏色區分員工）">
          {/* 顏色調色盤：已被別人使用的顏色會停用並打紅叉 */}
          <div className="color-picker">
            {EMPLOYEE_COLORS.map((c) => {
              const taken = takenColors.includes(c) && c !== color
              return (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch${color === c ? ' color-swatch--active' : ''}`}
                  style={{ background: c }}
                  disabled={taken}
                  title={taken ? `已被「${takenNames[c] || '其他員工'}」使用` : c}
                  onClick={() => setColor(c)}
                />
              )
            })}
          </div>
          <p className="form-hint">打紅叉的顏色代表已被其他員工使用。</p>
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>在職（停用後不會被自動排班）</span>
        </label>
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
