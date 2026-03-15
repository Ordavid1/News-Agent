#!/usr/bin/env node
/**
 * One-time utility: Exchange an AE OAuth authorization code for an access token.
 *
 * Usage:
 *   ALIEXPRESS_DS_APP_KEY=xxx ALIEXPRESS_DS_APP_SECRET=yyy node scripts/ae-ds-token-exchange.mjs <code>
 *
 * Where <code> is the authorization code shown on the ds-token-callback page.
 */

import crypto from 'crypto';

const APP_KEY = process.env.ALIEXPRESS_DS_APP_KEY;
const APP_SECRET = process.env.ALIEXPRESS_DS_APP_SECRET;
const CODE = process.argv[2];

if (!APP_KEY || !APP_SECRET) {
  console.error('ERROR: Set ALIEXPRESS_DS_APP_KEY and ALIEXPRESS_DS_APP_SECRET env vars.');
  console.error('Example: ALIEXPRESS_DS_APP_KEY=529640 ALIEXPRESS_DS_APP_SECRET=xxx node scripts/ae-ds-token-exchange.mjs <code>');
  process.exit(1);
}

if (!CODE) {
  console.error('ERROR: Pass the authorization code as an argument.');
  console.error('Example: node scripts/ae-ds-token-exchange.mjs 3_529640_aBcDeFgHiJk...');
  process.exit(1);
}

function signRequest(params, secret, apiPath = '') {
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign').sort();
  const concatenated = sortedKeys.reduce((acc, key) => {
    return acc + key + (params[key] !== undefined && params[key] !== null ? String(params[key]) : '');
  }, '');
  // REST endpoints require the URL path prepended to the param string
  const signString = apiPath + concatenated;
  return crypto.createHmac('sha256', secret).update(signString, 'utf8').digest('hex').toUpperCase();
}

async function exchangeCode() {
  const params = {
    app_key: APP_KEY,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
    code: CODE
  };

  params.sign = signRequest(params, APP_SECRET, '/auth/token/create');

  const url = 'https://api-sg.aliexpress.com/rest/auth/token/create';
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  console.log('\nExchanging authorization code for access token...\n');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body
    });

    const data = await response.json();

    if (data.error_response) {
      console.error('ERROR from AE:', JSON.stringify(data.error_response, null, 2));
      process.exit(1);
    }

    console.log('=== TOKEN EXCHANGE SUCCESSFUL ===\n');
    console.log('Access Token:', data.access_token);
    console.log('Refresh Token:', data.refresh_token);
    console.log('Expires:', data.expire_time ? new Date(parseInt(data.expire_time)).toISOString() : 'unknown');
    console.log('Refresh Expires:', data.refresh_token_valid_time ? new Date(parseInt(data.refresh_token_valid_time)).toISOString() : 'unknown');
    console.log('Account:', data.user_nick || data.seller_id || 'N/A');
    console.log('\n=== ADD TO RENDER ENV VARS ===');
    console.log(`ALIEXPRESS_DS_ACCESS_TOKEN=${data.access_token}`);
    console.log('\nFull response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Network error:', err.message);
    process.exit(1);
  }
}

exchangeCode();
