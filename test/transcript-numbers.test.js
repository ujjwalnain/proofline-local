import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalChecker } from '../extension/local-checker.js';

async function extractClaim(t, text, claim) {
  const events = [];
  let searches = 0;
  const checker = new LocalChecker({
    session: {
      async clone() {
        return {
          async prompt() { return JSON.stringify({ claim, query: 'pi', complete: true }); },
          destroy() {},
        };
      },
    },
    emit: event => events.push(event),
    fetchImpl: async () => {
      searches++;
      return new Response(JSON.stringify({ query: { search: [] } }));
    },
  });
  t.after(() => checker.close());
  checker.add({ id: 'numeric-claim', text, atMs: 1200 });
  await checker.finish();
  return { searches, claims: events.filter(event => event.type === 'claim').map(event => event.claim) };
}

test('extraction rejects a decimal suffix presented as a whole number', async t => {
  for (const number of ['3.14', '-3.14', '+3.14']) {
    const result = await extractClaim(t, `${number} is the value of pi.`, '14 is the value of pi.');
    assert.deepEqual(result.claims, [], number);
    assert.equal(result.searches, 0, 'changed numbers must be rejected before evidence lookup');
  }
});

test('extraction still rejects a decimal prefix presented as a whole number', async t => {
  const result = await extractClaim(t, 'The value of pi is 3.14.', 'The value of pi is 3.');
  assert.deepEqual(result.claims, []);
  assert.equal(result.searches, 0);
});

test('extraction preserves complete decimal claims and sentence punctuation', async t => {
  for (const text of ['3.14 is the value of pi.', 'The value of pi is 3.14.']) {
    const result = await extractClaim(t, text, text);
    assert.equal(result.searches, 1);
    assert.equal(result.claims[0].text, text);
    assert.equal(result.claims[0].atMs, 1200);
  }
});

test('a rejected decimal suffix does not hide a later whole-number match', async t => {
  const text = '3.14 is the value of pi. 14 is the value of pi.';
  const result = await extractClaim(t, text, '14 is the value of pi.');
  assert.equal(result.searches, 1);
  assert.equal(result.claims[0].text, '14 is the value of pi.');
});
