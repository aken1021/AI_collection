window.HandbookStorage = (() => {
  let database
  let revision
  const fileBacked = location.hostname === '127.0.0.1'
  async function open() {
    if (database) return database
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ai-handbook-files-v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('data')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return database
  }
  async function readLegacy() {
    if (typeof indexedDB === 'undefined') return undefined
    const db = await open()
    return new Promise((resolve, reject) => {
      const request = db.transaction('data').objectStore('data').get('library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  async function writeLegacy(value) {
    const db = await open()
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('data', 'readwrite')
      transaction.objectStore('data').put(value, 'library')
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || Error('儲存交易中止'))
    })
  }
  async function request(options) {
    const response = await fetch('/api/library', { cache: 'no-store', ...options })
    let data
    try { data = await response.json() } catch { throw Error('請使用 start.ps1 啟動網站，才能儲存至 data/library.json。') }
    if (!response.ok) throw Error(data?.error || 'data/library.json 讀寫失敗')
    revision = response.headers.get('ETag')
    if (!revision) throw Error('本機儲存服務未回傳版本資訊，請確認使用 start.ps1 啟動。')
    return data
  }
  async function read() {
    if (!fileBacked) return readLegacy()
    const stored = await request()
    if (stored !== null) return stored
    // Same-origin browser data is copied only when no file exists.
    // Keep the old IndexedDB untouched as a migration backup.
    const legacy = await readLegacy()
    if (legacy) { await write(legacy); return legacy }
    return undefined
  }
  async function write(value) {
    if (!fileBacked) return writeLegacy(value)
    await request({ method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify({ ...value, schema: 'ai-handbook-cloud/v1' }) })
  }
  return { read, write, fileBacked }
})()
