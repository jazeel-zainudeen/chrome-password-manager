/**
 * OmniPass Content Script
 * Provides in-page credential dropdown, autofill, inline field trigger,
 * complete suppression of native browser autofill options,
 * and reliable password options for insecure HTTP and HTTPS.
 */

(function () {
  // Prevent duplicate injection
  if (window.__OMNIPASS_INITIALIZED__) return;
  window.__OMNIPASS_INITIALIZED__ = true;

  let currentTargetInput = null;
  let activeDropdown = null;
  let shadowRoot = null;
  let containerEl = null;
  let settings = null;
  let credentialsSummary = { matched: [], others: [], all: [] };
  let currentCredentials = [];
  let isPositioning = false;

  // Initialize extension context
  async function init() {
    settings = await OmniStorage.getSettings();
    const isHttp = window.location.protocol === 'http:';

    // If disabled on HTTP and currently on HTTP, skip
    if (isHttp && !settings.enableOnHttp) {
      return;
    }

    createShadowHost();
    await refreshCredentials();
    attachGlobalListeners();
    observeDomChanges();
  }

  /**
   * Creates isolated Shadow DOM container for all OmniPass UI elements.
   */
  function createShadowHost() {
    containerEl = document.createElement('div');
    containerEl.id = 'omnipass-root';
    containerEl.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647; pointer-events: none;';
    
    shadowRoot = containerEl.attachShadow({ mode: 'open' });
    
    // Inject styles into shadow DOM
    const style = document.createElement('style');
    style.textContent = getShadowStyles();
    shadowRoot.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.id = 'omnipass-wrapper';
    wrapper.style.pointerEvents = 'auto';
    shadowRoot.appendChild(wrapper);

    // Inline field button
    const fieldIcon = document.createElement('button');
    fieldIcon.id = 'omnipass-field-icon';
    fieldIcon.className = 'op-field-icon';
    fieldIcon.setAttribute('type', 'button');
    fieldIcon.setAttribute('title', 'OmniPass: Show saved logins');
    fieldIcon.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 2l-2 2m-1-1l-3 3m1 1l-2 2m-2-2l-4 4a5 5 0 1 1-7-7l4-4a5 5 0 0 1 7 7z"/>
      </svg>
    `;
    fieldIcon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentTargetInput) {
        currentTargetInput.readOnly = false;
        currentTargetInput.focus();
        if (activeDropdown) {
          hidePickerDropdown();
        } else {
          showPickerDropdown(currentTargetInput);
        }
      }
    });
    shadowRoot.appendChild(fieldIcon);

    (document.body || document.documentElement).appendChild(containerEl);
  }

  /**
   * Refreshes credentials matching the current URL and all vault accounts.
   */
  async function refreshCredentials() {
    try {
      credentialsSummary = await OmniStorage.getCredentialsSummaryForUrl(window.location.href);
      currentCredentials = credentialsSummary.all || [];
    } catch (e) {
      credentialsSummary = { matched: [], others: [], all: [] };
      currentCredentials = [];
    }
  }

  /**
   * Attaches focus, click, and input listeners.
   */
  function attachGlobalListeners() {
    // Early suppression on mousedown/pointerdown before browser evaluates focus
    document.addEventListener('mousedown', (e) => {
      if (isTargetInput(e.target) && settings && settings.hideNativeOptions !== false) {
        suppressNativeAutofill(e.target);
      }
    }, true);

    document.addEventListener('focusin', onInputFocus, true);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('submit', onFormSubmit, true);

    window.addEventListener('resize', repositionActiveDropdown, { passive: true });
    window.addEventListener('scroll', repositionActiveDropdown, { passive: true });

    // Listener for popup fill trigger
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'FILL_CREDENTIAL' && message.credential) {
        if (!currentTargetInput) {
          currentTargetInput = document.querySelector('input[type="password"]') ||
                               document.querySelector('input[autocomplete*="username"], input[type="email"], input[name*="user"], input[id*="user"]');
        }
        if (currentTargetInput) {
          fillCredential(message.credential);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'No form input found on page' });
        }
        return true;
      }
      return false;
    });
  }

  /**
   * Observes dynamic DOM additions (SPAs, modals).
   */
  function observeDomChanges() {
    const observer = new MutationObserver(() => {
      decorateInputs();
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    decorateInputs();
  }

  /**
   * Checks if an element is a search bar, token, or non-login field.
   */
  function isExcludedField(el) {
    if (!el) return true;
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const type = (el.type || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();

    if (['hidden', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type)) return true;
    if (role === 'search') return true;

    return /search|query|csrf|token|captcha|otp|code|auth\[server\]|auth\[db\]/i.test(name) ||
           /search|query|csrf|token|captcha|otp|code/i.test(id);
  }

  /**
   * Checks if an input is explicitly for username, email, or login account.
   */
  function isExplicitUsernameInput(el) {
    if (!el || el.tagName !== 'INPUT' || isExcludedField(el)) return false;
    const type = (el.type || 'text').toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();

    if (autocomplete.includes('username') || autocomplete.includes('email')) return true;
    if (type === 'email') return true;

    return /user|login|email|account|usr|uname|identifier|auth\[user/i.test(name) ||
           /user|login|email|account|usr|uname|identifier/i.test(id);
  }

  /**
   * Identifies login-related inputs (password or username/email).
   */
  function isTargetInput(el) {
    if (!el || el.tagName !== 'INPUT' || isExcludedField(el)) return false;
    const type = (el.type || 'text').toLowerCase();

    if (type === 'password') return true;
    if (isExplicitUsernameInput(el)) return true;

    // Fallback: If input is in a form that has a password input, check if it's text/empty
    if (type === 'text' || !el.hasAttribute('type')) {
      const form = el.form || el.closest('form, div[role="form"], main, .login, .auth');
      if (form && form.querySelector('input[type="password"]')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Finds related username & password inputs within the same form/context.
   */
  function getRelatedInputs(target) {
    const form = target.form || target.closest('form, div[role="form"], main, .login, .auth, body') || document;
    const inputs = Array.from(form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'));

    let passwordInput = (target.type === 'password') ? target : inputs.find(i => (i.type || '').toLowerCase() === 'password');
    let usernameInput = null;

    if (target !== passwordInput && (isExplicitUsernameInput(target) || isTargetInput(target))) {
      usernameInput = target;
    }

    if (!usernameInput && passwordInput) {
      // 1. First priority: input with explicit username/email markers
      usernameInput = inputs.find(i => i !== passwordInput && isExplicitUsernameInput(i));

      // 2. Second priority: the text input immediately preceding the password input in DOM order
      if (!usernameInput) {
        const passIndex = inputs.indexOf(passwordInput);
        for (let i = passIndex - 1; i >= 0; i--) {
          const cand = inputs[i];
          if (!isExcludedField(cand) && cand !== passwordInput) {
            usernameInput = cand;
            break;
          }
        }
      }

      // 3. Third priority: any candidate input that is not the password field
      if (!usernameInput) {
        usernameInput = inputs.find(i => i !== passwordInput && isTargetInput(i));
      }
    }

    if (!passwordInput && usernameInput) {
      const userIndex = inputs.indexOf(usernameInput);
      for (let i = userIndex + 1; i < inputs.length; i++) {
        if ((inputs[i].type || '').toLowerCase() === 'password') {
          passwordInput = inputs[i];
          break;
        }
      }
    }

    return { usernameInput, passwordInput };
  }

  /**
   * Hides native browser options and decorates inputs.
   */
  function decorateInputs() {
    const inputs = document.querySelectorAll('input');
    inputs.forEach(input => {
      if (!isTargetInput(input)) return;
      if (input.dataset.omnipassDecorated) return;
      input.dataset.omnipassDecorated = 'true';

      if (settings && settings.hideNativeOptions !== false) {
        suppressNativeAutofill(input);
      }
    });

    injectGlobalSuppressionStyles();
  }

  /**
   * Completely suppresses Chrome's native autofill/autocomplete dropdowns.
   */
  function suppressNativeAutofill(input) {
    try {
      if (!input || input.disabled) return;
      if (input.dataset.omnipassOrigReadonly === undefined) {
        input.dataset.omnipassOrigReadonly = input.hasAttribute('readonly') ? 'true' : 'false';
      }
      if (input.dataset.omnipassOrigReadonly === 'true') {
        return;
      }

      // 1. Force autocomplete to new-password to stop Chrome's generic popup
      input.setAttribute('autocomplete', 'new-password');
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-1p-ignore', 'true');
      input.setAttribute('data-bwignore', 'true');
      input.setAttribute('aria-autocomplete', 'none');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');

      if (input.form) {
        input.form.setAttribute('autocomplete', 'off');
      }

      // 2. Readonly shield: prevents Chrome from popping up native suggestion menu on click
      if (document.activeElement !== input) {
        input.readOnly = true;
      }

      const releaseReadOnly = () => {
        setTimeout(() => {
          if (input.dataset.omnipassOrigReadonly !== 'true') {
            input.readOnly = false;
          }
        }, 20);
      };

      input.addEventListener('pointerdown', releaseReadOnly, { capture: true, passive: true });
      input.addEventListener('mousedown', releaseReadOnly, { capture: true, passive: true });
      input.addEventListener('touchstart', releaseReadOnly, { capture: true, passive: true });
      input.addEventListener('focus', releaseReadOnly, { capture: true, passive: true });

      input.addEventListener('blur', () => {
        if (input.dataset.omnipassOrigReadonly !== 'true') {
          input.readOnly = true;
        }
      }, { capture: true, passive: true });

    } catch (e) {
      // Guard against any unexpected DOM exceptions
    }
  }

  /**
   * Injects CSS rule to hide Chrome's internal auto-fill icons.
   */
  function injectGlobalSuppressionStyles() {
    if (document.getElementById('omnipass-native-suppression-styles')) return;
    const style = document.createElement('style');
    style.id = 'omnipass-native-suppression-styles';
    style.textContent = `
      input::-webkit-credentials-auto-fill-button,
      input::-webkit-contacts-auto-fill-button,
      input::-webkit-caps-lock-indicator {
        visibility: hidden !important;
        display: none !important;
        pointer-events: none !important;
        height: 0 !important;
        width: 0 !important;
        margin: 0 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * Positions inline field icon inside target input.
   */
  function positionFieldIcon(input) {
    if (!settings || !settings.showInlineIcon || !input || !shadowRoot) return;
    const icon = shadowRoot.getElementById('omnipass-field-icon');
    if (!icon) return;

    const rect = input.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const iconSize = 20;
    const top = rect.top + (rect.height - iconSize) / 2 + window.scrollY;
    const left = rect.right - iconSize - 6 + window.scrollX;

    icon.style.top = `${top}px`;
    icon.style.left = `${left}px`;
    icon.classList.add('op-icon-visible');
  }

  function hideFieldIcon() {
    if (!shadowRoot) return;
    const icon = shadowRoot.getElementById('omnipass-field-icon');
    if (icon) {
      icon.classList.remove('op-icon-visible');
    }
  }

  /**
   * Handle focus on inputs.
   */
  async function onInputFocus(e) {
    const target = e.target;
    if (!isTargetInput(target)) return;

    if (settings && settings.hideNativeOptions !== false) {
      suppressNativeAutofill(target);
    }

    currentTargetInput = target;
    positionFieldIcon(target);
    await refreshCredentials();

    if (settings && settings.autoSuggestOnFocus) {
      showPickerDropdown(target);
    }
  }

  /**
   * Handle document click.
   */
  function onDocumentClick(e) {
    const path = e.composedPath();
    const clickedInsideShadow = path.some(node => node === containerEl || (shadowRoot && shadowRoot.contains(node)));
    const clickedInsideInput = path.some(node => node === currentTargetInput);

    if (!clickedInsideShadow && !clickedInsideInput) {
      hidePickerDropdown();
      hideFieldIcon();
    }
  }

  /**
   * Handle key events (Escape to close, navigation).
   */
  function onKeyDown(e) {
    if (e.key === 'Escape' && activeDropdown) {
      hidePickerDropdown();
      if (currentTargetInput) currentTargetInput.focus();
    }
  }

  /**
   * Render and show the credential picker dropdown with valid options.
   */
  function showPickerDropdown(input) {
    if (!shadowRoot) return;
    const wrapper = shadowRoot.getElementById('omnipass-wrapper');
    if (!wrapper) return;

    currentTargetInput = input;
    const isHttp = window.location.protocol === 'http:';
    const hostname = window.location.hostname || 'this site';
    const port = window.location.port ? `:${window.location.port}` : '';

    const dropdown = document.createElement('div');
    dropdown.className = 'omnipass-dropdown';
    dropdown.setAttribute('role', 'dialog');
    dropdown.setAttribute('aria-label', 'OmniPass Credential Selector');

    let html = `
      <div class="op-header">
        <div class="op-brand">
          <div class="op-logo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2l-2 2m-1-1l-3 3m1 1l-2 2m-2-2l-4 4a5 5 0 1 1-7-7l4-4a5 5 0 0 1 7 7z"/>
            </svg>
          </div>
          <span class="op-title">OmniPass</span>
        </div>
        <div class="op-badge ${isHttp ? 'op-badge-insecure' : 'op-badge-secure'}" title="${isHttp ? 'Insecure HTTP site: OmniPass enables password selection here' : 'Secure HTTPS Connection'}">
          ${isHttp ? `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
            </svg>
            <span>HTTP Unlocked</span>
          ` : `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span>HTTPS</span>
          `}
        </div>
      </div>

      <!-- Quick Search Bar -->
      <div class="op-search-wrap">
        <svg class="op-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" id="op-search-filter" class="op-search-filter" placeholder="Search or choose account..." autocomplete="off" spellcheck="false">
      </div>

      <!-- Accounts List Container -->
      <div class="op-creds-container" id="op-creds-container">
        <!-- Rendered dynamically -->
      </div>

      <!-- Quick Actions footer -->
      <div class="op-footer">
        <button type="button" class="op-action-btn" data-action="generate">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          Generate
        </button>
        <button type="button" class="op-action-btn" data-action="add-current">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Save This Login
        </button>
      </div>
    `;

    wrapper.innerHTML = '';
    wrapper.appendChild(dropdown);
    activeDropdown = dropdown;

    // Render account items
    renderDropdownAccounts(dropdown, '');

    // Attach interaction handlers
    attachDropdownEvents(dropdown);
    positionDropdown(dropdown, input);
  }

  /**
   * Generates HTML for account items with search filtering.
   */
  function renderDropdownAccounts(dropdown, filterText = '') {
    const container = dropdown.querySelector('#op-creds-container');
    if (!container) return;

    const q = (filterText || '').trim().toLowerCase();
    const hostname = window.location.hostname || 'this site';
    const port = window.location.port ? `:${window.location.port}` : '';

    const matched = (credentialsSummary.matched || []).filter(c => matchesQuery(c, q));
    const others = (credentialsSummary.others || []).filter(c => matchesQuery(c, q));
    const all = (credentialsSummary.all || []).filter(c => matchesQuery(c, q));

    let html = '';

    if (q) {
      // Searching across all vault items
      if (all.length > 0) {
        html += `<div class="op-group-title">Search Results (${all.length})</div>`;
        html += `<div class="op-creds-list">`;
        all.forEach(cred => {
          html += renderCredentialItemHtml(cred, true);
        });
        html += `</div>`;
      } else {
        html += `
          <div class="op-empty-state">
            <div class="op-empty-text">No logins match "<strong>${escapeHtml(filterText)}</strong>"</div>
            <div class="op-empty-sub">Use 'Save This Login' below to remember this account.</div>
          </div>
        `;
      }
    } else {
      // Normal display
      if (matched.length > 0) {
        html += `<div class="op-group-title">Logins for ${escapeHtml(hostname)}${port}</div>`;
        html += `<div class="op-creds-list">`;
        matched.forEach(cred => {
          html += renderCredentialItemHtml(cred, false);
        });
        html += `</div>`;

        if (others.length > 0) {
          html += `<div class="op-group-title" style="margin-top: 6px;">All Vault Logins (${others.length})</div>`;
          html += `<div class="op-creds-list">`;
          others.forEach(cred => {
            html += renderCredentialItemHtml(cred, true);
          });
          html += `</div>`;
        }
      } else if (all.length > 0) {
        html += `
          <div class="op-domain-notice">
            No specific login for <strong>${escapeHtml(hostname)}</strong> yet. Select a saved account from your vault:
          </div>
          <div class="op-group-title">Vault Accounts (${all.length})</div>
          <div class="op-creds-list">
        `;
        all.forEach(cred => {
          html += renderCredentialItemHtml(cred, true);
        });
        html += `</div>`;
      } else {
        html += `
          <div class="op-empty-state">
            <div class="op-empty-text">Your vault is ready</div>
            <div class="op-empty-sub">Enter your login and click 'Save This Login' below.</div>
          </div>
        `;
      }
    }

    container.innerHTML = html;
  }

  function matchesQuery(cred, q) {
    if (!q) return true;
    const u = (cred.username || '').toLowerCase();
    const h = (cred.hostname || '').toLowerCase();
    const t = (cred.title || '').toLowerCase();
    return u.includes(q) || h.includes(q) || t.includes(q);
  }

  function renderCredentialItemHtml(cred, showOriginBadge) {
    const firstLetter = (cred.username ? cred.username[0] : 'U').toUpperCase();
    return `
      <div class="op-cred-item" data-id="${escapeHtml(cred.id)}" tabindex="0">
        <div class="op-cred-avatar">
          ${firstLetter}
        </div>
        <div class="op-cred-info">
          <div class="op-cred-user-row">
            <span class="op-cred-user">${escapeHtml(cred.username || 'No username')}</span>
            ${showOriginBadge && cred.hostname ? `<span class="op-origin-tag" title="${escapeHtml(cred.origin || cred.hostname)}">${escapeHtml(cred.hostname)}</span>` : ''}
          </div>
          <div class="op-cred-pass" data-pass="${escapeHtml(cred.password)}" title="Click to reveal">••••••••</div>
        </div>
        <div class="op-cred-actions">
          <button type="button" class="op-btn-copy" data-action="copy" data-id="${escapeHtml(cred.id)}" title="Copy password">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button type="button" class="op-btn-fill" data-action="fill" data-id="${escapeHtml(cred.id)}">
            Fill
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Positions dropdown relative to the active input with collision detection.
   */
  function positionDropdown(dropdown, input) {
    if (!dropdown || !input) return;
    const rect = input.getBoundingClientRect();
    const dropdownHeight = dropdown.offsetHeight || 260;
    const dropdownWidth = 320;

    let top = rect.bottom + 6;
    let left = rect.left;

    // Collision detection: Check if it overflows viewport bottom
    if (rect.bottom + dropdownHeight > window.innerHeight) {
      top = Math.max(10, rect.top - dropdownHeight - 6);
    }

    // Horizontal containment
    if (left + dropdownWidth > window.innerWidth - 10) {
      left = window.innerWidth - dropdownWidth - 10;
    }
    if (left < 10) left = 10;

    dropdown.style.top = `${top + window.scrollY}px`;
    dropdown.style.left = `${left + window.scrollX}px`;
    dropdown.classList.add('op-visible');
  }

  function repositionActiveDropdown() {
    if (currentTargetInput) {
      positionFieldIcon(currentTargetInput);
    }
    if (activeDropdown && currentTargetInput) {
      if (!isPositioning) {
        isPositioning = true;
        requestAnimationFrame(() => {
          positionDropdown(activeDropdown, currentTargetInput);
          isPositioning = false;
        });
      }
    }
  }

  /**
   * Hides the active dropdown picker.
   */
  function hidePickerDropdown() {
    if (activeDropdown) {
      activeDropdown.classList.remove('op-visible');
      setTimeout(() => {
        if (shadowRoot) {
          const wrapper = shadowRoot.getElementById('omnipass-wrapper');
          if (wrapper) wrapper.innerHTML = '';
        }
        activeDropdown = null;
      }, 150);
    }
  }

  /**
   * Handles click and search events inside the picker dropdown.
   */
  function attachDropdownEvents(dropdown) {
    // Search input listener
    const searchInput = dropdown.querySelector('#op-search-filter');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        renderDropdownAccounts(dropdown, e.target.value);
      });
      // Prevent keydown inside search from closing picker or bubbling to host
      searchInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          hidePickerDropdown();
        }
      });
    }

    dropdown.addEventListener('click', async (e) => {
      // Toggle password reveal
      const passEl = e.target.closest('.op-cred-pass');
      if (passEl) {
        e.stopPropagation();
        const rawPass = passEl.dataset.pass;
        if (passEl.textContent.includes('•')) {
          passEl.textContent = rawPass;
          passEl.style.letterSpacing = 'normal';
        } else {
          passEl.textContent = '••••••••';
          passEl.style.letterSpacing = '1px';
        }
        return;
      }

      const target = e.target.closest('[data-action], .op-cred-item');
      if (!target) return;

      const action = target.dataset.action;
      const credId = target.dataset.id || target.closest('.op-cred-item')?.dataset.id;
      const cred = currentCredentials.find(c => c.id === credId);

      if (action === 'fill' || target.classList.contains('op-cred-item')) {
        if (cred) {
          fillCredential(cred);
          hidePickerDropdown();
        }
      } else if (action === 'copy') {
        e.stopPropagation();
        if (cred) {
          await copyToClipboard(cred.password);
          showToast('Password copied to clipboard!');
        }
      } else if (action === 'generate') {
        const password = generateStrongPassword();
        if (currentTargetInput) {
          fillInput(currentTargetInput, password);
          flashFieldSuccess(currentTargetInput);
          showToast('Generated strong password inserted!');
        }
        hidePickerDropdown();
      } else if (action === 'add-current') {
        const { usernameInput, passwordInput } = getRelatedInputs(currentTargetInput);
        const uVal = usernameInput ? usernameInput.value : '';
        const pVal = passwordInput ? passwordInput.value : '';

        if (!pVal && !uVal) {
          showToast('Please enter credentials in the form first');
          return;
        }

        await OmniStorage.saveCredential({
          origin: window.location.origin,
          hostname: window.location.hostname,
          protocol: window.location.protocol,
          port: window.location.port,
          username: uVal,
          password: pVal
        });

        await refreshCredentials();
        showToast('Login saved for this site!');
        hidePickerDropdown();
      }
    });
  }

  /**
   * Autofills username and password into detected fields.
   */
  function fillCredential(cred) {
    if (!currentTargetInput) return;
    const { usernameInput, passwordInput } = getRelatedInputs(currentTargetInput);

    if (usernameInput && cred.username) {
      fillInput(usernameInput, cred.username);
      flashFieldSuccess(usernameInput);
    }

    if (passwordInput && cred.password) {
      fillInput(passwordInput, cred.password);
      flashFieldSuccess(passwordInput);
    }

    if (cred.id) {
      OmniStorage.markLastUsed(cred.id);
    }

    showToast(`Filled credentials for ${cred.username || 'account'}`);
  }

  /**
   * Sets value and triggers input / change events so React/Vue/vanilla frameworks react.
   */
  function fillInput(input, value) {
    input.readOnly = false;
    input.focus();
    
    // React value setter hack for synthetic event dispatch
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  /**
   * Subtle visual glow to indicate autofill success.
   */
  function flashFieldSuccess(input) {
    const origTransition = input.style.transition;
    const origBoxShadow = input.style.boxShadow;
    const origBorderColor = input.style.borderColor;

    input.style.transition = 'all 0.25s ease';
    input.style.borderColor = '#10B981';
    input.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.25)';

    setTimeout(() => {
      input.style.borderColor = origBorderColor;
      input.style.boxShadow = origBoxShadow;
      input.style.transition = origTransition;
    }, 1200);
  }

  /**
   * Generates secure password on the fly.
   */
  function generateStrongPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*()-_=+';
    let res = '';
    const buf = new Uint32Array(16);
    window.crypto.getRandomValues(buf);
    for (let i = 0; i < 16; i++) {
      res += chars[buf[i] % chars.length];
    }
    return res;
  }

  /**
   * Copy to clipboard.
   */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }

  /**
   * Prompt user to save credentials after submitting a form.
   */
  function onFormSubmit(e) {
    if (!settings || !settings.promptToSaveOnSubmit) return;
    const form = e.target;
    if (!form || !form.querySelector) return;

    const passwordInput = form.querySelector('input[type="password"]');
    if (!passwordInput || !passwordInput.value) return;

    const { usernameInput } = getRelatedInputs(passwordInput);
    const username = usernameInput ? usernameInput.value : '';
    const password = passwordInput.value;

    if (!password) return;

    // Check if already in vault with same password
    const alreadySaved = currentCredentials.some(
      c => (c.username || '').toLowerCase() === (username || '').toLowerCase() && c.password === password
    );

    if (!alreadySaved) {
      showSavePrompt({
        origin: window.location.origin,
        hostname: window.location.hostname,
        protocol: window.location.protocol,
        port: window.location.port,
        username,
        password
      });
    }
  }

  /**
   * Renders modern floating "Save Password" toast banner in Shadow DOM.
   */
  function showSavePrompt(cred) {
    if (!shadowRoot) return;
    const existingPrompt = shadowRoot.getElementById('omnipass-save-prompt');
    if (existingPrompt) existingPrompt.remove();

    const isHttp = cred.protocol === 'http:';
    const prompt = document.createElement('div');
    prompt.id = 'omnipass-save-prompt';
    prompt.className = 'op-save-prompt';

    prompt.innerHTML = `
      <div class="op-prompt-header">
        <div class="op-prompt-brand">
          <div class="op-logo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M21 2l-2 2m-1-1l-3 3m1 1l-2 2m-2-2l-4 4a5 5 0 1 1-7-7l4-4a5 5 0 0 1 7 7z"/>
            </svg>
          </div>
          <span>Save login to OmniPass?</span>
        </div>
        ${isHttp ? '<span class="op-prompt-badge">HTTP Insecure</span>' : ''}
      </div>
      <div class="op-prompt-body">
        <div class="op-prompt-site">${escapeHtml(cred.hostname)}</div>
        <div class="op-prompt-user">Username: <strong>${escapeHtml(cred.username || '(None)')}</strong></div>
      </div>
      <div class="op-prompt-footer">
        <button type="button" class="op-prompt-btn op-btn-secondary" id="op-dismiss-btn">Not Now</button>
        <button type="button" class="op-prompt-btn op-btn-primary" id="op-save-btn">Save</button>
      </div>
    `;

    shadowRoot.appendChild(prompt);

    requestAnimationFrame(() => {
      prompt.classList.add('op-prompt-visible');
    });

    const dismiss = () => {
      prompt.classList.remove('op-prompt-visible');
      setTimeout(() => prompt.remove(), 250);
    };

    prompt.querySelector('#op-dismiss-btn').onclick = dismiss;
    prompt.querySelector('#op-save-btn').onclick = async () => {
      await OmniStorage.saveCredential(cred);
      await refreshCredentials();
      chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {});
      dismiss();
      showToast('Login saved to OmniPass!');
    };

    setTimeout(dismiss, 15000);
  }

  /**
   * Shows a brief toast notification in the corner.
   */
  function showToast(msg) {
    if (!shadowRoot) return;
    const toast = document.createElement('div');
    toast.className = 'op-toast';
    toast.textContent = msg;
    shadowRoot.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('op-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('op-toast-visible');
      setTimeout(() => toast.remove(), 250);
    }, 2500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * High-polish CSS scoped entirely inside the Shadow DOM.
   */
  function getShadowStyles() {
    return `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      /* Dropdown Main */
      .omnipass-dropdown {
        position: absolute;
        width: 320px;
        background: #111827;
        color: #f3f4f6;
        border-radius: 12px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1);
        padding: 10px;
        font-size: 13px;
        z-index: 2147483647;
        opacity: 0;
        transform: translateY(4px) scale(0.98);
        transition: opacity 0.15s ease, transform 0.15s ease;
        backdrop-filter: blur(12px);
      }

      .omnipass-dropdown.op-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      /* Header */
      .op-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 4px 8px 4px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        margin-bottom: 8px;
      }

      .op-brand {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .op-logo {
        width: 22px;
        height: 22px;
        border-radius: 6px;
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
      }

      .op-title {
        font-weight: 600;
        font-size: 12px;
        color: #f9fafb;
        letter-spacing: 0.3px;
      }

      .op-badge {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        font-weight: 500;
        padding: 2px 7px;
        border-radius: 9999px;
      }

      .op-badge-insecure {
        background: rgba(245, 158, 11, 0.18);
        color: #fbbf24;
        border: 1px solid rgba(245, 158, 11, 0.3);
      }

      .op-badge-secure {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.25);
      }

      /* Search Box */
      .op-search-wrap {
        position: relative;
        margin-bottom: 8px;
      }

      .op-search-filter {
        width: 100%;
        background: #1f2937;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 7px;
        color: #f9fafb;
        padding: 6px 10px 6px 26px;
        font-size: 12px;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
      }

      .op-search-filter:focus {
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
      }

      .op-search-icon {
        position: absolute;
        left: 8px;
        top: 50%;
        transform: translateY(-50%);
        color: #9ca3af;
        pointer-events: none;
      }

      /* Section & Group Titles */
      .op-group-title {
        font-size: 10px;
        font-weight: 600;
        color: #9ca3af;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        padding: 4px 6px 3px 6px;
      }

      .op-domain-notice {
        background: rgba(99, 102, 241, 0.12);
        border: 1px solid rgba(99, 102, 241, 0.25);
        border-radius: 7px;
        padding: 7px 9px;
        font-size: 11.5px;
        color: #c7d2fe;
        margin-bottom: 6px;
        line-height: 1.35;
      }

      /* Credential Items List */
      .op-creds-container {
        max-height: 220px;
        overflow-y: auto;
      }

      .op-creds-container::-webkit-scrollbar {
        width: 4px;
      }
      .op-creds-container::-webkit-scrollbar-thumb {
        background: #374151;
        border-radius: 4px;
      }

      .op-creds-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .op-cred-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 8px;
        background: #1f2937;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
        border: 1px solid transparent;
      }

      .op-cred-item:hover, .op-cred-item:focus {
        background: #283548;
        border-color: rgba(99, 102, 241, 0.4);
        outline: none;
      }

      .op-cred-avatar {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: #374151;
        color: #e5e7eb;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 11px;
        flex-shrink: 0;
      }

      .op-cred-info {
        flex: 1;
        min-width: 0;
      }

      .op-cred-user-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .op-cred-user {
        font-weight: 500;
        color: #f3f4f6;
        font-size: 12.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .op-origin-tag {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        color: #9ca3af;
        max-width: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .op-cred-pass {
        color: #9ca3af;
        font-size: 11px;
        letter-spacing: 1px;
        cursor: pointer;
      }

      .op-cred-pass:hover {
        color: #e5e7eb;
      }

      .op-cred-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .op-btn-copy {
        background: transparent;
        border: none;
        color: #9ca3af;
        cursor: pointer;
        padding: 5px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, background 0.15s;
      }

      .op-btn-copy:hover {
        color: #f3f4f6;
        background: #374151;
      }

      .op-btn-fill {
        background: #4f46e5;
        color: white;
        border: none;
        padding: 4px 10px;
        font-size: 11.5px;
        font-weight: 500;
        border-radius: 5px;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .op-btn-fill:hover {
        background: #4338ca;
      }

      /* Empty State */
      .op-empty-state {
        padding: 14px 8px;
        text-align: center;
        color: #9ca3af;
      }

      .op-empty-text {
        font-size: 12px;
        color: #d1d5db;
        margin-bottom: 4px;
      }

      .op-empty-sub {
        font-size: 11px;
        color: #6b7280;
      }

      /* Footer */
      .op-footer {
        display: flex;
        align-items: center;
        gap: 6px;
        padding-top: 8px;
        margin-top: 6px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }

      .op-action-btn {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        background: #1f2937;
        color: #d1d5db;
        border: 1px solid rgba(255, 255, 255, 0.05);
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .op-action-btn:hover {
        background: #374151;
        color: #ffffff;
      }

      /* Inline Field Trigger Icon */
      .op-field-icon {
        position: absolute;
        width: 20px;
        height: 20px;
        border-radius: 5px;
        background: #1f2937;
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #818cf8;
        display: none;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 2147483646;
        box-shadow: 0 2px 5px rgba(0, 0, 0, 0.25);
        transition: all 0.15s ease;
        pointer-events: auto;
      }

      .op-field-icon:hover {
        background: #374151;
        color: #a5b4fc;
        transform: scale(1.08);
      }

      .op-field-icon.op-icon-visible {
        display: flex;
      }

      /* Save Prompt Toast */
      .op-save-prompt {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 320px;
        background: #111827;
        border-radius: 12px;
        box-shadow: 0 12px 30px -5px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.12);
        padding: 14px;
        z-index: 2147483647;
        opacity: 0;
        transform: translateY(-10px) scale(0.95);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }

      .op-save-prompt.op-prompt-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      .op-prompt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }

      .op-prompt-brand {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
        color: #f9fafb;
      }

      .op-prompt-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(245, 158, 11, 0.2);
        color: #fbbf24;
        font-weight: 500;
      }

      .op-prompt-body {
        font-size: 12px;
        color: #9ca3af;
        margin-bottom: 12px;
        line-height: 1.4;
      }

      .op-prompt-site {
        font-weight: 600;
        color: #e5e7eb;
      }

      .op-prompt-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .op-prompt-btn {
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: background 0.15s ease;
      }

      .op-btn-secondary {
        background: #1f2937;
        color: #d1d5db;
      }

      .op-btn-secondary:hover {
        background: #374151;
        color: #ffffff;
      }

      .op-btn-primary {
        background: #6366f1;
        color: #ffffff;
      }

      .op-btn-primary:hover {
        background: #4f46e5;
      }

      /* Notification Toast */
      .op-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #1f2937;
        color: #f3f4f6;
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 12.5px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        z-index: 2147483647;
      }

      .op-toast.op-toast-visible {
        opacity: 1;
        transform: translateY(0);
      }
    `;
  }

  // Kickstart content script
  init();
})();
