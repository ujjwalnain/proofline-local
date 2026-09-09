(() => {
  if (globalThis.__prooflineLocalWatching) return;
  globalThis.__prooflineLocalWatching = true;
  const navigate = () => chrome.runtime.sendMessage({ type: 'proofline:source-navigated' }).catch(() => {});
  document.addEventListener('yt-navigate-start', navigate);
  window.addEventListener('pagehide', navigate);
})();
