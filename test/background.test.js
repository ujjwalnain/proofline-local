import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const EXTENSION_ID = 'a'.repeat(32);
const PANEL = `chrome-extension://${EXTENSION_ID}/panel.html`;
const YOUTUBE_TAB = { id: 42, url: 'https://www.youtube.com/watch?v=example', windowId: 1 };

function fixture({ contexts = [], contextsPromise = null } = {}) {
  const handlers = {}, messages = [], scripts = [], created = [], focused = [], badges = [], titles = [];
  const currentContexts = [...contexts];
  const context = {
    URL, Map, Set,
    chrome: {
      action: {
        onClicked: { addListener: listener => { handlers.click = listener; } },
        setBadgeText: async item => { badges.push(item); }, setBadgeBackgroundColor: async () => {},
        setTitle: async item => { titles.push(item); },
      },
      runtime: {
        id: EXTENSION_ID, getURL: () => PANEL,
        getContexts: async () => contextsPromise || currentContexts,
        sendMessage: async message => { messages.push(message); },
        onMessage: { addListener: listener => { handlers.message = listener; } },
      },
      scripting: { executeScript: async options => { scripts.push(options); } },
      windows: {
        get: async () => ({ left: 0, top: 0, width: 1200, height: 800 }),
        update: async (id, options) => { focused.push({ id, options }); },
        create: async options => { created.push(options); currentContexts.push({ documentUrl: options.url, windowId: 11 }); return { id: 11 }; },
      },
      tabs: {
        onRemoved: { addListener: listener => { handlers.removed = listener; } },
        onUpdated: { addListener: listener => { handlers.updated = listener; } },
      },
    },
  };
  vm.runInNewContext(source, context, { filename: 'extension/background.js' });
  return { handlers, messages, scripts, created, focused, badges, titles };
}

test('toolbar opens the companion only on allowed HTTPS YouTube hosts', async () => {
  for (const url of ['http://www.youtube.com/watch?v=1', 'https://www.youtube.com.evil.example/watch?v=1', 'https://example.com', 'javascript:alert(1)', 'not-a-url']) {
    const value = fixture();
    await value.handlers.click({ ...YOUTUBE_TAB, url });
    assert.equal(value.scripts.length, 0, `Must not inject on ${url}`);
    assert.equal(value.created.length, 0);
    assert.equal(value.badges[0].text, 'YT');
  }
  for (const url of ['https://www.youtube.com/watch?v=1', 'https://m.youtube.com/watch?v=1']) {
    const value = fixture();
    await value.handlers.click({ ...YOUTUBE_TAB, url });
    assert.equal(value.scripts.length, 1);
    assert.equal(value.created.length, 1);
    assert.equal(value.created[0].type, 'popup');
    assert.equal(value.created[0].url, `${PANEL}?tabId=42`);
  }
});

test('reusing an existing popup reinjects navigation watcher without creating a duplicate', async () => {
  const value = fixture({ contexts: [{ documentUrl: `${PANEL}?tabId=42`, windowId: 11 }] });
  await value.handlers.click(YOUTUBE_TAB);
  assert.equal(value.scripts.length, 1, 'A full source reload removes the old injected watcher');
  assert.equal(value.scripts[0].target.tabId, 42);
  assert.equal(value.scripts[0].files[0], 'source-watch.js');
  assert.equal(value.created.length, 0);
  assert.equal(value.focused[0].id, 11);
});

test('rapid repeated toolbar clicks create only one popup', async () => {
  let resolve;
  const contextsPromise = new Promise(done => { resolve = done; });
  const value = fixture({ contextsPromise });
  const first = value.handlers.click(YOUTUBE_TAB);
  const second = value.handlers.click(YOUTUBE_TAB);
  resolve([]);
  await Promise.all([first, second]);
  assert.equal(value.created.length, 1);
  assert.equal(value.scripts.length, 1);
});

test('content navigation messages require own extension identity and an allowed YouTube sender', () => {
  const value = fixture();
  const message = { type: 'proofline:source-navigated' };
  const sender = { id: EXTENSION_ID, tab: { id: 42 }, url: YOUTUBE_TAB.url };
  value.handlers.message(message, { ...sender, id: 'b'.repeat(32) });
  value.handlers.message(message, { ...sender, url: 'https://www.youtube.com.evil.example/' });
  value.handlers.message(message, { ...sender, tab: undefined });
  value.handlers.message({ type: 'unexpected' }, sender);
  assert.equal(value.messages.length, 0);
  value.handlers.message(message, sender);
  assert.equal(value.messages.length, 1);
  assert.equal(value.messages[0].type, 'proofline:stop-for-navigation');
  assert.equal(value.messages[0].tabId, 42);
});

test('tab reload, URL navigation and closure remain covered after content-script replacement', () => {
  const value = fixture();
  // No content-script message is available after a complete page replacement.
  value.handlers.updated(42, { status: 'loading' });
  value.handlers.updated(42, { url: 'https://www.youtube.com/watch?v=next' });
  value.handlers.updated(42, { url: 'https://example.com/' });
  value.handlers.removed(42);
  assert.equal(value.messages.length, 4);
  assert.ok(value.messages.every(message => message.type === 'proofline:stop-for-navigation' && message.tabId === 42));
  value.handlers.updated(42, { status: 'complete' });
  value.handlers.updated(42, { title: 'Updated stream title' });
  assert.equal(value.messages.length, 4, 'Title and completion updates must not interrupt a running check');
});
