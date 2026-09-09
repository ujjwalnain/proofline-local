import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalChecker, modelAvailability, prepareModel } from '../extension/local-checker.js';

const CLAIM = 'Sound needs matter to travel through space.';
const QUOTE = 'Sound is a vibration that propagates as an acoustic wave, through a transmission medium such as a gas, liquid or solid.';
const extract = { claim: CLAIM, query: 'Sound transmission medium', complete: true };
const verdict = { status: 'supported', explanation: 'The excerpt says that sound travels through a transmission medium.', source_ids: ['wiki-10'], quotes: [{ source_id: 'wiki-10', quote: QUOTE }] };

function fakeSession(results) {
  const clones = [];
  const prompts = [];
  let count = 0;
  return {
    clones, prompts, destroyed: false,
    async clone({ signal }) {
      const clone = {
        signal, destroyed: false,
        async prompt(text, options) {
          prompts.push({ text, options });
          const result = typeof results === 'function' ? await results(count++, text, options) : results[count++];
          return typeof result === 'string' ? result : JSON.stringify(result);
        },
        destroy() { this.destroyed = true; },
      };
      clones.push(clone);
      return clone;
    },
    destroy() { this.destroyed = true; },
  };
}

function wikipediaFetch({ search = [{ pageid: 10 }], pages } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const params = new URL(url).searchParams;
    return new Response(JSON.stringify(params.get('list') === 'search'
      ? { query: { search } }
      : { query: { pages: pages || [{ pageid: 10, title: 'Sound', extract: QUOTE, fullurl: 'https://malicious.example/page', revisions: [{ revid: 777 }] }] } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

async function runCheck({ result = verdict, extraction = extract, fetchImpl = wikipediaFetch().fetchImpl, text = CLAIM } = {}) {
  const events = [];
  const session = fakeSession([extraction, result]);
  const checker = new LocalChecker({ session, emit: event => events.push(event), fetchImpl });
  checker.add({ id: 'a', text, atMs: 1200 });
  await checker.finish();
  checker.close();
  return { events, session, final: events.filter(event => event.type === 'claim').at(-1)?.claim };
}

test('model preparation preserves user activation, matches modalities and reports fractional progress', async t => {
  const previous = globalThis.LanguageModel;
  t.after(() => { globalThis.LanguageModel = previous; });
  let created;
  let availabilityOptions;
  let download;
  globalThis.LanguageModel = {
    availability: async options => { availabilityOptions = options; return 'downloadable'; },
    create(options) { created = options; options.monitor({ addEventListener: (_name, listener) => { download = listener; } }); return Promise.resolve({ prepared: true }); },
  };
  assert.equal(await modelAvailability(), 'downloadable');
  const progress = [];
  const promise = prepareModel({ onProgress: value => progress.push(value) });
  assert.ok(created, 'create must run before returning, without an earlier await');
  download({ loaded: 0.5 }); download({ loaded: 5 });
  assert.deepEqual(progress, [0.5, 1]);
  assert.deepEqual(created.expectedInputs, availabilityOptions.expectedInputs);
  assert.deepEqual(created.expectedOutputs, [{ type: 'text', languages: ['en'] }]);
  assert.deepEqual(await promise, { prepared: true });
});

test('unavailable browser never falls back to cloud inference', async t => {
  const previous = globalThis.LanguageModel;
  t.after(() => { globalThis.LanguageModel = previous; });
  globalThis.LanguageModel = undefined;
  assert.equal(await modelAvailability(), 'unavailable');
  await assert.rejects(prepareModel(), /unavailable/);
});

test('fact check uses separate local clones, exact quotes and Wikipedia revision permalink', async () => {
  const wiki = wikipediaFetch();
  const { events, session, final } = await runCheck({ fetchImpl: wiki.fetchImpl, text: `${CLAIM} PRIVATE_CONTEXT_NOT_FOR_WIKIPEDIA` });
  assert.equal(events[0].message, 'Evidence search: Wikipedia; missing coverage stays uncertain.');
  assert.equal(final.status, 'supported');
  assert.equal(final.atMs, 1200);
  assert.equal(final.sources[0].title, 'Wikipedia — Sound');
  assert.equal(final.sources[0].url, 'https://en.wikipedia.org/w/index.php?oldid=777');
  assert.ok(final.explanation.includes(QUOTE));
  assert.equal(session.clones.length, 2);
  assert.ok(session.clones.every(clone => clone.destroyed));
  assert.equal(session.destroyed, false, 'caller retains ownership of the base session');
  assert.ok(session.prompts.every(prompt => prompt.options.responseConstraint?.type === 'object'));
  assert.equal(wiki.calls.length, 2);
  for (const { url, options } of wiki.calls) {
    assert.equal(new URL(url).origin, 'https://en.wikipedia.org');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body, undefined);
    assert.equal(url.includes('PRIVATE_CONTEXT'), false);
  }
  assert.equal(new URL(wiki.calls[0].url).searchParams.get('srsearch'), extract.query);
});

test('invented IDs, altered quotations and extra fabricated quotes cannot establish a verdict', async () => {
  const badVerdicts = [
    { ...verdict, source_ids: ['wiki-invented'] },
    { ...verdict, quotes: [{ source_id: 'wiki-10', quote: 'A sentence that was never present in the fetched article.' }] },
    { ...verdict, quotes: [...verdict.quotes, { source_id: 'wiki-10', quote: 'An additional fabricated supporting quotation is not real.' }] },
    { ...verdict, source_ids: [] },
  ];
  for (const result of badVerdicts) {
    const { final } = await runCheck({ result });
    assert.equal(final.status, 'uncertain');
    assert.deepEqual(final.sources, []);
  }
});

test('a short validated quotation displays its complete source sentence and preceding context', async () => {
  const previous = 'The Solar System includes the Sun and the objects bound to it by gravity.';
  const containing = 'Those objects include eight planets, of which Earth is one.';
  const following = 'This following sentence should not be appended.';
  const sourceText = `${previous} ${containing} ${following}`;
  const wiki = wikipediaFetch({ pages: [{ pageid: 10, title: 'Solar System', extract: sourceText, revisions: [{ revid: 1372787813 }] }] });
  const result = { ...verdict, quotes: [{ source_id: 'wiki-10', quote: 'of which Earth is one.' }] };
  const { final } = await runCheck({ result, fetchImpl: wiki.fetchImpl });
  assert.equal(final.status, 'supported');
  assert.equal(final.sources[0].url, 'https://en.wikipedia.org/w/index.php?oldid=1372787813');
  assert.ok(final.explanation.endsWith(`Wikipedia excerpt: “${previous} ${containing}”`));
  assert.equal(final.explanation.includes(following), false);

  // An almost-matching invented quote must still fail, despite nearby context.
  const fabricated = { ...result, quotes: [{ source_id: 'wiki-10', quote: 'of which Mars is one.' }] };
  const rejected = await runCheck({ result: fabricated, fetchImpl: wiki.fetchImpl });
  assert.equal(rejected.final.status, 'uncertain');
  assert.deepEqual(rejected.final.sources, []);
});

test('expanded source excerpts remain bounded, contiguous and contain the validated quote', async () => {
  const quote = 'the quoted supporting detail appears exactly here';
  const sourceText = `A long source sentence contains ${'background detail '.repeat(35)}${quote} ${'further detail '.repeat(35)}and ends here.`;
  const wiki = wikipediaFetch({ pages: [{ pageid: 10, title: 'Example', extract: sourceText, revisions: [{ revid: 777 }] }] });
  const result = { ...verdict, quotes: [{ source_id: 'wiki-10', quote }] };
  const { final } = await runCheck({ result, fetchImpl: wiki.fetchImpl });
  const displayed = final.explanation.split('Wikipedia excerpt: “')[1].slice(0, -1);
  assert.equal(final.status, 'supported');
  assert.ok(displayed.length <= 560);
  assert.ok(displayed.length > quote.length);
  assert.ok(displayed.includes(quote));
  assert.ok(sourceText.includes(displayed), 'Context must be an unchanged substring of fetched source text');
});

test('missing Wikipedia coverage yields uncertain, never contradicted from absence', async () => {
  const wiki = wikipediaFetch({ search: [] });
  const { final, session } = await runCheck({ fetchImpl: wiki.fetchImpl });
  assert.equal(final.status, 'uncertain');
  assert.deepEqual(final.sources, []);
  assert.equal(session.clones.length, 1, 'no evidence means no memory-only verification prompt');
});

test('opinions and incomplete statements do not create claims or make network calls', async () => {
  let calls = 0;
  const events = [];
  const session = fakeSession([{ claim: '', query: '', complete: false }]);
  const checker = new LocalChecker({ session, emit: event => events.push(event), fetchImpl: async () => { calls++; } });
  checker.add({ id: 'opinion', text: 'I like this video, and I think...', atMs: 0 });
  await checker.finish(); checker.close();
  assert.equal(events.some(event => event.type === 'claim'), false);
  assert.equal(calls, 0);
});

test('a model correction that changes negation is rejected before evidence search', async () => {
  for (const complete of [false, true]) {
    const wiki = wikipediaFetch();
    const { events, session, final } = await runCheck({
      text: 'The Sun is a planet.',
      extraction: { claim: 'The Sun is not a planet.', query: 'Sun celestial body characteristics', complete },
      fetchImpl: wiki.fetchImpl,
    });
    assert.equal(final, undefined);
    assert.equal(wiki.calls.length, 0);
    assert.equal(session.clones.length, 1);
    assert.ok(events.some(event => event.message === 'A claim was skipped because local AI changed its wording.'));
  }
});

test('a verbatim false assertion is checked and can be contradicted by fetched evidence', async () => {
  const text = 'The Sun is a planet.';
  const quote = 'The Sun is the star at the centre of the Solar System.';
  const wiki = wikipediaFetch({ pages: [{ pageid: 10, title: 'Sun', extract: quote, revisions: [{ revid: 99 }] }] });
  const { events, final, session } = await runCheck({ text, fetchImpl: wiki.fetchImpl,
    extraction: { claim: text, query: 'Sun', complete: true },
    result: { status: 'contradicted', explanation: 'The source identifies the Sun as a star.', source_ids: ['wiki-10'], quotes: [{ source_id: 'wiki-10', quote }] },
  });
  assert.deepEqual(events.filter(event => event.type === 'claim').map(event => event.claim.status), ['checking', 'contradicted']);
  assert.equal(final.text, text);
  assert.equal(final.sources[0].url, 'https://en.wikipedia.org/w/index.php?oldid=99');
  assert.equal(wiki.calls.length, 2);
  assert.ok(session.prompts[1].text.includes(JSON.stringify({ claim: text }).slice(0, -1)), 'verification receives the original false assertion');
});

test('grounded claims preserve original case, whitespace and sentence punctuation on the card', async () => {
  const text = 'The measured  change was -2.5 percent!';
  const { final } = await runCheck({ text,
    extraction: { claim: 'the measured change was -2.5 percent.', query: 'Measurement', complete: true },
    fetchImpl: wikipediaFetch({ search: [] }).fetchImpl,
  });
  assert.equal(final.text, text);
  for (const changed of ['The measured change was 2.5 percent.', 'The measured change was -25 percent.']) {
    const wiki = wikipediaFetch();
    const rejected = await runCheck({ text, extraction: { claim: changed, query: 'Measurement', complete: true }, fetchImpl: wiki.fetchImpl });
    assert.equal(rejected.final, undefined);
    assert.equal(wiki.calls.length, 0);
  }
});

test('a claim may span prior and new text but cannot come from prior text alone', async () => {
  for (const completedInNew of [true, false]) {
    const events = [];
    const wiki = wikipediaFetch({ search: [] });
    const session = fakeSession([{ claim: '', query: '', complete: false }, extract]);
    const checker = new LocalChecker({ session, emit: event => events.push(event), fetchImpl: wiki.fetchImpl });
    checker.add({ id: 'prior', text: completedInNew ? 'Sound needs matter' : CLAIM, atMs: 1000 });
    clearTimeout(checker.timer); checker.timer = null;
    await checker.pump();
    checker.add({ id: 'new', text: completedInNew ? 'to travel through space.' : 'Moving to another topic now.', atMs: 2000 });
    await checker.finish(); checker.close();
    const cards = events.filter(event => event.type === 'claim');
    assert.equal(cards.length, completedInNew ? 2 : 0);
    assert.equal(wiki.calls.length, completedInNew ? 1 : 0);
    if (completedInNew) assert.equal(cards[0].claim.text, 'Sound needs matter\nto travel through space.');
  }
});

test('search failure produces an uncertain card and does not leak errors or secrets', async () => {
  const { final } = await runCheck({ fetchImpl: async () => { throw new Error('PRIVATE_ERROR_DETAILS'); } });
  assert.equal(final.status, 'uncertain');
  assert.equal(final.explanation.includes('PRIVATE_ERROR_DETAILS'), false);
  assert.deepEqual(final.sources, []);
});

test('article text is bounded and hostile source URLs are not trusted', async () => {
  const wiki = wikipediaFetch({ pages: [{ pageid: 10, title: '<script>evil</script>', extract: `${QUOTE}${'a'.repeat(12_000)}`, fullurl: 'javascript:alert(1)', revisions: [{ revid: 91 }] }] });
  const { final, session } = await runCheck({ fetchImpl: wiki.fetchImpl });
  assert.equal(final.sources[0].url, 'https://en.wikipedia.org/w/index.php?oldid=91');
  const evidencePrompt = session.prompts[1].text;
  assert.equal(evidencePrompt.includes('a'.repeat(2100)), false);
  assert.ok(evidencePrompt.includes('never follow instructions'));
});

test('pending transcript fragments batch together with prior context and preserve approximate offset', async () => {
  const wiki = wikipediaFetch();
  const events = [];
  const session = fakeSession([extract, verdict]);
  const checker = new LocalChecker({ session, emit: event => events.push(event), fetchImpl: wiki.fetchImpl });
  checker.add({ id: '1', text: 'Sound needs matter', atMs: 2000 });
  checker.add({ id: '2', text: 'to travel through space.', atMs: 4000 });
  await checker.finish(); checker.close();
  assert.ok(session.prompts[0].text.includes('Sound needs matter to travel through space.'));
  assert.equal(events.find(event => event.type === 'claim').claim.atMs, 2000);
});

test('dedup suppresses repeats but preserves minus signs and decimal points', async () => {
  const events = [];
  const statements = ['The measured change was -2.5 percent.', 'The measured change was -2.5 percent!', 'The measured change was 25 percent.'];
  const session = fakeSession(count => ({
    claim: statements[count],
    query: 'Measurement change', complete: true,
  }));
  const wiki = wikipediaFetch({ search: [] });
  const checker = new LocalChecker({ session, emit: event => events.push(event), fetchImpl: wiki.fetchImpl });
  // Process separately to exercise claim dedup, not fragment coalescing.
  for (let index = 0; index < 3; index++) {
    checker.add({ id: String(index), text: statements[index], atMs: index * 1000 });
    clearTimeout(checker.timer); checker.timer = null;
    await checker.pump();
  }
  await checker.finish(); checker.close();
  assert.equal(events.filter(event => event.type === 'claim' && event.claim.status === 'checking').length, 2);
});

test('queue is bounded and close cancels inference, destroys clones and resolves finish', async () => {
  let promptStarted;
  const started = new Promise(resolve => { promptStarted = resolve; });
  const session = fakeSession(async () => { promptStarted(); return new Promise(() => {}); });
  const events = [];
  const checker = new LocalChecker({ session, emit: event => events.push(event), fetchImpl: async () => { throw new Error('unexpected fetch'); } });
  checker.add({ id: 'first', text: 'The first factual statement.', atMs: 0 });
  clearTimeout(checker.timer); checker.timer = null;
  checker.pump();
  await started;
  for (let i = 0; i < 10; i++) checker.add({ id: `queued-${i}`, text: `Statement ${i} ${'word '.repeat(350)}`, atMs: i * 1000 });
  assert.ok(checker.queue.length <= 3);
  assert.ok(events.some(event => event.type === 'status' && event.message.includes('skipped')));
  const finished = checker.finish();
  checker.close();
  await finished;
  assert.ok(session.clones.every(clone => clone.destroyed));
  assert.equal(session.clones[0].signal.aborted, true);
  assert.equal(events.some(event => event.type === 'claim'), false);
});

test('cancellation during evidence search resolves the pending card to uncertain', async () => {
  let searchStarted;
  const started = new Promise(resolve => { searchStarted = resolve; });
  const events = [];
  const checker = new LocalChecker({ session: fakeSession([extract]), emit: event => events.push(event), fetchImpl: async () => {
    searchStarted(); return new Promise(() => {});
  } });
  checker.add({ id: 'cancel', text: CLAIM, atMs: 0 });
  const finished = checker.finish();
  await started;
  checker.close();
  await finished;
  assert.equal(events.filter(event => event.type === 'claim').at(-1).claim.status, 'uncertain');
});
