import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { DAY_TYPES, settingsToMap, type Headcount, type Setting, type ShiftType } from '../types'
import { Modal, Field, Spinner, toast, useConfirm } from '../components/ui'

// =============================================================
// ShiftTypes.tsx —— 班別與人力需求（管理員）
// 上半：班別清單（新增/編輯/刪除班別，含代碼、時段、排序）。
// 下半：每日人力需求表——每個班別在 平日/週末/例假日 各需要幾人
//       （設 0 表示那天不開班）。自動排班會依照這裡的需求來填人。
// =============================================================

export default function ShiftTypes() {
  const [shifts, setShifts] = useState<ShiftType[]>([])
  const [headcounts, setHeadcounts] = useState<Headcount[]>([])
  const [settings, setSettings] = useState<Setting[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ShiftType | null>(null)
  const [creating, setCreating] = useState(false)
  const [savingHc, setSavingHc] = useState(false)
  const { confirm, dialog } = useConfirm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, h, st] = await Promise.all([
        api<{ shiftTypes: ShiftType[] }>('/shift-types'),
        api<{ headcounts: Headcount[] }>('/headcounts'),
        api<{ settings: Setting[] }>('/settings'),
      ])
      setShifts(s.shiftTypes)
      setHeadcounts(h.headcounts)
      setSettings(st.settings)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const workShifts = shifts.filter((s) => s.code !== 'OFF')
  const cfg = settingsToMap(settings)
  const holidayCount = cfg.holidays ? cfg.holidays.split(/\s+/).filter(Boolean).length : 0

  // 讀取某班別某日型的需要人數（沒有資料視為 0）
  function hcCount(code: string, dayType: string): number {
    const h = headcounts.find((x) => x.shift_code === code && x.day_type === dayType)
    return h ? Number(h.count) : 0
  }

  // 修改某班別某日型的需要人數；改為 0 就刪掉該筆（表示不開班）
  function setHcCount(code: string, dayType: string, count: number) {
    setHeadcounts((prev) => {
      const next = prev.filter((x) => !(x.shift_code === code && x.day_type === dayType))
      if (count > 0) next.push({ shift_code: code, day_type: dayType as Headcount['day_type'], count })
      return next
    })
  }

  // 把整張人力需求表寫回後端
  async function saveHeadcounts() {
    setSavingHc(true)
    try {
      await api('/headcounts', { method: 'PUT', body: { headcounts } })
      toast('人力需求已儲存')
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setSavingHc(false)
    }
  }

  async function remove(row: ShiftType) {
    const ok = await confirm({
      title: '刪除班別',
      message: `確定要刪除班別「${row.name}」嗎？`,
      hint: '此操作無法復原。',
    })
    if (!ok) return
    try {
      await api(`/shift-types/${row.id}`, { method: 'DELETE' })
      toast('已刪除')
      await load()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="view">
      <div className="view__head">
        <h3 className="view__title">班別設定</h3>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          ＋ 新增班別
        </button>
      </div>

      {loading ? (
        <Spinner label="載入中…" />
      ) : (
        <>
          <div className="table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>班別</th>
                  <th>代碼</th>
                  <th>起訖時間</th>
                  <th>排序</th>
                  <th className="table__actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((row) => (
                  <tr key={row.id}>
                    <td className="table__strong">{row.name}</td>
                    <td>{row.code}</td>
                    <td>{row.start_time ? `${row.start_time}–${row.end_time || '次日'}` : '—'}</td>
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
              </tbody>
            </table>
          </div>

          <section className="panel hc">
            <div className="hc__head">
              <h3 className="panel__title">每日人力需求</h3>
              <p className="panel__desc">
                每個班別在不同日型各需要幾人；設為 0 表示當天該班不開班。例假日請到〈排班規則設定〉填寫日期
                {holidayCount > 0 && `（目前已設定 ${holidayCount} 天例假日）`}。
              </p>
            </div>
            {/* 人力需求表格：每格直接輸入數字，改完按下方「儲存人力需求」 */}
            <div className="table-card">
              <table className="table table--hc">
                <thead>
                  <tr>
                    <th>班別</th>
                    {DAY_TYPES.map((dt) => (
                      <th key={dt.value}>{dt.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {workShifts.map((s) => (
                    <tr key={s.code}>
                      <td className="table__strong">{s.name}</td>
                      {DAY_TYPES.map((dt) => (
                        <td key={dt.value}>
                          <input
                            type="number"
                            min={0}
                            max={50}
                            className="num-input"
                            value={hcCount(s.code, dt.value)}
                            onChange={(e) => setHcCount(s.code, dt.value, Number(e.target.value) || 0)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="hc__save">
              <button type="button" className="btn btn--primary" disabled={savingHc} onClick={() => void saveHeadcounts()}>
                {savingHc ? '儲存中…' : '儲存人力需求'}
              </button>
            </div>
          </section>
        </>
      )}

      {(creating || editing) && (
        <ShiftModal
          shift={editing}
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

// 新增/編輯班別彈窗
function ShiftModal({
  shift,
  onClose,
  onSaved,
}: {
  shift: ShiftType | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(shift?.name || '')
  const [code, setCode] = useState(shift?.code || '')
  const [start, setStart] = useState(shift?.start_time || '')
  const [end, setEnd] = useState(shift?.end_time || '')
  const [sort, setSort] = useState(shift?.sort || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!name.trim() || !code.trim()) {
      setError('班別名稱與代碼為必填')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = { name: name.trim(), code: code.trim(), start_time: start, end_time: end, sort }
      if (shift) {
        await api(`/shift-types/${shift.id}`, { method: 'PUT', body })
      } else {
        await api('/shift-types', { method: 'POST', body })
      }
      toast(shift ? '已更新' : '已新增班別')
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={shift ? '編輯班別' : '新增班別'} onClose={onClose}>
      <div className="stack">
        <Field label="班別名稱 *">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="代碼 *（例如 M / A / N，1–4 個英文字母）">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={4} />
        </Field>
        <div className="form-row">
          <Field label="開始時間">
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="結束時間">
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="排序（數字越小越先排）">
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
