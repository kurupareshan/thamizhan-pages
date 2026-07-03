#!/usr/bin/env node
/**
 * Fetch daily rasi palan (horoscope) for all 12 signs from the Prokerala API
 * and write rasi_palan.json at the repository root.
 *
 * Required env:
 *   PROKERALA_CLIENT_ID
 *   PROKERALA_CLIENT_SECRET
 * Optional env:
 *   RASI_PALAN_LANG  (default: "ta" — Tamil; falls back to English if the
 *                     endpoint rejects the language parameter)
 *   FORCE            (set to "1" to refetch even if today's file exists)
 *
 * Requires Node 18+ (global fetch).
 */

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.prokerala.com';
const OUT_FILE = new URL('../rasi_palan.json', import.meta.url);
const SIGNS = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];

const clientId = process.env.PROKERALA_CLIENT_ID;
const clientSecret = process.env.PROKERALA_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('PROKERALA_CLIENT_ID / PROKERALA_CLIENT_SECRET must be set');
  process.exit(1);
}

// Palan is published for the Indian calendar day.
const todayIST = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
}).format(new Date());
const datetime = `${todayIST}T00:00:00+05:30`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alreadyPublishedToday() {
  try {
    const existing = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    return existing.date === todayIST;
  } catch {
    return false;
  }
}

async function getToken() {
  const res = await fetch(`${API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Token request failed: HTTP ${res.status} — ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.access_token;
}

// Prokerala has used a few response shapes for this endpoint; handle them all.
function extractPrediction(body) {
  const d = body.data ?? body;
  const dp = d.daily_prediction ?? d.daily_predictions ?? d.prediction ?? null;
  if (typeof dp === 'string') return dp.trim();
  const item = Array.isArray(dp) ? dp[0] : dp;
  if (item && typeof item === 'object') {
    if (typeof item.prediction === 'string') return item.prediction.trim();
    if (Array.isArray(item.predictions)) {
      const parts = item.predictions.map((p) => p.prediction).filter(Boolean);
      if (parts.length) return parts.join('\n\n');
    }
  }
  return null;
}

async function fetchSign(token, sign, lang) {
  const url = new URL(`${API}/v2/horoscope/daily`);
  url.searchParams.set('sign', sign);
  url.searchParams.set('datetime', datetime);
  if (lang) url.searchParams.set('la', lang);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      console.warn(`${sign}: rate limited, waiting…`);
      await sleep(15000 * attempt);
      continue;
    }
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`${sign}: HTTP ${res.status} — ${JSON.stringify(body).slice(0, 300)}`);
    }
    const prediction = extractPrediction(body);
    if (!prediction) {
      throw new Error(`${sign}: no prediction found in response — ${JSON.stringify(body).slice(0, 300)}`);
    }
    return prediction;
  }
  throw new Error(`${sign}: still rate-limited after 3 attempts`);
}

async function main() {
  if (process.env.FORCE !== '1' && (await alreadyPublishedToday())) {
    console.log(`rasi_palan.json already has ${todayIST} — nothing to do.`);
    return;
  }

  const token = await getToken();
  let lang = process.env.RASI_PALAN_LANG ?? 'ta';
  const predictions = {};

  // Probe the first sign with the requested language; if the endpoint
  // rejects it, retry without and publish in English instead.
  try {
    predictions[SIGNS[0]] = await fetchSign(token, SIGNS[0], lang);
  } catch (err) {
    if (!lang) throw err;
    console.warn(`Language "${lang}" failed (${err.message}); retrying in English.`);
    lang = '';
    predictions[SIGNS[0]] = await fetchSign(token, SIGNS[0], lang);
  }

  for (const sign of SIGNS.slice(1)) {
    await sleep(1500); // stay well under per-minute rate limits
    predictions[sign] = await fetchSign(token, sign, lang);
    console.log(`${sign}: ok`);
  }

  const output = {
    date: todayIST,
    language: lang || 'en',
    generated_at: new Date().toISOString(),
    predictions,
  };
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote rasi_palan.json for ${todayIST} (${output.language})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
