#!/usr/bin/env node
/**
 * generate.js — Pre-generation pipeline for Good Job Disc Jockey
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node generate.js "quantum computing" "CRISPR" "neuroscience"
 *
 * Output:
 *   gdj-extension/videos/{paperId}.mp4   — Sora video with baked-in audio narration
 *   gdj-extension/videos/manifest.json   — metadata for the extension
 *
 * Pipeline:
 *   1. Fetch arXiv papers for all topics (parallel)
 *   2. Generate scripts with GPT-4o (parallel)
 *   3. Submit all Sora jobs simultaneously (fan-out)
 *   4. Poll all jobs concurrently until done
 *   5. Download completed videos
 *
 * No ffmpeg. No TTS. Sora handles video + audio together.
 * Requires: Node 18+, npm install openai fast-xml-parser
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = path.join(__dirname, 'gdj-extension', 'videos');
const MANIFEST_PATH = path.join(VIDEOS_DIR, 'manifest.json');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const xmlParser = new XMLParser({ ignoreAttributes: false });

// ─── arXiv ───────────────────────────────────────────────────────────────────

async function fetchPapers(topic, count = 3) {
  const query = encodeURIComponent(`all:${topic}`);
  const url = `https://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=${count}`;
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    res = await fetch(url, { headers: { 'User-Agent': 'GoodJobDiscJockey/1.0 (yhack; mailto:contact@example.com)' } });
    if (res.status !== 429) break;
    console.warn(`  [arXiv] 429 rate limit for "${topic}", retrying (${attempt + 1}/5)...`);
  }
  if (!res.ok) throw new Error(`arXiv fetch failed for "${topic}": ${res.status}`);
  const xml = await res.text();
  const parsed = xmlParser.parse(xml);

  const entries = parsed?.feed?.entry;
  if (!entries) return [];
  const list = Array.isArray(entries) ? entries : [entries];

  return list.map(e => {
    const rawId = (e.id || '').toString().trim();
    const paperId = rawId.split('/').pop().replace(/v\d+$/, '');
    return {
      paperId,
      topic,
      paperTitle:   (e.title || '').replace(/\s+/g, ' ').trim(),
      paperSummary: (e.summary || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }).filter(p => p.paperId && p.paperTitle);
}

// ─── Script generation ────────────────────────────────────────────────────────

// Generate a ~45-word script for a single 20s reel.
async function generateScript(paper) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: `You are a charismatic 24-year-old who explains science on Instagram. Write a spoken narration script for a 20-second Reel about this research paper (~45 words, spoken in about 20 seconds).

Rules:
- Start with "Did you know" — hook must name a SPECIFIC finding: a number, a mechanism, a named molecule, a measured quantity. Not a vague claim.
- End with a specific concrete implication or question grounded in the actual result.
- Sound like a real person talking. Contractions, casual language ("literally", "actually", "honestly"). Short punchy sentences.
- BANNED words: "revolutionize", "game-changer", "breakthrough", "could change everything", "pave the way", "researchers found", "scientists discovered", "has implications", "opens the door", "imagine the possibilities"
- The science must be concrete: real nouns, real verbs, real numbers.

Return only the script, no labels or other text.

Paper: ${paper.paperTitle}
Abstract: ${paper.paperSummary}`,
    }],
  });
  const script = res.choices[0].message.content.trim();
  return { script, full: script };
}

// ─── Sora prompt ─────────────────────────────────────────────────────────────

// Generate 3 specific visual insets for the script.
async function generateVisualInsets(paper, script) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `Given this research paper and script, describe exactly 3 small floating image panels that would illustrate the specific concepts being spoken about.

Each inset must be:
- A concrete, specific visual (a molecule diagram, a chart, a microscope image, a satellite photo, a graph, a real physical object, etc.)
- Something that actually exists and could appear in scientific literature
- Directly tied to what's being said in the script
- NO text, labels, numbers, equations, or written characters of any kind — pure imagery only

Format: Return exactly 3 lines starting with "Inset 1:", "Inset 2:", "Inset 3:". No other text.

Paper: ${paper.paperTitle}
Script: ${script}`,
    }],
  });
  return res.choices[0].message.content.trim();
}

function buildSoraPrompt(script, visualInsets) {
  return `A young, enthusiastic person in their mid-20s in a clean, softly lit minimal home studio speaks directly to camera. Natural hand gestures, expressive face, occasional eyebrow raise. Vertical 9:16 format. Casual but sharp. 20 seconds.

As they speak, small floating image panels appear in the frame beside them:
${visualInsets}

IMPORTANT: The floating panels must contain NO text, NO labels, NO numbers, NO equations, NO written characters of any kind — only pure imagery and shapes.

Dialogue: "${script}"

Audio: Single speaker. Warm, conversational, upbeat. Crisp audio, minimal room reverb.`;
}

// ─── Sora API ─────────────────────────────────────────────────────────────────

async function soraPost(path, body) {
  const res = await fetch(`https://api.openai.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sora POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function soraGet(path) {
  const res = await fetch(`https://api.openai.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sora GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function soraDownload(videoId, outputPath) {
  const res = await fetch(`https://api.openai.com/v1/videos/${videoId}/content`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
}

// Submit the base Sora job (Part 1). Returns job ID immediately.
async function submitSoraJob(soraPrompt) {
  const job = await soraPost('/v1/videos', {
    model: 'sora-2',
    prompt: soraPrompt,
    size: '720x1280',  // vertical 9:16 at 720p
    seconds: '20',
  });
  if (!job.id) throw new Error(`No job ID in Sora response: ${JSON.stringify(job)}`);
  return job.id;
}

// Poll a single job until it completes or fails. Returns the final job object.
async function pollUntilDone(videoId, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    await sleep(5000);
    const job = await soraGet(`/v1/videos/${videoId}`);
    const pct = job.progress ?? 0;
    process.stdout.write(`\r  [${label}] ${job.status} ${pct}%   `);
    if (job.status === 'completed') { process.stdout.write('\n'); return job; }
    if (job.status === 'failed')    throw new Error(`Sora job ${videoId} failed: ${JSON.stringify(job)}`);
  }
  throw new Error(`Sora job ${videoId} timed out after 12 minutes`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const topics = process.argv.slice(2);
  if (!topics.length) {
    console.error('Usage: OPENAI_API_KEY=sk-... node generate.js "topic1" "topic2" ...');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    process.exit(1);
  }

  mkdirSync(VIDEOS_DIR, { recursive: true });

  // Resume support: load existing manifest
  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : [];
  const doneIds = new Set(manifest.map(e => e.paperId));

  // ── Phase 1: Fetch papers (sequential to avoid arXiv rate limits) ────────
  console.log(`\nFetching papers for: ${topics.join(', ')}`);
  const papersByTopic = [];
  for (const t of topics) {
    papersByTopic.push(await fetchPapers(t, 3));
    if (topics.length > 1) await sleep(3000); // arXiv asks for 3s between requests
  }
  const allPapers = papersByTopic.flat().filter(p => !doneIds.has(p.paperId));

  // Deduplicate by paperId
  const seen = new Set();
  const pending = allPapers.filter(p => { if (seen.has(p.paperId)) return false; seen.add(p.paperId); return true; });

  console.log(`${pending.length} papers to generate (${doneIds.size} already done)\n`);
  if (!pending.length) { console.log('Nothing to do.'); return; }

  // ── Phase 2: Generate scripts (all papers in parallel) ───────────────────
  console.log('Generating scripts + visual insets...');
  const withScripts = await Promise.all(
    pending.map(async paper => {
      const script = await generateScript(paper);
      const insets = await generateVisualInsets(paper, script.script);
      console.log(`  ✓ ${paper.topic}: "${script.script.slice(0, 55)}..."`);
      return { ...paper, script, insets };
    })
  );

  // Save scripts immediately so generate-fallback.js can use them if Sora fails
  const scriptsPath = path.join(__dirname, 'scripts.json');
  const existingScripts = existsSync(scriptsPath)
    ? JSON.parse(readFileSync(scriptsPath, 'utf8'))
    : {};
  for (const e of withScripts) existingScripts[e.paperId] = e;
  writeFileSync(scriptsPath, JSON.stringify(existingScripts, null, 2));

  // ── Phase 3: Submit all Sora jobs simultaneously (fan-out) ───────────────
  console.log('\nSubmitting Sora jobs...');
  const jobs = await Promise.all(
    withScripts.map(async entry => {
      const prompt = buildSoraPrompt(entry.script.script, entry.insets);
      try {
        const jobId = await submitSoraJob(prompt);
        console.log(`  ✓ ${entry.topic} → job ${jobId}`);
        return { ...entry, jobId };
      } catch (err) {
        console.error(`  ✗ Submit failed for ${entry.paperId}: ${err.message}`);
        return { ...entry, jobId: null };
      }
    })
  );

  const submitted = jobs.filter(j => j.jobId);
  const submitFailed = jobs.filter(j => !j.jobId);
  if (submitFailed.length) {
    console.warn(`\n${submitFailed.length} jobs failed to submit. They will be skipped.`);
  }
  if (!submitted.length) { console.error('No jobs submitted successfully.'); process.exit(1); }

  // ── Phase 4: Poll all jobs concurrently ──────────────────────────────────
  console.log(`\nPolling ${submitted.length} jobs concurrently...\n`);
  const results = await Promise.allSettled(
    submitted.map(async entry => {
      try {
        await pollUntilDone(entry.jobId, entry.topic.slice(0, 16).padEnd(16));
        return { ...entry, completed: true };
      } catch (err) {
        console.error(`\n  ✗ ${entry.paperId}: ${err.message}`);
        return { ...entry, completed: false };
      }
    })
  );

  // ── Phase 5: Download videos ──────────────────────────────────────────────
  console.log('\nDownloading videos...');
  for (const result of results) {
    const entry = result.value;
    if (!entry?.completed) continue;

    const finalPath = path.join(VIDEOS_DIR, `${entry.paperId}.mp4`);

    try {
      await soraDownload(entry.jobId, finalPath);

      manifest.push({
        paperId:      entry.paperId,
        topic:        entry.topic,
        paperTitle:   entry.paperTitle,
        paperSummary: entry.paperSummary,
      });
      saveManifest(manifest);
      console.log(`  ✓ ${entry.paperTitle.slice(0, 60)}`);
    } catch (err) {
      console.error(`  ✗ Failed for ${entry.paperId}: ${err.message}`);
    }
  }

  const total = manifest.length;
  const newCount = total - doneIds.size;
  console.log(`\n✓ Done. ${newCount} new videos generated (${total} total in manifest).`);
  console.log(`  Reload the extension in chrome://extensions to pick up new videos.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
