/**
 * Passwords Content Script
 * Provides in-page credential dropdown, autofill, inline field trigger,
 * complete suppression of native browser autofill options,
 * and reliable password options for insecure HTTP and HTTPS.
 */

(function () {
  // Prevent duplicate injection
  if (window.__PASSWORDS_INITIALIZED__) return;
  window.__PASSWORDS_INITIALIZED__ = true;

  let currentTargetInput = null;
  let activeDropdown = null;
  let shadowRoot = null;
  let containerEl = null;
  let settings = null;
  let credentialsSummary = { matched: [], others: [], all: [] };
  let currentCredentials = [];
  let isPositioning = false;
  let isDeletingConfirm = false;
  let inputObserver = null;

  // Immediately inject global suppression styles at document_start
  injectGlobalSuppressionStyles();

  // Early mutation observer to intercept input elements before Chrome renders or autofocuses them
  const earlyDomObserver = new MutationObserver((mutations) => {
    let hasNewInputs = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (node.tagName === 'INPUT' || (node.querySelector && node.querySelector('input'))) {
            hasNewInputs = true;
            break;
          }
        }
      }
      if (hasNewInputs) break;
    }
    if (hasNewInputs) {
      decorateInputs();
    }
  });

  try {
    earlyDomObserver.observe(document.documentElement || document, {
      childList: true,
      subtree: true
    });
  } catch (e) {}

  // Initialize extension context
  async function init() {
    try {
      settings = await OmniStorage.getSettings();
    } catch (e) {
      settings = { hideNativeOptions: true, enableOnHttp: true, autoSuggestOnFocus: true, showInlineIcon: true };
    }
    const isHttp = window.location.protocol === 'http:';

    // If disabled on HTTP and currently on HTTP, skip
    if (isHttp && !settings.enableOnHttp) {
      return;
    }

    const mountContainer = () => {
      createShadowHost();
      refreshCredentials();
      attachGlobalListeners();
      observeDomChanges();
      checkPendingSavePrompt();
    };

    if (document.body) {
      mountContainer();
    } else {
      document.addEventListener('DOMContentLoaded', mountContainer, { once: true });
    }
  }

  /**
   * Creates isolated Shadow DOM container for all Passwords UI elements.
   */
  function createShadowHost() {
    containerEl = document.createElement('div');
    containerEl.id = 'passwords-root';
    containerEl.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647; pointer-events: none;';

    shadowRoot = containerEl.attachShadow({ mode: 'open' });

    // Inject styles into shadow DOM
    const style = document.createElement('style');
    style.textContent = getShadowStyles();
    shadowRoot.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.id = 'passwords-wrapper';
    wrapper.style.pointerEvents = 'auto';
    shadowRoot.appendChild(wrapper);

    // Inline field button
    const fieldIcon = document.createElement('button');
    fieldIcon.id = 'passwords-field-icon';
    fieldIcon.className = 'pw-field-icon';
    fieldIcon.setAttribute('type', 'button');
    fieldIcon.setAttribute('data-tooltip', 'Password Manager: Show saved logins');
    fieldIcon.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2-1 4-3 7-3 3 0 5 2 7 3a1 1 0 0 1 1 1v7z"/>
        <circle cx="12" cy="11" r="1"/>
        <path d="M12 12v2.5"/>
      </svg>
    `;
    fieldIcon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentTargetInput) {
        currentTargetInput.readOnly = false;

        if (activeDropdown) {
          currentTargetInput.dataset.ignoreFocusOnce = 'true';
          currentTargetInput.focus();
          hidePickerDropdown();
        } else {
          currentTargetInput.focus();
          if (!activeDropdown) {
            showPickerDropdown(currentTargetInput);
          }
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
    document.addEventListener('focusout', onInputBlur, true);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('submit', onFormSubmit, true);

    window.addEventListener('resize', repositionActiveDropdown, { passive: true });
    window.addEventListener('scroll', repositionActiveDropdown, { passive: true });

    // Custom Tooltip Controller inside Shadow DOM / Page
    let activeInPageTooltipEl = null;

    function showInPageTooltip(target) {
      hideInPageTooltip();
      const text = target.getAttribute('data-tooltip');
      if (!text || !text.trim() || !shadowRoot) return;

      activeInPageTooltipEl = document.createElement('div');
      activeInPageTooltipEl.className = 'pw-custom-tooltip';
      activeInPageTooltipEl.textContent = text;
      shadowRoot.appendChild(activeInPageTooltipEl);

      const targetRect = target.getBoundingClientRect();
      const tooltipRect = activeInPageTooltipEl.getBoundingClientRect();

      let top = targetRect.top - tooltipRect.height - 6;
      let left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;

      if (top < 4) {
        top = targetRect.bottom + 6;
        activeInPageTooltipEl.classList.add('pw-tooltip-bottom');
      }

      if (left < 6) {
        left = 6;
      } else if (left + tooltipRect.width > window.innerWidth - 6) {
        left = window.innerWidth - tooltipRect.width - 6;
      }

      activeInPageTooltipEl.style.top = `${Math.round(top)}px`;
      activeInPageTooltipEl.style.left = `${Math.round(left)}px`;

      requestAnimationFrame(() => {
        if (activeInPageTooltipEl) {
          activeInPageTooltipEl.classList.add('pw-tooltip-visible');
        }
      });
    }

    function hideInPageTooltip() {
      if (activeInPageTooltipEl) {
        const el = activeInPageTooltipEl;
        activeInPageTooltipEl = null;
        el.classList.remove('pw-tooltip-visible');
        setTimeout(() => el.remove(), 120);
      }
    }

    // Attach tooltip listeners inside shadowRoot
    if (shadowRoot) {
      shadowRoot.addEventListener('mouseenter', (e) => {
        const target = e.target.closest ? e.target.closest('[data-tooltip]') : null;
        if (target) showInPageTooltip(target);
      }, true);

      shadowRoot.addEventListener('mouseleave', (e) => {
        const target = e.target.closest ? e.target.closest('[data-tooltip]') : null;
        if (target) hideInPageTooltip();
      }, true);

      shadowRoot.addEventListener('mousedown', () => {
        hideInPageTooltip();
      }, true);
    }

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
      if (message.type === 'REFRESH_CREDENTIALS') {
        refreshCredentials().then(() => {
          sendResponse({ success: true });
        }).catch(() => {
          sendResponse({ success: false });
        });
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

  function isTargetInput(el) {
    if (!el || el.tagName !== 'INPUT' || isExcludedField(el)) return false;
    const type = (el.type || 'text').toLowerCase();

    if (type === 'password') return true;

    // Strong signal: explicitly marked as username
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.includes('username')) return true;

    // For other text/email fields, require a password input in the same form context
    // to confirm this is actually a login screen and not a newsletter/contact form.
    const form = el.form || el.closest('form, div[role="form"], main, .login, .auth');
    if (form && form.querySelector('input[type="password"]')) {
      if (isExplicitUsernameInput(el)) return true;
      if (type === 'text' || type === 'email' || !el.hasAttribute('type')) return true;
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
      if (input.dataset.passwordsDecorated) return;
      input.dataset.passwordsDecorated = 'true';

      if (!settings || settings.hideNativeOptions !== false) {
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
      if (input.dataset.passwordsOrigReadonly === undefined) {
        input.dataset.passwordsOrigReadonly = input.hasAttribute('readonly') ? 'true' : 'false';
      }
      if (input.dataset.passwordsOrigReadonly === 'true') {
        return;
      }

      // Handle autofocus: Chrome triggers native autofill popup immediately on page load
      // if an input has the autofocus attribute. Neutralize it early!
      if (input.hasAttribute('autofocus')) {
        input.removeAttribute('autofocus');
        input.dataset.passwordsHadAutofocus = 'true';
        if (document.activeElement === input) {
          input.blur();
        }
      }

      // 1. Force autocomplete to off / new-password to stop Chrome's generic popup
      input.setAttribute('autocomplete', 'chrome-off');
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-1p-ignore', 'true');
      input.setAttribute('data-bwignore', 'true');
      input.setAttribute('aria-autocomplete', 'none');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');

      if (input.form) {
        input.form.setAttribute('autocomplete', 'off');
      }

      // 2. Readonly shield: prevents Chrome from popping up native suggestion menu on click or focus.
      // Keeps input readonly initially; on explicit user pointer or key interaction, unlocks immediately.
      input.readOnly = true;

      const releaseReadOnly = () => {
        // Unlock field slightly after touch/mouse to let our dropdown trigger without Chrome's native autofill
        setTimeout(() => {
          if (input.dataset.passwordsOrigReadonly !== 'true') {
            input.readOnly = false;
          }
        }, 120);
      };

      input.addEventListener('pointerdown', releaseReadOnly, { capture: true, passive: true });
      input.addEventListener('mousedown', releaseReadOnly, { capture: true, passive: true });
      input.addEventListener('touchstart', releaseReadOnly, { capture: true, passive: true });
      input.addEventListener('keydown', () => {
        if (input.dataset.passwordsOrigReadonly !== 'true') {
          input.readOnly = false;
        }
      }, { capture: true, passive: true });

      input.addEventListener('blur', () => {
        if (input.dataset.passwordsOrigReadonly !== 'true') {
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
    if (document.getElementById('passwords-native-suppression-styles')) return;
    const style = document.createElement('style');
    style.id = 'passwords-native-suppression-styles';
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
    const icon = shadowRoot.getElementById('passwords-field-icon');
    if (!icon) return;

    const rect = input.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const iconSize = 20;

    const computedStyle = window.getComputedStyle(input);
    const borderRight = parseFloat(computedStyle.borderRightWidth) || 0;

    // Base offset from the inner right edge
    let rightOffset = 8;

    // Password fields often have native 'show password' eye icons on the right edge
    if (input.type === 'password') {
      rightOffset = 32;
    }

    const top = rect.top + (rect.height - iconSize) / 2 + window.scrollY;
    const left = rect.right - borderRight - iconSize - rightOffset + window.scrollX;

    icon.style.top = `${top}px`;
    icon.style.left = `${left}px`;
    icon.classList.add('pw-icon-visible');
  }

  function hideFieldIcon() {
    if (!shadowRoot) return;
    const icon = shadowRoot.getElementById('passwords-field-icon');
    if (icon) {
      icon.classList.remove('pw-icon-visible');
    }
  }

  function observeInputVisibility(input) {
    if (inputObserver) {
      inputObserver.disconnect();
    }
    if (!window.IntersectionObserver) return;

    inputObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      // Hide if the input goes out of view, is removed, or is hidden via CSS
      if (!entry.isIntersecting || !document.body.contains(input)) {
        hideFieldIcon();
        hidePickerDropdown();
      }
    }, {
      root: null, // viewport
      threshold: 0
    });
    inputObserver.observe(input);
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
    observeInputVisibility(target);

    const ignoreFocus = target.dataset.ignoreFocusOnce === 'true';
    if (ignoreFocus) target.dataset.ignoreFocusOnce = 'false';

    await refreshCredentials();

    if (!ignoreFocus && settings && settings.autoSuggestOnFocus !== false) {
      if (!activeDropdown) {
        showPickerDropdown(target);
      }
    }
  }

  /**
   * Handle focus loss.
   */
  function onInputBlur(e) {
    const related = e.relatedTarget;

    // If focus moves to our input, keep open
    if (related === currentTargetInput) {
      return;
    }

    // If focus moves within our dropdown, keep open
    if (related && (related === containerEl || (related.nodeType && shadowRoot && shadowRoot.contains(related)))) {
      return;
    }

    // If blur occurred because an internal button or popover was clicked/removed, keep dropdown open
    if (activeDropdown && (isDeletingConfirm || (e.target && e.target.closest && (e.target.closest('.pw-delete-wrap') || e.target.closest('.pw-delete-confirm-popover'))))) {
      return;
    }

    // If the element losing focus was just removed from the DOM (e.g. a deleted popover),
    // it will have no parent. Don't close the dropdown in this case.
    if (e.target && !e.target.parentNode) {
      return;
    }

    hidePickerDropdown();
  }

  /**
   * Handle document click.
   */
  function onDocumentClick(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const clickedInsideShadow = path.some(node => node && (node === containerEl || (node.nodeType && shadowRoot && shadowRoot.contains(node))));
    const clickedInsideTargetInput = path.some(node => node === currentTargetInput);
    const clickedInput = path.find(node => node && node.tagName === 'INPUT' && isTargetInput(node));

    if (!clickedInsideShadow) {
      if (!clickedInput && !clickedInsideTargetInput) {
        hidePickerDropdown();
        hideFieldIcon();
      } else if (clickedInput && settings && settings.autoSuggestOnFocus !== false) {
        if (!activeDropdown) {
          showPickerDropdown(clickedInput);
        }
      }
    }

    const target = e.target;
    if (target && target.closest) {
      const btn = target.closest('button, input[type="submit"], [role="button"]');
      if (btn) {
        const type = (btn.type || '').toLowerCase();
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (type === 'submit' || text.includes('login') || text.includes('sign in') || text.includes('submit') || text.includes('continue')) {
          const container = btn.closest('form, div[role="form"], .login, .auth, main') || document;
          checkAndPromptSave(container);
        }
      }
    }
  }

  /**
   * Handle key events (Escape to close, navigation).
   */
  function onKeyDown(e) {
    if (e.key === 'Escape' && activeDropdown) {
      if (activeDropdown.querySelector('.pw-delete-confirm-popover')) {
        e.stopPropagation();
        closeActiveContentDeleteConfirm();
        return;
      }
      hidePickerDropdown();
      if (currentTargetInput) {
        currentTargetInput.dataset.ignoreFocusOnce = 'true';
        currentTargetInput.focus();
      }
    }
    if (e.key === 'Enter') {
      const target = e.target;
      if (target && target.tagName === 'INPUT') {
        const container = target.closest('form, div[role="form"], .login, .auth, main') || document;
        checkAndPromptSave(container);
      }
    }
  }

  /**
   * Render and show the credential picker dropdown with valid options.
   */
  function showPickerDropdown(input) {
    if (!shadowRoot) return;
    const wrapper = shadowRoot.getElementById('passwords-wrapper');
    if (!wrapper) return;

    currentTargetInput = input;
    const isHttp = window.location.protocol === 'http:';
    const hostname = window.location.hostname || 'this site';
    const port = window.location.port ? `:${window.location.port}` : '';

    const dropdown = document.createElement('div');
    dropdown.className = 'passwords-dropdown';
    dropdown.setAttribute('role', 'dialog');
    dropdown.setAttribute('aria-label', 'Password Manager Credential Selector');

    let html = `

      <!-- Quick Search Bar -->
      <div class="pw-search-wrap">
        <svg class="pw-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" id="pw-search-filter" class="pw-search-filter" placeholder="Search or choose account..." autocomplete="off" spellcheck="false">
      </div>

      <!-- Accounts List Container -->
      <div class="pw-creds-container" id="pw-creds-container">
        <!-- Rendered dynamically -->
      </div>

      <!-- Quick Actions footer -->
      <div class="pw-footer">
        <button type="button" class="pw-action-btn" data-action="generate">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          Generate
        </button>
        <button type="button" class="pw-action-btn" data-action="add-current">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Save This Login
        </button>
      </div>
    `;

    if (activeDropdown && activeDropdown.parentNode) {
      activeDropdown.parentNode.removeChild(activeDropdown);
    }

    dropdown.innerHTML = html;
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
    const container = dropdown.querySelector('#pw-creds-container');
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
        html += `<div class="pw-group-title">Search Results (${all.length})</div>`;
        html += `<div class="pw-creds-list">`;
        all.forEach(cred => {
          html += renderCredentialItemHtml(cred, true, q);
        });
        html += `</div>`;
      } else {
        html += `
          <div class="pw-empty-state">
            <div class="pw-empty-text">No logins match "<strong>${escapeHtml(filterText)}</strong>"</div>
            <div class="pw-empty-sub">Use 'Save This Login' below to remember this account.</div>
          </div>
        `;
      }
    } else {
      // Normal display
      if (matched.length > 0) {
        html += `<div class="pw-group-title">Logins for ${escapeHtml(hostname)}${port}</div>`;
        html += `<div class="pw-creds-list">`;
        matched.forEach(cred => {
          html += renderCredentialItemHtml(cred, false, '');
        });
        html += `</div>`;
      } else {
        html += `
          <div class="pw-empty-state">
            <div class="pw-empty-text">Your vault is ready</div>
            <div class="pw-empty-sub">Enter your login and click 'Save This Login' below.</div>
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

  function highlightMatch(text, query) {
    const raw = text || '';
    if (!query) return escapeHtml(raw);
    const escapedText = escapeHtml(raw);
    const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return escapedText.replace(regex, '<mark class="pw-search-highlight">$1</mark>');
  }

  function formatLastUsed(ts) {
    if (!ts) return '';
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60 * 1000) return 'Used just now';
    if (diff < 60 * 60 * 1000) {
      const mins = Math.floor(diff / (60 * 1000));
      return `Used ${mins}m ago`;
    }
    if (diff < 24 * 60 * 60 * 1000) {
      const hrs = Math.floor(diff / (60 * 60 * 1000));
      return `Used ${hrs}h ago`;
    }
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    if (days === 1) return 'Used yesterday';
    if (days < 30) return `Used ${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderCredentialItemHtml(cred, isSearchResult, query = '') {
    const firstLetter = (cred.username ? cred.username[0] : 'U').toUpperCase();
    const lastUsedText = formatLastUsed(cred.lastUsed);
    const highlightedUsername = highlightMatch(cred.username || 'No username', query);
    const siteSource = cred.hostname || (cred.origin ? new URL(cred.origin).hostname : '');
    const highlightedSource = highlightMatch(siteSource, query);

    return `
      <div class="pw-cred-item" data-id="${escapeHtml(cred.id)}" tabindex="0">
        <div class="pw-cred-avatar">
          ${firstLetter}
        </div>
        <div class="pw-cred-info">
          <div class="pw-cred-user-row">
            <span class="pw-cred-user" data-tooltip="${escapeHtml(cred.username || 'No username')}">${highlightedUsername}</span>
            ${!isSearchResult && cred.hostname && cred.origin !== window.location.origin ? `<span class="pw-origin-tag" data-tooltip="${escapeHtml(cred.origin || cred.hostname)}">${escapeHtml(cred.hostname)}</span>` : ''}
          </div>
          ${isSearchResult && siteSource ? `
            <div class="pw-cred-source-row" data-tooltip="${escapeHtml(cred.origin || siteSource)}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
              <span>${highlightedSource}</span>
            </div>
          ` : ''}
          <div class="pw-cred-pass" data-pass="${escapeHtml(cred.password)}" data-tooltip="${escapeHtml(cred.password)}">
            <svg class="pw-pass-key-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span class="pw-pass-text"></span>
          </div>
          ${lastUsedText ? `<div class="pw-last-used-sub">${escapeHtml(lastUsedText)}</div>` : ''}
        </div>
        <div class="pw-cred-actions">
          <button type="button" class="pw-btn-toggle-pass" data-action="toggle-pass" data-tooltip="Show / hide password">
            <svg class="pw-eye-open" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <svg class="pw-eye-closed" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
              <line x1="1" y1="1" x2="23" y2="23"></line>
            </svg>
          </button>
          <button type="button" class="pw-btn-copy" data-action="copy" data-id="${escapeHtml(cred.id)}" data-tooltip="Copy password">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <div class="pw-delete-wrap">
            <button type="button" class="pw-btn-delete" data-action="delete" data-id="${escapeHtml(cred.id)}" data-tooltip="Delete login">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
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
    dropdown.classList.add('pw-visible');
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
   * Closes any active delete confirmation popover in the dropdown.
   */
  function closeActiveContentDeleteConfirm() {
    if (!activeDropdown) return;
    activeDropdown.querySelectorAll('.pw-delete-confirm-popover').forEach(p => {
      if (p._timeoutId) clearTimeout(p._timeoutId);
      if (p.parentNode) {
        try {
          p.parentNode.removeChild(p);
        } catch (_) {}
      }
    });
    activeDropdown.querySelectorAll('.pw-btn-delete.active-delete').forEach(b => {
      b.classList.remove('active-delete');
    });
    activeDropdown.querySelectorAll('.pw-cred-item.has-active-confirm').forEach(i => {
      i.classList.remove('has-active-confirm');
    });
  }

  /**
   * Hides the active dropdown picker.
   */
  function hidePickerDropdown() {
    closeActiveContentDeleteConfirm();
    if (activeDropdown) {
      const dropdownToHide = activeDropdown;
      dropdownToHide.classList.remove('pw-visible');
      activeDropdown = null;
      setTimeout(() => {
        if (dropdownToHide.parentNode) {
          dropdownToHide.parentNode.removeChild(dropdownToHide);
        }
      }, 150);
    }
  }

  /**
   * Handles click and search events inside the picker dropdown.
   */
  function attachDropdownEvents(dropdown) {
    // Search input listener
    const searchInput = dropdown.querySelector('#pw-search-filter');
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
      // If an active delete confirm popover is open, clicking elsewhere inside dropdown dismisses it
      if (activeDropdown && activeDropdown.querySelector('.pw-delete-confirm-popover')) {
        const isDeleteAction = e.target.closest('.pw-btn-delete, .pw-delete-confirm-popover');
        if (!isDeleteAction) {
          e.stopPropagation();
          closeActiveContentDeleteConfirm();
          return;
        }
      }

      // Toggle password reveal via eye button
      const togglePassBtn = e.target.closest('[data-action="toggle-pass"]');
      if (togglePassBtn) {
        e.stopPropagation();
        const credItem = togglePassBtn.closest('.pw-cred-item');
        const passEl = credItem ? credItem.querySelector('.pw-cred-pass') : null;
        if (passEl) {
          const rawPass = passEl.dataset.pass || '';
          const passTextEl = passEl.querySelector('.pw-pass-text');
          const eyeOpen = togglePassBtn.querySelector('.pw-eye-open');
          const eyeClosed = togglePassBtn.querySelector('.pw-eye-closed');
          const isRevealed = passEl.classList.contains('pw-revealed');
          if (!isRevealed) {
            if (passTextEl) passTextEl.textContent = rawPass;
            passEl.classList.add('pw-revealed');
            togglePassBtn.classList.add('active');
            if (eyeOpen) eyeOpen.style.display = 'none';
            if (eyeClosed) eyeClosed.style.display = 'inline-block';
          } else {
            passEl.classList.remove('pw-revealed');
            togglePassBtn.classList.remove('active');
            if (eyeOpen) eyeOpen.style.display = 'inline-block';
            if (eyeClosed) eyeClosed.style.display = 'none';
            setTimeout(() => {
              if (!passEl.classList.contains('pw-revealed') && passTextEl) {
                passTextEl.textContent = '';
              }
            }, 200);
          }
        }
        return;
      }

      // Clicking on the password text itself does nothing or fills as part of item click
      const isCopyOrDelete = e.target.closest('.pw-btn-copy, .pw-btn-delete, .pw-delete-confirm-popover');
      if (isCopyOrDelete) {
        // Handled by copy/delete branches below
      }

      const target = e.target.closest('[data-action], .pw-cred-item');
      if (!target) return;

      const action = target.dataset.action;
      const credItem = target.closest('.pw-cred-item') || target;
      const credId = target.dataset.id || credItem.dataset.id;
      const cred = currentCredentials.find(c => c.id === credId);

      if (action === 'fill' || target.classList.contains('pw-cred-item') || (!action && target.closest('.pw-cred-item'))) {
        if (cred) {
          fillCredential(cred);
          hidePickerDropdown();
        }
      } else if (action === 'copy') {
        e.stopPropagation();
        if (cred) {
          if (cred.id) {
            OmniStorage.markLastUsed(cred.id);
          }
          await copyToClipboard(cred.password);
          showToast('Password copied to clipboard!');
        }
      } else if (action === 'delete') {
        e.stopPropagation();
        const deleteBtn = target.classList.contains('pw-btn-delete') ? target : target.closest('.pw-btn-delete');
        if (!deleteBtn) return;
        const deleteWrap = deleteBtn.closest('.pw-delete-wrap');
        const credItem = deleteBtn.closest('.pw-cred-item');
        if (!deleteWrap) return;

        const existing = deleteWrap.querySelector('.pw-delete-confirm-popover');
        if (existing) {
          closeActiveContentDeleteConfirm();
          return;
        }

        closeActiveContentDeleteConfirm();
        deleteBtn.classList.add('active-delete');
        if (credItem) credItem.classList.add('has-active-confirm');

        const pop = document.createElement('div');
        pop.className = 'pw-delete-confirm-popover';
        pop.innerHTML = `
          <span class="pw-delete-confirm-text">Delete login?</span>
          <div class="pw-delete-confirm-btns">
            <button type="button" class="pw-btn-confirm-del" data-id="${escapeHtml(credId)}">Delete</button>
            <button type="button" class="pw-btn-cancel-del">Cancel</button>
          </div>
        `;

        pop.addEventListener('click', (evt) => {
          evt.stopPropagation();
        });

        const confirmBtn = pop.querySelector('.pw-btn-confirm-del');
        const cancelBtn = pop.querySelector('.pw-btn-cancel-del');

        confirmBtn.addEventListener('click', async (evt) => {
          evt.stopPropagation();
          evt.preventDefault();
          isDeletingConfirm = true;
          const deletedBackup = cred ? { ...cred } : null;
          try {
            closeActiveContentDeleteConfirm();
            await OmniStorage.deleteCredential(credId);
            try {
              if (window.PasswordCredential && navigator.credentials) {
                await navigator.credentials.preventSilentAccess();
              }
            } catch (err) {
              console.warn("Failed to prevent silent access via Credential Management API", err);
            }
            showToast('Login deleted', deletedBackup ? {
              label: 'Undo',
              onClick: async () => {
                await OmniStorage.saveCredential(deletedBackup);
                await refreshCredentials();
                if (activeDropdown && activeDropdown.classList.contains('pw-visible')) {
                  const searchInput = activeDropdown.querySelector('#pw-search-filter');
                  renderDropdownAccounts(activeDropdown, searchInput ? searchInput.value : '');
                }
                showToast('Login restored');
              }
            } : null);
            await refreshCredentials();
            if (activeDropdown && activeDropdown.classList.contains('pw-visible')) {
              const searchInput = activeDropdown.querySelector('#pw-search-filter');
              renderDropdownAccounts(activeDropdown, searchInput ? searchInput.value : '');
            }
          } finally {
            isDeletingConfirm = false;
          }
        });

        cancelBtn.addEventListener('click', (evt) => {
          evt.stopPropagation();
          evt.preventDefault();
          closeActiveContentDeleteConfirm();
        });

        deleteWrap.appendChild(pop);

        const timeoutId = setTimeout(() => {
          if (deleteWrap.contains(pop)) {
            closeActiveContentDeleteConfirm();
          }
        }, 7000);
        pop._timeoutId = timeoutId;
      } else if (action === 'generate') {
        const password = generateStrongPassword();
        if (currentTargetInput) {
          const { passwordInput } = getRelatedInputs(currentTargetInput);
          const targetInput = passwordInput || currentTargetInput;
          fillInput(targetInput, password);
          flashFieldSuccess(targetInput);
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

        try {
          if (window.PasswordCredential && navigator.credentials) {
            const googleCred = new PasswordCredential({
              id: uVal || 'unknown',
              password: pVal,
              name: uVal
            });
            await navigator.credentials.store(googleCred);
          }
        } catch (err) {
          console.warn("Failed to save to Google Password Manager", err);
        }

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
    input.dataset.ignoreFocusOnce = 'true';
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

  function checkAndPromptSave(container) {
    if (!settings || !settings.promptToSaveOnSubmit) return;
    if (!container || !container.querySelector) return;

    const passwordInput = container.querySelector('input[type="password"]');
    if (!passwordInput || !passwordInput.value) return;

    const { usernameInput } = getRelatedInputs(passwordInput);
    const username = usernameInput ? usernameInput.value : '';
    const password = passwordInput.value;

    if (!password) return;

    // Check if already in vault with same password
    const matchingCred = currentCredentials.find(
      c => (c.username || '').toLowerCase() === (username || '').toLowerCase()
    );

    if (matchingCred && matchingCred.password === password) {
      return; // Already up-to-date with identical password
    }

    const isUpdate = !!matchingCred;

    const credData = {
      origin: window.location.origin,
      hostname: window.location.hostname,
      protocol: window.location.protocol,
      port: window.location.port,
      username,
      password,
      isUpdate,
      timestamp: Date.now()
    };

    // Store in sessionStorage to survive page navigation/reload
    try {
      sessionStorage.setItem('pw_pending_save', JSON.stringify(credData));
    } catch (e) {
      // Ignore quota/access errors
    }

    showSavePrompt(credData);
  }

  /**
   * Checks if there is a pending login save from a recent form submission or navigation.
   */
  async function checkPendingSavePrompt() {
    // Only show pending save prompts in the top-level window, never inside embedded iframes
    if (window.top !== window.self) return;
    if (!settings || !settings.promptToSaveOnSubmit) return;
    let pending = null;
    try {
      const raw = sessionStorage.getItem('pw_pending_save');
      if (raw) {
        pending = JSON.parse(raw);
      }
    } catch (e) {
      return;
    }

    if (!pending || !pending.password) return;

    // Only prompt within 60 seconds of submission on the same origin
    const isRecent = Date.now() - (pending.timestamp || 0) < 60000;
    const sameOrigin = pending.origin === window.location.origin;

    if (!isRecent || !sameOrigin) {
      try { sessionStorage.removeItem('pw_pending_save'); } catch (e) { }
      return;
    }

    // Refresh credentials to see if this matches existing
    await refreshCredentials();

    const matchingCred = currentCredentials.find(
      c => (c.username || '').toLowerCase() === (pending.username || '').toLowerCase()
    );

    if (matchingCred && matchingCred.password === pending.password) {
      // Already matching and saved
      try { sessionStorage.removeItem('pw_pending_save'); } catch (e) { }
      return;
    }

    pending.isUpdate = !!matchingCred;

    // Show prompt on the destination page
    showSavePrompt(pending);
  }

  function onFormSubmit(e) {
    checkAndPromptSave(e.target);
  }

  /**
   * Renders modern floating "Save Password" toast banner in Shadow DOM.
   */
  function showSavePrompt(cred) {
    if (!shadowRoot) return;
    const existingPrompt = shadowRoot.getElementById('passwords-save-prompt');
    if (existingPrompt) existingPrompt.remove();

    const isHttp = cred.protocol === 'http:';
    const isUpdate = !!cred.isUpdate;
    const prompt = document.createElement('div');
    prompt.id = 'passwords-save-prompt';
    prompt.className = 'pw-save-prompt';

    const titleText = isUpdate ? 'Update password in Password Manager?' : 'Save login to Password Manager?';
    const buttonText = isUpdate ? 'Update' : 'Save';

    prompt.innerHTML = `
      <div class="pw-prompt-header">
        <div class="pw-prompt-brand">
          <div class="pw-logo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M21 2l-2 2m-1-1l-3 3m1 1l-2 2m-2-2l-4 4a5 5 0 1 1-7-7l4-4a5 5 0 0 1 7 7z"/>
            </svg>
          </div>
          <span>${titleText}</span>
        </div>
        ${isHttp ? '<span class="pw-prompt-badge">HTTP Insecure</span>' : ''}
      </div>
      <div class="pw-prompt-body">
        <div class="pw-prompt-site">${escapeHtml(cred.hostname)}</div>
        <div class="pw-prompt-fields">
          <div class="pw-prompt-field-group">
            <label class="pw-prompt-label">Username</label>
            <input type="text" class="pw-prompt-input" id="pw-prompt-username" value="${escapeHtml(cred.username || '')}" placeholder="Username or email" autocomplete="off" spellcheck="false" />
          </div>
          <div class="pw-prompt-field-group">
            <label class="pw-prompt-label">Password</label>
            <div class="pw-prompt-pass-wrap">
              <input type="password" class="pw-prompt-input pw-prompt-input-pass" id="pw-prompt-password" value="${escapeHtml(cred.password || '')}" placeholder="Password" autocomplete="off" spellcheck="false" />
              <button type="button" class="pw-prompt-toggle-pass" id="pw-prompt-eye" data-tooltip="Show / hide password">
                <svg class="pw-prompt-eye-open" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
                <svg class="pw-prompt-eye-closed" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                  <line x1="1" y1="1" x2="23" y2="23"></line>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="pw-prompt-footer">
        <button type="button" class="pw-prompt-btn pw-btn-secondary" id="pw-dismiss-btn">Not Now</button>
        <button type="button" class="pw-prompt-btn pw-btn-primary" id="pw-save-btn">${buttonText}</button>
      </div>
    `;

    const wrapper = shadowRoot.getElementById('passwords-wrapper');
    if (wrapper) {
      wrapper.appendChild(prompt);
    } else {
      shadowRoot.appendChild(prompt);
    }

    // Bind eye show/hide toggle in prompt
    const eyeBtn = prompt.querySelector('#pw-prompt-eye');
    const passInput = prompt.querySelector('#pw-prompt-password');
    const userInput = prompt.querySelector('#pw-prompt-username');
    if (eyeBtn && passInput) {
      eyeBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isCurrentlyPass = passInput.type === 'password';
        passInput.type = isCurrentlyPass ? 'text' : 'password';
        const openIcon = eyeBtn.querySelector('.pw-prompt-eye-open');
        const closedIcon = eyeBtn.querySelector('.pw-prompt-eye-closed');
        if (openIcon && closedIcon) {
          openIcon.style.display = isCurrentlyPass ? 'none' : 'block';
          closedIcon.style.display = isCurrentlyPass ? 'block' : 'none';
        }
      };
    }

    requestAnimationFrame(() => {
      prompt.classList.add('pw-prompt-visible');
    });

    const dismiss = () => {
      try { sessionStorage.removeItem('pw_pending_save'); } catch (e) { }
      prompt.classList.remove('pw-prompt-visible');
      setTimeout(() => prompt.remove(), 250);
    };

    prompt.querySelector('#pw-dismiss-btn').onclick = dismiss;
    prompt.querySelector('#pw-save-btn').onclick = async () => {
      const finalUsername = userInput ? userInput.value.trim() : cred.username;
      const finalPassword = passInput ? passInput.value : cred.password;

      if (!finalPassword) {
        showToast('Password cannot be empty');
        return;
      }

      const credToSave = {
        ...cred,
        username: finalUsername,
        password: finalPassword,
        userModified: true
      };

      await OmniStorage.saveCredential(credToSave);
      try { sessionStorage.removeItem('pw_pending_save'); } catch (e) { }

      try {
        if (window.PasswordCredential && navigator.credentials) {
          const googleCred = new PasswordCredential({
            id: credToSave.username || 'unknown',
            password: credToSave.password,
            name: credToSave.username
          });
          await navigator.credentials.store(googleCred);
        }
      } catch (err) {
        console.warn("Failed to save to Google Password Manager via prompt", err);
      }

      await refreshCredentials();
      chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => { });
      dismiss();
      showToast(isUpdate ? 'Password updated in Password Manager!' : 'Login saved to Password Manager!');
    };

    setTimeout(dismiss, 15000);
  }

  /**
   * Shows a brief toast notification in the corner, with optional undo/redo action.
   */
  function showToast(msg, action) {
    if (!shadowRoot) return;
    // Remove any existing toast
    const existing = shadowRoot.querySelectorAll('.pw-toast');
    existing.forEach(t => {
      if (t._timeout) clearTimeout(t._timeout);
      t.remove();
    });

    const toast = document.createElement('div');
    toast.className = 'pw-toast';
    
    const textSpan = document.createElement('span');
    textSpan.className = 'pw-toast-msg';
    textSpan.textContent = msg;
    toast.appendChild(textSpan);

    if (action && action.label && typeof action.onClick === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-toast-action-btn';
      btn.textContent = action.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (toast._timeout) clearTimeout(toast._timeout);
        toast.classList.remove('pw-toast-visible');
        setTimeout(() => toast.remove(), 250);
        action.onClick();
      });
      toast.appendChild(btn);
    }

    shadowRoot.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('pw-toast-visible'));
    const duration = action ? 5000 : 2500;
    toast._timeout = setTimeout(() => {
      toast.classList.remove('pw-toast-visible');
      setTimeout(() => toast.remove(), 250);
    }, duration);
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
      .passwords-dropdown {
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
        backdrpw-filter: blur(12px);
      }

      .passwords-dropdown.pw-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      /* Search Box */
      .pw-search-wrap {
        position: relative;
        margin-bottom: 8px;
      }

      .pw-search-filter {
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

      .pw-search-filter:focus {
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
      }

      .pw-search-icon {
        position: absolute;
        left: 8px;
        top: 50%;
        transform: translateY(-50%);
        color: #9ca3af;
        pointer-events: none;
      }

      /* Section & Group Titles */
      .pw-group-title {
        font-size: 10px;
        font-weight: 600;
        color: #9ca3af;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        padding: 4px 6px 3px 6px;
      }

      .pw-domain-notice {
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
      .pw-creds-container {
        max-height: 220px;
        overflow-y: auto;
      }

      .pw-creds-container::-webkit-scrollbar {
        width: 4px;
      }
      .pw-creds-container::-webkit-scrollbar-thumb {
        background: #374151;
        border-radius: 4px;
      }

      .pw-creds-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .pw-cred-item {
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

      .pw-cred-item:hover, .pw-cred-item:focus {
        background: #283548;
        border-color: rgba(99, 102, 241, 0.4);
        outline: none;
      }

      .pw-cred-avatar {
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

      .pw-cred-info {
        flex: 1;
        min-width: 0;
      }

      .pw-cred-user-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .pw-cred-user {
        font-weight: 500;
        color: #f3f4f6;
        font-size: 12.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .pw-origin-tag {
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

      .pw-cred-source-row {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10.5px;
        color: #9ca3af;
        margin-top: 2px;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pw-cred-source-row svg {
        flex-shrink: 0;
        color: #6b7280;
      }

      .pw-search-highlight {
        background: rgba(245, 158, 11, 0.28);
        color: #fbbf24;
        font-weight: 600;
        border-radius: 2px;
        padding: 0 1px;
      }

      .pw-cred-pass {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11.5px;
        color: #d1d5db;
        user-select: text;
        max-height: 0;
        opacity: 0;
        margin-top: 0;
        transform: translateY(-2px);
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        transition: max-height 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                    opacity 0.18s ease,
                    transform 0.18s ease,
                    margin-top 0.18s ease;
      }

      .pw-pass-key-icon {
        color: #818cf8;
        flex-shrink: 0;
        opacity: 0.85;
      }

      .pw-pass-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pw-cred-pass.pw-revealed {
        max-height: 20px;
        opacity: 1;
        margin-top: 2px;
        transform: translateY(0);
      }

      .pw-last-used-sub {
        font-size: 10px;
        color: #818cf8;
        margin-top: 2px;
        line-height: 1.2;
        font-weight: 500;
      }

      .pw-btn-toggle-pass {
        background: transparent;
        border: none;
        color: #9ca3af;
        cursor: pointer;
        padding: 5px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, background 0.15s, transform 0.15s;
      }

      .pw-btn-toggle-pass:hover {
        color: #f3f4f6;
        background: #374151;
      }

      .pw-btn-toggle-pass.active {
        color: #818cf8;
        background: rgba(99, 102, 241, 0.15);
      }

      .pw-cred-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .pw-btn-copy {
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

      .pw-btn-copy:hover {
        color: #f3f4f6;
        background: #374151;
      }

      .pw-delete-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .pw-btn-delete {
        background: transparent;
        border: none;
        color: #ef4444;
        cursor: pointer;
        padding: 5px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, background 0.15s;
      }

      .pw-btn-delete:hover {
        background: rgba(239, 68, 68, 0.1);
      }

      .pw-btn-delete.active-delete {
        background: rgba(239, 68, 68, 0.2) !important;
        color: #ef4444 !important;
      }

      .pw-cred-item.has-active-confirm {
        z-index: 30;
        position: relative;
      }

      .pw-delete-confirm-popover {
        position: absolute;
        right: calc(100% + 6px);
        top: 50%;
        transform: translateY(-50%);
        background: #111827;
        border: 1px solid rgba(239, 68, 68, 0.45);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(0, 0, 0, 0.3);
        border-radius: 6px;
        padding: 4px 8px;
        display: flex;
        align-items: center;
        gap: 6px;
        z-index: 1000;
        white-space: nowrap;
        animation: pwPopIn 0.15s cubic-bezier(0.16, 1, 0.3, 1);
        cursor: default;
      }

      @keyframes pwPopIn {
        from {
          opacity: 0;
          transform: translateY(-50%) translateX(4px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(-50%) translateX(0) scale(1);
        }
      }

      .pw-delete-confirm-popover::after {
        content: '';
        position: absolute;
        top: 50%;
        right: -5px;
        transform: translateY(-50%) rotate(45deg);
        width: 8px;
        height: 8px;
        background: #111827;
        border-top: 1px solid rgba(239, 68, 68, 0.45);
        border-right: 1px solid rgba(239, 68, 68, 0.45);
        pointer-events: none;
      }

      .pw-delete-confirm-text {
        font-size: 11px;
        font-weight: 600;
        color: #f3f4f6;
        user-select: none;
      }

      .pw-delete-confirm-btns {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .pw-btn-confirm-del {
        background: #ef4444;
        color: #ffffff;
        border: none;
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        line-height: 1.3;
        transition: background 0.15s;
      }

      .pw-btn-confirm-del:hover {
        background: #dc2626;
      }

      .pw-btn-cancel-del {
        background: rgba(255, 255, 255, 0.1);
        color: #9ca3af;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        line-height: 1.3;
        transition: all 0.15s;
      }

      .pw-btn-cancel-del:hover {
        background: rgba(255, 255, 255, 0.2);
        color: #ffffff;
      }

      .pw-btn-fill {
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

      .pw-btn-fill:hover {
        background: #4338ca;
      }

      /* Empty State */
      .pw-empty-state {
        padding: 14px 8px;
        text-align: center;
        color: #9ca3af;
      }

      .pw-empty-text {
        font-size: 12px;
        color: #d1d5db;
        margin-bottom: 4px;
      }

      .pw-empty-sub {
        font-size: 11px;
        color: #6b7280;
      }

      /* Footer */
      .pw-footer {
        display: flex;
        align-items: center;
        gap: 6px;
        padding-top: 8px;
        margin-top: 6px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }

      .pw-action-btn {
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

      .pw-action-btn:hover {
        background: #374151;
        color: #ffffff;
      }

      /* Inline Field Trigger Icon */
      .pw-field-icon {
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

      .pw-field-icon:hover {
        background: #374151;
        color: #a5b4fc;
        transform: scale(1.08);
      }

      .pw-field-icon.pw-icon-visible {
        display: flex;
      }

      /* Save Prompt Toast */
      .pw-save-prompt {
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
        pointer-events: auto;
      }

      .pw-save-prompt.pw-prompt-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      .pw-prompt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }

      .pw-prompt-brand {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
        color: #f9fafb;
      }

      .pw-prompt-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(245, 158, 11, 0.2);
        color: #fbbf24;
        font-weight: 500;
      }

      .pw-prompt-body {
        font-size: 12px;
        color: #9ca3af;
        margin-bottom: 12px;
        line-height: 1.4;
      }

      .pw-prompt-site {
        font-weight: 600;
        color: #e5e7eb;
        margin-bottom: 8px;
      }

      .pw-prompt-fields {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 6px;
      }

      .pw-prompt-field-group {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .pw-prompt-label {
        font-size: 11px;
        color: #9ca3af;
        font-weight: 500;
      }

      .pw-prompt-input {
        width: 100%;
        box-sizing: border-box;
        background: #1f2937;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        color: #f3f4f6;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }

      .pw-prompt-input:focus {
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
      }

      .pw-prompt-pass-wrap {
        position: relative;
        display: flex;
        align-items: center;
      }

      .pw-prompt-input-pass {
        padding-right: 32px;
      }

      .pw-prompt-toggle-pass {
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        background: transparent;
        border: none;
        color: #9ca3af;
        padding: 4px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: color 0.15s ease, background 0.15s ease;
      }

      .pw-prompt-toggle-pass:hover {
        color: #f3f4f6;
        background: rgba(255, 255, 255, 0.08);
      }

      .pw-prompt-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .pw-prompt-btn {
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: background 0.15s ease;
      }

      .pw-btn-secondary {
        background: #1f2937;
        color: #d1d5db;
      }

      .pw-btn-secondary:hover {
        background: #374151;
        color: #ffffff;
      }

      .pw-btn-primary {
        background: #6366f1;
        color: #ffffff;
      }

      .pw-btn-primary:hover {
        background: #4f46e5;
      }

      /* Notification Toast */
      .pw-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #111827;
        color: #f3f4f6;
        border: 1px solid rgba(255, 255, 255, 0.15);
        padding: 8px 14px;
        border-radius: 8px;
        font-size: 12.5px;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 10px;
        pointer-events: auto;
      }

      .pw-toast.pw-toast-visible {
        opacity: 1;
        transform: translateY(0);
      }

      .pw-toast-msg {
        line-height: 1.3;
      }

      .pw-toast-action-btn {
        background: #374151;
        color: #818cf8;
        border: 1px solid rgba(129, 140, 248, 0.3);
        padding: 3px 8px;
        border-radius: 5px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
        line-height: 1.2;
      }

      .pw-toast-action-btn:hover {
        background: #4f46e5;
        color: #ffffff;
        border-color: #4f46e5;
      }

      /* Custom In-Page Tooltip */
      .pw-custom-tooltip {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        background: #0f172a;
        color: #f1f5f9;
        border: 1px solid rgba(255, 255, 255, 0.16);
        box-shadow: 0 4px 14px -1px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(99, 102, 241, 0.2);
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 500;
        line-height: 1.25;
        white-space: nowrap;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0;
        transform: translateY(3px) scale(0.96);
        transition: opacity 0.14s cubic-bezier(0.16, 1, 0.3, 1), transform 0.14s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }

      .pw-custom-tooltip.pw-tooltip-bottom {
        transform: translateY(-3px) scale(0.96);
      }

      .pw-custom-tooltip.pw-tooltip-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    `;
  }

  // Kickstart content script
  init();
})();
