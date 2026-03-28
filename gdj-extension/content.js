const INJECT_PROBABILITY = 0.2; // 1 in 5 reels

function isReelVideo(video) {
  const path = location.pathname;
  if (path.startsWith('/reels') || path.startsWith('/reel/')) return true;
  // Home feed: large autoplay video not inside a story/DM dialog.
  // offsetHeight may be 0 if the element was just added to the DOM (pre-layout),
  // so also check the video's explicit height attribute or style as a fallback.
  const h = video.offsetHeight || parseInt(video.style.height) || 0;
  if (h > 400 || video.closest('article')) {
    return !video.closest('[role="dialog"]');
  }
  return false;
}

function addCaptionOverlay(wrapper, title) {
  wrapper.querySelector('.gdj-caption')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'gdj-caption';
  overlay.style.cssText = `
    position: absolute;
    bottom: 80px;
    left: 16px;
    right: 72px;
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-weight: 700;
    font-size: 14px;
    line-height: 1.4;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    pointer-events: none;
    z-index: 20;
  `;
  overlay.textContent = title;
  wrapper.appendChild(overlay);
  return overlay;
}

async function injectEducationalReel(originalVideo) {
  const entry = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_NEXT_VIDEO' }, resolve);
  });

  if (!entry) return;

  const videoUrl = chrome.runtime.getURL(`videos/${entry.paperId}.mp4`);

  const wrapper = originalVideo.parentElement;
  wrapper.style.position = 'relative';
  originalVideo.style.opacity = '0';
  // Silence the original so its audio doesn't bleed through.
  originalVideo.muted = true;

  const eduVideo = document.createElement('video');
  eduVideo.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    z-index: 10;
  `;
  eduVideo.src = videoUrl;
  eduVideo.playsInline = true;
  eduVideo.loop = true;
  // Start muted for autoplay policy; unmute on first interaction.
  eduVideo.muted = true;
  wrapper.appendChild(eduVideo);

  const captionEl = addCaptionOverlay(wrapper, entry.paperTitle);

  function cleanup() {
    syncOff();
    eduVideo.pause();
    eduVideo.remove();
    captionEl.remove();
    originalVideo.style.opacity = '1';
    originalVideo.muted = false;
  }

  // Mirror the original video's play/pause state so scrolling away
  // stops our audio and scrolling back resumes it correctly.
  function onOriginalPause() { eduVideo.pause(); }
  function onOriginalPlay()  { eduVideo.play().catch(() => {}); }
  originalVideo.addEventListener('pause', onOriginalPause);
  originalVideo.addEventListener('play',  onOriginalPlay);

  function syncOff() {
    originalVideo.removeEventListener('pause', onOriginalPause);
    originalVideo.removeEventListener('play',  onOriginalPlay);
  }

  // Unmute on tap
  const unmute = () => { eduVideo.muted = false; };
  eduVideo.addEventListener('click', unmute, { once: true });
  wrapper.addEventListener('click', unmute, { once: true });

  // Load failure — restore original silently
  eduVideo.addEventListener('error', () => {
    console.warn('[GDJ] Failed to load video:', videoUrl);
    cleanup();
  }, { once: true });

  // Start playback (original may already be playing)
  eduVideo.play().catch(() => {});
}

function scanVideos() {
  document.querySelectorAll('video[playsinline]').forEach(video => {
    if (video.dataset.gdjProcessed) return;
    if (!isReelVideo(video)) return;
    video.dataset.gdjProcessed = 'true';
    console.log('[GDJ] Reel detected, rolling injection (p=' + INJECT_PROBABILITY + ')', video);
    if (Math.random() < INJECT_PROBABILITY) {
      injectEducationalReel(video);
    }
  });
}

const observer = new MutationObserver(scanVideos);
observer.observe(document.body, { childList: true, subtree: true });

scanVideos();
