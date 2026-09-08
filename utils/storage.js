/**
 * OmniPass Storage & Domain Utility
 * Handles credential persistence, smart origin matching, and settings.
 */

const OmniStorage = (() => {
  const STORAGE_KEY_VAULT = 'omnipass_vault';
  const STORAGE_KEY_SETTINGS = 'omnipass_settings';

  const DEFAULT_SETTINGS = {
    enableOnHttp: true,
    showInlineIcon: true,
    autoSuggestOnFocus: true,
    promptToSaveOnSubmit: true,
    hideNativeOptions: true,
    theme: 'dark'
  };

  const DEFAULT_SEED_CREDENTIALS = [
    {
      id: 'demo_admin',
      title: 'Local Dev & Router Admin',
      origin: 'http://localhost:8899',
      hostname: 'localhost',
      protocol: 'http:',
      port: '8899',
      isInsecure: true,
      username: 'admin',
      password: 'Password123!',
      notes: 'Default admin account for dev & router testing',
      createdAt: 1710000000000,
      updatedAt: 1710000000000
    },
    {
      id: 'demo_dev',
      title: 'Internal Dev User',
      origin: 'http://127.0.0.1:8899',
      hostname: '127.0.0.1',
      protocol: 'http:',
      port: '8899',
      isInsecure: true,
      username: 'dev_user',
      password: 'SuperSecret2026!',
      notes: 'Developer test login',
      createdAt: 1710000000000,
      updatedAt: 1710000000000
    }
  ];

  /**
   * Identifies if a hostname is local / loopback.
   */
  function isLocalHost(host) {
    if (!host) return false;
    const h = host.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.startsWith('127.');
  }

  /**
   * Normalizes domain names (e.g. strips port or www).
   */
  function getBaseDomain(hostname) {
    if (!hostname) return '';
    const parts = hostname.toLowerCase().split('.');
    if (parts.length >= 2 && !isLocalHost(hostname)) {
      return parts.slice(-2).join('.');
    }
    return hostname.toLowerCase();
  }

  /**
   * Parses URL and extracts normalized domain metadata.
   */
  function parseUrl(urlStr) {
    try {
      const defaultUrl = (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href : 'http://localhost';
      const url = new URL(urlStr || defaultUrl);
      return {
        href: url.href,
        origin: url.origin,
        hostname: url.hostname,
        protocol: url.protocol,
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        isInsecure: url.protocol === 'http:',
        isLocal: isLocalHost(url.hostname)
      };
    } catch (e) {
      return {
        href: urlStr || '',
        origin: urlStr || '',
        hostname: urlStr || '',
        protocol: 'http:',
        port: '80',
        isInsecure: true,
        isLocal: true
      };
    }
  }

  /**
   * Retrieves all credentials from local storage (auto-seeds defaults if empty).
   */
  async function getAllCredentials() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_VAULT], async (result) => {
        let vault = result[STORAGE_KEY_VAULT];
        if (!Array.isArray(vault) || vault.length === 0) {
          vault = [...DEFAULT_SEED_CREDENTIALS];
          await new Promise((r) => chrome.storage.local.set({ [STORAGE_KEY_VAULT]: vault }, r));
        }
        resolve(vault);
      });
    });
  }

  /**
   * Checks whether a stored credential matches a given URL info object.
   */
  function isCredentialMatch(cred, info) {
    if (!cred) return false;

    // 1. Exact origin match
    if (cred.origin && cred.origin.toLowerCase() === info.origin.toLowerCase()) {
      return 3;
    }

    const credHost = (cred.hostname || '').toLowerCase();
    const infoHost = (info.hostname || '').toLowerCase();

    // 2. Both are local development/loopback addresses (localhost <-> 127.0.0.1)
    if (isLocalHost(credHost) && isLocalHost(infoHost)) {
      return 2;
    }

    // 3. Exact hostname match (e.g. across different ports)
    if (credHost === infoHost) {
      return 2;
    }

    // 4. Subdomain or base domain match
    if (credHost && infoHost) {
      const credBase = getBaseDomain(credHost);
      const infoBase = getBaseDomain(infoHost);
      if (credBase && infoBase && credBase === infoBase) {
        return 1;
      }
    }

    return 0;
  }

  /**
   * Retrieves structured credentials: matched vs others vs all.
   */
  async function getCredentialsSummaryForUrl(urlStr) {
    const info = parseUrl(urlStr);
    const vault = await getAllCredentials();

    const matched = [];
    const others = [];

    vault.forEach((item) => {
      const matchScore = isCredentialMatch(item, info);
      if (matchScore > 0) {
        matched.push({ item, score: matchScore });
      } else {
        others.push(item);
      }
    });

    // Sort matched by relevance score then by last used / updated
    matched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.item.updatedAt || 0) - (a.item.updatedAt || 0);
    });

    const sortedMatched = matched.map((m) => m.item);
    const sortedOthers = others.sort((a, b) => (b.updatedAt || 0) - (a.item?.updatedAt || 0));

    return {
      matched: sortedMatched,
      others: sortedOthers,
      all: [...sortedMatched, ...sortedOthers],
      info: info
    };
  }

  /**
   * Retrieves credentials matching a specific URL or hostname.
   */
  async function getCredentialsForUrl(urlStr) {
    const summary = await getCredentialsSummaryForUrl(urlStr);
    return summary.matched;
  }

  /**
   * Saves or updates a credential.
   */
  async function saveCredential(cred) {
    const vault = await getAllCredentials();
    const now = Date.now();
    const id = cred.id || 'cred_' + Math.random().toString(36).substring(2, 9) + '_' + now;

    const existingIndex = vault.findIndex((c) => c.id === id);
    const defaultUrl = (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href : 'http://localhost';
    const parsed = parseUrl(cred.origin || cred.url || defaultUrl);

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
        (c) =>
          c.origin === credentialData.origin &&
          (c.username || '').toLowerCase() === (credentialData.username || '').toLowerCase()
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
    isLocalHost,
    getBaseDomain,
    getAllCredentials,
    getCredentialsForUrl,
    getCredentialsSummaryForUrl,
    saveCredential,
    deleteCredential,
    markLastUsed,
    getSettings,
    saveSettings,
    exportVault,
    importVault,
    DEFAULT_SETTINGS,
    DEFAULT_SEED_CREDENTIALS
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OmniStorage;
}
