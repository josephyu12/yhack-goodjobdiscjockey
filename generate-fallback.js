#!/usr/bin/env node
/**
 * generate-fallback.js — TTS + ffmpeg fallback for failed Sora jobs
 *
 * Run this AFTER generate.js if any videos are missing.
 * Reads scripts.json (written by generate.js), generates TTS audio +
 * animated text card, and outputs the same {paperId}.mp4 filenames.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node generate-fallback.js
 *
 * Requires: ffmpeg in PATH (brew install ffmpeg)
 */

import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = path.join(__dirname, 'gdj-extension', 'videos');
const SCRIPTS_PATH = path.join(__dirname, 'scripts.json');
const MANIFEST_PATH = path.join(VIDEOS_DIR, 'manifest.json');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateAudio(script, outputPath) {
  const res = await client.audio.speech.create({
    model: 'tts-1',
    input: script,
    voice: 'nova',
    response_format: 'mp3',
  });
  writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
}

function escapeDrawtext(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function splitLines(text, charsPerLine = 36) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > charsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

async function generateFallbackVideo(paperId, paper, scriptObj) {
  const fullScript = typeof scriptObj === 'string'
    ? scriptObj
    : (scriptObj.script ?? `${scriptObj.part1 ?? ''} ${scriptObj.part2 ?? ''}`).trim();

  const audioPath  = path.join(VIDEOS_DIR, `${paperId}-fb-audio.mp3`);
  const visualPath = path.join(VIDEOS_DIR, `${paperId}-fb-visual.mp4`);
  const finalPath  = path.join(VIDEOS_DIR, `${paperId}.mp4`);
  const script = fullScript;

  // TTS
  await generateAudio(script, audioPath);

  // Build drawtext filters for the script lines
  const scriptLines = splitLines(script);
  const scriptFilter = scriptLines.map((line, i) =>
    `drawtext=text='${escapeDrawtext(line)}':fontsize=38:fontcolor=white:x=(w-text_w)/2:y=${340 + i * 55}`
  ).join(',');

  // Title at top (smaller, grey)
  const titleLines = splitLines(paper.paperTitle.slice(0, 80), 28);
  const titleFilter = titleLines.map((line, i) =>
    `drawtext=text='${escapeDrawtext(line)}':fontsize=26:fontcolor=#999999:x=(w-text_w)/2:y=${100 + i * 38}`
  ).join(',');

  const vf = [titleFilter, scriptFilter].filter(Boolean).join(',');

  // Black background, 9:16, 20s
  execSync(
    `ffmpeg -y -f lavfi -i color=c=black:s=720x1280:r=30 -vf "${vf}" -t 20 -c:v libx264 -pix_fmt yuv420p "${visualPath}"`,
    { stdio: 'pipe' }
  );

  // Mux audio
  execSync(
    `ffmpeg -y -i "${visualPath}" -i "${audioPath}" -c:v copy -c:a aac -shortest "${finalPath}"`,
    { stdio: 'pipe' }
  );

  [audioPath, visualPath].forEach(f => { try { if (existsSync(f)) unlinkSync(f); } catch {} });
  console.log(`  ✓ Fallback: ${finalPath}`);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    process.exit(1);
  }
  if (!existsSync(SCRIPTS_PATH)) {
    console.error('scripts.json not found — run generate.js first so scripts are saved.');
    process.exit(1);
  }

  mkdirSync(VIDEOS_DIR, { recursive: true });

  const scripts = JSON.parse(readFileSync(SCRIPTS_PATH, 'utf8'));
  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : [];
  const doneIds = new Set(manifest.map(e => e.paperId));

  const missing = Object.entries(scripts).filter(([paperId]) => {
    const finalPath = path.join(VIDEOS_DIR, `${paperId}.mp4`);
    return !doneIds.has(paperId) && !existsSync(finalPath);
  });

  if (!missing.length) {
    console.log('No missing videos — all papers from scripts.json are accounted for.');
    return;
  }

  console.log(`\nGenerating fallback TTS videos for ${missing.length} missing papers...\n`);

  for (const [paperId, entry] of missing) {
    console.log(`  ${entry.paperTitle.slice(0, 60)}...`);
    try {
      await generateFallbackVideo(paperId, entry, entry.script);
      manifest.push({
        paperId,
        topic:        entry.topic,
        paperTitle:   entry.paperTitle,
        paperSummary: entry.paperSummary,
      });
      writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.error(`  ✗ ${paperId}: ${err.message}`);
    }
  }

  console.log('\nFallback generation complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
