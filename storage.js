window.HandbookStorage = (() => {
  let database
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
  async function read() {
    const db = await open()
    return new Promise((resolve, reject) => {
      const request = db.transaction('data').objectStore('data').get('library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  async function write(value) {
    const db = await open()
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('data', 'readwrite')
      transaction.objectStore('data').put(value, 'library')
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || Error('儲存交易中止'))
    })
  }
  return { read, write }
})()
