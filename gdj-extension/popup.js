const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');

chrome.runtime.sendMessage({ type: 'GET_COUNT' }, ({ count }) => {
  if (count > 0) {
    statusEl.textContent = `${count} educational reel${count === 1 ? '' : 's'} queued`;
    statusEl.className = 'status ready';
    hintEl.textContent = 'Browse Instagram Reels — 1 in 5 will be secretly educational.';
  } else {
    statusEl.textContent = 'No reels loaded';
    statusEl.className = 'status empty';
    hintEl.textContent = 'Run generate.js to create videos, then reload the extension.';
  }
});
