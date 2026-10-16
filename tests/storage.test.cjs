const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const fs = require('node:fs')
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'storage.js'), 'utf8')

function setup(initial, legacy) {
  let disk = initial, revision = initial ? '"1"' : 'missing', writes = 0, opens = 0, fail = false
  const context = {
    window: {}, location: { hostname: '127.0.0.1' },
    indexedDB: { open() {
      opens++
      const request = {}
      queueMicrotask(() => {
        request.result = { transaction() { return { objectStore() { return { get() {
          const get = {}
          queueMicrotask(() => { get.result = legacy; get.onsuccess() })
          return get
        } } } } } }
        request.onsuccess()
      })
      return request
    } },
    async fetch(url, options) {
      if (fail) throw Error('offline')
      assert.equal(url, '/api/library')
      assert.equal(options.cache, 'no-store')
      if (options.method === 'POST') {
        assert.equal(options.headers['If-Match'], revision)
        disk = JSON.parse(options.body)
        revision = `"${++writes + 1}"`
      }
      return { ok: true, headers: { get: () => revision }, json: async () => disk }
    }
  }
  vm.runInNewContext(source, context)
  return { storage: context.window.HandbookStorage, disk: () => disk, writes: () => writes, opens: () => opens, fail: () => { fail = true } }
}

test('existing file takes precedence over old browser data', async () => {
  const value = { personal: [{ content: '檔案內容' }], stars: [], trash: [] }
  const app = setup(value, { personal: [{ content: '舊資料' }] })
  assert.equal(await app.storage.read(), value)
  assert.equal(app.opens(), 0)
  assert.equal(app.writes(), 0)
})

test('first read migrates the entire old library, preserving attachments and trash', async () => {
  const legacy = { personal: [{ attachments: [{ content: 'AP8=', encoding: 'base64' }], history: [{ snapshot: { content: '舊版' } }] }], stars: ['slot:one'], trash: [{ items: [] }], cloudMeta: { ownerEmail: 'owner@example.com' } }
  const app = setup(null, legacy)
  assert.equal(await app.storage.read(), legacy)
  assert.deepEqual(app.disk(), { ...legacy, schema: 'ai-handbook-cloud/v1' })
  assert.equal(app.writes(), 1)
})

test('server failure does not fall back to silently writing browser data', async () => {
  const app = setup(null)
  await app.storage.read()
  app.fail()
  await assert.rejects(app.storage.write({ personal: [], stars: [], trash: [] }), /offline/)
  assert.equal(app.writes(), 0)
})
