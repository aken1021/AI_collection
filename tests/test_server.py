import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from server import LibraryServer


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.server = LibraryServer(('127.0.0.1', 0), self.folder.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.folder.cleanup()

    def request(self, method='GET', path='/api/library', value=None, revision=None, **extra):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Content-Type': 'application/json', **extra}
        if revision is not None:
            headers['If-Match'] = revision
        connection.request(method, path, None if value is None else json.dumps(value), headers)
        response = connection.getresponse()
        result = response.status, response.getheader('ETag'), response.read()
        connection.close()
        return result

    def test_round_trip_backups_conflict_and_attachments(self):
        status, revision, body = self.request()
        self.assertEqual((status, revision, json.loads(body)), (200, 'missing', None))
        library = {'personal': [{'id': 'one', 'domain': 'slot', 'content': '測試', 'attachments': [{'name': 'a.bin', 'encoding': 'base64', 'content': 'AP8='}], 'history': [{'snapshot': {'content': '舊版'}}]}], 'stars': ['slot:one'], 'trash': [{'items': [{'content': '已刪除'}]}], 'cloudMeta': {}}
        status, revision, _ = self.request('POST', value=library, revision=revision)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(self.request()[2]), library)
        original = self.server.library.read_bytes()
        library['personal'].append({'id': 'two', 'domain': 'stocks'})
        self.assertEqual(self.request('POST', value=library, revision=revision)[0], 200)
        self.assertEqual(self.server.library.with_name('library.previous.json').read_bytes(), original)
        self.assertEqual(self.request('POST', value=library, revision=revision)[0], 409)
        self.assertEqual(json.loads(self.server.library.read_text(encoding='utf-8')), library)

    def test_reject_cross_origin_private_paths_and_invalid_payload(self):
        self.assertEqual(self.request(Origin='https://example.com')[0], 403)
        self.assertEqual(self.request(Host='evil.example')[0], 403)
        self.assertEqual(self.request('POST', value={'personal': []}, revision='missing')[0], 400)
        for path in ('/data/library.json', '/.git/config', '/%2e%2e/server.py'):
            self.assertEqual(self.request(path=path)[0], 404)
        self.assertFalse(self.server.library.exists())

    def test_corrupt_existing_file_is_never_overwritten(self):
        self.server.library.parent.mkdir()
        self.server.library.write_text('broken', encoding='utf-8')
        self.assertEqual(self.request()[0], 500)
        library = {'personal': [], 'stars': [], 'trash': []}
        self.assertEqual(self.request('POST', value=library, revision='missing')[0], 400)
        self.assertEqual(self.server.library.read_text(), 'broken')


if __name__ == '__main__':
    unittest.main()
