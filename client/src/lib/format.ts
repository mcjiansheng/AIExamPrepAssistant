// 日期、时长、用量的显示。数字用阿拉伯数字，正文遵循中文排版（07 第 8 节）。
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function parseDate(date: string) {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDaysIso(date: string, n: number) {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function dayDiff(from: string, to: string) {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
}
/** 11月25日 周二 */
export function longDate(date: string) {
  const d = parseDate(date);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
}
/** 11/25 */
export function shortDate(date: string) {
  const d = parseDate(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
export function weekday(date: string) {
  return WEEK[parseDate(date).getDay()]!;
}
/** 今天、明天、后天、周四 */
export function relativeDay(date: string) {
  const n = dayDiff(todayIso(), date);
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === 2) return '后天';
  if (n === -1) return '昨天';
  if (n > 0 && n < 7) return weekday(date);
  return shortDate(date);
}
/** 25 分钟、1 小时 30 分 */
export function duration(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
/** 1.2 万 */
export function tokens(n: number) {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} 千`;
  return String(n);
}
export function money(n: number | null) {
  if (n === null) return '—';
  return n < 0.01 && n > 0 ? '不到 ¥0.01' : `¥${n.toFixed(2)}`;
}
export function percent(ratio: number) {
  return `${Math.round(ratio * 100)}%`;
}
/** 3 分钟前、昨天 20:10 */
export function ago(iso: string) {
  const t = Date.parse(iso);
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const n = dayDiff(date, todayIso());
  if (n === 0) return `今天 ${hm}`;
  if (n === 1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
