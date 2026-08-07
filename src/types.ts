// =============================================================
// types.ts —— 資料型別定義
// 把「後端會回傳什麼資料」全部定義在這裡，加上一些全站共用的
// 日期輔助函式。TypeScript 會用這些定義檢查程式有沒有寫錯欄位。
// =============================================================

// 帳號：管理員(admin)／一般員工(user)
export interface User {
  id: string
  username: string
  display_name: string
  role: 'admin' | 'user'
  employee_id: string
  created_at: string
}

export type EmployeeType = 'fulltime' | 'parttime'

// 員工：color 是該員工在班表上的代表色（後端啟動時會自動補色）；
// skills 是該員工的工作技能（一對多，可同時會 吧台、內場 等多個工作項目）
export interface Employee {
  id: string
  name: string
  employee_no: string
  employee_type: EmployeeType
  shift_hours: string
  weekly_hours: string
  color: string
  active: string
  skills: { id: string; name: string; icon: string }[]
  created_at: string
}

// 員工代表色調色盤（12 色），員工管理頁讓使用者挑，系統自動補色時也從這裡輪流取
export const EMPLOYEE_COLORS = [
  '#f59e0b',
  '#22d3ee',
  '#a78bfa',
  '#34d399',
  '#fb923c',
  '#60a5fa',
  '#f472b6',
  '#a3e635',
  '#e879f9',
  '#2dd4bf',
  '#f87171',
  '#facc15',
]

export function isFullTime(emp: Employee): boolean {
  return emp.employee_type === 'fulltime'
}

// 日類型：平日／週末／例假日（決定這天的人力需求，也是自動排班的依據之一）
export type DayType = 'weekday' | 'weekend' | 'holiday'

export const DAY_TYPES: { value: DayType; label: string }[] = [
  { value: 'weekday', label: '平日（一～五）' },
  { value: 'weekend', label: '週末（六日）' },
  { value: 'holiday', label: '例假日' },
]

// 算出某天屬於哪種日類型（例假日優先，其次週末）
export function dayTypeOf(year: number, month: number, day: number, holidays: Set<string>): DayType {
  if (holidays.has(dateKey(year, month, day))) return 'holiday'
  const dow = (new Date(year, month - 1, day).getDay() + 6) % 7
  return dow >= 5 ? 'weekend' : 'weekday'
}

// 人力需求：某個班別在某種日類型需要幾個人（由「班別與人力設定」維護）
export interface Headcount {
  shift_code: string
  day_type: DayType
  count: number
}

// 設定項目：key 是識別碼，value 是內容（「排班規則設定」維護）
export interface Setting {
  key: string
  value: string
  desc: string
}

// 班別：例如「早班 code=E」或「晚班 code=L」，含顯示顏色與時段
export interface ShiftType {
  id: string
  name: string
  code: string
  start_time: string
  end_time: string
  color: string
  sort: string
  created_at: string
}

// 工作項目：例如「吧台」「內場」；icon 是顯示用的 emoji/符號；
// 員工可透過「工作技能」關聯到多個工作項目
export interface WorkItem {
  id: string
  name: string
  icon: string
  sort: string
  created_at: string
}

// 工作項目可選的圖示（工作項目頁彈窗挑選）
export const WORK_ITEM_ICONS = ['🍸', '🍺', '🍳', '👨‍🍳', '🍽️', '☕', '🥤', '🍜', '🥗', '🧀', '🍰', '🎂']

// 把後端回傳的設定陣列轉成「以 key 查詢」的物件，方便直接用 settings.xxx 讀取
export function settingsToMap(settings: Setting[]): SettingsMap {
  const map: Record<string, string> = {}
  for (const s of settings) map[s.key] = s.value ?? ''
  return map as unknown as SettingsMap
}

// 偏好班別的呈現色：早班（開始 <15:00）＝太陽的溫暖感（淺橙→金黃、琥珀色），
// 晚/夜班＝淺紫 #F3E8FF（深紫字）。
// 回傳 { bg 底、fg 文字、bar 指示色、border 淺色描邊 }。
export function preferColors(
  shift: Pick<ShiftType, 'start_time'> | undefined | null,
): { bg: string; fg: string; bar: string; border: string } {
  const h = shift?.start_time ? Number(shift.start_time.split(':')[0]) : NaN
  if (Number.isFinite(h) && h < 15) {
    return { bg: 'linear-gradient(160deg, #FFF6E3, #FFE2B8)', fg: '#92400E', bar: '#F59E0B', border: '#FBD38E' }
  }
  return { bg: '#F3E8FF', fg: '#6d28d9', bar: '#a78bfa', border: '#DEC9FC' }
}

// 員工狀態方塊的完整配色：可排班=綠、排休=紅、沒空=灰、偏好=太陽/晚紫
export function statusPalette(
  rec: Availability | undefined,
  preferShift: Pick<ShiftType, 'start_time'> | undefined | null,
): { bg: string; fg: string; bar: string; border: string } {
  if (rec?.status === 'off') return { bg: '#FBE9E8', fg: '#7f1d1d', bar: '#dc2626', border: '#F3C6C3' }
  if (rec?.status === 'unavailable') return { bg: '#F4F4F5', fg: '#52525B', bar: '#6b7280', border: '#D4D4D8' }
  if (preferShift && (!rec || rec.status !== 'available')) return preferColors(preferShift)
  return { bg: '#E7F4EC', fg: '#14532d', bar: '#16a34a', border: '#C2E3CB' }
}

export interface SettingsMap {
  work_start: string
  work_end: string
  fulltime_shift_hours: string
  parttime_shift_hours: string
  holidays: string
  max_consecutive_work_days: string
}

// 排休/時段：某員工某天的狀態。
// status 的有效值：off（排休）｜unavailable（無法排班）｜班別 code（偏好該班別）
// 舊資料可能殘留 available（可排班），程式中一律當作可排班處理
export interface Availability {
  employee_id: string
  date: string
  status: string
  note: string
  start_time?: string
  end_time?: string
}

// 已排的班：某人某天被排到某個班別（note 是該班的備註）。
// work_item 是該員工當日負責的工作項目 id，多個以逗號分隔（如 "1,2" ＝ 吧台＋內場）
export interface Assignment {
  year: number
  month: number
  day: number
  shift_code: string
  employee_id: string
  note?: string
  work_item?: string
}

// 自動排班結果的統計資料（顯示在「本月人力彙總」）
export interface GenerateSummary {
  year: number
  month: number
  days: number
  totalSlots: number
  employees: number
  perEmployee: {
    employee_id: string
    total: number
    hours: number
    targetHours: number
    perShift: Record<string, number>
  }[]
}

// 自動排班的整體結果：排好的班、無法填滿的時段（可能因人力或工作項目未被滿足）、統計
export interface GenerateResult {
  assignments: Assignment[]
  unfilled: { day: number; shift_code: string; work_item?: string }[]
  summary: GenerateSummary
}

export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

// —— 日期輔助函式（月份以 1~12 表示；JS 的月份是 0~11，這裡統一轉換）——

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// 產出「2026-08-05」格式的日期字串，當作資料的唯一識別碼
export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

export function today(): { year: number; month: number } {
  const d = new Date()
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

// 每月 1 號是星期幾（0=週一 … 6=週日），月曆排版用
export function firstDayOffset(year: number, month: number): number {
  return (new Date(year, month - 1, 1).getDay() + 6) % 7
}

export function isOff(status: string): boolean {
  return status === 'off'
}
