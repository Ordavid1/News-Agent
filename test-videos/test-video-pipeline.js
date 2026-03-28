#!/usr/bin/env node

/**
 * Test Script: Video Generation Pipeline
 *
 * Tests the full pipeline for a given article:
 *   Article URL → Extract content → Storyline → Scene classification →
 *   Image description → Video prompt → Video generation (Veo + Runway)
 *
 * Usage:
 *   node test-video-pipeline.js              # Run both Veo and Runway
 *   node test-video-pipeline.js --veo        # Veo only
 *   node test-video-pipeline.js --runway     # Runway only
 */

import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { extract } from '@extractus/article-extractor';
import { fileURLToPath } from 'url';

// Dynamic imports for project modules (ESM)
const { default: VideoPromptEngine } = await import('../services/VideoPromptEngine.js');

// videoPrompts.mjs uses browser-style exports — import the functions
const {
  getVideoPromptSystemPrompt,
  getVideoPromptUserPrompt
} = await import('../public/components/videoPrompts.mjs');

// ─── Config ────────────────────────────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY;
const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

const ARTICLE_URL = 'https://www.sportingnews.com/us/ncaa-basketball/news/espns-suffers-disastrous-mistake-ncaa-womens-basketball-bracket-likely-due-ai/706df43117cf27f8353692b4';
const ARTICLE_TITLE = "ESPN's suffers disastrous mistake with NCAA women's basketball bracket likely due to AI";
const ARTICLE_SOURCE = 'Sporting News';

// Parse CLI flags
const args = process.argv.slice(2);
const runVeo = args.includes('--veo') || (!args.includes('--runway'));
const runRunway = args.includes('--runway') || (!args.includes('--veo'));

const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-videos');

// ─── Utilities ─────────────────────────────────────────────────
function log(phase, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

function separator(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(70)}\n`);
}

// ─── Phase 1: Extract Article Content ──────────────────────────
async function extractArticle(url) {
  log('EXTRACT', `Fetching article from: ${url}`);

  const articleData = await extract(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 15000
  });

  if (!articleData?.content) {
    throw new Error('Article extractor returned no content');
  }

  let text = articleData.content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > 3000) {
    const truncated = text.slice(0, 3000);
    const lastPeriod = truncated.lastIndexOf('.');
    text = lastPeriod > 2000 ? truncated.slice(0, lastPeriod + 1) : truncated;
  }

  // Also grab the featured image
  const imageUrl = articleData.image || null;

  log('EXTRACT', `Content: ${text.length} chars`);
  log('EXTRACT', `Image: ${imageUrl || '(none)'}`);
  log('EXTRACT', `Preview: ${text.slice(0, 200)}...`);

  return { text, imageUrl, summary: articleData.description || '' };
}

// ─── Phase 2: Describe Image (Vision) ─────────────────────────
async function describeImage(imageUrl) {
  if (!imageUrl) { log('VISION', 'Skipped — no image URL'); return null; }

  try {
    log('VISION', `Describing image: ${imageUrl}`);
    log('VISION', 'Downloading image...');

    const imgResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer', timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      maxRedirects: 5
    });
    log('VISION', `Image downloaded: ${(imgResponse.data.byteLength / 1024).toFixed(0)} KB`);

  const contentType = imgResponse.headers['content-type'] || '';
  let mimeType = 'image/jpeg';
  if (contentType.includes('png')) mimeType = 'image/png';
  else if (contentType.includes('webp')) mimeType = 'image/webp';

  const base64 = Buffer.from(imgResponse.data).toString('base64');

  const response = await axios.post(GEMINI_ENDPOINT, {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: 'Describe this image in 1-2 concise sentences. Focus on: who or what is visible, their attire and appearance, the setting or background, and any visible logos or text. Be factual and specific — describe what you see, not what you interpret.' }
      ]
    }]
  }, {
    headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' },
    timeout: 30000
  });

  const desc = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  log('VISION', `Description: ${desc}`);
  return desc;
  } catch (err) {
    log('VISION', `Failed (non-blocking): ${err.message}`);
    return null;
  }
}

// ─── Phase 3: Generate Storyline ───────────────────────────────
async function generateStoryline(title, fullContent, fallbackSummary) {
  const sourceText = fullContent || fallbackSummary || '';
  if (!sourceText || sourceText.length < 50) {
    log('STORYLINE', 'Skipped — insufficient source text');
    return fallbackSummary;
  }

  log('STORYLINE', `Generating from ${sourceText.length} chars of content...`);

  const prompt = `You are an editorial director preparing a video production brief. Read this article and produce a STORYLINE SUMMARY (500-800 characters) that a cinematic video director will use to create a compelling news video.

ARTICLE TITLE: ${title}

ARTICLE TEXT:
${sourceText.slice(0, 2500)}

YOUR STORYLINE MUST CAPTURE:
1. NARRATIVE ARC: What happened, who is involved, what's at stake, and what's the outcome or tension
2. TONE & MOOD: Is this urgent/breaking? Hopeful/inspiring? Somber/tragic? Exciting/revolutionary? Convey the emotional register
3. KEY PLAYERS & SETTING: Who are the central figures? Describe the physical setting where this story takes place — the specific venue, location, or environment
4. CAUSE & CONSEQUENCE: What caused this event and what are its consequences? What changed or is at stake?
5. VISUAL ANCHORS: Mention specific settings, people, objects, or scenes described in the article that could be visually represented
6. WHY IT MATTERS: The broader significance — what makes this story compelling, what creates FOMO for viewers who might scroll past

OUTPUT: Write a single flowing paragraph, 500-800 characters. No labels, no bullet points. Write it as a narrative brief — vivid, specific, emotionally resonant. Start with the story's hook, build through the key details, and end with the stakes or significance.`;

  const response = await axios.post(GEMINI_ENDPOINT, {
    contents: [{ parts: [{ text: prompt }] }]
  }, {
    headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' },
    timeout: 20000
  });

  const storyline = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  log('STORYLINE', `Generated: ${storyline?.length} chars`);
  log('STORYLINE', storyline);
  return storyline || fallbackSummary;
}

