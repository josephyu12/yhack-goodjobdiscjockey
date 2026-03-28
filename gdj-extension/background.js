const DB_NAME = 'gdj-videos';
const DB_VERSION = 1;
const STORE = 'videos';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE, { autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

// Store only metadata — videos are served via chrome.runtime.getURL, not from IndexedDB blobs.
async function storeVideo(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(entry);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function loadManifestIntoQueue() {
  try {
    const manifestUrl = chrome.runtime.getURL('videos/manifest.json');
    const res = await fetch(manifestUrl);
    if (!res.ok) return;
    const entries = await res.json();
    for (const entry of entries) {
      await storeVideo({ ...entry, createdAt: Date.now() });
    }
  } catch (err) {
    console.error('[GDJ] Failed to reload manifest:', err);
  }
}

// Dequeue oldest entry (FIFO). Repopulates from manifest if queue is empty.
async function getNextVideo() {
  let entry = await dequeueOne();
  if (!entry) {
    await loadManifestIntoQueue();
    entry = await dequeueOne();
  }
  return entry;
}

async function dequeueOne() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) { resolve(null); return; }
      const entry = cursor.value;
      cursor.delete();
      resolve(entry);
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function getCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

// On install: read manifest.json bundled with the extension and populate IndexedDB with metadata.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const manifestUrl = chrome.runtime.getURL('videos/manifest.json');
    const res = await fetch(manifestUrl);
    if (!res.ok) {
      console.warn('[GDJ] No videos/manifest.json found — run generate.js first, then reload.');
      return;
    }
    const entries = await res.json();
    for (const entry of entries) {
      await storeVideo({ ...entry, createdAt: Date.now() });
    }
    console.log(`[GDJ] Loaded ${entries.length} educational reels into queue.`);
  } catch (err) {
    console.error('[GDJ] Failed to load video manifest:', err);
  }
});

// Message handler: content script requests the next video entry.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_NEXT_VIDEO') {
    getNextVideo().then(sendResponse).catch(() => sendResponse(null));
    return true; // keep channel open for async response
  }
  if (msg.type === 'GET_COUNT') {
    getCount().then(count => sendResponse({ count })).catch(() => sendResponse({ count: 0 }));
    return true;
  }
});
