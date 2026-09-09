import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import { updateTranscript, sanitizeClaim } from '../extension/session-state.js';

// Execute the real controller. Only browser adapters and UI rendering are mocked.
const controller = (await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness({ pendingCapture = false, pendingModel = false, pendingFinish = false, captureFailure = false, pendingInstall = false } = {}) {
  const captured = deferred(), modelLoaded = deferred(), checksFinished = deferred(), installed = deferred();
  const timeouts = new Map(), intervals = new Map(), windowListeners = new Map();
  const models = [], recognizers = [], checkers = [], preparationCalls = [];
  let state, actions, messageListener;
  let captureCalls = 0, timerId = 0, activation = false;

  const tracks = ['audio', 'video'].map(kind => ({
    kind, readyState: 'live', stopCalls: 0, ended: null,
    stop() { this.readyState = 'ended'; this.stopCalls++; },
    addEventListener(_name, callback) { this.ended = callback; },
  }));
  const stream = { getTracks: () => tracks };
  function model() {
    const value = { destroyCalls: 0, destroy() { this.destroyCalls++; } };
    models.push(value); return value;
  }
  const nextModel = model();
  class FakeChecker {
    constructor({ emit }) { this.emit = emit; this.added = []; this.closeCalls = 0; this.finishCalls = 0; checkers.push(this); }
    add(event) { this.added.push(event); }
    finish() { this.finishCalls++; return pendingFinish ? checksFinished.promise : Promise.resolve(); }
    close() { this.closeCalls++; }
  }
  const context = {
    URL, URLSearchParams, Map, Set, console, AbortController, updateTranscript, sanitizeClaim,
    location: { search: '?tabId=42' }, performance: { now: () => 0 },
    requestAnimationFrame: callback => queueMicrotask(callback),
    setTimeout: (callback, delay) => { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    window: { addEventListener: (name, listener) => windowListeners.set(name, listener), close() {} },
    chrome: {
      tabs: { get: async () => ({ title: 'Testing local captions - YouTube' }) },
      runtime: { onMessage: { addListener: listener => { messageListener = listener; } } },
    },
    createView: callbacks => { actions = callbacks; return { render: value => { state = value; } }; },
    speechAvailability: async () => 'available', modelAvailability: async () => 'available',
    installSpeech: () => { preparationCalls.push({ type: 'speech', activation }); return pendingInstall ? installed.promise : Promise.resolve(true); },
    loadModel: options => {
      preparationCalls.push({ type: 'model', activation, options });
      return pendingModel ? modelLoaded.promise : Promise.resolve(nextModel);
    },
    captureAudio: () => {
      captureCalls++;
      assert.equal(activation, true, 'Display capture must be requested synchronously from the start click');
      if (captureFailure) return Promise.reject(Object.assign(new Error('Share denied'), { name: 'NotAllowedError' }));
      return pendingCapture ? captured.promise : Promise.resolve(stream);
    },
    createLocalRecognizer: (selected, callbacks) => {
      assert.equal(selected, stream);
      const recognizer = {
        callbacks, startCalls: 0, stopCalls: 0, abortCalls: 0,
        start() { this.startCalls++; callbacks.onStatus('listening'); },
        stop() { this.stopCalls++; },
        abort() { this.abortCalls++; callbacks.onEnd(); },
      };
      recognizers.push(recognizer); return recognizer;
    },
    LocalChecker: FakeChecker,
    startDemo() { throw new Error('Live tests cannot silently start demonstration results.'); },
  };
  vm.runInNewContext(controller, context, { filename: 'extension/panel.js' });
  await setImmediate();
  return {
    tracks, models, recognizers, checkers, preparationCalls, timeouts, intervals,
    get state() { return state; }, get captureCalls() { return captureCalls; },
    click(name) { activation = true; try { return actions[name](); } finally { activation = false; } },
    grantCapture: () => captured.resolve(stream), resolveModel: () => modelLoaded.resolve(nextModel),
    resolveFinish: () => checksFinished.resolve(), resolveInstall: () => installed.resolve(true),
    navigate: (tabId = 42) => messageListener({ type: 'proofline:stop-for-navigation', tabId }),
    pagehide: () => windowListeners.get('pagehide')(),
    fireTimer(delay) {
      const entry = [...timeouts].find(([, item]) => item.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms deadline`);
      timeouts.delete(entry[0]); entry[1].callback();
    },
  };
}

function captureEnded(value) {
  for (const track of value.tracks) {
    assert.equal(track.readyState, 'ended', `${track.kind} capture must be released`);
    assert.equal(track.stopCalls, 1, `${track.kind} track should only be stopped once`);
  }
}

test('stop while the picker is open disposes a late granted capture without starting recognition', async () => {
  const value = await harness({ pendingCapture: true });
  const started = value.click('start');
  assert.equal(value.state.phase, 'connecting');
  await value.click('stop');
  await setImmediate();
  value.grantCapture();
  await started;
  captureEnded(value);
  assert.equal(value.recognizers.length, 0);
  assert.equal(value.checkers.length, 0);
  assert.equal(value.state.phase, 'idle');
  assert.equal(value.intervals.size, 0);
});

test('capture denial never retries with a microphone or shows demo verdicts', async () => {
  const value = await harness({ captureFailure: true });
  await value.click('start');
  assert.equal(value.captureCalls, 1);
  assert.equal(value.recognizers.length, 0);
  assert.equal(value.checkers.length, 0);
  assert.equal(value.state.phase, 'error');
  assert.equal(value.state.claims.length, 0);
  assert.match(value.state.error, /cancelled or blocked/);
});

test('stop during model creation destroys a late model and never restores listening', async () => {
  const value = await harness({ pendingModel: true });
  const started = value.click('start');
  await setImmediate();
  assert.equal(value.preparationCalls.length, 1);
  await value.click('stop');
  value.resolveModel();
  await started;
  await setImmediate();
  captureEnded(value);
  assert.equal(value.models[0].destroyCalls, 1);
  assert.equal(value.recognizers.length, 0);
  assert.equal(value.state.phase, 'idle');
});

test('stop releases capture immediately, accepts the engine final, then drains checks', async () => {
  const value = await harness({ pendingFinish: true });
  await value.click('start');
  const recognizer = value.recognizers[0], checker = value.checkers[0];
  await value.click('stop');
  captureEnded(value);
  assert.equal(value.state.phase, 'stopping');
  assert.equal(recognizer.abortCalls, 0, 'The engine needs its final-result grace period');
  recognizer.callbacks.onFinal({ id: 'last', text: 'The final spoken sentence.', atMs: 1000 });
  recognizer.callbacks.onEnd();
  assert.equal(checker.added[0].text, 'The final spoken sentence.');
  assert.equal(checker.finishCalls, 1);
  value.resolveFinish();
  await setImmediate();
  assert.equal(value.state.phase, 'idle');
  assert.equal(value.state.segments[0].text, 'The final spoken sentence.');
  assert.equal(checker.closeCalls, 1);
  assert.equal(value.timeouts.size, 0);
  assert.equal(value.intervals.size, 0);
});

test('stopping preserves at least the adapter final-result grace and bounds evidence drain', async () => {
  const value = await harness({ pendingFinish: true });
  await value.click('start');
  const checker = value.checkers[0];
  checker.emit({ type: 'claim', claim: { id: 'pending', text: 'Pending factual statement.', status: 'checking', explanation: '', sources: [], atMs: 0 } });
  await value.click('stop');
  const grace = [...value.timeouts.values()].find(item => item.delay <= 10_000);
  assert.ok(grace.delay >= 2500, 'Controller must not abort before the adapter’s 2500ms stop grace');
  value.fireTimer(grace.delay);
  value.fireTimer(15_000);
  await setImmediate();
  captureEnded(value);
  assert.equal(value.state.phase, 'idle');
  assert.equal(value.state.claims[0].status, 'uncertain');
  assert.equal(checker.closeCalls, 1);
});

test('navigation aborts only the associated source session and ignores late recognizer/checker callbacks', async () => {
  const value = await harness();
  await value.click('start');
  const recognizer = value.recognizers[0], checker = value.checkers[0];
  value.navigate(99);
  assert.equal(value.state.phase, 'listening');
  value.navigate(42);
  captureEnded(value);
  assert.equal(recognizer.abortCalls, 1);
  assert.equal(checker.closeCalls, 1);
  assert.equal(value.state.phase, 'error');
  recognizer.callbacks.onFinal({ id: 'late', text: 'A late transcript must be ignored.', atMs: 2000 });
  checker.emit({ type: 'claim', claim: { id: 'late', text: 'Unrelated late result.', status: 'supported', explanation: '', sources: [{ title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Sound' }], atMs: 2000 } });
  assert.equal(value.state.segments.length, 0);
  assert.equal(value.state.claims.length, 0);
  assert.equal(value.timeouts.size, 0);
  assert.equal(value.intervals.size, 0);
});

test('closing the popup releases capture, aborts local work and destroys the reusable model', async () => {
  const value = await harness();
  await value.click('start');
  value.pagehide();
  captureEnded(value);
  assert.equal(value.recognizers[0].abortCalls, 1);
  assert.equal(value.checkers[0].closeCalls, 1);
  assert.equal(value.models[0].destroyCalls, 1);
  assert.equal(value.timeouts.size, 0);
  assert.equal(value.intervals.size, 0);
});

test('setup invokes both model and speech installers within their own user gestures', async () => {
  const speech = await harness({ pendingInstall: true });
  speech.click('prepareSpeech');
  assert.equal(speech.preparationCalls[0].type, 'speech');
  assert.equal(speech.preparationCalls[0].activation, true);
  await speech.click('stop');
  speech.resolveInstall();
  await setImmediate();
  assert.notEqual(speech.state.phase, 'preparing');

  const model = await harness({ pendingModel: true });
  model.click('prepareModel');
  assert.equal(model.preparationCalls[0].type, 'model');
  assert.equal(model.preparationCalls[0].activation, true);
  await model.click('stop');
  assert.equal(model.preparationCalls[0].options.signal.aborted, true);
  model.resolveModel();
  await setImmediate();
  assert.equal(model.models[0].destroyCalls, 1);
  assert.notEqual(model.state.phase, 'preparing');
});