// ─── Phase 4: Scene Classification ────────────────────────────
function classifyScene(article) {
  const metadata = VideoPromptEngine.getSceneMetadata({ article });
  log('CLASSIFY', `Primary: ${metadata.category}, Secondary: ${metadata.secondaryCategory || 'none'}, Mood: ${metadata.mood}`);
  return metadata;
}

// ─── Phase 5: Generate Video Prompt ────────────────────────────
async function generateVideoPrompt(article, caption, model, sceneMetadata, imageDescription) {
  const charLimit = model === 'runway' ? 950 : 1400;

  log('PROMPT', `Generating cinematic directive for ${model} (category: ${sceneMetadata.category}, limit: ${charLimit} chars)...`);

  const systemPrompt = getVideoPromptSystemPrompt({}, model, sceneMetadata);
  const userPrompt = getVideoPromptUserPrompt(article, caption, model, sceneMetadata, imageDescription);

  const response = await axios.post(GEMINI_ENDPOINT, {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.9 }
  }, {
    headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' },
    timeout: 30000
  });

  let videoPrompt = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!videoPrompt) throw new Error('Gemini returned empty video prompt');

  // Strip meta-framing
  videoPrompt = videoPrompt
    .replace(/^(here['']?s?\s+(the\s+)?video\s+prompt[:\s]*)/i, '')
    .replace(/^(video\s+prompt[:\s]*)/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  // Enforce char limit
  if (videoPrompt.length > charLimit) {
    log('PROMPT', `Truncating: ${videoPrompt.length} → ${charLimit} chars`);
    const truncated = videoPrompt.slice(0, charLimit);
    const lastPeriod = truncated.lastIndexOf('.');
    videoPrompt = lastPeriod > charLimit * 0.7
      ? truncated.slice(0, lastPeriod + 1)
      : truncated.slice(0, charLimit - 3) + '...';
  }

  log('PROMPT', `Generated ${model} prompt: ${videoPrompt.length} chars`);
  log('PROMPT', videoPrompt);
  return videoPrompt;
}

