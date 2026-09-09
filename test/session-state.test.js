import assert from 'node:assert/strict';
import test from 'node:test';
import { updateTranscript, sanitizeClaim } from '../extension/session-state.js';

function fixture() { return { state: { segments: [], partial: '' }, drafts: new Map() }; }

test('interim hypotheses replace their slot and final text removes its provisional version', () => {
  const { state, drafts } = fixture();
  updateTranscript(state, { id: 'one', text: 'The world is', atMs: 1000 }, drafts);
  updateTranscript(state, { id: 'one', text: 'The world was', atMs: 1000 }, drafts);
  assert.equal(state.partial, 'The world was');
  updateTranscript(state, { id: 'one', text: 'The world was changing.', atMs: 1000 }, drafts, true);
  assert.equal(state.partial, '');
  assert.equal(drafts.size, 0);
  assert.equal(state.segments[0].text, 'The world was changing.');
  updateTranscript(state, { id: 'one', text: 'Late stale interim', atMs: 1000 }, drafts);
  assert.equal(state.partial, '');
});

test('final segments reconcile by ID, sort by session offset and bound history', () => {
  const { state, drafts } = fixture();
  updateTranscript(state, { id: 'later', text: 'Later.', atMs: 2000 }, drafts, true);
  updateTranscript(state, { id: 'earlier', text: 'Earlier.', atMs: 1000 }, drafts, true);
  updateTranscript(state, { id: 'earlier', text: 'Earlier corrected.', atMs: 1000 }, drafts, true);
  assert.equal(state.segments.length, 2);
  assert.equal(state.segments[0].text, 'Earlier corrected.');
  for (let index = 0; index < 400; index++) updateTranscript(state, { id: `id-${index}`, text: String(index), atMs: 3000 + index }, drafts, true);
  assert.equal(state.segments.length, 300);
  assert.equal(state.segments.at(-1).id, 'id-399');
});

test('clearing a disappeared interim hypothesis does not promote it to final', () => {
  const { state, drafts } = fixture();
  updateTranscript(state, { id: 'provisional', text: 'A possibly incorrect number', atMs: 0 }, drafts);
  updateTranscript(state, { id: 'provisional', text: '', atMs: 0 }, drafts);
  assert.equal(state.partial, '');
  assert.equal(state.segments.length, 0);
});

test('invalid transcript messages are ignored and long transcript text is bounded', () => {
  const { state, drafts } = fixture();
  updateTranscript(state, { id: 17, text: 'Invalid ID.' }, drafts, true);
  updateTranscript(state, { id: 'invalid', text: null }, drafts, true);
  assert.equal(state.segments.length, 0);
  updateTranscript(state, { id: 'long', text: 'x'.repeat(25000), atMs: Infinity }, drafts, true);
  assert.equal(state.segments[0].text.length, 20000);
  assert.equal(state.segments[0].atMs, 0);
});

test('confident verdicts without allowed evidence are downgraded to uncertain', () => {
  for (const status of ['supported', 'contradicted', 'context']) {
    const result = sanitizeClaim({ id: 'claim', text: 'A claim.', status, explanation: 'An unsupported determination.', sources: [] });
    assert.equal(result.status, 'uncertain');
    assert.match(result.explanation, /No retrieved evidence/);
    assert.deepEqual(result.sources, []);
  }
});

test('evidence links permit only HTTPS Wikipedia hostname and require a text title', () => {
  const base = { id: 'claim', text: 'A checkable statement.', status: 'supported', explanation: 'Evidence explanation.', atMs: 1000 };
  for (const url of ['javascript:alert(1)', 'file:///private/config', 'http://en.wikipedia.org/wiki/Sound', 'https://en.wikipedia.org.evil.example/wiki/Sound', 'https://example.com']) {
    const result = sanitizeClaim({ ...base, sources: [{ title: 'Untrusted', url }] });
    assert.equal(result.status, 'uncertain', `Reject ${url}`);
    assert.equal(result.sources.length, 0);
  }
  const good = sanitizeClaim({ ...base, sources: [{ title: 'Wikipedia — Sound', url: 'https://en.wikipedia.org/w/index.php?oldid=777' }, { title: 42, url: 'https://en.wikipedia.org/wiki/Sound' }] });
  assert.equal(good.status, 'supported');
  assert.equal(good.sources.length, 1);
  assert.equal(good.sources[0].title, 'Wikipedia — Sound');
});

test('unknown verdict statuses and malformed claims cannot enter the UI', () => {
  assert.equal(sanitizeClaim(null), null);
  assert.equal(sanitizeClaim({ id: 7, text: 'Claim', status: 'supported' }), null);
  assert.equal(sanitizeClaim({ id: '7', text: 'Claim', status: 'definitely-true' }), null);
  assert.equal(sanitizeClaim({ id: '7', text: {}, status: 'uncertain' }), null);
  assert.equal(sanitizeClaim({ id: '7', text: 'Claim', status: 'checking' }).status, 'checking');
});
