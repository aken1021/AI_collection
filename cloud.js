/* Private, owner-only Firebase library. Credentials remain in Firebase Auth. */
window.HandbookCloud = (() => {
  const config = window.HANDBOOK_CLOUD_CONFIG
  const login = document.getElementById('cloud-login'), logout = document.getElementById('cloud-logout'), sync = document.getElementById('cloud-sync'), status = document.getElementById('cloud-status')
  const listeners = new Set()
  let auth, database, user = null, revision = null
  const message = text => { status.textContent = text }
  const authorized = value => value && value.emailVerified && value.email?.toLowerCase() === config.ownerEmail.toLowerCase()
  function onUser(callback) { listeners.add(callback); if (auth) callback(user); return () => listeners.delete(callback) }
  async function digest(text) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('') }
  async function read() {
    if (!authorized(user)) throw Error('請先以您的 Google 帳號登入。')
    const pointer = await database.doc('privateLibrary/current').get({ source: 'server' })
    if (!pointer.exists) { revision = null; return { data: null, revision: null } }
    const metadata = pointer.data()
    if (!Number.isInteger(metadata.parts) || metadata.parts < 1 || metadata.parts > 1000 || !/^[\w-]+$/.test(metadata.revision)) throw Error('雲端備份格式不正確。')
    const snapshots = await Promise.all(Array.from({ length: metadata.parts }, (_, n) => database.doc(`privateLibraryVersions/${metadata.revision}/chunks/${n}`).get({ source: 'server' })))
    const text = snapshots.map(snapshot => { if (!snapshot.exists || typeof snapshot.data().payload !== 'string') throw Error('雲端備份缺少檔案區塊。'); return snapshot.data().payload }).join('')
    if (await digest(text) !== metadata.hash) throw Error('雲端備份校驗不符。')
    const data = JSON.parse(text)
    if (data.schema !== 'ai-handbook-cloud/v1') throw Error('不支援的雲端備份格式。')
    revision = metadata.revision
    return { data, revision }
  }
  async function write(data) {
    if (!authorized(user)) throw Error('請先登入，才能儲存到雲端。')
    const text = JSON.stringify({ ...data, schema: 'ai-handbook-cloud/v1' })
    if (new TextEncoder().encode(text).length > 50 * 1024 * 1024) throw Error('雲端資料超過 50 MB，請先匯出並整理大型附件。')
    const nextRevision = crypto.randomUUID(), hash = await digest(text), chunks = window.HandbookCloudFormat.split(text)
    for (let at = 0; at < chunks.length; at += 400) {
      const batch = database.batch()
      chunks.slice(at, at + 400).forEach((payload, n) => batch.set(database.doc(`privateLibraryVersions/${nextRevision}/chunks/${at + n}`), { payload }))
      await batch.commit()
    }
    await database.runTransaction(async transaction => {
      const reference = database.doc('privateLibrary/current'), current = await transaction.get(reference)
      if ((current.exists ? current.data().revision : null) !== revision) throw Error('另一台電腦已更新資料；本機變更已保留，請先下載備份再按「同步雲端」取得最新資料。')
      transaction.set(reference, { revision: nextRevision, parts: chunks.length, hash, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), ownerUid: user.uid })
    })
    revision = nextRevision
    return revision
  }
  try {
    if (location.protocol === 'file:') { login.hidden = true; message('離線版：資料保存在此瀏覽器。'); return { onUser, message, enabled: false } }
    if (!config || !window.firebase) throw Error('無法載入登入服務；本機資料仍保留。請確認網路後重新整理。')
    firebase.initializeApp(config)
    auth = firebase.auth(); auth.useDeviceLanguage()
    database = firebase.firestore(); database.settings({ ignoreUndefinedProperties: true, merge: true })
    login.onclick = async () => {
      try {
        const provider = new firebase.auth.GoogleAuthProvider()
        provider.setCustomParameters({ login_hint: config.ownerEmail, prompt: 'select_account' })
        await auth.signInWithPopup(provider)
      } catch (error) {
        message(error.code === 'auth/popup-blocked' ? '登入視窗被阻擋，請允許彈出視窗後再按 Google 登入。' : error.code === 'auth/popup-closed-by-user' ? '登入尚未完成，請再按 Google 登入。' : error.code === 'auth/network-request-failed' ? 'Google 登入連線失敗。請以 Chrome 或 Edge 開啟本站並登入；內建瀏覽器可能受限。' : `Google 登入失敗：${error.message}`)
      }
    }
    logout.onclick = () => { const blocker = window.HandbookCloud.beforeSignOut?.(); if (blocker) message(blocker); else auth.signOut() }
    auth.onAuthStateChanged(async value => {
      if (value && !authorized(value)) { await auth.signOut(); message('此網站只允許指定的擁有者帳號存取雲端資料。'); return }
      user = value
      login.hidden = !!user; logout.hidden = !user; sync.hidden = !user
      message(user ? `已登入 ${user.email}，正在讀取私人雲端資料…` : '私人資料庫：請用您的 Google 帳號登入，才能在其他電腦取得相同內容。')
      for (const callback of listeners) await callback(user)
    })
    return { onUser, read, write, message, enabled: true, get user() { return user } }
  } catch (error) { message(error.message); login.disabled = true; return { onUser, message, enabled: false } }
})()
