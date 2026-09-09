// Chrome's local Web Speech engine; captured tab audio never falls back to a mic
// or cloud service. Model preparation and display capture need separate gestures.
const LANGUAGE = 'en-US';
const RETRY_DELAY_MS = 250;
const MAX_EMPTY_RESTARTS = 3;
const STOP_GRACE_MS = 2500;

function speechError(message, code) {
  return Object.assign(new Error(message), { code });
}

function getSpeechConstructor(language = LANGUAGE) {
  const nav = globalThis.navigator;
  const ua = nav?.userAgent || '';
  const version = /\bChrome\/(\d+)/.exec(ua);
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  const brands = nav?.userAgentData?.brands;
  const supportedPlatform = /^(macOS|Windows|Linux|MacIntel|MacPPC|Win32|Win64|Linux x86_64|Linux aarch64)$/i.test(platform);
  // The audioTrack overload is not safely detectable by invoking start(): old
  // browsers can ignore its argument and start the microphone instead.
  if (language !== LANGUAGE || !version || Number(version[1]) < 139 ||
      !supportedPlatform || /Android|CrOS|iPhone|iPad|Edg\/|OPR\//.test(ua) ||
      (brands?.length && !brands.some(brand => brand.brand === 'Google Chrome')) ||
      globalThis.isSecureContext === false ||
      (globalThis.window && globalThis.window.top !== globalThis.window)) return null;
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (typeof Recognition !== 'function' || !('processLocally' in Recognition.prototype) ||
      typeof Recognition.available !== 'function' || typeof Recognition.install !== 'function') return null;
  return Recognition;
}

