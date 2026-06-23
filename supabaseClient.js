import { createClient } from "@supabase/supabase-js";

/* Reads your project's public values from environment variables.
   These are set in a .env file locally and in Vercel's dashboard when deployed.
   The anon key is safe to expose in the browser — Row Level Security is what
   actually protects your data. */
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anon);

export const supabase = supabaseConfigured
  ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
