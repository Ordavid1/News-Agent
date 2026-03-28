#!/usr/bin/env node

/**
 * Test Script: Video Generation Pipeline
 * Usage:
 *   node test-video-pipeline.js              # Both Veo and Runway
 *   node test-video-pipeline.js --veo        # Veo only
 *   node test-video-pipeline.js --runway     # Runway only
 */

import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { extract } from '@extractus/article-extractor';
import { fileURLToPath } from 'url';

const { default: VideoPromptEngine } = await import('./services/VideoPromptEngine.js');
const { getVideoPromptSystemPrompt, getVideoPromptUserPrompt } = await import('./public/components/videoPrompts.mjs');

const GOOGLE_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY;
const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

const ARTICLE_URL = 'https://www.sportingnews.com/us/ncaa-basketball/news/espns-suffers-disastrous-mistake-ncaa-womens-basketball-bracket-likely-due-ai/706df43117cf27f8353692b4';
const ARTICLE_TITLE = "ESPN's suffers disastrous mistake with NCAA women's basketball bracket likely due to AI";
const ARTICLE_SOURCE = 'Sporting News';

const args = process.argv.slice(2);
const runVeo = args.includes('--veo') || (!args.includes('--runway'));
const runRunway = args.includes('--runway') || (!args.includes('--veo'));
const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-videos');

function log(phase, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${phase}] ${msg}`); }
function separator(title) { console.log(`\n${'═'.repeat(70)}\n  ${title}\n${'═'.repeat(70)}\n`); }

async function extractArticle(url) {
  log('EXTRACT', `Fetching: ${url}`);
  const data = await extract(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 15000
  });
  if (!data?.content) throw new Error('No content extracted');
  let text = data.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  if (text.length > 3000) { const t = text.slice(0, 3000); const lp = t.lastIndexOf('.'); text = lp > 2000 ? t.slice(0, lp + 1) : t; }
  log('EXTRACT', `${text.length} chars, image: ${data.image || 'none'}`);
  return { text, imageUrl: data.image || null, summary: data.description || '' };
}

async function describeImage(imageUrl) {
  if (!imageUrl) return null;
  try {
    log('VISION', `Describing: ${imageUrl}`);
    const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5 });
    const ct = imgRes.headers['content-type'] || '';
    let mime = 'image/jpeg';
    if (ct.includes('png')) mime = 'image/png'; else if (ct.includes('webp')) mime = 'image/webp';
    const base64 = Buffer.from(imgRes.data).toString('base64');
    const res = await axios.post(GEMINI_ENDPOINT, {
      contents: [{ parts: [{ inlineData: { mimeType: mime, data: base64 } }, { text: 'Describe this image in 1-2 concise sentences. Focus on: who or what is visible, their attire and appearance, the setting or background, and any visible logos or text. Be factual and specific.' }] }]
    }, { headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 });
    const desc = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    log('VISION', desc); return desc;
  } catch (e) { log('VISION', `Failed: ${e.message}`); return null; }
}

async function generateStoryline(title, content, fallback) {
  const src = content || fallback || '';
  if (src.length < 50) return fallback;
  log('STORYLINE', `Generating from ${src.length} chars...`);
  const res = await axios.post(GEMINI_ENDPOINT, {
    contents: [{ parts: [{ text: `You are an editorial director preparing a video production brief. Read this article and produce a STORYLINE SUMMARY (500-800 characters) that a cinematic video director will use to create a compelling news video.\n\nARTICLE TITLE: ${title}\n\nARTICLE TEXT:\n${src.slice(0, 2500)}\n\nYOUR STORYLINE MUST CAPTURE:\n1. NARRATIVE ARC: What happened, who is involved, what's at stake\n2. TONE & MOOD: urgent/hopeful/somber/exciting\n3. KEY PLAYERS & SETTING: Who and where\n4. CAUSE & CONSEQUENCE: What caused it, what changed\n5. VISUAL ANCHORS: Specific settings, people, objects for visual representation\n6. WHY IT MATTERS: Broader significance, FOMO factor\n\nOUTPUT: Single flowing paragraph, 500-800 characters. No labels, no bullets.` }] }]
  }, { headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
  const sl = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  log('STORYLINE', `${sl?.length} chars: ${sl}`); return sl || fallback;
}

