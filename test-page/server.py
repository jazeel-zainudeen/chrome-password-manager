#!/usr/bin/env python3
"""
Simple HTTP test server for Passwords.
Serves the test login page on http://localhost:8899 (unencrypted HTTP)
to demonstrate password picking and autofill functionality on insecure origins.
"""

import http.server
import socketserver
import os
import sys
sys.dont_write_bytecode = True

DEFAULT_PORT = 8899
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

def run():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"=====================================================")
        print(f"  Passwords HTTP Insecure Test Server Running!       ")
        print(f"  URL: http://localhost:{PORT}/index.html           ")
        print(f"=====================================================")
        print(f"Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")

if __name__ == '__main__':
    run()
