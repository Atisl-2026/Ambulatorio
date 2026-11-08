// Utility per date condivise tra server e client.
// Le date "di calendario" sono sempre stringhe 'YYYY-MM-DD'; gli orari 'HH:MM'.

const pad = (n) => String(n).padStart(2, '0');

export const MONTHS = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];
export const DAYS_SHORT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
export const DAYS_LONG = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];

export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Mezzogiorno locale: evita problemi con il cambio dell'ora legale.
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(parseISO(s)) === s;
}

export function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function todayISO() {
  return toISO(new Date());
}

export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// 0 = lunedì ... 6 = domenica
export function weekdayIndex(s) {
  return (parseISO(s).getDay() + 6) % 7;
}

export function mondayOf(s) {
  return addDays(s, -weekdayIndex(s));
}

export function isoWeek(s) {
  const thursday = addDays(mondayOf(s), 3);
  const year = parseISO(thursday).getFullYear();
  const week1 = mondayOf(`${year}-01-04`);
  const week = 1 + Math.round((parseISO(mondayOf(s)) - parseISO(week1)) / (7 * 864e5));
  return { year, week };
}

export function weekKey(s) {
  const { year, week } = isoWeek(s);
  return `${year}-W${pad(week)}`;
}

export function mondayFromWeekKey(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(key || '');
  if (!m) return null;
  const monday = addDays(mondayOf(`${m[1]}-01-04`), (Number(m[2]) - 1) * 7);
  return weekKey(monday) === key ? monday : null;
}

// Lunedì → sabato
export function weekDays(monday) {
  return [0, 1, 2, 3, 4, 5].map((i) => addDays(monday, i));
}

export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(y, mo, 0, 12).getDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad(last)}`, year: y, month: mo };
}

export function formatDate(s, { weekday = false, year = true } = {}) {
  if (!isISODate(s)) return s || '';
  const d = parseISO(s);
  const parts = [];
  if (weekday) parts.push(DAYS_SHORT[weekdayIndex(s)]);
  parts.push(`${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3).toLowerCase()}`);
  if (year) parts.push(String(d.getFullYear()));
  return parts.join(' ');
}

export function formatDateNumeric(s) {
  if (!isISODate(s)) return s || '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function weekLabel(monday) {
  const sat = addDays(monday, 5);
  const a = parseISO(monday);
  const b = parseISO(sat);
  const { week } = isoWeek(monday);
  const left = a.getMonth() === b.getMonth()
    ? `${a.getDate()}`
    : `${a.getDate()} ${MONTHS[a.getMonth()].toLowerCase()}`;
  return `Settimana ${week} · ${left}–${b.getDate()} ${MONTHS[b.getMonth()].toLowerCase()} ${b.getFullYear()}`;
}
