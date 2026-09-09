import test from 'node:test';
import assert from 'node:assert/strict';
import { speechAvailability, installSpeech, captureAudio, createLocalRecognizer } from '../extension/local-speech.js';

function fixture(t, overrides = {}) {
  const calls = { available: [], install: [], capture: [], instances: [] };
  class Track extends EventTarget {
    constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.stops = 0; }
    getSettings() { return { displaySurface: 'browser' }; }
    stop() { this.readyState = 'ended'; this.stops++; }
  }
  const audio = new Track('audio');
  const video = new Track('video');
  const stream = { getAudioTracks: () => [audio], getVideoTracks: () => [video], getTracks: () => [audio, video] };
  class Recognition {
    static available(options) { calls.available.push(options); return Promise.resolve('available'); }
    static install(options) { calls.install.push(options); return Promise.resolve(true); }
    get processLocally() { return this.local; }
    set processLocally(value) { this.local = value; }
    constructor() { this.startArgs = []; this.stops = 0; this.aborts = 0; calls.instances.push(this); }
    start(...args) { this.startArgs.push(args); this.onstart?.(); }
    stop() { this.stops++; }
    abort() { this.aborts++; }
  }
  const nav = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    mediaDevices: { getDisplayMedia(options) { calls.capture.push(options); return Promise.resolve(stream); } },
    ...overrides,
  };
  for (const [key, value] of Object.entries({ navigator: nav, SpeechRecognition: Recognition })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => prior ? Object.defineProperty(globalThis, key, prior) : delete globalThis[key]);
  }
  return { calls, Recognition, audio, video, stream, nav };
}

function result(text, isFinal = false) { return Object.assign([{ transcript: text }], { isFinal }); }

test('model setup requests local English, with install called in the same stack as the user action', async t => {
  const { calls } = fixture(t);
  assert.equal(await speechAvailability(), 'available');
  const promise = installSpeech();
  assert.equal(calls.install.length, 1);
  assert.equal(await promise, true);
  assert.deepEqual(calls.available[0], { langs: ['en-US'], processLocally: true });
  assert.deepEqual(calls.install[0], { langs: ['en-US'], processLocally: true });
  assert.equal(await speechAvailability('hi-IN'), 'unavailable');
});

test('unsupported versions and platforms never invoke recognition or capture', async t => {
  const { nav, calls } = fixture(t);
  for (const [ua, platform] of [
    ['Chrome/138.0.0.0', 'MacIntel'], ['Chrome/152.0.0.0 Android', 'Linux aarch64'],
    ['Chrome/152.0.0.0 CrOS', 'Linux x86_64'], ['Chrome/152.0.0.0 Edg/152.0', 'Win32'],
  ]) {
    nav.userAgent = ua; nav.platform = platform;
    assert.equal(await speechAvailability(), 'unavailable');
    assert.equal(await installSpeech(), false);
    await assert.rejects(captureAudio(), { code: 'unsupported-browser' });
  }
  assert.equal(calls.capture.length, 0);
  assert.equal(calls.instances.length, 0);
});

test('capture is invoked synchronously and rejects non-tab or missing-audio choices', async t => {
  const { calls, stream, audio, video } = fixture(t);
  const pending = captureAudio();
  assert.equal(calls.capture.length, 1);
  assert.equal(await pending, stream);
  assert.equal(calls.capture[0].audio.suppressLocalAudioPlayback, false);
  assert.equal(calls.capture[0].systemAudio, 'exclude');
  video.getSettings = () => ({ displaySurface: 'monitor' });
  await assert.rejects(captureAudio(), { code: 'missing-tab-audio' });
  assert.equal(audio.stops, 1);
  assert.equal(video.stops, 1);
});

