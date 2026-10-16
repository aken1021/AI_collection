"""Local handbook server; keeps the complete library in data/library.json."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parent
MAX_BYTES = 100 * 1024 * 1024


def validate(value):
    if not isinstance(value, dict):
        raise ValueError('Library must be an object')
    for key in ('personal', 'stars', 'trash'):
        if not isinstance(value.get(key), list):
            raise ValueError(f'{key} must be an array')
    if not isinstance(value.get('cloudMeta', {}), dict):
        raise ValueError('cloudMeta must be an object')
    return value


class LibraryServer(ThreadingHTTPServer):
    def __init__(self, address, root=ROOT):
        self.root = Path(root).resolve()
        self.library = self.root / 'data' / 'library.json'
        self.lock = threading.Lock()
        super().__init__(address, Handler)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(args[2].root), **kwargs)

    def allowed(self):
        # Prevent DNS rebinding and cross-site writes to a local library.
        expected = f'127.0.0.1:{self.server.server_port}'
        return self.headers.get('Host') == expected and self.headers.get('Origin', f'http://{expected}') == f'http://{expected}'

    def reply(self, status, value, revision=None):
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        if revision is not None:
            self.send_header('ETag', revision)
        self.end_headers()
        self.wfile.write(body)

    def current(self):
        if not self.server.library.exists():
            return None, 'missing'
        raw = self.server.library.read_bytes()
        return validate(json.loads(raw)), '"' + hashlib.sha256(raw).hexdigest() + '"'

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {'error': 'Only the local app can access this server'})
        path = unquote(urlsplit(self.path).path)
        if path == '/api/library':
            try:
                with self.server.lock:
                    value, revision = self.current()
                return self.reply(200, value, revision)
            except (ValueError, OSError) as error:
                return self.reply(500, {'error': str(error)})
        # Only public app assets are served, never libraries, backups or dotfiles.
        if path not in ('/', '/index.html', '/app.js', '/archive.js', '/catalog.js', '/cloud.js', '/cloud-format.js', '/firebase-config.js', '/storage.js', '/style.css', '/favicon.svg'):
            return self.reply(404, {'error': 'Not found'})
        super().do_GET()

    def do_HEAD(self):
        # Avoid SimpleHTTPRequestHandler exposing private files via HEAD.
        self.reply(405, {'error': 'Use GET'})

    def do_POST(self):
        if not self.allowed():
            return self.reply(403, {'error': 'Only the local app can write data'})
        if urlsplit(self.path).path != '/api/library':
            return self.reply(404, {'error': 'Not found'})
        try:
            if self.headers.get('Content-Type') != 'application/json':
                return self.reply(415, {'error': 'Expected application/json'})
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BYTES:
                return self.reply(413, {'error': 'Library exceeds the 100 MB limit'})
            value = validate(json.loads(self.rfile.read(size)))
            raw = json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')
            with self.server.lock:
                _, revision = self.current()
                if self.headers.get('If-Match') != revision:
                    return self.reply(409, {'error': '資料已由其他分頁更新，請先匯出目前內容，再重新整理。'})
                self.server.library.parent.mkdir(parents=True, exist_ok=True)
                if self.server.library.exists():
                    self.atomic_write(self.server.library.with_name('library.previous.json'), self.server.library.read_bytes())
                self.atomic_write(self.server.library, raw)
            return self.reply(200, {'saved': True}, '"' + hashlib.sha256(raw).hexdigest() + '"')
        except (ValueError, OSError) as error:
            return self.reply(400, {'error': str(error)})

    @staticmethod
    def atomic_write(path, raw):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
                temporary = handle.name
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = LibraryServer(('127.0.0.1', args.port))
    print(f'Open http://127.0.0.1:{args.port} — storage: {server.library}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
