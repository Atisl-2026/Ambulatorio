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

// Registro di tutte le richieste pubblicate (archivio sul Drive).
export async function exportRequests(author) {
  const ctx = makeContext();
  const wb = new ExcelJS.Workbook();
  wb.creator = author;
  wb.created = new Date();
  const ws = wb.addWorksheet('Richieste', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'N.', key: 'id', width: 7 },
    { header: 'Data', key: 'date', width: 12 },
    { header: 'Titolo', key: 'title', width: 34 },
    { header: 'Cliente', key: 'client', width: 26 },
    { header: 'Stato', key: 'status', width: 16 },
    { header: 'Descrizione', key: 'description', width: 60 },
    { header: 'Allegati', key: 'attachments', width: 30 },
    { header: 'Autore', key: 'author', width: 20 },
    { header: 'Stato blocco', key: 'locked', width: 18 },
    { header: 'Ultima modifica di', key: 'updatedBy', width: 20 },
    { header: 'Ultima modifica il', key: 'updatedAt', width: 18 },
    { header: 'Versione', key: 'version', width: 9 },
  ];
  const rows = all('SELECT * FROM requests WHERE is_published = 1 ORDER BY date, id');
  for (const r of rows) {
    const d = withNames('request', rowData('request', r), ctx);
    ws.addRow({
      id: r.id, date: d.date ? parseISO(d.date) : null, title: d.title, client: d.client, status: d.status,
      description: d.description, attachments: d.attachments.map((a) => a.name).join(', '),
      author: ctx.users.get(r.created_by) || '', locked: r.locked ? 'Bloccata dal Capo' : '',
      updatedBy: ctx.users.get(r.updated_by) || '', updatedAt: formatDateTime(r.updated_at), version: r.version,
    });
  }
  const header = ws.getRow(1);
  header.height = 28;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FF222222' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFED00' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF6B7A3A' } } };
  });
  ws.getColumn('date').numFmt = 'dd/mm/yyyy';
  ws.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: 12 } };
  return { buffer: await wb.xlsx.writeBuffer(), filename: 'Registro_richieste.xlsx', count: rows.length };
}
