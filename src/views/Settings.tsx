import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { settingsToMap, type Setting } from '../types'
import { Field, Spinner, toast } from '../components/ui'

// =============================================================
// Settings.tsx —— 排班規則設定（管理員）
// 營業時間、正職/工讀每班時數、例假日清單。
// 修改的內容暫存在本頁的 settings state，按「儲存設定」才一次寫回後端。
// =============================================================

export default function Settings() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ settings: Setting[] }>('/settings')
      setSettings(res.settings)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 轉成「key → value」查詢表，表單直接讀 cfg.work_start 等欄位
  const cfg = settingsToMap(settings)

  // 表單欄位變更：更新對應 key 的值（僅記憶體，尚未存後端）
  function set(key: string, value: string) {
    setSettings((prev) => {
      const idx = prev.findIndex((s) => s.key === key)
      if (idx >= 0) {
        const next = prev.slice()
        next[idx] = { ...next[idx], value }
        return next
      }
      return [...prev, { key, value, desc: '' }]
    })
  }

  // 一次把整份設定寫回後端
  async function save() {
    setSaving(true)
    setError('')
    try {
      await api('/settings', { method: 'PUT', body: { settings } })
      toast('排班規則已儲存')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="view">
      <div className="view__head">
        <h3 className="view__title">排班規則設定</h3>
        <button type="button" className="btn btn--primary" disabled={saving || loading} onClick={() => void save()}>
          {saving ? '儲存中…' : '儲存設定'}
        </button>
      </div>

      {loading ? (
        <Spinner label="載入設定中…" />
      ) : (
        <>
          <section className="panel">
            <h3 className="panel__title">營業與班表</h3>
            <div className="form-grid">
              <Field label="每日開始營業時間">
                <input type="time" value={cfg.work_start} onChange={(e) => set('work_start', e.target.value)} />
              </Field>
              <Field label="每日結束營業時間">
                <input type="time" value={cfg.work_end} onChange={(e) => set('work_end', e.target.value)} />
              </Field>
            </div>
            <p className="hint">此時間為資訊用途；實際班別起訖時間請在〈班別與人力〉調整。</p>
          </section>

          <section className="panel">
            <h3 className="panel__title">排班時數規則</h3>
            <div className="form-grid">
              <Field label="正職每班固定時數（小時）">
                <input type="number" min={1} max={24} value={cfg.fulltime_shift_hours} onChange={(e) => set('fulltime_shift_hours', e.target.value)} />
              </Field>
              <Field label="工讀每班預設時數（小時）">
                <input type="number" min={1} max={24} value={cfg.parttime_shift_hours} onChange={(e) => set('parttime_shift_hours', e.target.value)} />
              </Field>
            </div>
            <p className="hint">
              工讀可依員工在〈員工管理〉個別覆寫「每班時數」；正職每班時數以此處設定為準。
              工讀無每週時數上限，排班時只要有空就盡量安排，並依「每班時數×當月天數」比例公平輪班。
            </p>
          </section>

          <section className="panel">
            <h3 className="panel__title">連續工作天數上限</h3>
            <div className="form-grid">
              <Field label="每人每週最多連續工作天數（0 = 不限制）">
                <input
                  type="number"
                  min={0}
                  max={14}
                  placeholder="6"
                  value={cfg.max_consecutive_work_days}
                  onChange={(e) => set('max_consecutive_work_days', e.target.value)}
                />
              </Field>
            </div>
            <p className="hint">自動排班時，同一人不會被排入連續工作超過這個天數（例如設定 6，最多連續上 6 天就需休息）。</p>
          </section>

          <section className="panel">
            <h3 className="panel__title">例假日</h3>
            <label className="field">
              <span className="field__label">例假日日期（一行一天，格式 2026-01-01）</span>
              <textarea
                className="holiday-input"
                rows={6}
                placeholder={'2026-01-01\n2026-02-17'}
                value={cfg.holidays}
                onChange={(e) => set('holidays', e.target.value)}
              />
            </label>
            <p className="hint">例假日會以〈班別與人力〉中的「例假日」人力需求來排班（例如早班 2 人）。</p>
          </section>

          {error && <p className="form-error">{error}</p>}
        </>
      )}
    </div>
  )
}
