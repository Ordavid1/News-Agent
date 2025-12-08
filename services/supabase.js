/**
 * Supabase Client Service
 *
 * Provides two clients:
 * - supabase: Uses publishable key, respects RLS (for user-context operations)
 * - supabaseAdmin: Uses secret key, bypasses RLS (for server-side operations)
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

// Validate required environment variables
if (!supabaseUrl) {
  throw new Error('Missing SUPABASE_URL environment variable');
}

if (!supabasePublishableKey) {
  throw new Error('Missing SUPABASE_PUBLISHABLE_KEY environment variable');
}

if (!supabaseSecretKey) {
  throw new Error('Missing SUPABASE_SECRET_KEY environment variable');
}

/**
 * Public Supabase client
 * - Respects Row Level Security (RLS)
 * - Safe to use in contexts where user auth is applied
 */
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false, // Server-side, no need to persist
    detectSessionInUrl: false
  }
});

/**
 * Admin Supabase client
 * - Bypasses Row Level Security (RLS)
 * - Use for server-side operations that need full access
 * - Use for operations on behalf of users (with proper validation)
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

/**
 * Create a Supabase client with a specific user's JWT
 * Useful for making requests on behalf of authenticated users
 * while still respecting RLS
 *
 * @param {string} accessToken - User's JWT access token
 * @returns {SupabaseClient}
 */
export function createUserClient(accessToken) {
  return createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });
}

/**
 * Helper to check if Supabase is properly configured
 * @returns {Promise<boolean>}
 */
export async function checkSupabaseConnection() {
  try {
    const { error } = await supabaseAdmin.from('profiles').select('count').limit(1);
    if (error && error.code !== 'PGRST116') { // PGRST116 = table doesn't exist yet
      console.error('Supabase connection error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Supabase connection failed:', err);
    return false;
  }
}

export default {
  supabase,
  supabaseAdmin,
  createUserClient,
  checkSupabaseConnection
};