export async function speechAvailability(language = LANGUAGE) {
  const Recognition = getSpeechConstructor(language);
  if (!Recognition) return 'unavailable';
  try {
    const status = await Recognition.available({ langs: [language], processLocally: true });
    return ['available', 'downloadable', 'downloading'].includes(status) ? status : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function installSpeech(language = LANGUAGE) {
  const Recognition = getSpeechConstructor(language);
  if (!Recognition) return Promise.resolve(false);
  // Do not await an availability check first: install must retain the click's
  // transient activation. Chrome can consume that activation for the download.
  try {
    return Promise.resolve(Recognition.install({ langs: [language], processLocally: true }));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function captureAudio() {
  const media = globalThis.navigator?.mediaDevices;
  if (!getSpeechConstructor() || typeof media?.getDisplayMedia !== 'function') {
    return Promise.reject(speechError('Use current desktop Google Chrome on macOS, Windows, or Linux.', 'unsupported-browser'));
  }
  // This invocation occurs synchronously in the Start button handler. Do not
  // insert model downloads, messaging, or permission queries ahead of it.
  let request;
  try {
    request = media.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 1 },
      audio: { suppressLocalAudioPlayback: false },
      selfBrowserSurface: 'exclude',
      systemAudio: 'exclude',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
  } catch (error) {
    return Promise.reject(error);
  }
  return Promise.resolve(request).then(stream => {
    const [audioTrack] = stream.getAudioTracks();
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack?.getSettings().displaySurface !== 'browser' ||
        !audioTrack || audioTrack.kind !== 'audio' || audioTrack.readyState !== 'live') {
      stream.getTracks().forEach(track => track.stop());
      throw speechError('Choose the YouTube browser tab and enable Share tab audio.', 'missing-tab-audio');
    }
    return stream;
  });
}

export function createLocalRecognizer(stream, {
  language = LANGUAGE,
  onDelta = () => {},
  onFinal = () => {},
  onStatus = () => {},
  onError = () => {},
  onEnd = () => {},
} = {}) {
  const Recognition = getSpeechConstructor(language);
  if (!Recognition) throw speechError('On-device English speech recognition requires current desktop Google Chrome.', 'unsupported-browser');
  const [audioTrack] = stream.getAudioTracks();
  if (!audioTrack || audioTrack.kind !== 'audio' || audioTrack.readyState !== 'live') {
    throw speechError('The shared tab has no live audio track.', 'missing-tab-audio');
  }
  let recognition = null;
  let started = false;
  let stopping = false;
  let ended = false;
  let startedAt = 0;
  let epoch = 0;
  let emptyRestarts = 0;
  let retryTimer = null;
  let stopTimer = null;
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const clearTimers = () => {
    clearTimeout(retryTimer);
    clearTimeout(stopTimer);
    retryTimer = null;
    stopTimer = null;
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimers();
    audioTrack.removeEventListener('ended', onTrackEnded);
    onStatus('stopped');
    onEnd();
  };
  const fail = error => {
    if (ended) return;
    stopping = true;
    const current = recognition;
    recognition = null;
    try { current?.abort(); } catch { /* The browser may already have ended. */ }
    onError(error);
    finish();
  };
  const onTrackEnded = () => {
    if (ended) return;
    stopping = true;
    try { recognition?.abort(); } catch { /* Track already gone. */ }
    finish();
  };

  function begin() {
    if (ended || stopping) return;
    if (audioTrack.readyState !== 'live') { finish(); return; }
    const current = new Recognition();
    recognition = current;
    const currentEpoch = ++epoch;
    const times = new Map();
    const finals = new Set();
    const lastInterims = new Map();
    let resultCount = 0;
    current.lang = language;
    current.processLocally = true;
    current.continuous = true;
    current.interimResults = true;
    current.maxAlternatives = 1;
    current.onstart = () => {
      if (!ended && recognition === current) onStatus(stopping ? 'stopping' : 'listening');
    };
    current.onresult = event => {
      if (ended || recognition !== current) return;
      emptyRestarts = 0;
      // Interim slots may disappear when recognition revises its hypothesis.
      for (let index = event.results.length; index < resultCount; index++) {
        if (!finals.has(index) && lastInterims.has(index)) {
          onDelta({ id: `${sessionId}:${currentEpoch}:${index}`, text: '', atMs: times.get(index) ?? elapsed() });
          lastInterims.delete(index);
        }
      }
      resultCount = event.results.length;
      for (let index = event.resultIndex; index < event.results.length; index++) {
        if (finals.has(index)) continue;
        const result = event.results[index];
        const text = result[0]?.transcript || '';
        if (!times.has(index)) times.set(index, elapsed());
        const item = { id: `${sessionId}:${currentEpoch}:${index}`, text, atMs: times.get(index) };
        if (result.isFinal) {
          finals.add(index);
          lastInterims.delete(index);
          onFinal(item);
        } else if (lastInterims.get(index) !== text) {
          lastInterims.set(index, text);
          onDelta(item);
        }
      }
    };
    current.onerror = event => {
      if (ended || recognition !== current) return;
      if (event.error === 'no-speech') return; // onend owns bounded reconnection.
      if (stopping && event.error === 'aborted') { finish(); return; }
      fail(speechError(`Local speech recognition stopped: ${event.error || 'unknown error'}.`, event.error || 'recognition-error'));
    };
    current.onend = () => {
      if (ended || recognition !== current) return;
      recognition = null;
      // Never promote an unfinished hypothesis to final on a disconnect.
      for (const index of lastInterims.keys()) {
        onDelta({ id: `${sessionId}:${currentEpoch}:${index}`, text: '', atMs: times.get(index) ?? elapsed() });
      }
      if (stopping || audioTrack.readyState !== 'live') { finish(); return; }
      if (++emptyRestarts > MAX_EMPTY_RESTARTS) {
        fail(speechError('Local speech recognition repeatedly stopped. Check that the YouTube tab is playing, then start again.', 'restart-limit'));
        return;
      }
      onStatus('reconnecting');
      retryTimer = setTimeout(begin, RETRY_DELAY_MS);
    };
    try {
      current.start(audioTrack);
    } catch (error) {
      fail(speechError(error.message || 'Unable to start local speech recognition.', error.name || 'recognition-error'));
    }
  }

  return {
    start() {
      if (started || ended) return;
      started = true;
      startedAt = performance.now();
      audioTrack.addEventListener('ended', onTrackEnded, { once: true });
      begin();
    },
    stop() {
      if (ended || stopping) return;
      stopping = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (!recognition) { finish(); return; }
      onStatus('stopping');
      // Allow the engine to return its final result before onend. A hung engine
      // must not hold the UI in Stopping indefinitely.
      stopTimer = setTimeout(() => {
        try { recognition?.abort(); } catch { /* Engine already gone. */ }
        finish();
      }, STOP_GRACE_MS);
      try { recognition.stop(); } catch { finish(); }
    },
    abort() {
      if (ended) return;
      stopping = true;
      try { recognition?.abort(); } catch { /* Engine already gone. */ }
      finish();
    },
  };
}
