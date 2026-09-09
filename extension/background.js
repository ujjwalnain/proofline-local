const opening = new Set();
function youtube(value) { try { const url = new URL(value); return url.protocol === 'https:' && ['www.youtube.com', 'm.youtube.com'].includes(url.hostname); } catch { return false; } }

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !youtube(tab.url)) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'YT' });
    await chrome.action.setBadgeBackgroundColor({ color: '#414141' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'Open a YouTube video, then click Proofline.' });
    return;
  }
  if(opening.has(tab.id))return;
  opening.add(tab.id);
  try {
    // Recover from MV3 service-worker suspension without duplicating a running popup.
    const existing = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const page = chrome.runtime.getURL('panel.html');
    const match = existing.find(context => context.documentUrl === `${page}?tabId=${tab.id}`);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['source-watch.js'] });
    if (match?.windowId) { await chrome.windows.update(match.windowId, { focused: true }); return; }
    const parent = await chrome.windows.get(tab.windowId);
    await chrome.windows.create({
      type: 'popup', url: `${page}?tabId=${tab.id}`, focused: true,
      width: 430, height: Math.max(540, Math.min(760, (parent.height || 800) - 40)),
      left: Math.max(0, (parent.left || 0) + (parent.width || 1000) - 450),
      top: Math.max(0, (parent.top || 0) + 40),
    });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  } catch {
    await chrome.action.setTitle({ tabId: tab.id, title: 'Refresh YouTube, then click Proofline again.' });
  } finally { opening.delete(tab.id); }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !youtube(sender.url)) return;
  if (message.type === 'proofline:source-navigated') chrome.runtime.sendMessage({ type: 'proofline:stop-for-navigation', tabId: sender.tab.id }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.runtime.sendMessage({ type: 'proofline:stop-for-navigation', tabId }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.status==='loading'||change.url)chrome.runtime.sendMessage({type:'proofline:stop-for-navigation',tabId}).catch(()=>{});
});
