/**
 * OmniPass Content Script
 * Provides in-page credential dropdown, autofill, inline field trigger,
 * and save-on-submit prompt - fully operational on insecure HTTP and HTTPS.
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
   * Refreshes credentials matching the current URL.
   */
  async function refreshCredentials() {
    try {
      currentCredentials = await OmniStorage.getCredentialsForUrl(window.location.href);
    } catch (e) {
      currentCredentials = [];
    }
  }

  /**
   * Attaches focus, click, and input listeners.
   */
  function attachGlobalListeners() {
    // Focus in handler for inputs
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
      }
      return true;
    });
  }

  /**
   * Observes dynamic DOM additions (SPAs, modals).
   */
  function observeDomChanges() {
    const observer = new MutationObserver(() => {
      // Re-attach inline icons if enabled
      if (settings && settings.showInlineIcon) {
        decorateInputs();
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    if (settings && settings.showInlineIcon) {
      decorateInputs();
    }
  }

  /**
   * Identifies login-related inputs (password or username/email).
   */
  function isTargetInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = (el.type || 'text').toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();

    if (type === 'password') return true;

    // Check if input is a likely username/email field
    if (autocomplete.includes('username') || autocomplete.includes('email')) return true;
    if (type === 'email') return true;
    if (type === 'text') {
      if (/user|login|email|account|usr|identifier/i.test(name) || /user|login|email|account|usr|identifier/i.test(id)) {
        return true;
      }
      // Or if it shares a form with a password field
      if (el.form && el.form.querySelector('input[type="password"]')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Finds related username & password inputs within the same form/context.
   */
  function getRelatedInputs(target) {
    let form = target.form;
    let usernameInput = null;
    let passwordInput = null;

    if (!form) {
      // Look in closest container or document
      const container = target.closest('form, div[role="form"], main, .login, .auth, body') || document;
      const inputs = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'));
      passwordInput = inputs.find(i => (i.type || '').toLowerCase() === 'password');
      usernameInput = inputs.find(i => isTargetInput(i) && (i.type || '').toLowerCase() !== 'password');
    } else {
      passwordInput = form.querySelector('input[type="password"]');
      const inputs = Array.from(form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'));
      usernameInput = inputs.find(i => isTargetInput(i) && (i.type || '').toLowerCase() !== 'password');
    }

    if (target.type === 'password') {
      passwordInput = target;
    } else if (isTargetInput(target)) {
      usernameInput = target;
    }

    return { usernameInput, passwordInput };
  }

  /**
   * Adds modern inline key badges to inputs.
   */
  function decorateInputs() {
    const inputs = document.querySelectorAll('input[type="password"], input[type="email"], input[autocomplete*="username"]');
    inputs.forEach(input => {
      if (input.dataset.omnipassDecorated) return;
      input.dataset.omnipassDecorated = 'true';
    });
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
   * Render and show the credential picker dropdown.
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
        <div class="op-badge ${isHttp ? 'op-badge-insecure' : 'op-badge-secure'}" title="${isHttp ? 'Insecure HTTP site: OmniPass bypasses native Chrome block' : 'Secure HTTPS Connection'}">
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
    `;

    if (currentCredentials.length > 0) {
      html += `<div class="op-section-label">Logins for ${hostname}${port}</div>`;
      html += `<div class="op-creds-list">`;
      currentCredentials.forEach((cred, idx) => {
        html += `
          <div class="op-cred-item" data-index="${idx}" tabindex="0">
            <div class="op-cred-avatar">
              ${(cred.username ? cred.username[0] : 'U').toUpperCase()}
            </div>
            <div class="op-cred-info">
              <div class="op-cred-user">${escapeHtml(cred.username || 'No username')}</div>
              <div class="op-cred-pass">••••••••</div>
            </div>
            <div class="op-cred-actions">
              <button type="button" class="op-btn-copy" data-action="copy" data-index="${idx}" title="Copy password">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
              <button type="button" class="op-btn-fill" data-action="fill" data-index="${idx}">
                Fill
              </button>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    } else {
      html += `
        <div class="op-empty-state">
          <div class="op-empty-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
          </div>
          <div class="op-empty-text">No saved logins for <strong>${escapeHtml(hostname)}</strong></div>
          <div class="op-empty-sub">Add a credential or generate a strong password below.</div>
        </div>
      `;
    }

    // Quick Actions footer
    html += `
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
          Add Login
        </button>
      </div>
    `;

    wrapper.innerHTML = '';
    wrapper.appendChild(dropdown);
    activeDropdown = dropdown;

    // Attach interaction handlers
    attachDropdownEvents(dropdown);
    positionDropdown(dropdown, input);
  }

  /**
   * Positions dropdown relative to the active input with collision detection.
   */
  function positionDropdown(dropdown, input) {
    if (!dropdown || !input) return;
    const rect = input.getBoundingClientRect();
    const dropdownHeight = dropdown.offsetHeight || 220;
    const dropdownWidth = 320;

    let top = rect.bottom + 6;
    let left = rect.left;

    // Collision detection: Check if it overflows viewport bottom
    if (rect.bottom + dropdownHeight > window.innerHeight) {
      // Place above input
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
   * Handles click actions inside the picker dropdown.
   */
  function attachDropdownEvents(dropdown) {
    dropdown.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-action], .op-cred-item');
      if (!target) return;

      const action = target.dataset.action;
      const index = target.dataset.index;

      if (action === 'fill' || target.classList.contains('op-cred-item')) {
        const credIdx = parseInt(target.dataset.index ?? target.closest('.op-cred-item')?.dataset.index, 10);
        if (!isNaN(credIdx) && currentCredentials[credIdx]) {
          fillCredential(currentCredentials[credIdx]);
          hidePickerDropdown();
        }
      } else if (action === 'copy') {
        e.stopPropagation();
        const credIdx = parseInt(index, 10);
        if (!isNaN(credIdx) && currentCredentials[credIdx]) {
          await copyToClipboard(currentCredentials[credIdx].password);
          showToast('Password copied to clipboard!');
        }
      } else if (action === 'generate') {
        const password = generateStrongPassword();
        if (currentTargetInput) {
          fillInput(currentTargetInput, password);
          showToast('Generated password filled!');
        }
        hidePickerDropdown();
      } else if (action === 'add-current') {
        const { usernameInput, passwordInput } = getRelatedInputs(currentTargetInput);
        const uVal = usernameInput ? usernameInput.value : '';
        const pVal = passwordInput ? passwordInput.value : '';
        
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

    // Record last used
    if (cred.id) {
      OmniStorage.markLastUsed(cred.id);
    }

    showToast(`Filled credentials for ${cred.username || 'account'}`);
  }

  /**
   * Sets value and triggers input / change events so React/Vue/vanilla frameworks react.
   */
  function fillInput(input, value) {
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

    // Animate in
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
      chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
      dismiss();
      showToast('Login saved to OmniPass!');
    };

    // Auto dismiss after 15s
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
        width: 310px;
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
        padding: 4px 6px 8px 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        margin-bottom: 6px;
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

      .op-section-label {
        font-size: 11px;
        color: #9ca3af;
        padding: 4px 6px;
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }

      /* Credential Items List */
      .op-creds-list {
        max-height: 200px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .op-creds-list::-webkit-scrollbar {
        width: 4px;
      }
      .op-creds-list::-webkit-scrollbar-thumb {
        background: #374151;
        border-radius: 4px;
      }

      .op-cred-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
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

      .op-cred-user {
        font-weight: 500;
        color: #f3f4f6;
        font-size: 12.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .op-cred-pass {
        color: #9ca3af;
        font-size: 11px;
        letter-spacing: 1px;
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
        padding: 16px 8px;
        text-align: center;
        color: #9ca3af;
      }

      .op-empty-icon {
        color: #6b7280;
        margin-bottom: 6px;
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
