import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import {
  dayTypeOf,
  daysInMonth,
  settingsToMap,
  today,
  type DayType,
  type Employee,
  type GenerateResult,
  type Headcount,
  type Setting,
  type ShiftType,
  type WorkItem,
} from '../types'
import MonthNav from '../components/MonthNav'
import { Spinner, toast } from '../components/ui'

// =============================================================
// Generate.tsx —— 自動排班的前後檢查頁
// 此頁已從選單移除（入口改在「班表總覽」的「⟳ 自動排班」），但仍保留：
// 排班前檢查（人數、天數、需排班數）與產生後的詳細結果統計。
// =============================================================

export default function Generate() {
  const t = today()
  const [year, setYear] = useState(t.year)
  const [month, setMonth] = useState(t.month)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([])
  const [headcounts, setHeadcounts] = useState<Headcount[]>([])
  const [settings, setSettings] = useState<Setting[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [result, setResult] = useState<GenerateResult | null>(null) // 最近一次產生結果
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [e, s, h, st, w] = await Promise.all([
        api<{ employees: Employee[] }>('/employees'),
        api<{ shiftTypes: ShiftType[] }>('/shift-types'),
        api<{ headcounts: Headcount[] }>('/headcounts'),
        api<{ settings: Setting[] }>('/settings'),
        api<{ workItems: WorkItem[] }>('/work-items'),
      ])
      setEmployees(e.employees)
      setShiftTypes(s.shiftTypes)
      setHeadcounts(h.headcounts)
      setSettings(st.settings)
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

  const cfg = settingsToMap(settings)
  const active = useMemo(() => employees.filter((e) => e.active !== '0'), [employees])
  const workShifts = useMemo(() => shiftTypes.filter((s) => s.code !== 'OFF'), [shiftTypes])
  const days = daysInMonth(year, month)

  // 把例假日清單（設定頁的文字方塊）轉成 Set，供 dayTypeOf 判斷
  const holidaySet = useMemo(() => {
    return new Set(cfg.holidays.split(/[\n,;\s]+/).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)))
  }, [cfg.holidays])

  // 本月 平日/週末/例假日 各有幾天
  const dayTypeCount = useMemo(() => {
    const count: Record<DayType, number> = { weekday: 0, weekend: 0, holiday: 0 }
    for (let d = 1; d <= days; d++) count[dayTypeOf(year, month, d, holidaySet)]++
    return count
  }, [year, month, days, holidaySet])

  // 估算本月每個班別共需排幾班（人數需求 × 該日型天數）
  const plan = useMemo(() => {
    const need: { code: string; name: string; count: number }[] = []
    for (const s of workShifts) {
      let count = 0
      for (const [dt, weight] of Object.entries(dayTypeCount)) {
        const h = headcounts.find((x) => x.shift_code === s.code && x.day_type === dt)
        count += (h ? Number(h.count) : 0) * weight
      }
      need.push({ code: s.code, name: s.name, count })
    }
    const total = need.reduce((sum, n) => sum + n.count, 0)
    return { need, total }
  }, [workShifts, headcounts, dayTypeCount])

  // 呼叫後端自動排班演算法，回傳結果並顯示
  async function generate() {
    setBusy(true)
    try {
      const res = await api<GenerateResult>('/schedule/generate', { method: 'POST', body: { year, month } })
      setResult(res)
      toast(
        res.unfilled.length > 0 ? `已產生，但 ${res.unfilled.length} 個時段人力/工作未滿足` : `已產生 ${res.summary.totalSlots} 班`,
        res.unfilled.length > 0 ? 'error' : 'ok',
      )
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  // 員工 ID → 員工 查詢表（結果表格要查姓名用）
  const empInfo = useMemo(() => {
    const m = new Map<string, Employee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  return (
    <div className="view">
      <div className="view__head">
        <MonthNav year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m) }} allowFuture />
      </div>

      {loading ? (
        <Spinner label="載入中…" />
      ) : (
        <>
          <section className="panel gen-plan">
            <h3 className="panel__title">排班前檢查</h3>
            <div className="gen-plan__cards">
              <div className="gen-card">
                <span className="gen-card__num">{active.length}</span>
                <span className="gen-card__label">在職員工</span>
              </div>
              <div className="gen-card">
                <span className="gen-card__num">{days}</span>
                <span className="gen-card__label">本月天數</span>
              </div>
              <div className="gen-card">
                <span className="gen-card__num">{plan.total}</span>
                <span className="gen-card__label">需排班數</span>
              </div>
              <div className="gen-card">
                <span className="gen-card__num gen-card__num--sm">{cfg.work_start || '?'}–{cfg.work_end || '?'}</span>
                <span className="gen-card__label">每日營業</span>
              </div>
            </div>
            <div className="gen-plan__need">
              {plan.need.map((n) => (
                <span key={n.code} className="gen-need">
                  {n.name}（{n.code}）{n.count} 班
                </span>
              ))}
              <span className="gen-need">平日 {dayTypeCount.weekday} 天・週末 {dayTypeCount.weekend} 天・例假日 {dayTypeCount.holiday} 天</span>
            </div>
            {active.length === 0 && <p className="form-error">沒有在職員工，無法排班，請先到〈員工管理〉新增。</p>}
          </section>

          <div className="gen-actions">
            <button
              type="button"
              className="btn btn--primary btn--large"
              disabled={busy || active.length === 0}
              onClick={() => void generate()}
            >
              {busy ? '排班中…' : `⟳ 產生 ${month} 月班表`}
            </button>
            {result && <span className="gen-result-time">上次產生：{year}-{month}</span>}
          </div>

          {result && (
            <section className="panel gen-result">
              <h3 className="panel__title">產生結果</h3>
              <div className="gen-result__summary">
                <span>共排 {result.summary.totalSlots} 班</span>
                <span>參與員工 {result.summary.employees} 人</span>
                {result.unfilled.length > 0 ? (
                  <span className="badge badge--off">{result.unfilled.length} 個時段人力/工作未滿足</span>
                ) : (
                  <span className="badge badge--on">全數滿足人力與工作項目需求</span>
                )}
              </div>

              {result.unfilled.length > 0 && (
                <div className="unfilled">
                  <p className="unfilled__title">人力/工作未滿足的時段：</p>
                  <div className="unfilled__grid">
                    {result.unfilled.map((u) => {
                      const s = shiftTypes.find((x) => x.code === u.shift_code)
                      return (
                        <span key={`${u.day}-${u.shift_code}-${u.work_item || ''}`} className="unfilled-chip">
                          {month}/{u.day} {s?.name || u.shift_code}
                          {u.work_item ? `（${workItems.find((w) => String(w.id) === u.work_item)?.name || u.work_item}）` : ''}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="table-card">
                <table className="table table--result">
                  <thead>
                    <tr>
                      <th>員工</th>
                      <th>類型</th>
                      {workShifts.map((s) => (
                        <th key={s.code} className="th--shift" style={{ color: s.color }}>
                          {s.name}
                        </th>
                      ))}
                      <th>總班數</th>
                      <th>總時數</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.summary.perEmployee.map((p) => {
                      const emp = empInfo.get(p.employee_id)
                      return (
                        <tr key={p.employee_id}>
                          <td className="table__strong">{emp?.name || '?'}</td>
                          <td>
                            <span className={`badge${emp?.employee_type === 'fulltime' ? ' badge--admin' : ' badge--on'}`}>
                              {emp?.employee_type === 'fulltime' ? '正職' : '工讀'}
                            </span>
                          </td>
                          {workShifts.map((s) => (
                            <td key={s.code}>{p.perShift[s.code] || 0}</td>
                          ))}
                          <td className="table__strong">{p.total}</td>
                          <td>{p.hours}h</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="hint">
                  產生後會覆蓋該月份原有班表；可再到〈班表總覽〉手動微調。依每位員工已累積的排班時數公平輪班，時數少者優先排入。
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}
