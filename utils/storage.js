/**
 * OmniPass Storage & Domain Utility
 * Handles credential persistence, origin matching, and settings.
 */

const OmniStorage = (() => {
  const STORAGE_KEY_VAULT = 'omnipass_vault';
  const STORAGE_KEY_SETTINGS = 'omnipass_settings';

  const DEFAULT_SETTINGS = {
    enableOnHttp: true,
    showInlineIcon: true,
    autoSuggestOnFocus: true,
    promptToSaveOnSubmit: true,
    theme: 'dark'
  };

  /**
   * Parses URL and extracts normalized domain metadata.
   */
  function parseUrl(urlStr) {
    try {
      const url = new URL(urlStr || window.location.href);
      return {
        href: url.href,
        origin: url.origin,
        hostname: url.hostname,
        protocol: url.protocol,
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        isInsecure: url.protocol === 'http:'
      };
    } catch (e) {
      return {
        href: urlStr || '',
        origin: urlStr || '',
        hostname: urlStr || '',
        protocol: 'http:',
        port: '80',
        isInsecure: true
      };
    }
  }

  /**
   * Retrieves all credentials from local storage.
   */
  async function getAllCredentials() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_VAULT], (result) => {
        const vault = result[STORAGE_KEY_VAULT] || [];
        resolve(vault);
      });
    });
  }

  /**
   * Retrieves credentials matching a specific URL or hostname.
   */
  async function getCredentialsForUrl(urlStr) {
    const info = parseUrl(urlStr);
    const vault = await getAllCredentials();

    return vault.filter((item) => {
      if (!item) return false;
      // Match exact origin first
      if (item.origin && item.origin === info.origin) {
        return true;
      }
      // Match hostname (e.g. IP or localhost across different ports if user desires)
      if (item.hostname && item.hostname === info.hostname) {
        return true;
      }
      return false;
    }).sort((a, b) => {
      // Prioritize exact origin match
      const aExact = a.origin === info.origin ? 1 : 0;
      const bExact = b.origin === info.origin ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      // Then prioritize recently updated
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  /**
   * Saves or updates a credential.
   */
  async function saveCredential(cred) {
    const vault = await getAllCredentials();
    const now = Date.now();
    const id = cred.id || 'cred_' + Math.random().toString(36).substring(2, 9) + '_' + now;

    const existingIndex = vault.findIndex((c) => c.id === id);
    const parsed = parseUrl(cred.origin || cred.url || window.location.href);

    const credentialData = {
      id: id,
      title: cred.title || parsed.hostname || 'Untitled Account',
      origin: cred.origin || parsed.origin,
      hostname: cred.hostname || parsed.hostname,
      protocol: cred.protocol || parsed.protocol,
      port: cred.port || parsed.port,
      isInsecure: (cred.protocol || parsed.protocol) === 'http:',
      username: cred.username || '',
      password: cred.password || '',
      notes: cred.notes || '',
      createdAt: cred.createdAt || now,
      updatedAt: now,
      lastUsed: cred.lastUsed || 0
    };

    if (existingIndex >= 0) {
      vault[existingIndex] = { ...vault[existingIndex], ...credentialData, updatedAt: now };
    } else {
      // Check if duplicate for same origin + username exists
      const duplicateIndex = vault.findIndex(
        (c) => c.origin === credentialData.origin && c.username.toLowerCase() === credentialData.username.toLowerCase()
      );
      if (duplicateIndex >= 0) {
        vault[duplicateIndex] = {
          ...vault[duplicateIndex],
          ...credentialData,
          id: vault[duplicateIndex].id,
          updatedAt: now
        };
      } else {
        vault.unshift(credentialData);
      }
    }

    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_VAULT]: vault }, () => {
        resolve(credentialData);
      });
    });
  }

  /**
   * Deletes a credential by ID.
   */
  async function deleteCredential(id) {
    const vault = await getAllCredentials();
    const filtered = vault.filter((c) => c.id !== id);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_VAULT]: filtered }, () => {
        resolve(true);
      });
    });
  }

  /**
   * Updates lastUsed timestamp for a credential.
   */
  async function markLastUsed(id) {
    const vault = await getAllCredentials();
    const index = vault.findIndex((c) => c.id === id);
    if (index >= 0) {
      vault[index].lastUsed = Date.now();
      await new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY_VAULT]: vault }, resolve);
      });
    }
  }

  /**
   * Retrieves extension settings.
   */
  async function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_SETTINGS], (result) => {
        resolve({ ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY_SETTINGS] || {}) });
      });
    });
  }

  /**
   * Saves extension settings.
   */
  async function saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings }, () => {
        resolve(settings);
      });
    });
  }

  /**
   * Exports vault to a JSON string.
   */
  async function exportVault() {
    const vault = await getAllCredentials();
    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      vault: vault
    };
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Imports credentials from JSON.
   */
  async function importVault(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      const incoming = Array.isArray(data) ? data : data.vault;
      if (!Array.isArray(incoming)) {
        throw new Error('Invalid vault structure: must contain an array of credentials');
      }

      let count = 0;
      for (const item of incoming) {
        if (item.username || item.password) {
          await saveCredential(item);
          count++;
        }
      }
      return { success: true, count };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return {
    parseUrl,
    getAllCredentials,
    getCredentialsForUrl,
    saveCredential,
    deleteCredential,
    markLastUsed,
    getSettings,
    saveSettings,
    exportVault,
    importVault,
    DEFAULT_SETTINGS
  };
})();

// Export for module or global context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OmniStorage;
}
