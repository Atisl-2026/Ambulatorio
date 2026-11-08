// Utilità comuni alle funzioni cloud.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';

export const USER_EMAIL_DOMAIN = 'utenti.ambulatorio.app';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Caller = { id: string; username: string; display_name: string; role: string };

// Verifica il token dell'utente e il suo profilo (attivo, password già cambiata).
export async function getCaller(req: Request, db: SupabaseClient, { admin = false } = {}): Promise<Caller> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Sessione non valida.');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Sessione scaduta o non valida. Effettua di nuovo l\'accesso.');
  const { data: p } = await db.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!p || !p.active) throw new HttpError(401, 'Account non attivo.');
  if (p.must_change_password) throw new HttpError(403, 'Devi cambiare la password prima di continuare.');
  if (admin && p.role !== 'admin') throw new HttpError(403, 'Funzione riservata all\'amministratore.');
  return p as Caller;
}

export async function logActivity(db: SupabaseClient, who: { id?: string | null; display_name?: string | null } | null, action: string, details: string) {
  await db.from('activity_log').insert({ user_id: who?.id ?? null, user_name: who?.display_name ?? 'Sistema', action, details });
}

export async function emit(db: SupabaseClient, type: string, payload: Record<string, unknown> = {}, target: string | null = null) {
  await db.from('events').insert({ type, payload, target });
}

export function handler(fn: (req: Request, body: any) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Metodo non consentito.' }, 405);
    try {
      const body = await req.json().catch(() => ({}));
      return await fn(req, body);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
      console.error(err);
      return json({ error: 'Errore interno.' }, 500);
    }
  };
}
