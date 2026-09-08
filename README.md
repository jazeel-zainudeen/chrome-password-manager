# Password Manager 🔑
> **Modern, lightweight Chrome extension replacing the generic saved password picker with full support for insecure HTTP sites, local dev servers, and internal networks.**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-6366F1?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-10B981?style=flat-square)](#)
[![Theme](https://img.shields.io/badge/Theme-Modern%20Dark-0F172A?style=flat-square)](#)

---

## ⚡ The Problem Password Manager Solves

In modern Google Chrome, the native password manager **strictly suppresses password auto-suggestion and autofill dropdowns on unencrypted (`http://`) origins**, displaying warnings like *"Password form on an insecure (http://) page"*.

While this policy protects public web traffic, it causes constant friction for:
- **Developers & Engineers:** Working on local development servers (`http://localhost:3000`, `http://127.0.0.1:8000`, dev microservices).
- **Network & System Administrators:** Managing internal routers, switches, IoT web interfaces (`http://192.168.1.1`, firewall consoles).
- **Enterprise Users:** Accessing internal legacy tools or staging clusters without TLS/HTTPS certificates.

**Password Manager eliminates this limitation.** It provides a standalone, lightweight in-page credential picker and autofill manager that operates seamlessly across both `http://*` and `https://*` origins.

---

## ✨ Key Features

- **🌐 Insecure HTTP Autofill & Selection:** Full password management and autofill functionality on HTTP, localhost, custom ports, and IP addresses.
- **🛡️ Isolated Shadow DOM:** All in-page UI components (dropdown picker, inline trigger icons, toast prompts) render inside a Shadow DOM (`attachShadow({ mode: 'open' })`), guaranteeing that website CSS (Tailwind, Bootstrap, resets) never disrupts the UI and vice versa.
- **⚡ One-Click Autofill:** Intelligently maps username/email and password fields and dispatches synthetic input/change events compatible with React, Vue, Angular, and standard forms.
- **🎯 Inline Field Trigger:** Sleek key icon attached inside password and username inputs for quick manual triggering.
- **💾 Automatic Save-on-Submit:** Detects successful form submission on insecure/secure sites and offers a discreet prompt to save new or updated credentials.
- **🎲 Built-in Strong Password Generator:** Cryptographically secure (`crypto.getRandomValues`) generator with customizable length, character sets, and live strength indicator.
- **📦 Full Vault Manager:**
  - Search across all saved logins.
  - Filter by HTTP (Insecure) vs. HTTPS.
  - Show/hide passwords with mask toggle.
  - One-click password copy.
- **💾 Backup & Sync:** One-click JSON export and import for seamless backup and migration.
- **🪶 Ultra Lightweight:** Zero third-party frameworks or bulky bundlers. Pure vanilla Manifest V3 HTML/CSS/JS that loads instantly.

---

## 📂 Project Structure

```
passwords/
├── manifest.json              # Manifest V3 configuration & permissions
├── icons/                     # Extension icons (16px, 48px, 128px)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── background/
│   └── service-worker.js      # Background worker, tab badges, default seeds
├── content/
│   └── content.js             # Shadow DOM in-page picker, form detection, autofill
├── popup/
│   ├── popup.html             # Sleek extension popup interface
│   ├── popup.css              # Modern dark theme styles (glassmorphism accents)
│   └── popup.js               # Popup interactions, vault CRUD, generator
├── utils/
│   ├── storage.js             # chrome.storage.local persistence & domain matching
│   └── crypto.js              # Password generator & strength evaluation
└── test-page/
    ├── index.html             # Test lab simulating HTTP insecure login forms
    └── server.py              # Lightweight HTTP test server (http://localhost:8899)
```

---

## 🚀 Quickstart: Installing in Chrome

1. **Open Extension Settings:**
   - In Google Chrome, open a new tab and navigate to:
     ```text
     chrome://extensions
     ```
2. **Enable Developer Mode:**
   - Toggle the **Developer mode** switch in the tpw-right corner.
3. **Load Unpacked Extension:**
   - Click the **Load unpacked** button in the tpw-left corner.
   - Select the directory:
     ```text
     /home/jazeel/Projects/passwords
     ```
4. **Pin Password Manager:**
   - Click Chrome's puzzle icon (Extensions) on the top toolbar and pin **Password Manager** for easy access.

---

## 🧪 Testing Insecure HTTP Functionality

To immediately verify that password selection and autofill work on an insecure HTTP origin:

1. **Start the Test Server:**
   ```bash
   cd /home/jazeel/Projects/passwords/test-page
   python3 server.py
   ```
2. **Open the Test Page:**
   Visit: **[http://localhost:8899/index.html](http://localhost:8899/index.html)** in Chrome.
3. **Verify:**
   - Notice the connection is plain `http://` (unencrypted).
   - Click inside the **Username** or **Password** input field.
   - The **Password Manager Floating Picker** will appear anchored to the input, displaying the `HTTP Unlocked` status badge and the preloaded demo account (`admin / Password123!`).
   - Click **Fill** to autofill both fields with a subtle green success glow.
   - Click **Sign In** or submit custom credentials to see the **Save to Password Manager** floating banner in the upper right.

---

## ⚙️ Settings & Configuration

In the Password Manager popup under the **Settings** tab:
- **Enable on Insecure HTTP Sites:** Toggle on/off to control whether the in-page picker activates on unencrypted HTTP domains.
- **Show In-Page Dropdown on Focus:** Toggle automatic dropdown display when clicking input fields.
- **Prompt to Save on Submit:** Toggle the notification prompt after submitting login forms.
- **Export / Import JSON:** Back up your credentials or import from existing vaults.