async function generateVideoPrompt(article, caption, model, metadata, imgDesc) {
  const charLimit = model === 'runway' ? 950 : 1400;
  log('PROMPT', `Generating for ${model} (${metadata.category}, limit: ${charLimit})...`);
  const sys = getVideoPromptSystemPrompt({}, model, metadata);
  const usr = getVideoPromptUserPrompt(article, caption, model, metadata, imgDesc);
  const res = await axios.post(GEMINI_ENDPOINT, {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: [{ text: usr }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.9 }
  }, { headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 });
  let vp = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!vp) throw new Error('Empty video prompt');
  vp = vp.replace(/^(here['']?s?\s+(the\s+)?video\s+prompt[:\s]*)/i, '').replace(/^(video\s+prompt[:\s]*)/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (vp.length > charLimit) {
    log('PROMPT', `Truncating: ${vp.length} → ${charLimit}`);
    const t = vp.slice(0, charLimit); const lp = t.lastIndexOf('.');
    vp = lp > charLimit * 0.7 ? t.slice(0, lp + 1) : t.slice(0, charLimit - 3) + '...';
  }
  log('PROMPT', `${vp.length} chars:\n${vp}`); return vp;
}

async function generateVideoVeo(imageUrl, prompt) {
  log('VEO', 'Submitting...');
  const instance = { prompt };
  if (imageUrl) {
    const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'NewsAgentSaaS/1.0' } });
    const ct = imgRes.headers['content-type'] || ''; let mime = 'image/jpeg';
    if (ct.includes('png')) mime = 'image/png'; else if (ct.includes('webp')) mime = 'image/webp';
    if (imgRes.data.byteLength > 1024 * 1024) { log('VEO', `Image ${(imgRes.data.byteLength / 1048576).toFixed(1)}MB — text-only mode`); }
    else { instance.referenceImages = [{ image: { bytesBase64Encoded: Buffer.from(imgRes.data).toString('base64'), mimeType: mime }, referenceType: 'asset' }]; }
  }
  const sub = await axios.post('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning', {
    instances: [instance], parameters: { aspectRatio: '9:16', resolution: '1080p', durationSeconds: 8 }
  }, { headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' }, timeout: 180000 });
  const opName = sub.data.name; log('VEO', `Operation: ${opName}`);
  const deadline = Date.now() + 600000; let attempt = 0;
  while (Date.now() < deadline) {
    attempt++; await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(`https://generativelanguage.googleapis.com/v1beta/${opName}`, { headers: { 'x-goog-api-key': GOOGLE_API_KEY }, timeout: 15000 });
    if (poll.data.done) {
      if (poll.data.error) throw new Error(`Veo failed: ${poll.data.error.message || JSON.stringify(poll.data.error)}`);
      const uri = poll.data?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || poll.data?.response?.predictions?.[0]?.videoUri;
      if (!uri) { log('VEO', JSON.stringify(poll.data, null, 2)); throw new Error('No video URI'); }
      log('VEO', `Done after ${attempt} polls. Downloading...`);
      const vid = await axios.get(uri, { responseType: 'arraybuffer', timeout: 120000, headers: { 'x-goog-api-key': GOOGLE_API_KEY } });
      const buf = Buffer.from(vid.data); log('VEO', `${(buf.length / 1048576).toFixed(1)} MB`);
      return { buffer: buf, duration: 8 };
    }
    if (attempt % 6 === 0) log('VEO', `Processing... (poll #${attempt})`);
  }
  throw new Error('Veo timed out');
}

async function generateVideoRunway(imageUrl, prompt) {
  log('RUNWAY', 'Submitting...');
  const RunwayML = (await import('@runwayml/sdk')).default;
  const client = new RunwayML({ apiKey: RUNWAY_API_KEY });
  const params = { model: 'gen4.5', promptText: prompt, ratio: '720:1280', duration: 10 };
  if (imageUrl) { params.promptImage = imageUrl; log('RUNWAY', 'Image-to-video mode'); }
  const task = await client.imageToVideo.create(params); log('RUNWAY', `Task: ${task.id}`);
  const deadline = Date.now() + 600000; let attempt = 0;
  while (Date.now() < deadline) {
    attempt++; await new Promise(r => setTimeout(r, 5000));
    const s = await client.tasks.retrieve(task.id);
    if (s.status === 'SUCCEEDED') {
      const url = s.output?.[0]; if (!url) throw new Error('No URL');
      log('RUNWAY', `Done after ${attempt} polls: ${url}`);
      const vid = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
      const buf = Buffer.from(vid.data); log('RUNWAY', `${(buf.length / 1048576).toFixed(1)} MB`);
      return { buffer: buf, duration: 10, url };
    }
    if (s.status === 'FAILED') throw new Error(`Failed: ${s.failure}`);
    if (attempt % 6 === 0) log('RUNWAY', `${s.status} (poll #${attempt})`);
  }
  throw new Error('Runway timed out');
}

async function main() {
  separator('VIDEO PIPELINE TEST');
  log('INIT', `Models: ${[runVeo && 'Veo', runRunway && 'Runway'].filter(Boolean).join(', ')}`);
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  separator('PHASE 1: ARTICLE EXTRACTION');
  const { text, imageUrl, summary } = await extractArticle(ARTICLE_URL);

  separator('PHASE 2: IMAGE + STORYLINE');
  const [imgDesc, storyline] = await Promise.all([describeImage(imageUrl), generateStoryline(ARTICLE_TITLE, text, summary)]);

  separator('PHASE 3: CLASSIFICATION');
  const article = { title: ARTICLE_TITLE, summary, description: storyline, source: ARTICLE_SOURCE };
  const meta = VideoPromptEngine.getSceneMetadata({ article });
  log('CLASSIFY', `Primary: ${meta.category}, Secondary: ${meta.secondaryCategory || 'none'}, Mood: ${meta.mood}`);

  const caption = `ESPN's AI-generated bracket for the NCAA women's basketball tournament contained embarrassing errors. #NCAA #ESPN #WomensBasketball #MarchMadness`;
  const results = {};

  if (runVeo) { separator('PHASE 4: PROMPT (VEO)'); results.veo = { prompt: await generateVideoPrompt(article, caption, 'veo', meta, imgDesc) }; }
  if (runRunway) { separator('PHASE 4: PROMPT (RUNWAY)'); results.runway = { prompt: await generateVideoPrompt(article, caption, 'runway', meta, imgDesc) }; }

  separator('PHASE 5: VIDEO GENERATION');
  const tasks = [];
  if (runVeo) tasks.push(generateVideoVeo(imageUrl, results.veo.prompt).then(r => {
    const f = path.join(OUTPUT_DIR, `veo_${Date.now()}.mp4`); fs.writeFileSync(f, r.buffer);
    results.veo.file = f; results.veo.size = `${(r.buffer.length / 1048576).toFixed(1)} MB`;
    log('VEO', `Saved: ${f}`);
  }).catch(e => { results.veo.error = e.message; log('VEO', `FAILED: ${e.message}`); }));
  if (runRunway) tasks.push(generateVideoRunway(imageUrl, results.runway.prompt).then(r => {
    const f = path.join(OUTPUT_DIR, `runway_${Date.now()}.mp4`); fs.writeFileSync(f, r.buffer);
    results.runway.file = f; results.runway.size = `${(r.buffer.length / 1048576).toFixed(1)} MB`; results.runway.url = r.url;
    log('RUNWAY', `Saved: ${f}`);
  }).catch(e => { results.runway.error = e.message; log('RUNWAY', `FAILED: ${e.message}`); }));
  await Promise.all(tasks);

  separator('RESULTS');
  console.log(`Classification: ${meta.category} (secondary: ${meta.secondaryCategory || 'none'}), mood: ${meta.mood}`);
  for (const [m, d] of Object.entries(results)) {
    console.log(`\n--- ${m.toUpperCase()} ---`);
    console.log(`Prompt (${d.prompt?.length} chars): ${d.prompt?.slice(0, 200)}...`);
    if (d.error) console.log(`ERROR: ${d.error}`);
    else { console.log(`File: ${d.file} (${d.size})`); if (d.url) console.log(`URL: ${d.url}`); }
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, `report_${Date.now()}.json`), JSON.stringify({ timestamp: new Date().toISOString(), article: { title: ARTICLE_TITLE, url: ARTICLE_URL }, classification: meta, results }, null, 2));
}

main().catch(e => { console.error(`FATAL: ${e.message}`); if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2)); process.exit(1); });
