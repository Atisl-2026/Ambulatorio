// Sincronizzazione in tempo reale tramite Server-Sent Events.
import { sessionStillValid } from './auth.js';

const clients = new Set();

export function attachClient(req, res) {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const client = { res, userId: req.user.id, role: req.user.role, sessionHash: req.user.sessionHash };
  clients.add(client);
  write(client, { type: 'hello' });

  const timer = setInterval(() => {
    if (!sessionStillValid(client.sessionHash)) {
      write(client, { type: 'session:revoked' });
      close(client);
      return;
    }
    res.write(': ping\n\n');
  }, 25000);
  client.timer = timer;
  req.on('close', () => {
    clearInterval(timer);
    clients.delete(client);
  });
}

function write(client, evt) {
  try {
    client.res.write(`data: ${JSON.stringify(evt)}\n\n`);
  } catch {
    /* connessione chiusa */
  }
}

function close(client) {
  clearInterval(client.timer);
  clients.delete(client);
  try {
    client.res.end();
  } catch {
    /* già chiusa */
  }
}

export function broadcast(evt) {
  for (const c of clients) write(c, evt);
}

export function sendToUser(userId, evt) {
  for (const c of clients) if (c.userId === userId) write(c, evt);
}

export function revokeUser(userId) {
  for (const c of [...clients]) {
    if (c.userId === userId) {
      write(c, { type: 'session:revoked' });
      close(c);
    }
  }
}

export const onlineCount = () => new Set([...clients].map((c) => c.userId)).size;
