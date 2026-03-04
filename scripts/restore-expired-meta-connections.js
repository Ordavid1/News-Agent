/**
 * One-time recovery script: Restore Facebook/Instagram connections
 * incorrectly marked as 'expired' by the token refresh worker.
 *
 * Root cause: The worker tried to refresh tokens for platforms that
 * don't support refresh tokens (Facebook/Instagram use long-lived tokens).
 * After 3 failed retries it called markConnectionExpired().
 *
 * This script restores those connections to 'active' if the token
 * hasn't actually expired yet (long-lived tokens last ~60 days).
 *
 * Usage: node scripts/restore-expired-meta-connections.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials in .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const META_PLATFORMS = ['facebook', 'instagram'];

async function restoreExpiredMetaConnections() {
  console.log('Looking for Facebook/Instagram connections incorrectly marked as expired...\n');

  try {
    // Find all expired Facebook/Instagram connections
    const { data: connections, error: fetchError } = await supabase
      .from('social_connections')
      .select('id, user_id, platform, status, token_expires_at, updated_at, platform_username')
      .in('platform', META_PLATFORMS)
      .in('status', ['expired', 'error']);

    if (fetchError) {
      console.error('Error fetching connections:', fetchError);
      return;
    }

    if (!connections || connections.length === 0) {
      console.log('No expired/error Facebook or Instagram connections found. Nothing to fix.');
      return;
    }

    console.log(`Found ${connections.length} affected connection(s):\n`);

    let restored = 0;
    let skipped = 0;

    for (const conn of connections) {
      const tokenExpiry = conn.token_expires_at ? new Date(conn.token_expires_at) : null;
      const isTokenStillValid = !tokenExpiry || tokenExpiry > new Date();

      console.log(`  Platform: ${conn.platform}`);
      console.log(`  Username: ${conn.platform_username || '(none)'}`);
      console.log(`  Status:   ${conn.status}`);
      console.log(`  Token expires: ${tokenExpiry ? tokenExpiry.toISOString() : 'no expiry set'}`);
      console.log(`  Token valid:   ${isTokenStillValid ? 'YES' : 'NO (genuinely expired)'}`);

      if (isTokenStillValid) {
        const { error: updateError } = await supabase
          .from('social_connections')
          .update({
            status: 'active',
            last_error: null,
            updated_at: new Date().toISOString()
          })
          .eq('id', conn.id);

        if (updateError) {
          console.log(`  Result:   FAILED to restore - ${updateError.message}`);
        } else {
          console.log(`  Result:   RESTORED to active`);
          restored++;
        }
      } else {
        console.log(`  Result:   SKIPPED (token genuinely expired, user must reconnect)`);
        skipped++;
      }

      console.log('');
    }

    // Also clean up any stuck token_refresh_queue entries for these platforms
    const { data: stuckJobs, error: queueError } = await supabase
      .from('token_refresh_queue')
      .select('id, connection_id, status')
      .in('status', ['pending', 'processing']);

    if (!queueError && stuckJobs && stuckJobs.length > 0) {
      // Get connection IDs for meta platforms
      const metaConnectionIds = connections.map(c => c.id);
      const stuckMetaJobs = stuckJobs.filter(j => metaConnectionIds.includes(j.connection_id));

      if (stuckMetaJobs.length > 0) {
        const { error: cleanupError } = await supabase
          .from('token_refresh_queue')
          .update({
            status: 'completed',
            processed_at: new Date().toISOString()
          })
          .in('id', stuckMetaJobs.map(j => j.id));

        if (!cleanupError) {
          console.log(`Cleaned up ${stuckMetaJobs.length} stuck refresh queue job(s) for Meta platforms.`);
        }
      }
    }

    console.log(`\nDone. Restored: ${restored}, Skipped: ${skipped}`);

  } catch (error) {
    console.error('Script error:', error);
  }
}

restoreExpiredMetaConnections();
