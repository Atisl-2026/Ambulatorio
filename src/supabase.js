import { createClient } from '@supabase/supabase-js';

// Indirizzo e chiave pubblica del progetto Supabase (inseriti in fase di compilazione).
// La chiave "anon/publishable" è pubblica per natura: la protezione dei dati è garantita
// dal login e dalle regole di sicurezza del database (RLS).
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
// Senza configurazione si usa Supabase locale (`npx supabase start`) con la sua chiave di sviluppo standard.
const LOCAL_DEV_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || LOCAL_DEV_KEY;
export const USER_EMAIL_DOMAIN = 'utenti.ambulatorio.app';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ambulatorio-auth' },
});

export const usernameToEmail = (u) => `${String(u || '').trim().toLowerCase()}@${USER_EMAIL_DOMAIN}`;
export const logoUrl = (v = 0) => `${SUPABASE_URL}/storage/v1/object/public/branding/logo?v=${v}`;
