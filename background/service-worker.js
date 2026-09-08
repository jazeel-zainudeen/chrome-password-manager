/**
 * OmniPass Background Service Worker
 * Manages tab updates, badge indicators, and message dispatch.
 */

importScripts('/utils/storage.js');

// Seed default demo credentials and sync decrypted Chrome passwords on install
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await OmniStorage.syncChromePasswords();
    await OmniStorage.getAllCredentials();
  } catch (err) {
    console.warn('OmniPass: Failed to sync passwords on install', err);
  }
});

// Also ensure sync on browser startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    await OmniStorage.syncChromePasswords();
  } catch (err) {
    console.warn('OmniPass: Failed to sync on startup', err);
  }
});

// Update badge when tab changes or updates
async function updateTabBadge(tabId, url) {
  if (!tabId || typeof tabId !== 'number' || tabId < 0) return;

  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    try {
      await chrome.action.setBadgeText({ tabId, text: '' });
    } catch (e) {}
    return;
  }

  try {
    const creds = await OmniStorage.getCredentialsForUrl(url);
    const parsed = OmniStorage.parseUrl(url);
    const count = creds ? creds.length : 0;

    if (count > 0) {
      await chrome.action.setBadgeText({ tabId, text: count.toString() });
      if (parsed.isInsecure) {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: '#f59e0b' });
      } else {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
      }
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (err) {
    // Tab might have been closed or detached
  }
}

// Tab navigation & activation listeners
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url) {
    updateTabBadge(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
      updateTabBadge(tab.id, tab.url);
    }
  } catch (e) {
    // Tab might be closed
  }
});

// Message listener for content script and popup requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REFRESH_BADGE') {
    if (sender && sender.tab && sender.tab.id && sender.tab.url) {
      updateTabBadge(sender.tab.id, sender.tab.url);
      sendResponse({ success: true });
    } else {
      // Triggered from popup
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs && tabs[0] && tabs[0].id && tabs[0].url) {
          updateTabBadge(tabs[0].id, tabs[0].url);
        }
      }).catch(() => {});
      sendResponse({ success: true });
    }
    return true;
  }
  return false;
});
