/**
 * Passwords Popup UI Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  let currentTab = null;
  let currentUrlInfo = null;
  let activeVaultFilter = 'all';

  // UI Elements
  const headerSiteName = document.getElementById('header-site-name');
  const headerSiteBadge = document.getElementById('header-site-badge');
  const currentDomainTitle = document.getElementById('current-domain-title');
  const currentSecurityTag = document.getElementById('current-security-tag');
  const currentInsecureNote = document.getElementById('current-insecure-note');
  const currentCredsContainer = document.getElementById('current-creds-container');
  const allCredsContainer = document.getElementById('all-creds-container');
  const toastEl = document.getElementById('popup-toast');

  // Generator Elements
  const genResult = document.getElementById('gen-result');
  const genLengthSlider = document.getElementById('gen-length-slider');
  const genLengthIndicator = document.getElementById('gen-length-indicator');
  const genStrengthFill = document.getElementById('gen-strength-fill');
  const genStrengthText = document.getElementById('gen-strength-text');
  const genUpper = document.getElementById('gen-upper');
  const genLower = document.getElementById('gen-lower');
  const genNumbers = document.getElementById('gen-numbers');
  const genSymbols = document.getElementById('gen-symbols');
  const btnRegenerate = document.getElementById('btn-regenerate');
  const btnCopyGenerated = document.getElementById('btn-copy-generated');

  // Form elements
  const btnShowAddCurrent = document.getElementById('btn-show-add-current');
  const formCurrentAdd = document.getElementById('form-current-add');
  const btnCancelAdd = document.getElementById('btn-cancel-add');
  const inputUsername = document.getElementById('input-username');
  const inputPassword = document.getElementById('input-password');
  const btnToggleInputPass = document.getElementById('btn-toggle-input-pass');
  const btnFillGenerated = document.getElementById('btn-fill-generated');

  // Vault elements
  const vaultSearchInput = document.getElementById('vault-search-input');
  const filterChips = document.querySelectorAll('.filter-chip');
  const countAll = document.getElementById('count-all');
  const countInsecure = document.getElementById('count-insecure');
  const countSecure = document.getElementById('count-secure');

  // Settings elements
  const settingEnableHttp = document.getElementById('setting-enable-http');
  const settingAutoSuggest = document.getElementById('setting-auto-suggest');
  const settingPromptSave = document.getElementById('setting-prompt-save');
  const settingHideNative = document.getElementById('setting-hide-native');
  const btnExportVault = document.getElementById('btn-export-vault');
  const inputImportFile = document.getElementById('input-import-file');

  // Tab Navigation
  const navTabs = document.querySelectorAll('.nav-tab');
  const tabContents = document.querySelectorAll('.tab-content');

  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;
      navTabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(targetId)?.classList.add('active');

      if (targetId === 'tab-vault') {
        renderVaultList();
      } else if (targetId === 'tab-generator') {
        updateGeneratedPassword();
      }
    });
  });

  // Get active browser tab
  async function initActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length > 0) {
        currentTab = tabs[0];
        currentUrlInfo = OmniStorage.parseUrl(currentTab.url);

        const hostname = currentUrlInfo.hostname || 'Local Browser';
        const port = currentUrlInfo.port && currentUrlInfo.port !== '80' && currentUrlInfo.port !== '443' ? `:${currentUrlInfo.port}` : '';
        const displayHost = `${hostname}${port}`;

        headerSiteName.textContent = displayHost;
        currentDomainTitle.textContent = displayHost;

        const dot = headerSiteBadge.querySelector('.status-dot');

        if (currentUrlInfo.isInsecure) {
          dot.className = 'status-dot insecure';
          currentSecurityTag.className = 'security-tag insecure';
          currentSecurityTag.textContent = 'HTTP Insecure';
          currentInsecureNote.style.display = 'block';
        } else {
          dot.className = 'status-dot secure';
          currentSecurityTag.className = 'security-tag secure';
          currentSecurityTag.textContent = 'HTTPS Secure';
          currentInsecureNote.style.display = 'none';
        }
      }
    } catch (err) {
      console.warn('Failed to query tab', err);
      currentUrlInfo = { hostname: 'unknown', origin: 'unknown', isInsecure: true };
    }
  }

  // Load and render credentials for active tab
  async function renderCurrentSiteCredentials() {
    if (!currentUrlInfo) return;
    const creds = await OmniStorage.getCredentialsForUrl(currentUrlInfo.origin || currentUrlInfo.href);
    currentCredsContainer.innerHTML = '';

    if (creds.length === 0) {
      currentCredsContainer.innerHTML = `
        <div class="empty-view">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <div class="empty-view-title">No saved logins for this site</div>
          <p style="font-size: 11px; margin-top: 4px;">Add a login above to enable one-click autofill.</p>
        </div>
      `;
      return;
    }

    creds.forEach((cred) => {
      const card = createCredentialCard(cred, true);
      currentCredsContainer.appendChild(card);
    });
  }

  // Helper to construct credential card element
  function createCredentialCard(cred, showFillButton) {
    const card = document.createElement('div');
    card.className = 'cred-card';

    const firstLetter = (cred.username ? cred.username[0] : 'U').toUpperCase();
    const isInsecure = cred.isInsecure || cred.protocol === 'http:';

    card.innerHTML = `
      <div class="cred-card-main">
        <div class="cred-user-wrap">
          <div class="cred-avatar">${firstLetter}</div>
          <div class="cred-user-meta">
            <div class="cred-username" title="${escapeHtml(cred.username)}">${escapeHtml(cred.username || 'No username')}</div>
            <div class="cred-password-mask" data-pass="${escapeHtml(cred.password)}">••••••••••••</div>
          </div>
        </div>
        <div class="cred-card-actions">
          <button class="btn-icon btn-toggle-pass" title="Show password">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
          <button class="btn-icon btn-copy-cred-pass" title="Copy password">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          ${showFillButton ? `
            <button class="btn-xs btn-primary btn-fill-page">
              Fill
            </button>
          ` : ''}
          <button class="btn-icon btn-delete-cred" title="Delete login" style="color: #ef4444;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="cred-card-footer">
        <span class="cred-origin-badge" title="${escapeHtml(cred.origin || cred.hostname)}">${escapeHtml(cred.hostname || 'Unknown')}</span>
        <span class="security-tag ${isInsecure ? 'insecure' : 'secure'}" style="font-size: 9px; padding: 1px 6px;">
          ${isInsecure ? 'HTTP' : 'HTTPS'}
        </span>
      </div>
    `;

    // Event: Toggle password reveal
    const btnToggle = card.querySelector('.btn-toggle-pass');
    const maskEl = card.querySelector('.cred-password-mask');
    let isRevealed = false;
    btnToggle.addEventListener('click', () => {
      isRevealed = !isRevealed;
      maskEl.textContent = isRevealed ? cred.password : '••••••••••••';
      maskEl.style.letterSpacing = isRevealed ? 'normal' : '1.5px';
    });

    // Event: Copy password
    const btnCopy = card.querySelector('.btn-copy-cred-pass');
    btnCopy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(cred.password);
      showToast('Password copied to clipboard!');
    });

    // Event: Fill in page
    if (showFillButton) {
      const btnFill = card.querySelector('.btn-fill-page');
      btnFill.addEventListener('click', async () => {
        if (!currentTab) return;
        try {
          await chrome.tabs.sendMessage(currentTab.id, {
            type: 'FILL_CREDENTIAL',
            credential: cred
          });
          showToast(`Filled ${cred.username || 'login'}`);
          window.close(); // Close popup smoothly on fill
        } catch (err) {
          showToast('Failed to fill: Ensure page is open');
        }
      });
    }

    // Event: Delete
    const btnDelete = card.querySelector('.btn-delete-cred');
    btnDelete.addEventListener('click', async () => {
      if (confirm(`Delete saved login for ${cred.username || cred.hostname}?`)) {
        await OmniStorage.deleteCredential(cred.id);
        showToast('Login deleted');
        renderCurrentSiteCredentials();
        renderVaultList();
        updateTabBadge();
      }
    });

    return card;
  }

  // Render full vault tab
  async function renderVaultList() {
    const all = await OmniStorage.getAllCredentials();
    const query = (vaultSearchInput.value || '').toLowerCase().trim();

    const filtered = all.filter(item => {
      // Filter by security chip
      if (activeVaultFilter === 'insecure' && !item.isInsecure && item.protocol !== 'http:') return false;
      if (activeVaultFilter === 'secure' && (item.isInsecure || item.protocol === 'http:')) return false;

      // Filter by search query
      if (query) {
        const matchesUser = (item.username || '').toLowerCase().includes(query);
        const matchesHost = (item.hostname || '').toLowerCase().includes(query);
        const matchesOrigin = (item.origin || '').toLowerCase().includes(query);
        return matchesUser || matchesHost || matchesOrigin;
      }
      return true;
    });

    // Update counts
    countAll.textContent = all.length;
    countInsecure.textContent = all.filter(c => c.isInsecure || c.protocol === 'http:').length;
    countSecure.textContent = all.filter(c => !c.isInsecure && c.protocol !== 'http:').length;

    allCredsContainer.innerHTML = '';
    if (filtered.length === 0) {
      allCredsContainer.innerHTML = `
        <div class="empty-view">
          <div class="empty-view-title">No matching credentials found</div>
        </div>
      `;
      return;
    }

    filtered.forEach(cred => {
      const card = createCredentialCard(cred, false);
      allCredsContainer.appendChild(card);
    });
  }

  // Add / Save Form Handling
  btnShowAddCurrent.addEventListener('click', () => {
    formCurrentAdd.style.display = formCurrentAdd.style.display === 'none' ? 'block' : 'none';
    if (formCurrentAdd.style.display === 'block') {
      inputUsername.focus();
    }
  });

  btnCancelAdd.addEventListener('click', () => {
    formCurrentAdd.reset();
    formCurrentAdd.style.display = 'none';
  });

  btnToggleInputPass.addEventListener('click', () => {
    inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
  });

  btnFillGenerated.addEventListener('click', () => {
    const pass = OmniCrypto.generatePassword({ length: 16 });
    inputPassword.value = pass;
    inputPassword.type = 'text';
    showToast('Generated strong password inserted');
  });

  formCurrentAdd.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = inputUsername.value.trim();
    const password = inputPassword.value;

    if (!password) {
      showToast('Password is required');
      return;
    }

    await OmniStorage.saveCredential({
      origin: currentUrlInfo?.origin || window.location.origin,
      hostname: currentUrlInfo?.hostname || 'localhost',
      protocol: currentUrlInfo?.protocol || 'http:',
      port: currentUrlInfo?.port || '80',
      username,
      password
    });

    formCurrentAdd.reset();
    formCurrentAdd.style.display = 'none';
    showToast('Login saved!');
    renderCurrentSiteCredentials();
    updateTabBadge();
  });

  // Vault Search & Filter events
  vaultSearchInput.addEventListener('input', renderVaultList);

  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeVaultFilter = chip.dataset.filter;
      renderVaultList();
    });
  });

  // Password Generator Logic
  function updateGeneratedPassword() {
    const length = parseInt(genLengthSlider.value, 10);
    genLengthIndicator.textContent = `${length} characters`;

    const pass = OmniCrypto.generatePassword({
      length: length,
      useUpper: genUpper.checked,
      useLower: genLower.checked,
      useNumbers: genNumbers.checked,
      useSymbols: genSymbols.checked
    });

    genResult.textContent = pass;

    const strength = OmniCrypto.evaluateStrength(pass);
    genStrengthText.textContent = strength.label;
    genStrengthText.style.color = strength.color;
    genStrengthFill.style.backgroundColor = strength.color;
    genStrengthFill.style.width = `${Math.max(15, (strength.score + 1) * 20)}%`;
  }

  genLengthSlider.addEventListener('input', updateGeneratedPassword);
  [genUpper, genLower, genNumbers, genSymbols].forEach(cb => {
    cb.addEventListener('change', updateGeneratedPassword);
  });
  btnRegenerate.addEventListener('click', updateGeneratedPassword);

  btnCopyGenerated.addEventListener('click', async () => {
    const pass = genResult.textContent;
    await navigator.clipboard.writeText(pass);
    showToast('Password copied!');
  });

  // Settings Handlers
  async function loadSettings() {
    const settings = await OmniStorage.getSettings();
    settingEnableHttp.checked = settings.enableOnHttp !== false;
    settingAutoSuggest.checked = settings.autoSuggestOnFocus !== false;
    settingPromptSave.checked = settings.promptToSaveOnSubmit !== false;
    if (settingHideNative) {
      settingHideNative.checked = settings.hideNativeOptions !== false;
    }

    const update = async () => {
      await OmniStorage.saveSettings({
        enableOnHttp: settingEnableHttp.checked,
        autoSuggestOnFocus: settingAutoSuggest.checked,
        promptToSaveOnSubmit: settingPromptSave.checked,
        hideNativeOptions: settingHideNative ? settingHideNative.checked : true
      });
      showToast('Settings saved');
    };

    settingEnableHttp.addEventListener('change', update);
    settingAutoSuggest.addEventListener('change', update);
    settingPromptSave.addEventListener('change', update);
    if (settingHideNative) {
      settingHideNative.addEventListener('change', update);
    }
  }

  // Export Vault
  btnExportVault.addEventListener('click', async () => {
    const jsonStr = await OmniStorage.exportVault();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `passwords-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Vault exported successfully');
  });

  // Sync Chrome Passwords
  const btnSyncChromeVault = document.getElementById('btn-sync-chrome-vault');
  const btnSyncChromeSettings = document.getElementById('btn-sync-chrome-settings');
  const inputImportCsv = document.getElementById('input-import-csv');

  async function handleSyncChrome() {
    showToast('Syncing Chrome passwords...');
    const res = await OmniStorage.syncChromePasswords();
    if (res.success) {
      showToast(`Synced ${res.count} Chrome passwords!`);
      await renderCurrentSiteCredentials();
      await renderVaultList();
      updateTabBadge();
    } else {
      showToast('Sync error: ' + (res.error || 'unknown'));
    }
  }

  if (btnSyncChromeVault) {
    btnSyncChromeVault.addEventListener('click', handleSyncChrome);
  }
  if (btnSyncChromeSettings) {
    btnSyncChromeSettings.addEventListener('click', handleSyncChrome);
  }

  // Import Chrome CSV
  if (inputImportCsv) {
    inputImportCsv.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        const result = await OmniStorage.importChromeCsv(event.target.result);
        if (result.success) {
          showToast(`Imported ${result.count} accounts from CSV!`);
          renderCurrentSiteCredentials();
          renderVaultList();
          updateTabBadge();
        } else {
          alert('CSV Import error: ' + result.error);
        }
      };
      reader.readAsText(file);
    });
  }

  // Import Vault (JSON)
  inputImportFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const result = await OmniStorage.importVault(event.target.result);
      if (result.success) {
        showToast(`Imported ${result.count} credentials`);
        renderCurrentSiteCredentials();
        renderVaultList();
        updateTabBadge();
      } else {
        alert('Failed to import vault: ' + result.error);
      }
    };
    reader.readAsText(file);
  });

  // Toast Helper
  let toastTimer = null;
  function showToast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2000);
  }

  function updateTabBadge() {
    if (currentTab) {
      chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {});
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Initialize
  await initActiveTab();
  await renderCurrentSiteCredentials();
  await loadSettings();
  updateGeneratedPassword();
});
