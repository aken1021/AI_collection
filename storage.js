window.HandbookStorage = (() => {
  const serverMode = location.hostname === '127.0.0.1'
  const directMode = location.protocol === 'file:'
  const connectionKey = `data:${location.pathname}`
  let directory, revision, queue = Promise.resolve()

  function validate(value) {
    if (!value || value.schema !== 'ai-handbook-cloud/v1' || !['personal', 'stars', 'trash'].every(key => Array.isArray(value[key]))) throw Error('library.json 格式不正確，請使用完整資料庫備份。')
    return value
  }
  async function handleStore(action, value) {
    // IndexedDB remembers only the selected folder handle, never library contents.
    if (typeof indexedDB === 'undefined') return undefined
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ai-handbook-directory-v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('handles')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', action === 'read' ? 'readonly' : 'readwrite')
        const request = action === 'read' ? tx.objectStore('handles').get(connectionKey) : tx.objectStore('handles').put(value, connectionKey)
        tx.oncomplete = () => resolve(request.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error || Error('無法記住資料夾'))
      })
    } finally { db.close() }
  }
  async function request(options) {
    const response = await fetch(options?.method ? '/api/library' : 'data/library.json', { cache: 'no-store', ...options })
    let data
    try { data = await response.json() } catch { throw Error('本機服務無法讀寫 library.json，請使用 start.ps1 啟動。') }
    if (!response.ok) throw Error(data?.error || 'data/library.json 讀寫失敗')
    const nextRevision = response.headers.get('ETag')
    if (!nextRevision) throw Error('本機儲存服務未回傳版本資訊。')
    revision = nextRevision
    return data
  }
  async function readDirectory() {
    const file = await directory.getFileHandle('library.json')
    const text = await (await file.getFile()).text()
    const value = validate(JSON.parse(text))
    revision = text
    return value
  }
  async function connect() {
    if (typeof window.showDirectoryPicker !== 'function') throw Error('此瀏覽器無法直接連接資料夾。請使用 Chrome／Edge，或執行 start.ps1。')
    // Must run immediately inside the click gesture, before other async work.
    let selected = await window.showDirectoryPicker({ id: 'ai-handbook-data', mode: 'readwrite' })
    try { await selected.getFileHandle('library.json') }
    catch (error) {
      if (error.name !== 'NotFoundError') throw error
      try { selected = await selected.getDirectoryHandle('data'); await selected.getFileHandle('library.json') }
      catch { throw Error('請選擇本專案的 data 資料夾（內含 library.json），或其上一層專案資料夾。') }
    }
    const previous = directory, previousRevision = revision
    directory = selected
    let value
    try { value = await readDirectory() }
    catch (error) { directory = previous; revision = previousRevision; throw error }
    try { await handleStore('write', selected) } catch { /* Folder still works for this session. */ }
    return value
  }
  async function read() {
    if (serverMode) {
      const value = await request()
      return value === null ? undefined : validate(value)
    }
    if (!directory) {
      try {
        const remembered = await handleStore('read')
        if (remembered && await remembered.queryPermission({ mode: 'readwrite' }) === 'granted') directory = remembered
      } catch { /* Connecting explicitly remains available. */ }
    }
    if (directory) return readDirectory()
    if (directMode) throw Error('請按「連接 data 資料夾」，選取本專案的 data，才能讀取 library.json。')
    const response = await fetch('data/library.json', { cache: 'no-store' })
    if (!response.ok) throw Error('無法讀取 data/library.json，請確認檔案已部署，或連接本機 data 資料夾。')
    return validate(await response.json())
  }
  async function writeDirectory(value) {
    if (!directory) throw Error('尚未儲存。請先按「連接 data 資料夾」，再重試儲存或匯入。')
    if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw Error('資料夾寫入權限已失效，請重新連接 data 資料夾。')
    const file = await directory.getFileHandle('library.json')
    const current = await (await file.getFile()).text()
    if (current !== revision) throw Error('library.json 已由其他分頁或程式更新。請先匯出目前內容，再重新整理，避免覆蓋資料。')
    const backup = await directory.getFileHandle('library.previous.json', { create: true })
    await writeFile(backup, current)
    const text = JSON.stringify(value, null, 2) + '\n'
    await writeFile(file, text)
    revision = text
  }
  async function writeFile(handle, text) {
    const writable = await handle.createWritable()
    try { await writable.write(text); await writable.close() }
    catch (error) { try { await writable.abort() } catch {} throw error }
  }
  function write(value) {
    const snapshot = JSON.parse(JSON.stringify({ ...value, schema: 'ai-handbook-cloud/v1' }))
    validate(snapshot)
    const operation = async () => {
      if (serverMode) return request({ method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify(snapshot) })
      const save = () => writeDirectory(snapshot)
      if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(`ai-handbook:${connectionKey}`, save)
      return save()
    }
    const pending = queue.catch(() => {}).then(operation)
    queue = pending
    return pending
  }
  return { read, write, connect, fileBacked: true, serverMode, directMode, get connected() { return serverMode || !!directory } }
})()
