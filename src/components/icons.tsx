import type { ShiftType } from '../types'

// =============================================================
// icons.tsx —— 班別偏好用的圖示（內嵌 SVG）
// 依班別開始時間顯示：
//   白天班（開始 <15:00）= 太陽（琥珀色）
//   晚/夜班              = 星星（靛藍色，夜晚的星光）
// 用 SVG 而不是文字符號，畫面一致且不依賴系統字型。
// =============================================================

function SunIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="shift-icon shift-icon--sun"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function NightIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="shift-icon shift-icon--night"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2.5 14.4 8.6 21 9l-4.7 4.2 1.4 6.5L12 16.4 6.3 19.7l1.4-6.5L3 9l6.6-.4L12 2.5z" />
      <path d="M19.5 13.5l.7 1.7 1.8.3-1.35 1.25.45 1.75-1.6-.9-1.6.9.45-1.75-1.35-1.25 1.8-.3.7-1.7z" />
    </svg>
  )
}

// 依班別回傳對應的圖示：白天班＝太陽，其餘（晚/夜、未設時間）＝星星
export function ShiftIcon({ shift, size = 14 }: { shift?: Pick<ShiftType, 'start_time'> | null; size?: number }) {
  const h = shift?.start_time ? Number(shift.start_time.split(':')[0]) : NaN
  const day = Number.isFinite(h) && h < 15
  return day ? <SunIcon size={size} /> : <NightIcon size={size} />
}