test('interims replace the same result, finals emit once, and stop permits a last final', t => {
  const { stream, audio, calls } = fixture(t);
  const deltas = [], finals = [], statuses = [];
  let ends = 0;
  const controller = createLocalRecognizer(stream, { onDelta: item => deltas.push(item), onFinal: item => finals.push(item), onStatus: value => statuses.push(value), onEnd: () => ends++ });
  controller.start();
  const engine = calls.instances[0];
  assert.equal(engine.processLocally, true);
  assert.equal(engine.interimResults, true);
  assert.equal(engine.continuous, true);
  assert.deepEqual(engine.startArgs, [[audio]]);
  engine.onresult({ resultIndex: 0, results: [result('The earth')] });
  engine.onresult({ resultIndex: 0, results: [result('The Earth is round.')] });
  controller.stop();
  assert.equal(engine.stops, 1);
  assert.equal(ends, 0);
  engine.onresult({ resultIndex: 0, results: [result('The Earth is round.', true)] });
  engine.onresult({ resultIndex: 0, results: [result('duplicate', true)] });
  engine.onend();
  assert.equal(deltas[0].id, deltas[1].id);
  assert.equal(deltas[1].id, finals[0].id);
  assert.equal(deltas[0].atMs, finals[0].atMs);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'The Earth is round.');
  assert.equal(ends, 1);
  assert.equal(audio.stops, 0, 'capture ownership stays with root');
  assert.deepEqual(statuses, ['listening', 'stopping', 'stopped']);
});

test('interim slots removed by the engine clear without fabricating final text', t => {
  const { stream, calls } = fixture(t);
  const deltas = [], finals = [];
  const controller = createLocalRecognizer(stream, { onDelta: x => deltas.push(x), onFinal: x => finals.push(x) });
  controller.start();
  const engine = calls.instances[0];
  engine.onresult({ resultIndex: 0, results: [result('first'), result('discard')] });
  engine.onresult({ resultIndex: 0, results: [result('first revised')] });
  assert.equal(deltas.find(x => x.id === deltas[1].id && x.text === '')?.text, '');
  assert.equal(finals.length, 0);
  controller.abort();
});

test('permission or model failures end once, never enabling cloud or retrying a microphone', async t => {
  const { stream, calls } = fixture(t);
  const errors = []; let ends = 0;
  const controller = createLocalRecognizer(stream, { onError: error => errors.push(error), onEnd: () => ends++ });
  controller.start();
  const engine = calls.instances[0];
  engine.onerror({ error: 'language-not-supported' });
  engine.onend();
  controller.abort();
  assert.equal(errors[0].code, 'language-not-supported');
  assert.equal(ends, 1);
  assert.equal(calls.instances.length, 1);
  assert.equal(engine.processLocally, true);
  assert.equal(engine.startArgs[0].length, 1);
});

test('reconnects are bounded, preserve the audio track, and keep result IDs distinct', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, audio, calls } = fixture(t);
  const ids = [], errors = []; let ends = 0;
  const controller = createLocalRecognizer(stream, { onDelta: x => ids.push(x.id), onError: e => errors.push(e), onEnd: () => ends++ });
  controller.start();
  calls.instances[0].onresult({ resultIndex: 0, results: [result('first')] });
  calls.instances[0].onend();
  t.mock.timers.tick(250);
  calls.instances[1].onresult({ resultIndex: 0, results: [result('second')] });
  assert.notEqual(ids[0], ids.at(-1));
  for (let attempt = 0; attempt < 4; attempt++) {
    calls.instances.at(-1).onend();
    t.mock.timers.tick(250);
  }
  assert.equal(errors.at(-1).code, 'restart-limit');
  assert.equal(ends, 1);
  for (const engine of calls.instances) assert.deepEqual(engine.startArgs, [[audio]]);
});

test('ending capture prevents reconnection, and stop timeout releases a hung recognizer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, audio, calls } = fixture(t);
  let ends = 0;
  const controller = createLocalRecognizer(stream, { onEnd: () => ends++ });
  controller.start();
  controller.stop();
  t.mock.timers.tick(2500);
  assert.equal(ends, 1);
  assert.equal(calls.instances[0].aborts, 1);
  const second = createLocalRecognizer(stream, { onEnd: () => ends++ });
  second.start();
  audio.stop();
  audio.dispatchEvent(new Event('ended'));
  t.mock.timers.tick(1000);
  assert.equal(ends, 2);
  assert.equal(calls.instances.length, 2);
});
