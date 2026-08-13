import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { WorkItem } from '../types'
import { WORK_ITEM_ICONS } from '../types'
import { Modal, Field, Spinner, toast, useConfirm } from '../components/ui'

// =============================================================
// WorkItems.tsx —— 工作項目（管理員）
// 獨立的管理清單（名稱、圖示、排序，例如 吧台、內場）。
// 員工在「員工管理」頁可透過「工作技能」關聯到這些工作項目。
// =============================================================

export default function WorkItems() {
  const [items, setItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<WorkItem | null>(null)
  const [creating, setCreating] = useState(false)
  const { confirm, dialog } = useConfirm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ workItems: WorkItem[] }>('/work-items')
      setItems(res.workItems)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(row: WorkItem) {
    const ok = await confirm({
      title: '刪除工作項目',
      message: `確定要刪除工作項目「${row.name}」嗎？`,
      hint: '此操作無法復原。',
    })
    if (!ok) return
    try {
      await api(`/work-items/${row.id}`, { method: 'DELETE' })
      toast('已刪除')
      await load()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="view">
      <div className="view__head">
        <h3 className="view__title">工作項目</h3>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          ＋ 新增工作項目
        </button>
      </div>

      {loading ? (
        <Spinner label="載入中…" />
      ) : (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>項目</th>
                <th>排序</th>
                <th className="table__actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td className="table__strong">
                    {row.icon && <span className="wi-icon">{row.icon}</span>}
                    {row.name}
                  </td>
                  <td>{row.sort}</td>
                  <td className="table__actions">
                    <button type="button" className="btn btn--small" onClick={() => setEditing(row)}>
                      編輯
                    </button>
                    <button type="button" className="btn btn--small btn--danger" onClick={() => void remove(row)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    尚未有工作項目
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <WorkItemModal
          item={editing}
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

// 新增/編輯工作項目彈窗
function WorkItemModal({
  item,
  onClose,
  onSaved,
}: {
  item: WorkItem | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(item?.name || '')
  const [icon, setIcon] = useState(item?.icon || '')
  const [sort, setSort] = useState(item?.sort || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!name.trim()) {
      setError('工作項目名稱為必填')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = { name: name.trim(), icon, sort }
      if (item) {
        await api(`/work-items/${item.id}`, { method: 'PUT', body })
      } else {
        await api('/work-items', { method: 'POST', body })
      }
      toast(item ? '已更新' : '已新增工作項目')
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={item ? '編輯工作項目' : '新增工作項目'} onClose={onClose}>
      <div className="stack">
        <Field label="項目名稱 *">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="圖示（可選，顯示在清單與員工的技能）">
          <div className="icon-picker">
            {WORK_ITEM_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                className={`icon-option${icon === ic ? ' icon-option--active' : ''}`}
                onClick={() => setIcon(ic)}
              >
                {ic}
              </button>
            ))}
          </div>
        </Field>
        <Field label="排序（數字越小越前面）">
          <input type="number" value={sort} onChange={(e) => setSort(e.target.value)} />
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
