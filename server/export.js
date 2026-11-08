// Esportazione Excel del calendario (solo amministratore).
import ExcelJS from 'exceljs';
import { all } from './db.js';
import { HttpError } from './security.js';
import { makeContext, rowData, withNames } from './entities.js';
import {
  mondayFromWeekKey, addDays, monthRange, MONTHS, DAYS_LONG, weekdayIndex, parseISO, formatDateTime, weekKey,
} from '../shared/dates.js';

const COLUMNS = [
  { header: 'Operatrice', key: 'operator', width: 22 },
  { header: 'Medico', key: 'doctor', width: 26 },
  { header: 'Giorno', key: 'day', width: 14 },
  { header: 'Giorno settimana', key: 'weekday', width: 16 },
  { header: 'Orario', key: 'time', width: 10 },
  { header: 'Cliente', key: 'client', width: 28 },
  { header: 'Documenti controllati', key: 'docs', width: 14 },
  { header: 'Note', key: 'notes', width: 44 },
  { header: 'Settimana', key: 'week', width: 12 },
  { header: 'Stato blocco', key: 'locked', width: 20 },
  { header: 'Ultima modifica di', key: 'updatedBy', width: 22 },
  { header: 'Ultima modifica il', key: 'updatedAt', width: 18 },
];

async function buildWorkbook(title, from, to, author) {
  const ctx = makeContext();
  const weekLocks = ctx.weekLocks;
  const rows = all(
    'SELECT * FROM appointments WHERE is_published = 1 AND day BETWEEN ? AND ? ORDER BY day, time, id',
    from, to,
  );
  const wb = new ExcelJS.Workbook();
  wb.creator = author;
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS;

  for (const r of rows) {
    const d = withNames('appointment', rowData('appointment', r), ctx);
    const wLocked = weekLocks.has(addDays(r.day, -weekdayIndex(r.day)));
    ws.addRow({
      operator: d.operator_name,
      doctor: d.doctor_name + (d.doctor_specialty ? ` (${d.doctor_specialty})` : ''),
      day: parseISO(d.day),
      weekday: DAYS_LONG[weekdayIndex(d.day)],
      time: d.time,
      client: d.client,
      docs: d.docs_checked ? '✓' : '✗',
      notes: d.notes,
      week: weekKey(d.day),
      locked: r.locked ? 'Bloccato dal Capo' : wLocked ? 'Settimana bloccata' : '',
      updatedBy: ctx.users.get(r.updated_by) || '',
      updatedAt: formatDateTime(r.updated_at),
    });
  }

  const header = ws.getRow(1);
  header.height = 30;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FF222222' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFED00' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF6B7A3A' } } };
  });
  ws.getColumn('day').numFmt = 'dd/mm/yyyy';
  ws.getColumn('docs').alignment = { horizontal: 'center' };
  ws.getColumn('notes').alignment = { wrapText: true, vertical: 'top' };
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const docs = row.getCell('docs');
    docs.font = { bold: true, color: { argb: docs.value === '✓' ? 'FF4B5A20' : 'FFD7141A' } };
    if (row.getCell('locked').value) row.getCell('locked').font = { bold: true, color: { argb: 'FFD7141A' } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: COLUMNS.length } };
  return { wb, count: rows.length };
}

export async function exportWeek(week, author) {
  const monday = mondayFromWeekKey(week);
  if (!monday) throw new HttpError(400, 'Settimana non valida (formato AAAA-Wnn).');
  const { wb, count } = await buildWorkbook(`Settimana ${week}`, monday, addDays(monday, 5), author);
  return { buffer: await wb.xlsx.writeBuffer(), filename: `Ambulatorio_Settimana_${week}.xlsx`, count };
}

export async function exportMonth(month, author) {
  const r = monthRange(month);
  if (!r) throw new HttpError(400, 'Mese non valido (formato AAAA-MM).');
  const name = `${MONTHS[r.month - 1]} ${r.year}`;
  const { wb, count } = await buildWorkbook(name, r.from, r.to, author);
  return { buffer: await wb.xlsx.writeBuffer(), filename: `Ambulatorio_${MONTHS[r.month - 1]}_${r.year}.xlsx`, count };
}
