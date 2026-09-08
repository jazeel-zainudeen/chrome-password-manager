#!/usr/bin/env python3
"""
Passwords Chrome Password Sync Utility
Extracts and decrypts saved passwords from Google Chrome's local database
and exports them to chrome_passwords.json for seamless use in Passwords.
"""

import sqlite3
import shutil
import tempfile
import hashlib
import json
import os
import sys
sys.dont_write_bytecode = True
from urllib.parse import urlparse
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

CHROME_LOGIN_DATA_PATH = os.path.expanduser('~/.config/google-chrome/Default/Login Data')
OUTPUT_JSON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chrome_passwords.json')

def decrypt_chrome_password(enc, key, iv):
    if not enc:
        return ""
    if enc.startswith(b'v11') or enc.startswith(b'v10'):
        try:
            payload = enc[3:]
            cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
            decryptor = cipher.decryptor()
            dec = decryptor.update(payload) + decryptor.finalize()
            pad_len = dec[-1]
            if 1 <= pad_len <= 16:
                dec = dec[:-pad_len]
            return dec.decode('utf-8', errors='ignore')
        except Exception:
            return ""
    try:
        return enc.decode('utf-8', errors='ignore')
    except Exception:
        return ""

def get_chrome_key():
    """Retrieve Chrome encryption key from SecretStorage (GNOME Keyring/KWallet) or fallback."""
    try:
        import secretstorage
        bus = secretstorage.dbus_init()
        collection = secretstorage.get_default_collection(bus)
        for item in collection.get_all_items():
            if item.get_label() == 'Chrome Safe Storage':
                secret = item.get_secret()
                return hashlib.pbkdf2_hmac('sha1', secret, b'saltysalt', 1, 16)
    except Exception as e:
        pass
    # Fallback to default linux peanuts key
    return hashlib.pbkdf2_hmac('sha1', b'peanuts', b'saltysalt', 1, 16)

def sync_passwords():
    if not os.path.exists(CHROME_LOGIN_DATA_PATH):
        print(f"Error: Chrome database not found at {CHROME_LOGIN_DATA_PATH}")
        return False

    key = get_chrome_key()
    iv = b' ' * 16

    tmp_db = tempfile.mktemp(suffix='.db')
    try:
        shutil.copy(CHROME_LOGIN_DATA_PATH, tmp_db)
        conn = sqlite3.connect(tmp_db)
        c = conn.cursor()
        c.execute("SELECT origin_url, username_value, password_value, date_created FROM logins WHERE length(password_value) > 0;")
        rows = c.fetchall()
        conn.close()
    finally:
        if os.path.exists(tmp_db):
            os.remove(tmp_db)

    vault = []
    seen = set()

    for row in rows:
        url_str, username, enc_password, date_created = row[0], row[1], row[2], row[3]
        password = decrypt_chrome_password(enc_password, key, iv)

        if not username and not password:
            continue

        try:
            parsed = urlparse(url_str)
            protocol = parsed.scheme + ':' if parsed.scheme else 'http:'
            hostname = parsed.hostname or parsed.netloc or 'local'
            port = str(parsed.port) if parsed.port else ('443' if protocol == 'https:' else '80')
            origin = f"{protocol}//{parsed.netloc}" if parsed.netloc else url_str
        except Exception:
            protocol = 'http:'
            hostname = 'local'
            port = '80'
            origin = url_str

        is_insecure = (protocol == 'http:')
        dedup_key = f"{origin.lower()}|{username.lower()}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        title = hostname
        if parsed.path and len(parsed.path) > 1:
            title = f"{hostname}{parsed.path[:20]}"

        vault.append({
            "id": "chrome_" + hashlib.md5(f"{origin}_{username}".encode()).hexdigest()[:10],
            "title": title,
            "origin": origin,
            "hostname": hostname,
            "protocol": protocol,
            "port": port,
            "isInsecure": is_insecure,
            "username": username,
            "password": password,
            "notes": "Synced from Chrome Password Manager",
            "createdAt": date_created or 1710000000000,
            "updatedAt": 1710000000000,
            "lastUsed": 0
        })

    with open(OUTPUT_JSON_PATH, 'w') as f:
        json.dump(vault, f, indent=2)

    print(f"✓ Successfully synced {len(vault)} passwords from Chrome into {OUTPUT_JSON_PATH}")
    insecure_count = sum(1 for v in vault if v['isInsecure'])
    print(f"  - HTTP / Insecure site logins: {insecure_count}")
    print(f"  - HTTPS logins: {len(vault) - insecure_count}")
    return True

if __name__ == '__main__':
    sync_passwords()