// ─── Phase 6: Generate Video (Veo) ────────────────────────────
async function generateVideoVeo(imageUrl, prompt) {
  log('VEO', 'Submitting video generation request...');

  const instance = { prompt };

  if (imageUrl) {
    log('VEO', 'Downloading source image...');
    const imgRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer', timeout: 30000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });
    const ct = imgRes.headers['content-type'] || '';
    let mimeType = 'image/jpeg';
    if (ct.includes('png')) mimeType = 'image/png';
    else if (ct.includes('webp')) mimeType = 'image/webp';

    const rawSize = imgRes.data.byteLength;
    log('VEO', `Image downloaded: ${(rawSize / 1024).toFixed(0)} KB (${mimeType})`);

    // If image is over 1MB, skip it — Veo API upload will be too slow and the prompt should
    // carry enough context. This mirrors the production text-only fallback.
    if (rawSize > 1024 * 1024) {
      log('VEO', `Image too large (${(rawSize / (1024 * 1024)).toFixed(1)} MB) — using text-only mode for faster submission`);
    } else {
      instance.referenceImages = [{
        image: { bytesBase64Encoded: Buffer.from(imgRes.data).toString('base64'), mimeType },
        referenceType: 'asset'
      }];
    }
  }

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning';
  const submitRes = await axios.post(endpoint, {
    instances: [instance],
    parameters: { aspectRatio: '9:16', resolution: '1080p', durationSeconds: 8 }
  }, {
    headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' },
    timeout: 180000  // 3 min — large base64 payloads need time
  });

  const opName = submitRes.data.name;
  log('VEO', `Operation started: ${opName}`);

  // Poll
  const deadline = Date.now() + 600000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    await new Promise(r => setTimeout(r, 5000));

    const pollRes = await axios.get(`https://generativelanguage.googleapis.com/v1beta/${opName}`, {
      headers: { 'x-goog-api-key': GOOGLE_API_KEY },
      timeout: 15000
    });

    const op = pollRes.data;
    if (op.done) {
      if (op.error) throw new Error(`Veo failed: ${op.error.message || JSON.stringify(op.error)}`);

      const videoUri = op?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
        || op?.response?.predictions?.[0]?.videoUri
        || op?.response?.generatedSamples?.[0]?.video?.uri;

      if (!videoUri) {
        log('VEO', `Full response: ${JSON.stringify(op, null, 2)}`);
        throw new Error('No video URI in Veo response');
      }

      log('VEO', `Completed after ${attempt} polls. Downloading...`);

      const videoRes = await axios.get(videoUri, {
        responseType: 'arraybuffer', timeout: 120000,
        headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'User-Agent': 'NewsAgentSaaS/1.0' }
      });

      const buffer = Buffer.from(videoRes.data);
      log('VEO', `Downloaded: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB`);
      return { buffer, duration: 8 };
    }

    if (attempt % 6 === 0) log('VEO', `Still processing... (poll #${attempt})`);
  }

  throw new Error('Veo timed out after 10 minutes');
}

