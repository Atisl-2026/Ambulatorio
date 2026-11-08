// Generatore del file Excel del calendario, condiviso tra l'app (browser) e la funzione cloud.
// rows: [{ operator, doctor, specialty, day, time, client, docs, notes, locked, weekLocked, updatedBy, updatedAt }]
import { DAYS_LONG, MONTHS, weekdayIndex, parseISO, formatDateTime, weekKey, monthRange } from './dates.js';

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

export async function buildCalendarXlsx(ExcelJS, title, rows, author = 'Ambulatorio') {
  const wb = new ExcelJS.Workbook();
  wb.creator = author;
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS;
  for (const r of rows) {
    ws.addRow({
      operator: r.operator,
      doctor: r.doctor + (r.specialty ? ` (${r.specialty})` : ''),
      day: parseISO(r.day),
      weekday: DAYS_LONG[weekdayIndex(r.day)],
      time: r.time,
      client: r.client,
      docs: r.docs ? '✓' : '✗',
      notes: r.notes,
      week: weekKey(r.day),
      locked: r.locked ? 'Bloccato dal Capo' : r.weekLocked ? 'Settimana bloccata' : '',
      updatedBy: r.updatedBy,
      updatedAt: formatDateTime(r.updatedAt),
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
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export const weekFileName = (key) => `Ambulatorio_Settimana_${key}.xlsx`;

export function monthInfo(ym) {
  const r = monthRange(ym);
  if (!r) return null;
  const name = MONTHS[r.month - 1];
  return { ...r, label: `${name} ${r.year}`, fileName: `Ambulatorio_${name}_${r.year}.xlsx` };
}
