#!/usr/bin/env node
/**
 * One-time helper for the V4 Day 0 smoke tests.
 *
 * Uploads the local test assets in tests/assets/ to Supabase Storage under
 * a stable smoke-test path, prints their public URLs, and (if --write-env)
 * appends V4_SMOKE_PERSONA_URL + V4_SMOKE_SUBJECT_URL entries to .env so
 * the smoke test script picks them up automatically.
 *
 * Usage:
 *   node scripts/v4-upload-smoke-assets.mjs
 *     → uploads + prints URLs, no .env change
 *
 *   node scripts/v4-upload-smoke-assets.mjs --write-env
 *     → uploads + prints URLs + appends to .env (idempotent; removes old entries first)
 *
 * Requires: SUPABASE_URL + SUPABASE_SECRET_KEY in .env
 *
 * Files expected in tests/assets/:
 *   - 6365b083-e66f-4af9-90a7-67d485ac016a.jpg  (persona portrait)
 *   - apple-mbp-16-m3-pro-16-1-1000x1000.jpg     (subject)
 */

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

import { supabaseAdmin } from '../services/supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'tests', 'assets');
const ENV_PATH = path.join(REPO_ROOT, '.env');

// Stable storage paths (idempotent: overwriting on re-run is fine)
const BUCKET = 'media-assets';
const STORAGE_PREFIX = 'v4-smoke-tests';

const ASSETS = [
  {
    localName: '6365b083-e66f-4af9-90a7-67d485ac016a.jpg',
    storageKey: `${STORAGE_PREFIX}/persona.jpg`,
    envVar: 'V4_SMOKE_PERSONA_URL',
    description: 'persona portrait'
  },
  {
    localName: 'apple-mbp-16-m3-pro-16-1-1000x1000.jpg',
    storageKey: `${STORAGE_PREFIX}/subject.jpg`,
    envVar: 'V4_SMOKE_SUBJECT_URL',
    description: 'subject / product image'
  }
];

async function uploadOne(asset) {
  const localPath = path.join(ASSETS_DIR, asset.localName);
  let buffer;
  try {
    buffer = await fs.readFile(localPath);
  } catch (err) {
    throw new Error(`Failed to read ${asset.localName}: ${err.message}`);
  }

  console.log(`[${asset.description}] uploading ${asset.localName} (${(buffer.length / 1024).toFixed(0)}KB) → ${asset.storageKey}`);

  // Upsert so re-running the script replaces the previous version.
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(asset.storageKey, buffer, {
      contentType: 'image/jpeg',
      upsert: true
    });

  if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

  const { data: urlData } = supabaseAdmin.storage
    .from(BUCKET)
    .getPublicUrl(asset.storageKey);

  const publicUrl = urlData?.publicUrl;
  if (!publicUrl) throw new Error('Supabase did not return a public URL');

  console.log(`[${asset.description}] public URL: ${publicUrl}`);
  return { ...asset, publicUrl };
}

async function updateEnv(results) {
  let envContent = '';
  try {
    envContent = await fs.readFile(ENV_PATH, 'utf-8');
  } catch (err) {
    console.warn(`[env] .env not found at ${ENV_PATH} — skipping env update`);
    return;
  }

  // Strip any existing V4_SMOKE_* lines so re-runs don't accumulate stale entries
  const lines = envContent.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('V4_SMOKE_PERSONA_URL=')) return false;
    if (trimmed.startsWith('V4_SMOKE_SUBJECT_URL=')) return false;
    if (trimmed === '# V4 smoke test asset URLs (added by v4-upload-smoke-assets.mjs)') return false;
    return true;
  });

  // Append fresh entries at the end
  if (lines[lines.length - 1] !== '') lines.push('');
  lines.push('# V4 smoke test asset URLs (added by v4-upload-smoke-assets.mjs)');
  for (const result of results) {
    lines.push(`${result.envVar}=${result.publicUrl}`);
  }
  lines.push('');

  await fs.writeFile(ENV_PATH, lines.join('\n'), 'utf-8');
  console.log(`[env] wrote ${results.length} V4_SMOKE_* entries to .env`);
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error('❌ SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env');
    process.exit(1);
  }
  if (!supabaseAdmin) {
    console.error('❌ supabaseAdmin client not initialized — check your Supabase config');
    process.exit(1);
  }

  const writeEnv = process.argv.includes('--write-env');

  const results = [];
  for (const asset of ASSETS) {
    try {
      const result = await uploadOne(asset);
      results.push(result);
    } catch (err) {
      console.error(`❌ ${asset.description}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅ All assets uploaded successfully.\n');
  console.log('Public URLs:');
  for (const r of results) {
    console.log(`  ${r.envVar}=${r.publicUrl}`);
  }

  if (writeEnv) {
    await updateEnv(results);
  } else {
    console.log('\nℹ️  To auto-write these to .env, re-run with: --write-env');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
