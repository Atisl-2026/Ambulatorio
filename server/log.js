import { run, now } from './db.js';

// Registro attività: chi, cosa, quando.
export function logActivity(req, action, details, kind = null, itemId = null) {
  const u = req?.user;
  run(
    'INSERT INTO activity_log (at, user_id, user_name, action, kind, item_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    now(), u?.id ?? null, u?.displayName ?? null, action, kind, itemId, details ?? null, req?.ip ?? null,
  );
}
