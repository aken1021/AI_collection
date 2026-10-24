/* ZIP store writer and bounded reader; imports are data, never executable files. */
window.HandbookArchive = (() => {
  const encoder = new TextEncoder(), decoder = new TextDecoder()
  const maxBytes = 50 * 1024 * 1024
  function toBase64(bytes) { let s = ''; for (let n = 0; n < bytes.length; n += 8192) s += String.fromCharCode(...bytes.subarray(n, n + 8192)); return btoa(s) }
  function fromBase64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)) }
  function fileBytes(file) { return file.encoding === 'base64' ? fromBase64(file.content) : encoder.encode(file.content) }
  function textContent(file) {
    if (!file || typeof file.content !== 'string') return null
    if (file.encoding !== 'base64') return file.content
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fileBytes(file))
      return /[\x00-\x08\x0b\x0e-\x1f]/.test(text) ? null : text
    } catch { return null }
  }
  function readFile(name, data) {
    if (/\.(md|mdc|txt|json|py|cjs|mjs|js|ts|prefab)$/i.test(name)) {
      try { return { name, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) } } catch {}
    }
    return { name, content: toBase64(data), encoding: 'base64' }
  }
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
    return n >>> 0
  })
  function crc32(bytes) {
    let n = 0xffffffff
    for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8)
    return (n ^ 0xffffffff) >>> 0
  }
  function zip(files) {
    if (files.length > 1500) throw Error('匯出檔案超過 1500，請拆分。')
    const local = [], directory = []
    let offset = 0, directorySize = 0
    for (const file of files) {
      const name = encoder.encode(file.name), bytes = fileBytes(file), crc = crc32(bytes)
      const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer)
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true)
      h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, name.length, true)
      header.set(name, 30)
      const entry = new Uint8Array(46 + name.length), e = new DataView(entry.buffer)
      e.setUint32(0, 0x02014b50, true); e.setUint16(4, 20, true); e.setUint16(6, 20, true); e.setUint16(8, 0x800, true)
      e.setUint32(16, crc, true); e.setUint32(20, bytes.length, true); e.setUint32(24, bytes.length, true); e.setUint16(28, name.length, true); e.setUint32(42, offset, true)
      entry.set(name, 46); local.push(header, bytes); directory.push(entry)
      offset += header.length + bytes.length; directorySize += entry.length
      if (offset + directorySize + 22 > maxBytes) throw Error('匯出 ZIP 超過 50 MB，請拆分。')
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer)
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, directorySize, true); e.setUint32(16, offset, true)
    return new Blob([...local, ...directory, end], { type: 'application/zip' })
  }
  async function unzip(buffer) {
    if (buffer.byteLength > maxBytes) throw Error('ZIP 超過 50 MB，請拆分匯入。')
    const view = new DataView(buffer), bytes = new Uint8Array(buffer)
    let end = -1
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break }
    }
    if (end < 0) throw Error('ZIP 格式無法辨識。')
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw Error('不支援分卷 ZIP。')
    const count = view.getUint16(end + 10, true)
    if (count > 1500) throw Error('ZIP 檔案數超過 1500。')
    let cursor = view.getUint32(end + 16, true), total = 0
    const files = [], names = new Set()
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw Error('ZIP 目錄損毀。')
      const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), expectedCrc = view.getUint32(cursor + 16, true)
      const compressed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true)
      const nameLen = view.getUint16(cursor + 28, true), extraLen = view.getUint16(cursor + 30, true), commentLen = view.getUint16(cursor + 32, true), at = view.getUint32(cursor + 42, true)
      if (cursor + 46 + nameLen + extraLen + commentLen > end) throw Error('ZIP 目錄超出檔案範圍。')
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen)).replaceAll('\\', '/')
      cursor += 46 + nameLen + extraLen + commentLen
      if (name.endsWith('/')) continue
      if (!name || name.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw Error('ZIP 含不合法路徑。')
      if (names.has(name)) throw Error(`ZIP 含重複路徑：${name}`)
      names.add(name)
      if (flags & 1) throw Error('不支援加密 ZIP，請解密後再匯入。')
      total += size
      const isManifest = /(?:^|\/)匯出說明(?:-\d+)?\.md$/.test(name)
      if (size > (isManifest ? maxBytes : 10 * 1024 * 1024) || total > maxBytes) throw Error('解壓內容過大，請拆分匯入。')
      if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) throw Error('ZIP 檔案標頭損毀。')
      const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
      if (start + compressed > bytes.length) throw Error('ZIP 檔案資料不完整。')
      let data = bytes.subarray(start, start + compressed)
      if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw Error('此瀏覽器不支援壓縮 ZIP 匯入，請先解壓後選擇資料夾。')
        let stream
        try { stream = new DecompressionStream('deflate-raw') } catch { throw Error('此瀏覽器不支援此 ZIP 壓縮格式，請先解壓後選擇資料夾。') }
        const reader = new Blob([data]).stream().pipeThrough(stream).getReader(), chunks = []
        let inflated = 0
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; inflated += value.length; if (inflated > size || inflated > maxBytes) { await reader.cancel(); throw Error('ZIP 解壓大小與標示不符。') } chunks.push(value) }
        } finally { reader.releaseLock() }
        data = new Uint8Array(inflated); let n = 0; for (const chunk of chunks) { data.set(chunk, n); n += chunk.length }
      } else if (method !== 0) throw Error('不支援此 ZIP 壓縮方式，請先解壓後匯入資料夾。')
      if (data.length !== size || crc32(data) !== expectedCrc) throw Error('ZIP 文件校驗失敗。')
      files.push(readFile(name, data))
    }
    return files
  }
  return { zip, unzip, crc32, toBase64, fromBase64, fileBytes, readFile, textContent }
})()
