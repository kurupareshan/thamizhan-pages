#!/usr/bin/env node
/**
 * Generate the daily rasi palan for all 12 rasis in Tamil using the
 * Gemini API, and write rasi_palan.json at the repository root.
 *
 * One Gemini call per day generates all 12 palans — free tier is more
 * than enough. (Replaces the earlier Prokerala fetcher: their daily
 * horoscope costs ~500 credits/sign in Tamil, ~6000/day, which exceeds
 * the free plan's 5000 credits/MONTH.)
 *
 * Required env:
 *   GEMINI_API_KEY
 * Optional env:
 *   GEMINI_MODEL  (default: "gemini-2.5-flash")
 *   FORCE         (set to "1" to regenerate even if today's file exists)
 *
 * Requires Node 18+ (global fetch).
 */

import { readFile, writeFile } from 'node:fs/promises';

const OUT_FILE = new URL('../rasi_palan.json', import.meta.url);
const SIGNS = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];
const TAMIL_NAMES = {
  aries: 'மேஷம்', taurus: 'ரிஷபம்', gemini: 'மிதுனம்', cancer: 'கடகம்',
  leo: 'சிம்மம்', virgo: 'கன்னி', libra: 'துலாம்', scorpio: 'விருச்சிகம்',
  sagittarius: 'தனுசு', capricorn: 'மகரம்', aquarius: 'கும்பம்', pisces: 'மீனம்',
};

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY must be set');
  process.exit(1);
}
const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

// Palan is published for the Indian calendar day.
const now = new Date();
const todayIST = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
}).format(now);
const weekdayTamil = new Intl.DateTimeFormat('ta-IN', {
  weekday: 'long',
  timeZone: 'Asia/Kolkata',
}).format(now);

async function alreadyPublishedToday() {
  try {
    const existing = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    return existing.date === todayIST;
  } catch {
    return false;
  }
}

function buildPrompt() {
  const signList = SIGNS.map((s) => `"${s}" (${TAMIL_NAMES[s]})`).join(', ');
  return `நீங்கள் ஒரு தமிழ் பஞ்சாங்க / ஜோதிட நிபுணர். ஒரு தமிழ் கலாச்சார செயலிக்காக இன்றைய ராசி பலன் எழுதுகிறீர்கள்.

இன்றைய தேதி: ${todayIST} (${weekdayTamil})

12 ராசிகளுக்கும் இன்றைய ராசி பலனை தூய, இயல்பான தமிழில் எழுதுங்கள். ஒவ்வொரு ராசிக்கும் 3–5 வாக்கியங்கள்: அன்றைய பொதுப் பலன், வேலை/தொழில், பணவரவு, குடும்பம், உடல்நலம் ஆகியவற்றைத் தொட்டு எழுதுங்கள்.

விதிமுறைகள்:
- பாரம்பரிய, நம்பிக்கையூட்டும் ராசி பலன் நடை; ஒவ்வொரு ராசிக்கும் வெவ்வேறு உள்ளடக்கம்.
- சில ராசிகளுக்கு நல்ல பலனும், சில ராசிகளுக்கு எச்சரிக்கையான (ஆனால் அச்சுறுத்தாத) பலனும் இருக்கட்டும்.
- உறுதியான வாக்குறுதிகள் வேண்டாம்; மருத்துவ அல்லது முதலீட்டு ஆலோசனை வேண்டாம்.
- ஆங்கில வார்த்தைகள் தவிர்க்கவும்.

Return ONLY a valid JSON object with exactly these 12 keys: ${signList}. Each value must be the Tamil palan text as a single string. No markdown, no extra keys, no commentary.`;
}

function extractText(body) {
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

function parsePredictions(text) {
  // Strip markdown fences if the model added them despite JSON mode.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  const predictions = {};
  for (const sign of SIGNS) {
    const val = obj[sign];
    if (typeof val !== 'string' || val.trim().length < 40) {
      throw new Error(`Missing or too-short prediction for "${sign}"`);
    }
    predictions[sign] = val.trim();
  }
  return predictions;
}

async function generate() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt() }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status} — ${JSON.stringify(body).slice(0, 400)}`);
  }
  const text = extractText(body);
  if (!text) {
    throw new Error(`Empty Gemini response — ${JSON.stringify(body).slice(0, 400)}`);
  }
  return parsePredictions(text);
}

async function main() {
  if (process.env.FORCE !== '1' && (await alreadyPublishedToday())) {
    console.log(`rasi_palan.json already has ${todayIST} — nothing to do.`);
    return;
  }

  let predictions;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      predictions = await generate();
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  if (!predictions) throw lastErr;

  const output = {
    date: todayIST,
    language: 'ta',
    generated_at: new Date().toISOString(),
    predictions,
  };
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote rasi_palan.json for ${todayIST} (${weekdayTamil}) — 12 rasis OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
