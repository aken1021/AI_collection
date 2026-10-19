const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const fs = require('node:fs')
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'storage.js'), 'utf8')
const empty = () => ({ schema: 'ai-handbook-cloud/v1', personal: [], stars: [], trash: [] })
const fixture = () => ({ ...empty(), personal: [{ id: 'one', domain: 'slot', content: '完整內容', attachments: [{ name: 'a.bin', content: 'AP8=', encoding: 'base64' }], history: [{ snapshot: { content: '舊版' } }] }], stars: ['slot:one'], trash: [{ items: [{ content: '已刪除資料' }] }] })
const clone = value => JSON.parse(JSON.stringify(value))

function server(initial) {
  let disk = initial, revision = initial ? '"1"' : 'missing', writes = 0, fail = false
  const context = { window: {}, location: { hostname: '127.0.0.1', protocol: 'http:', pathname: '/' },
    async fetch(url, options) {
      if (fail) throw Error('offline')
      assert.equal(url, options.method ? '/api/library' : 'data/library.json')
      if (options.method === 'POST') {
        assert.equal(options.headers['If-Match'], revision)
        disk = JSON.parse(options.body); revision = `"${++writes + 1}"`
      }
      return { ok: true, headers: { get: () => revision }, json: async () => disk }
    }
  }
  vm.runInNewContext(source, context)
  return { storage: context.window.HandbookStorage, disk: () => disk, writes: () => writes, fail: () => { fail = true } }
}

function folder(initial = fixture()) {
  const files = new Map([['library.json', JSON.stringify(initial)]])
  let permission = 'granted', fail = false
  const directory = { queryPermission: async () => permission,
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (options?.create) files.set(name, '')
        else throw Object.assign(Error('not found'), { name: 'NotFoundError' })
      }
      return { getFile: async () => ({ text: async () => files.get(name) }),
        createWritable: async () => {
          let pending
          return {
            async write(text) { if (fail && name === 'library.json') throw Error('disk full'); pending = text },
            async close() { files.set(name, pending) }, async abort() {}
          }
        }
      }
    }
  }
  return { files, directory, revoke: () => { permission = 'denied' }, fail: () => { fail = true } }
}

function direct(disk, extra = {}) {
  const context = { window: { showDirectoryPicker: async () => disk.directory }, location: { hostname: '', protocol: 'file:', pathname: '/project/index.html' }, ...extra }
  vm.runInNewContext(source, context)
  return context.window.HandbookStorage
}

test('local server reads the JSON file and preserves all fields on save', async () => {
  const original = fixture(), app = server(original)
  assert.deepEqual(await app.storage.read(), original)
  original.personal.push({ id: 'two', domain: 'stocks' })
  await app.storage.write(original)
  assert.deepEqual(app.disk(), original)
})

test('server failure does not silently save to IndexedDB or localStorage', async () => {
  const app = server(empty())
  await app.storage.read(); app.fail()
  await assert.rejects(app.storage.write(fixture()), /offline/)
  assert.equal(app.writes(), 0)
})

test('opening index directly requires folder connection; it never returns a fake empty library', async () => {
  const app = direct(folder())
  await assert.rejects(app.read(), /連接 data/)
  await assert.rejects(app.write(fixture()), /尚未儲存/)
})

test('direct index reads and writes actual JSON, preserves attachments, and reopens saved content', async () => {
  const disk = folder(), app = direct(disk)
  assert.deepEqual(clone(await app.connect()), fixture())
  const before = disk.files.get('library.json')
  const changed = fixture(); changed.personal.push({ id: 'two', content: '新增匯入全文', domain: 'stocks' })
  await app.write(changed)
  assert.deepEqual(JSON.parse(disk.files.get('library.json')), changed)
  assert.equal(disk.files.get('library.previous.json'), before)
  assert.deepEqual(clone(await direct(disk).connect()), changed)
})

test('external changes cause conflicts without overwriting the file', async () => {
  const disk = folder(), app = direct(disk)
  await app.connect()
  const external = { ...fixture(), stars: ['changed-elsewhere'] }
  disk.files.set('library.json', JSON.stringify(external))
  await assert.rejects(app.write(empty()), /其他分頁/)
  assert.deepEqual(JSON.parse(disk.files.get('library.json')), external)
})

test('permission revocation and incomplete writes preserve the original JSON', async () => {
  const disk = folder(), app = direct(disk)
  await app.connect(); disk.fail()
  await assert.rejects(app.write(empty()), /disk full/)
  assert.deepEqual(JSON.parse(disk.files.get('library.json')), fixture())
  disk.revoke()
  await assert.rejects(app.write(empty()), /權限/)
})

test('concurrent save requests serialize and snapshot values at request time', async () => {
  const disk = folder(), app = direct(disk)
  await app.connect()
  const first = fixture(), second = { ...fixture(), stars: ['second'] }
  const one = app.write(first)
  first.personal[0].content = 'later mutation'
  const two = app.write(second)
  await Promise.all([one, two])
  assert.equal(JSON.parse(disk.files.get('library.previous.json')).personal[0].content, '完整內容')
  assert.deepEqual(JSON.parse(disk.files.get('library.json')), second)
})

test('static deployment reads data/library.json and refuses unconnected writes', async () => {
  const disk = folder()
  const app = direct(disk, { location: { hostname: 'example.com', protocol: 'https:', pathname: '/AI_collection/' }, fetch: async (url) => {
    assert.equal(url, 'data/library.json')
    return { ok: true, json: async () => fixture() }
  } })
  assert.deepEqual(await app.read(), fixture())
  await assert.rejects(app.write(empty()), /連接 data/)
})

test('folder picker cancellation keeps the existing connection and data', async () => {
  const disk = folder(), app = direct(disk)
  await app.connect()
  // A newly constructed page has no implicit access to this folder.
  const cancelled = direct(disk, { window: { showDirectoryPicker: async () => { throw Object.assign(Error('cancelled'), { name: 'AbortError' }) } } })
  await assert.rejects(cancelled.connect(), error => error.name === 'AbortError')
  assert.deepEqual(clone(await app.read()), fixture())
})
