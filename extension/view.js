const SVG_NS = 'http://www.w3.org/2000/svg';
const verdicts = {
  checking: { label: 'Checking sources', path: 'M12 4a8 8 0 1 0 8 8M12 7v5l3 2' },
  supported: { label: 'Supported', path: 'M20 11v1a8 8 0 1 1-4.7-7.3M8 11l4 4 8-9' },
  contradicted: { label: 'Contradicted', path: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0M9 9l6 6m0-6-6 6' },
  context: { label: 'Missing context', path: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0M12 11v5m0-8h.01' },
  uncertain: { label: 'Insufficient evidence', path: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0M10 9a2 2 0 1 1 3 1.7c-1 .6-1 1-1 2.3m0 3h.01' },
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function putText(element, value) {
  const text = String(value ?? '');
  if (element.textContent !== text) element.textContent = text;
}

function icon(className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  svg.append(document.createElementNS(SVG_NS, 'path'));
  return svg;
}

function timestamp(value = 0) {
  const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function createClaimCard() {
  const card = node('article', 'claim-card');
  const header = node('div', 'claim-header');
  const verdictIcon = icon('verdict-icon');
  const label = node('span', 'verdict-label');
  const time = node('span', 'claim-time');
  time.title = 'Time since listening started';
  header.append(verdictIcon, label, time);
  const text = node('p', 'claim-text');
  const explanation = node('p', 'claim-summary');
  const details = node('details', 'claim-details');
  const summary = node('summary');
  const sources = node('ol', 'source-list');
  details.append(summary, sources);
  card.append(header, text, explanation, details);
  return { element: card, verdictIcon, label, time, text, explanation, details, summary, sources, sourceKey: '' };
}

function updateClaimCard(card, claim) {
  const status = Object.hasOwn(verdicts, claim.status) ? claim.status : 'uncertain';
  const verdict = verdicts[status];
  if (card.element.dataset.status !== status) {
    card.element.dataset.status = status;
    card.verdictIcon.firstElementChild.setAttribute('d', verdict.path);
    putText(card.label, verdict.label);
  }
  putText(card.time, timestamp(claim.atMs));
  putText(card.text, claim.text);
  putText(card.explanation, claim.explanation || (status === 'checking' ? 'Searching Wikipedia for evidence and the surrounding context…' : 'No explanation was returned. Review the available sources.'));
  const validSources = (Array.isArray(claim.sources) ? claim.sources : []).map(source => ({ title: String(source.title || ''), url: safeSourceUrl(source.url) })).filter(source => source.url);
  const sourceKey = JSON.stringify(validSources);
  card.details.hidden = validSources.length === 0;
  if (card.sourceKey !== sourceKey) {
    card.sourceKey = sourceKey;
    putText(card.summary, `${validSources.length} ${validSources.length === 1 ? 'source' : 'sources'}`);
    const fragment = document.createDocumentFragment();
    validSources.forEach((source, index) => {
      const item = node('li');
      const link = node('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(node('span', 'source-number', index + 1), node('span', '', source.title || new URL(source.url).hostname));
      item.append(link);
      fragment.append(item);
    });
    card.sources.replaceChildren(fragment);
  }
}

/** A DOM-only view. All capture and network behavior belongs to panel.js. */
export function createView(callbacks) {
  const $ = id => document.getElementById(id);
  const panel = document.querySelector('.panel');
  const claimsPanel = $('claims-panel');
  const transcriptPanel = $('transcript-panel');
  const claims = new Map();
  const segments = new Map();
  let latest = { phase: 'idle', localReady: false, config: { language: 'en-US' }, setup: { speech: 'checking', model: 'checking' } };
  let selectedTab = 'claims';

  function selectTab(name, focus = false) {
    selectedTab = name;
    for (const id of ['claims', 'transcript']) {
      const selected = id === name;
      const tab = $(`${id}-tab`);
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`${id}-panel`).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }
  for (const name of ['claims', 'transcript']) {
    $(`${name}-tab`).addEventListener('click', () => selectTab(name));
    $(`${name}-tab`).addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        selectTab(event.key === 'Home' ? 'claims' : event.key === 'End' ? 'transcript' : selectedTab === 'claims' ? 'transcript' : 'claims', true);
      }
    });
  }

  function openSetup() {
    renderSetup(latest);
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
  }

  function renderSetup(state) {
    const busy = Boolean(state.preparation || state.phase === 'preparing');
    const activeSession = ['connecting', 'listening', 'stopping'].includes(state.phase);
    const labels = { checking: 'Checking', available: 'Ready', downloadable: 'Not downloaded', downloading: 'Downloading', unavailable: 'Unavailable' };
    for (const kind of ['speech', 'model']) {
      const status = state.setup?.[kind] || 'checking';
      const button = $(`prepare-${kind}-button`);
      putText($(`${kind}-status`), labels[status] || 'Checking');
      button.disabled = busy || activeSession || !['downloadable', 'downloading'].includes(status);
      putText(button, status === 'available' ? 'Ready' : state.preparation === kind ? 'Downloading…' : status === 'downloading' ? 'Continue download' : status === 'checking' ? 'Checking availability…' : status === 'unavailable' ? 'Unavailable on this device' : kind === 'speech' ? 'Download speech model' : 'Download local AI');
      putText($(`${kind}-description`), status === 'unavailable' ? kind === 'speech' ? 'Local speech recognition is not supported by this browser or device.' : 'Local AI is unavailable. This browser or device may not meet its support, storage, or hardware requirements.' : kind === 'speech' ? 'Live English captions, processed on your device.' : 'Extract claims and assess the Wikipedia evidence locally.');
    }
    $('setup-progress').hidden = !busy;
    $('cancel-preparation-button').hidden = !busy;
    $('setup-done-button').hidden = busy;
    const subject = state.preparation === 'speech' ? 'speech model' : 'local AI';
    const hasProgress = typeof state.progress === 'number' && Number.isFinite(state.progress);
    const progress = hasProgress ? Math.max(0, Math.min(100, state.progress <= 1 ? state.progress * 100 : state.progress)) : null;
    putText($('setup-progress-text'), progress === null ? `Preparing ${subject}… Keep this window open.` : `Preparing ${subject} · ${Math.round(progress)}%`);
    if (progress === null) $('setup-progress-bar').removeAttribute('value');
    else $('setup-progress-bar').value = progress;
    $('setup-error').hidden = !state.error;
    putText($('setup-error'), state.error);
  }

  function requestPreparation(kind) {
    if (latest.preparation || ['preparing', 'connecting', 'listening', 'stopping'].includes(latest.phase) || !['downloadable', 'downloading'].includes(latest.setup?.[kind])) return;
    // Invoke inside the click handler; the controller owns cancellation and concurrent-operation guards.
    if (kind === 'speech') callbacks.prepareSpeech();
    else callbacks.prepareModel();
  }

  $('listen-button').addEventListener('click', () => {
    if (['listening', 'connecting', 'preparing'].includes(latest.phase) || latest.preparation) callbacks.stop();
    else if (latest.phase !== 'stopping') {
      if (!latest.localReady) openSetup();
      else callbacks.start();
    }
  });
  $('demo-button').addEventListener('click', () => { selectTab('claims'); callbacks.demo(); });
  $('prepare-speech-button').addEventListener('click', () => requestPreparation('speech'));
  $('prepare-model-button').addEventListener('click', () => requestPreparation('model'));
  $('cancel-preparation-button').addEventListener('click', () => callbacks.stop());
  $('close-button').addEventListener('click', () => callbacks.close());
  $('settings-button').addEventListener('click', openSetup);
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  $('setup-done-button').addEventListener('click', () => $('settings-dialog').close());
  $('settings-dialog').addEventListener('click', event => {
    if (event.target !== $('settings-dialog')) return;
    const bounds = $('settings-dialog').getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('settings-dialog').close();
  });

  function render(state) {
    latest = state;
    const phase = state.phase || 'idle';
    const listening = phase === 'listening';
    const connecting = phase === 'connecting';
    const stopping = phase === 'stopping';
    const demo = phase === 'demo';
    const preparing = phase === 'preparing' || Boolean(state.preparation);
    const live = listening || connecting || stopping;
    panel.classList.toggle('is-listening', listening);
    panel.classList.toggle('is-connecting', connecting);
    renderSetup(state);
    $('demo-banner').hidden = !demo;
    putText(document.querySelector('.coverage-note'), demo ? 'Scripted NASA examples · no live sources fetched.' : 'Wikipedia evidence only · Missing coverage stays uncertain.');
    putText($('session-label'), demo ? 'SAMPLE SESSION' : live ? 'LOCAL LIVE FACT-CHECKING' : 'LOCAL YOUTUBE COMPANION');
    const title = state.title || 'YouTube, with local AI.';
    putText($('video-title'), title);
    $('video-title').title = title;
    putText($('status-text'), state.status || (listening ? 'Listening to tab audio' : connecting ? 'Connecting…' : stopping ? 'Finishing session…' : demo ? 'Sample content' : preparing ? 'Preparing local models…' : state.localReady ? 'Local models ready' : 'One-time setup needed'));
    $('session-time').hidden = !(live || demo || state.elapsedMs > 0);
    putText($('session-time'), timestamp(state.elapsedMs));
    putText($('footer-note-text'), live || demo || state.elapsedMs > 0 ? 'Times since listening started. Check the sources.' : 'Evidence first. Always check the sources.');
    $('audio-meter').hidden = !(listening && state.meterActive);
    if (listening && state.meterActive) {
      const level = Math.min(1, Math.max(0, Number(state.rms) || 0));
      const shape = [.3, .55, .8, .45, 1, .7, .4, .65, .3];
      [...$('audio-meter').children].forEach((bar, index) => { bar.style.height = `${2 + 12 * Math.min(1, level * 5) * shape[index]}px`; });
    }
    $('error-banner').hidden = !state.error;
    putText($('error-text'), state.error);
    const stopAction = listening || connecting || preparing;
    $('listen-button').disabled = stopping;
    $('listen-button').classList.toggle('is-stop', stopAction || stopping);
    putText($('listen-label'), stopping ? 'Stopping…' : preparing ? 'Cancel setup' : connecting ? 'Cancel connection' : listening ? 'Stop listening' : state.localReady ? 'Start listening' : 'Set up local AI');
    $('listen-icon').firstElementChild.setAttribute('d', stopAction || stopping ? 'M6 6h12v12H6Z' : 'M9 5v14l11-7Z');
    putText($('consent-copy'), demo ? 'This sample uses prewritten text and verdicts. It does not capture audio, run AI, or search for evidence.' : connecting ? 'Choose a YouTube tab and include audio. Audio and AI stay local; factual search queries go to Wikipedia.' : listening ? 'Audio and AI analysis stay on this device. Wikipedia receives factual search queries. Stop at any time.' : stopping ? 'Audio capture stopped. Pending local checks may finish using Wikipedia evidence.' : 'Audio and AI analysis stay on this device. Wikipedia receives factual search queries. Initial model downloads need internet.');

    const currentClaims = Array.isArray(state.claims) ? state.claims : [];
    const previousClaimScroll = claimsPanel.scrollTop;
    const keepClaimsAtEnd = claimsPanel.scrollHeight - claimsPanel.clientHeight - previousClaimScroll < 45;
    const hadClaims = claims.size > 0;
    const existingClaimIds = new Set();
    currentClaims.forEach((claim, index) => {
      const id = String(claim.id ?? index);
      existingClaimIds.add(id);
      let card = claims.get(id);
      if (!card) { card = createClaimCard(); claims.set(id, card); }
      updateClaimCard(card, claim);
      const existing = $('claim-list').children[index];
      if (existing !== card.element) $('claim-list').insertBefore(card.element, existing || null);
    });
    for (const [id, card] of claims) if (!existingClaimIds.has(id)) { card.element.remove(); claims.delete(id); }
    $('claims-empty').hidden = currentClaims.length > 0;
    $('claim-count').hidden = currentClaims.length === 0;
    putText($('claim-count'), currentClaims.length);
    if (!currentClaims.length) {
      putText($('empty-heading'), preparing ? 'Preparing your device.' : connecting ? 'Getting ready to listen.' : listening ? 'Listening for a claim.' : stopping ? 'Wrapping things up.' : state.error ? 'Let’s reconnect.' : 'Check this conversation');
      $('empty-heading').style.whiteSpace = 'pre-line';
      putText($('empty-description'), preparing ? 'Download the speech model and local AI separately. You only need to prepare them once.' : connecting ? 'Choose your YouTube tab in the sharing dialog and include tab audio.' : listening ? 'Checking claims against Wikipedia. Missing coverage stays uncertain; opinions and predictions don’t get a verdict.' : stopping ? 'Your transcript and completed checks will remain here.' : state.error ? 'Check the message above and your local setup, then try again.' : 'Transcribe and analyze on your device. Check factual claims against Wikipedia.');
    }
    $('demo-button').hidden = live || preparing;
    if (selectedTab === 'claims' && keepClaimsAtEnd && hadClaims) claimsPanel.scrollTop = claimsPanel.scrollHeight;
    else claimsPanel.scrollTop = previousClaimScroll;

    const currentSegments = Array.isArray(state.segments) ? state.segments : [];
    const previousTranscriptScroll = transcriptPanel.scrollTop;
    const keepTranscriptAtEnd = transcriptPanel.scrollHeight - transcriptPanel.clientHeight - previousTranscriptScroll < 60;
    const existingSegmentIds = new Set();
    currentSegments.forEach((segment, index) => {
      const id = String(segment.id ?? index);
      existingSegmentIds.add(id);
      let entry = segments.get(id);
      if (!entry) {
        const element = node('div', 'transcript-segment');
        const time = node('div', 'segment-meta');
        time.title = 'Time since listening started';
        const text = node('p');
        element.append(time, text);
        entry = { element, time, text };
        segments.set(id, entry);
      }
      putText(entry.time, timestamp(segment.atMs));
      putText(entry.text, segment.text);
      const existing = $('transcript-list').children[index];
      if (existing !== entry.element) $('transcript-list').insertBefore(entry.element, existing || null);
    });
    for (const [id, entry] of segments) if (!existingSegmentIds.has(id)) { entry.element.remove(); segments.delete(id); }
    const hasTranscript = currentSegments.length > 0 || Boolean(state.partial);
    putText(document.querySelector('.provisional-label'), listening || connecting || demo ? 'Transcribing' : 'Unfinalized text');
    $('transcript-empty').hidden = hasTranscript;
    $('transcript-indicator').hidden = !hasTranscript;
    $('partial-segment').hidden = !state.partial;
    putText($('partial-text'), state.partial);
    $('transcript-note').hidden = !hasTranscript;
    if (selectedTab === 'transcript' && keepTranscriptAtEnd) transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
    else transcriptPanel.scrollTop = previousTranscriptScroll;
  }

  return { render };
}
