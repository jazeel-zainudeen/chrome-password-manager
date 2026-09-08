/**
 * OmniPass Background Service Worker
 * Manages tab updates, badge indicators, and message dispatch.
 */

importScripts('../utils/storage.js');

// Seed default demo credentials on install if vault is empty
chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await OmniStorage.getAllCredentials();
  if (!existing || existing.length === 0) {
    const sampleCredentials = [
      {
        id: 'sample_localhost',
        title: 'Local Dev Server',
        origin: 'http://localhost:8080',
        hostname: 'localhost',
        protocol: 'http:',
        port: '8080',
        isInsecure: true,
        username: 'admin',
        password: 'Password123!',
        notes: 'Demo credential for local HTTP test',
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        id: 'sample_router',
        title: 'Local Router Admin',
        origin: 'http://192.168.1.1',
        hostname: '192.168.1.1',
        protocol: 'http:',
        port: '80',
        isInsecure: true,
        username: 'admin',
        password: 'RouterSecurityPass2026',
        notes: 'Legacy HTTP router login',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    for (const cred of sampleCredentials) {
      await OmniStorage.saveCredential(cred);
    }
  }
});

// Update badge when tab changes or updates
async function updateTabBadge(tabId, url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }

  try {
    const creds = await OmniStorage.getCredentialsForUrl(url);
    const parsed = OmniStorage.parseUrl(url);
    const count = creds.length;

    if (count > 0) {
      chrome.action.setBadgeText({ tabId, text: count.toString() });
      if (parsed.isInsecure) {
        // Amber/Orange badge for insecure HTTP sites with saved creds
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#f59e0b' });
      } else {
        // Indigo badge for HTTPS
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
      }
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (err) {
    console.error('OmniPass: Failed to update badge', err);
  }
}

// Tab navigation & activation listeners
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
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

// Message listener for content script requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REFRESH_BADGE' && sender.tab) {
    updateTabBadge(sender.tab.id, sender.tab.url);
    sendResponse({ success: true });
  }
  return true;
});
