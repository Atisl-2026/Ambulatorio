// Client HTTP verso il server. Tutte le richieste inviano il cookie di sessione.

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, url, body, { raw = false } = {}) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'AmbulatorioApp' },
  };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'Connessione al server non riuscita. Controlla la rete.');
  }
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* risposta non JSON */ }
    const err = new ApiError(res.status, data.error || `Errore ${res.status}`, data.code);
    if (res.status === 401 && !url.includes('/auth/login')) onUnauthorized(err);
    throw err;
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

export const api = {
  get: (url) => request('GET', `/api${url}`),
  post: (url, body = {}) => request('POST', `/api${url}`, body),
  put: (url, body = {}) => request('PUT', `/api${url}`, body),
  patch: (url, body = {}) => request('PATCH', `/api${url}`, body),
  del: (url) => request('DELETE', `/api${url}`),
  upload: (url, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', `/api${url}`, fd);
  },
  download: async (url) => {
    const res = await request('GET', `/api${url}`, undefined, { raw: true });
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = m ? decodeURIComponent(m[1]) : 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    return a.download;
  },
};

export const basePath = (kind) => (kind === 'request' ? '/requests' : '/appointments');
