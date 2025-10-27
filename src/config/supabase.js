import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Prefer a server-side service role key for privileged operations (storage, signed URLs, admin tasks).
const supabaseUrl = process.env.SUPABASE_URL;
// Use SERVICE KEY when available, otherwise fall back to anon key (not recommended for server-side writes)
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables (SUPABASE_URL and SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY)');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export default supabase;
