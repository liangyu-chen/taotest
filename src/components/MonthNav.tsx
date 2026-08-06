import { today } from '../types'

// =============================================================
// MonthNav.tsx —— 月曆切換器
// 顯示「‹ 2026 年 8 月 › 本月」。由父頁面傳入目前 year/month 與切換函式。
// 當 allowFuture 沒開（排休頁），未來月份最多往前 6 個月，不能再往後。
// =============================================================

const MAX_FUTURE_MONTHS = 6

export default function MonthNav({
  year,
  month,
  onChange,
  allowFuture,
}: {
  year: number
  month: number
  onChange: (y: number, m: number) => void
  allowFuture?: boolean
}) {
  const now = today()
  // 計算「最遠能切到的月份」：allowFuture 開啟時不限（null）
  const horizon = allowFuture
    ? null
    : (() => {
        const total = now.year * 12 + (now.month - 1) + MAX_FUTURE_MONTHS
        return { y: Math.floor(total / 12), m: (total % 12) + 1 }
      })()
  const atMax = horizon !== null && (year > horizon.y || (year === horizon.y && month >= horizon.m))
  const back = () => (month === 1 ? onChange(year - 1, 12) : onChange(year, month - 1))
  const fwd = () => {
    if (atMax) return
    onChange(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1)
  }

  return (
    <div className="monthnav">
      <button type="button" className="monthnav__btn" onClick={back} aria-label="上一個月">
        ‹
      </button>
      <span className="monthnav__label">
        {year} <em>年</em> {month} <em>月</em>
      </span>
      <button
        type="button"
        className="monthnav__btn"
        onClick={fwd}
        disabled={atMax}
        aria-label="下一個月"
      >
        ›
      </button>
      <button
        type="button"
        className="monthnav__btn monthnav__btn--text"
        onClick={() => onChange(now.year, now.month)}
      >
        本月
      </button>
    </div>
  )
}