// ─── Phase 6b: Generate Video (Runway) ────────────────────────
async function generateVideoRunway(imageUrl, prompt) {
  log('RUNWAY', 'Submitting video generation request...');

  const RunwayML = (await import('@runwayml/sdk')).default;
  const client = new RunwayML({ apiKey: RUNWAY_API_KEY });

  const taskParams = {
    model: 'gen4.5',
    promptText: prompt,
    ratio: '720:1280',
    duration: 10
  };

  if (imageUrl) {
    taskParams.promptImage = imageUrl;
    log('RUNWAY', 'Using image-to-video mode');
  }

  const task = await client.imageToVideo.create(taskParams);
  log('RUNWAY', `Task created: ${task.id}`);

  // Poll
  const deadline = Date.now() + 600000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    await new Promise(r => setTimeout(r, 5000));

    const status = await client.tasks.retrieve(task.id);

    if (status.status === 'SUCCEEDED') {
      const videoUrl = status.output?.[0];
      if (!videoUrl) throw new Error('Runway succeeded but no URL in output');

      log('RUNWAY', `Completed after ${attempt} polls. Downloading from: ${videoUrl}`);

      const videoRes = await axios.get(videoUrl, {
        responseType: 'arraybuffer', timeout: 120000
      });

      const buffer = Buffer.from(videoRes.data);
      log('RUNWAY', `Downloaded: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB`);
      return { buffer, duration: 10, url: videoUrl };
    }

    if (status.status === 'FAILED') {
      throw new Error(`Runway failed: ${status.failure || 'Unknown'}`);
    }

    if (attempt % 6 === 0) log('RUNWAY', `Status: ${status.status} (poll #${attempt})`);
  }

  throw new Error('Runway timed out after 10 minutes');
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  separator('VIDEO PIPELINE TEST');
  log('INIT', `Article: ${ARTICLE_TITLE}`);
  log('INIT', `Models to test: ${[runVeo && 'Veo 3.1', runRunway && 'Runway 4.5'].filter(Boolean).join(', ')}`);

  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');
  if (runRunway && !RUNWAY_API_KEY) throw new Error('RUNWAY_API_KEY not set');

  // Ensure output directory
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── Phase 1: Extract article ──
  separator('PHASE 1: ARTICLE EXTRACTION');
  const { text: articleContent, imageUrl, summary } = await extractArticle(ARTICLE_URL);

  // ── Phase 2: Parallel — image description + storyline ──
  separator('PHASE 2: IMAGE DESCRIPTION + STORYLINE');
  const [imageDescription, storyline] = await Promise.all([
    describeImage(imageUrl),
    generateStoryline(ARTICLE_TITLE, articleContent, summary)
  ]);

  // ── Phase 3: Scene classification ──
  separator('PHASE 3: SCENE CLASSIFICATION');
  const article = {
    title: ARTICLE_TITLE,
    summary: summary,
    description: storyline,
    source: ARTICLE_SOURCE
  };
  const sceneMetadata = classifyScene(article);

  // Mock caption (would normally come from caption generation)
  const caption = `ESPN's AI-generated bracket for the NCAA women's basketball tournament contained embarrassing errors. Here's what happened and why it matters. #NCAA #ESPN #WomensBasketball #MarchMadness`;

  // ── Phase 4+5: Generate video prompts ──
  const results = {};

  if (runVeo) {
    separator('PHASE 4: VIDEO PROMPT (VEO)');
    const veoPrompt = await generateVideoPrompt(article, caption, 'veo', sceneMetadata, imageDescription);
    results.veo = { prompt: veoPrompt };
  }

  if (runRunway) {
    separator('PHASE 4: VIDEO PROMPT (RUNWAY)');
    const runwayPrompt = await generateVideoPrompt(article, caption, 'runway', sceneMetadata, imageDescription);
    results.runway = { prompt: runwayPrompt };
  }

  // ── Phase 6: Generate videos (in parallel if both) ──
  separator('PHASE 5: VIDEO GENERATION');

  const videoTasks = [];

  if (runVeo) {
    videoTasks.push(
      generateVideoVeo(imageUrl, results.veo.prompt)
        .then(r => {
          const filePath = path.join(OUTPUT_DIR, `veo_${Date.now()}.mp4`);
          fs.writeFileSync(filePath, r.buffer);
          results.veo.file = filePath;
          results.veo.size = (r.buffer.length / (1024 * 1024)).toFixed(1);
          results.veo.duration = r.duration;
          log('VEO', `Saved: ${filePath} (${results.veo.size} MB)`);
        })
        .catch(err => {
          results.veo.error = err.message;
          log('VEO', `FAILED: ${err.message}`);
        })
    );
  }

  if (runRunway) {
    videoTasks.push(
      generateVideoRunway(imageUrl, results.runway.prompt)
        .then(r => {
          const filePath = path.join(OUTPUT_DIR, `runway_${Date.now()}.mp4`);
          fs.writeFileSync(filePath, r.buffer);
          results.runway.file = filePath;
          results.runway.size = (r.buffer.length / (1024 * 1024)).toFixed(1);
          results.runway.duration = r.duration;
          results.runway.url = r.url;
          log('RUNWAY', `Saved: ${filePath} (${results.runway.size} MB)`);
        })
        .catch(err => {
          results.runway.error = err.message;
          log('RUNWAY', `FAILED: ${err.message}`);
        })
    );
  }

  await Promise.all(videoTasks);

  // ── Summary ──
  separator('RESULTS SUMMARY');

  console.log(`Article:        ${ARTICLE_TITLE}`);
  console.log(`Classification: ${sceneMetadata.category}${sceneMetadata.secondaryCategory ? ` (secondary: ${sceneMetadata.secondaryCategory})` : ''}`);
  console.log(`Mood:           ${sceneMetadata.mood}`);
  console.log(`Storyline:      ${storyline?.slice(0, 120)}...`);
  console.log(`Image desc:     ${imageDescription?.slice(0, 120)}...`);
  console.log('');

  for (const [model, data] of Object.entries(results)) {
    console.log(`─── ${model.toUpperCase()} ───`);
    console.log(`  Prompt (${data.prompt?.length} chars): ${data.prompt?.slice(0, 150)}...`);
    if (data.error) {
      console.log(`  ERROR: ${data.error}`);
    } else {
      console.log(`  File:     ${data.file}`);
      console.log(`  Size:     ${data.size} MB`);
      console.log(`  Duration: ${data.duration}s`);
      if (data.url) console.log(`  URL:      ${data.url}`);
    }
    console.log('');
  }

  // Save full test report as JSON
  const reportPath = path.join(OUTPUT_DIR, `report_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    article: { title: ARTICLE_TITLE, url: ARTICLE_URL, source: ARTICLE_SOURCE },
    extraction: { contentLength: articleContent.length, imageUrl, summary },
    storyline,
    imageDescription,
    classification: { primary: sceneMetadata.category, secondary: sceneMetadata.secondaryCategory, mood: sceneMetadata.mood },
    results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ...v, prompt: v.prompt }]))
  }, null, 2));
  log('REPORT', `Saved: ${reportPath}`);

  // Print download instructions
  if (results.runway?.url) {
    console.log(`\n📥 Runway video download: ${results.runway.url}`);
  }
  for (const [model, data] of Object.entries(results)) {
    if (data.file) {
      console.log(`📥 ${model.toUpperCase()} local file: ${data.file}`);
    }
  }
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  if (err.response?.data) {
    console.error('API Response:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
