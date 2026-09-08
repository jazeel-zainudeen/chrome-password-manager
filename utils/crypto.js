/**
 * OmniPass Password Generator & Security Utilities
 */

const OmniCrypto = (() => {
  const CHARS = {
    uppercase: 'ABCDEFGHJKLMNPQRSTUVWXYZ', // Avoid ambiguous like O, I
    lowercase: 'abcdefghijkmnpqrstuvwxyz', // Avoid ambiguous like l
    numbers: '23456789',                  // Avoid ambiguous like 0, 1
    symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?'
  };

  const AMBIGUOUS = {
    uppercase: 'IO',
    lowercase: 'lo',
    numbers: '01',
    symbols: ''
  };

  /**
   * Generates a cryptographically secure random password.
   */
  function generatePassword(options = {}) {
    const {
      length = 16,
      useUpper = true,
      useLower = true,
      useNumbers = true,
      useSymbols = true,
      avoidAmbiguous = true
    } = options;

    let charPool = '';
    const guaranteed = [];

    if (useUpper) {
      const u = avoidAmbiguous ? CHARS.uppercase : CHARS.uppercase + AMBIGUOUS.uppercase;
      charPool += u;
      guaranteed.push(getRandomChar(u));
    }
    if (useLower) {
      const l = avoidAmbiguous ? CHARS.lowercase : CHARS.lowercase + AMBIGUOUS.lowercase;
      charPool += l;
      guaranteed.push(getRandomChar(l));
    }
    if (useNumbers) {
      const n = avoidAmbiguous ? CHARS.numbers : CHARS.numbers + AMBIGUOUS.numbers;
      charPool += n;
      guaranteed.push(getRandomChar(n));
    }
    if (useSymbols) {
      const s = avoidAmbiguous ? CHARS.symbols : CHARS.symbols + AMBIGUOUS.symbols;
      charPool += s;
      guaranteed.push(getRandomChar(s));
    }

    if (!charPool) {
      charPool = CHARS.lowercase + CHARS.numbers;
    }

    const remainingLength = Math.max(0, length - guaranteed.length);
    const randomChars = [];
    const randomBuffer = new Uint32Array(remainingLength);
    window.crypto.getRandomValues(randomBuffer);

    for (let i = 0; i < remainingLength; i++) {
      randomChars.push(charPool[randomBuffer[i] % charPool.length]);
    }

    // Combine and shuffle using Fisher-Yates
    const result = [...guaranteed, ...randomChars];
    for (let i = result.length - 1; i > 0; i--) {
      const randIndex = Math.floor(Math.random() * (i + 1));
      [result[i], result[randIndex]] = [result[randIndex], result[i]];
    }

    return result.join('');
  }

  function getRandomChar(str) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return str[buf[0] % str.length];
  }

  /**
   * Evaluates password strength (0 to 4).
   */
  function evaluateStrength(password) {
    if (!password) return { score: 0, label: 'Empty', color: '#64748b' };

    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 14) score += 1;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;

    // Normalize to 0 - 4
    const normalized = Math.min(4, Math.max(0, score - 1));

    const strengths = [
      { score: 0, label: 'Very Weak', color: '#ef4444' },
      { score: 1, label: 'Weak', color: '#f97316' },
      { score: 2, label: 'Fair', color: '#eab308' },
      { score: 3, label: 'Strong', color: '#10b981' },
      { score: 4, label: 'Very Strong', color: '#06b6d4' }
    ];

    return strengths[normalized];
  }

  return {
    generatePassword,
    evaluateStrength
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OmniCrypto;
}
