(() => {
  'use strict'
  const $ = id => document.getElementById(id)
  const labels = { all: '全部功能', skill: '技能操作指南', rule: '專案規則', knowledge: '知識庫', pattern: 'Pattern 範本' }
  const singular = { skill: '技能', rule: '規則', knowledge: '知識庫', pattern: 'Pattern' }
  const types = ['skill', 'rule', 'knowledge', 'pattern']
  const domains = { slot: '老虎機', stocks: '股票分析' }
  const storageKey = 'wildfrontier-handbook-personal-v2', favoriteKey = 'wildfrontier-handbook-stars-v2'
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const stripFront = s => s.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
  const redaction = s => String(s).replace(/^.*\b(?:agentKey|api[_-]?key|access[_-]?token|password|secret[_-]?key)\b.*$/gim, '[敏感設定值已移除，請在本機確認]').replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[憑證已移除]')
  const state = { domain: 'slot', domainViews: {}, type: 'all', category: '', query: '', mode: 'browse', selected: null, tab: 'guide', personal: [], stars: [], pending: [], pendingFiles: [], linkCandidates: [], editing: null, inputs: {} }
  let storageFailed = false, durableStorage = false, storageLoading = typeof indexedDB !== 'undefined', cloudReady = false, cloudQueue = Promise.resolve(), mutationSequence = 0
  state.trash = []
  state.cloudMeta = {}
  try { localStorage.removeItem('wildfrontier-handbook-personal-v1'); localStorage.removeItem('wildfrontier-handbook-stars-v1') } catch {}
  try { state.personal = JSON.parse(localStorage.getItem(storageKey) || '[]'); state.stars = JSON.parse(localStorage.getItem(favoriteKey) || '[]'); if (!Array.isArray(state.personal) || !Array.isArray(state.stars)) throw Error('格式錯誤') } catch { state.personal = []; state.stars = []; storageFailed = true }
  state.personal = state.personal.map(i => ({ ...i, domain: i.domain === 'stocks' ? 'stocks' : 'slot' }))
  const base = window.HANDBOOK.items
  async function save() {
    const sequence = ++mutationSequence
    if (!window.HandbookStorage.fileBacked && (state.cloudMeta.ownerEmail || window.HandbookCloud?.user)) { state.cloudMeta.ownerEmail ||= window.HandbookCloud.user.email; state.cloudMeta.dirty = true }
    if (durableStorage) {
      try {
        await window.HandbookStorage.write(localLibrary())
        if (cloudReady && window.HandbookCloud?.user) {
          const data = cloudLibrary()
          cloudQueue = cloudQueue.catch(() => {}).then(async () => {
            window.HandbookCloud.message('正在儲存到私人雲端…')
            const revision = await window.HandbookCloud.write(data)
            state.cloudMeta = { ...state.cloudMeta, revision, dirty: mutationSequence !== sequence, syncedAt: new Date().toISOString() }
            await window.HandbookStorage.write(localLibrary())
            window.HandbookCloud.message(`私人雲端已同步 · ${window.HandbookCloud.user?.email || ''}`)
          })
          try { await cloudQueue } catch (error) { window.HandbookCloud.message(`本機已保存，雲端尚未同步：${error.message}`) }
        }
        return true
      }
      catch (error) { toast(`儲存失敗：${error.message} 內容仍在頁面；請立即匯出備份。`); return false }
    }
    try { localStorage.setItem(storageKey, JSON.stringify(state.personal)); localStorage.setItem(favoriteKey, JSON.stringify(state.stars)); return true }
    catch { toast('瀏覽器儲存空間不足或不可用；請匯出 JSON 備份，此次內容僅保留於頁面。'); return false }
  }
  function localLibrary() { return { personal: state.personal, stars: state.stars, trash: state.trash, cloudMeta: state.cloudMeta } }
  function cloudLibrary() { return JSON.parse(JSON.stringify({ schema: 'ai-handbook-cloud/v1', personal: state.personal, stars: state.stars, trash: state.trash })) }
  function validateCloudLibrary(data) {
    if (data.schema !== 'ai-handbook-cloud/v1' || !Array.isArray(data.personal) || !Array.isArray(data.trash || [])) throw Error('雲端資料格式不合法。')
    const domain = state.domain, personal = [], trash = []
    try {
      for (const name of ['slot', 'stocks']) {
        state.domain = name
        personal.push(...validateItems({ schema: 'slot-handbook/v1', items: data.personal.filter(item => (item.domain || 'slot') === name) }))
        trash.push(...validateTrash((data.trash || []).filter(batch => batch.domain === name)))
      }
    } finally { state.domain = domain }
    return { personal, trash, stars: (data.stars || []).filter(value => typeof value === 'string') }
  }
  async function connectCloud() {
    const cloud = window.HandbookCloud
    if (!cloud?.enabled) return
    cloud.beforeSignOut = () => state.cloudMeta.dirty ? '尚有未同步的本機變更。請先等待同步完成，或下載完整備份。' : null
    cloud.onUser(async user => {
      cloudReady = false
      try {
        if (!user) {
          if (state.cloudMeta.ownerEmail && !state.cloudMeta.dirty) {
            state.personal = []; state.stars = []; state.trash = []
            await window.HandbookStorage.write(localLibrary())
          }
          render()
          return
        }
        await cloudQueue.catch(() => {})
        const remote = await cloud.read()
        if (cloud.user?.uid !== user.uid) return
        if (state.cloudMeta.dirty) { cloud.message('本機有未同步變更；請先備份，再按「同步雲端」取得最新資料。'); render(); return }
        const local = cloudLibrary()
        const firstJoin = !state.cloudMeta.ownerEmail
        if (remote.data) {
          const incoming = validateCloudLibrary(remote.data)
          if (!state.cloudMeta.ownerEmail) {
            const merged = new Map(incoming.personal.map(item => [`${item.domain}:${item.id}`, item]))
            for (const item of local.personal) { const key = `${item.domain}:${item.id}`, current = merged.get(key); if (!current || (item.updatedAt || '') > (current.updatedAt || '')) merged.set(key, item) }
            incoming.personal = [...merged.values()]
            for (const batch of local.trash) if (!incoming.trash.some(other => other.domain === batch.domain && other.at === batch.at)) incoming.trash.push(batch)
            incoming.stars = [...new Set([...incoming.stars, ...local.stars])]
          }
          Object.assign(state, incoming)
        }
        state.cloudMeta = { ownerEmail: user.email, revision: remote.revision, dirty: false, syncedAt: new Date().toISOString() }
        await window.HandbookStorage.write(localLibrary())
        cloudReady = true; render()
        if (!remote.data || (firstJoin && local.personal.length)) await save()
        else cloud.message(`私人雲端已載入 · ${user.email}`)
      } catch (error) { cloud.message(`雲端連線失敗，本機資料仍保留：${error.message}`); render() }
    })
    $('cloud-sync').onclick = async () => {
      if (!cloud.user) return
      try {
        await cloudQueue.catch(() => {})
        if (state.cloudMeta.dirty) { download(`尚未同步資料-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(cloudLibrary(), null, 2), 'application/json'); cloud.message('已先下載本機未同步資料的備份。') }
        const remote = await cloud.read()
        if (remote.data) Object.assign(state, validateCloudLibrary(remote.data))
        state.cloudMeta = { ownerEmail: cloud.user.email, revision: remote.revision, dirty: false, syncedAt: new Date().toISOString() }
        await window.HandbookStorage.write(localLibrary()); cloudReady = true; render(); cloud.message('已取得私人雲端最新資料。')
      } catch (error) { cloud.message(`同步失敗：${error.message}`) }
    }
  }
  function snapshot(item, reason) {
    const { history, ...value } = item
    return { revisionId: crypto.randomUUID(), at: new Date().toISOString(), reason, snapshot: JSON.parse(JSON.stringify(value)) }
  }
  function withVersion(previous, next, reason) {
    const versions = [...(next.history || []), ...(previous.history || []), snapshot(previous, reason)]
    const history = [...new Map(versions.map(version => [version.revisionId || `${version.at}:${version.reason}:${JSON.stringify(version.snapshot)}`, version])).values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-20)
    return { ...next, updatedAt: new Date().toISOString(), history }
  }
  function allItems() { return [...base.filter(i => (i.domain || 'slot') === state.domain), ...state.personal.filter(i => i.domain === state.domain)] }
  function switchDomain(domain) {
    if (!domains[domain] || domain === state.domain) return
    state.domainViews[state.domain] = { type: state.type, category: state.category, query: state.query, mode: state.mode, selected: state.selected, tab: state.tab }
    state.domain = domain
    Object.assign(state, state.domainViews[domain] || { type: 'all', category: '', query: '', mode: 'browse', selected: null, tab: 'guide' })
    $('search').value = state.query
    $('conflict-only').checked = false
    state.pending = []; state.pendingFiles = []; state.pendingTrash = []; state.pendingCloud = null; state.linkCandidates = []
    render()
  }
  function filtered() {
    const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return allItems().filter(i => (state.type === 'all' || i.type === state.type) && (!state.category || i.category === state.category) && (state.mode !== 'mine' || i.personal) && (state.mode !== 'stars' || state.stars.includes(`${state.domain}:${i.id}`) || (state.domain === 'slot' && state.stars.includes(i.id))) && (!$('conflict-only').checked || i.conflicts?.length) && terms.every(t => [i.title, i.name, i.summary, i.category, i.content, ...(i.sources || []), ...(i.fields || []).map(f => f[1])].join(' ').toLowerCase().includes(t)))
  }
  let toastTimer
  function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500) }
  function nav() {
    const items = allItems()
    $('type-nav').innerHTML = Object.entries(labels).map(([type, label]) => `<button class="side-link ${state.type === type && !['audit', 'guide', 'mine', 'stars'].includes(state.mode) ? 'active' : ''}" data-type="${type}">${label}<span>${type === 'all' ? items.length : items.filter(i => i.type === type).length}</span></button>`).join('')
    const categories = [...new Set(items.filter(i => state.type === 'all' || i.type === state.type).map(i => i.category))].sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    $('category').innerHTML = '<option value="">所有分類</option>' + categories.map(c => `<option value="${escape(c)}">${escape(c)}</option>`).join('')
    $('category').value = state.category
  }
  function render() {
    if (storageLoading) { $('detail').innerHTML = '<p>正在開啟附件與版本資料庫…</p>'; $('results').innerHTML = ''; return }
    const privateWeb = typeof location !== 'undefined' && location.protocol !== 'file:' && !!window.HANDBOOK_CLOUD_CONFIG
    if (!window.HandbookStorage.fileBacked && (privateWeb || state.cloudMeta.ownerEmail) && !window.HandbookCloud?.user) {
      $('detail').innerHTML = '<h2>私人資料庫</h2><p>請按上方「Google 登入」開啟您的技能、規則與知識庫。</p>'; $('results').innerHTML = ''; $('type-nav').innerHTML = ''; $('result-count').textContent = '請先登入您的 Google 帳號。'
      $('import-btn').disabled = true; $('export-btn').disabled = true; $('trash-btn').disabled = true; return
    }
    if (!storageLoading) { $('import-btn').disabled = false; $('export-btn').disabled = false; $('trash-btn').disabled = false }
    document.querySelectorAll('#domain-nav [data-domain]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.domain === state.domain)))
    $('domain-badge').textContent = domains[state.domain]
    $('page-subtitle').textContent = `${domains[state.domain]}資料庫：搜尋、匯入並連結技能、規則與知識。`
    $('search').placeholder = state.domain === 'slot' ? '搜尋技能、規則、知識，例如：停輪、音效、FreeGame' : '搜尋股票分析技能、規則、知識，例如：財報、估值、風險'
    nav()
    $('page-title').textContent = state.mode === 'mine' ? '我的新增與匯入' : state.mode === 'stars' ? '已收藏的資料' : state.mode === 'audit' ? '適用差異與規則衝突' : state.mode === 'guide' ? '使用與資料管理指南' : state.type === 'all' ? '查詢與應用' : labels[state.type]
    const rows = filtered()
    $('result-count').textContent = `${rows.length} 筆結果 · 支援名稱與內容全文搜尋`
    if (!rows.some(i => i.id === state.selected)) state.selected = rows[0]?.id || null
    $('results').innerHTML = rows.length ? rows.map(i => `<button class="result ${i.id === state.selected ? 'selected' : ''}" data-select="${escape(i.id)}"><span class="result-top"><span class="tag">${singular[i.type]} · ${escape(i.category)}</span>${i.personal ? '<span class="tag green">個人資料</span>' : i.blocked ? '<span class="tag gold">僅盤點</span>' : i.conflicts?.length ? '<span class="tag gold">需確認</span>' : ''}</span><strong>${escape(i.title)}</strong><span class="name">${escape(i.name)}</span><p>${escape(i.summary)}</p></button>`).join('') : '<div class="empty">沒有符合的資料。可換個關鍵字、取消篩選，或匯入資料。</div>'
    if (state.mode === 'guide') return renderHelp()
    if (state.mode === 'audit') return renderAudit()
    renderDetail()
  }
  function relatedItems(item, available = allItems()) {
    return available.filter(i => i.id !== item.id && ((item.relatedIds || []).includes(i.id) || (i.relatedIds || []).includes(item.id)))
  }
  function confirmDelete(items, message) {
    if (!items.length) return toast('目前沒有可刪除的個人資料；專案快照無法刪除。')
    $('delete-message').textContent = message
    $('delete-dialog').showModal()
    $('confirm-delete').onclick = async () => {
      state.trash.push({ at: new Date().toISOString(), domain: state.domain, items: JSON.parse(JSON.stringify(items)), links: state.personal.filter(i => i.domain === state.domain).map(i => ({ id: i.id, relatedIds: i.relatedIds || [] })) })
      const ids = new Set(items.map(i => i.id))
      state.personal = state.personal.filter(i => i.domain !== state.domain || !ids.has(i.id)).map(i => i.domain === state.domain ? { ...i, relatedIds: (i.relatedIds || []).filter(id => !ids.has(id)) } : i)
      state.stars = state.stars.filter(id => ![...ids].some(removed => id === `${state.domain}:${removed}` || (state.domain === 'slot' && id === removed)))
      const stored = await save()
      $('delete-dialog').close()
      render()
      if (stored) toast(`已移至回收桶 ${ids.size} 筆資料，可從回收桶還原。`)
    }
  }
  function renderDetail() {
    const item = allItems().find(i => i.id === state.selected)
    if (!item) { $('detail').innerHTML = '<h2>開始建立你的資料庫</h2><p>選擇「匯入」，即可整理自己的技能、規則與知識。</p>'; return }
    const exportLabel = item.type === 'knowledge' ? (/規格/.test(item.title + item.name) ? '規格' : '知識庫文件') : singular[item.type]
    const guide = item.type === 'skill'
    if (!guide && state.tab === 'guide') state.tab = 'content'
    const tabs = guide ? [['guide', '操作指南'], ['apply', '產生應用指令'], ['content', '來源全文']] : [['content', '文件內容'], ['apply', '產生應用指令']]
    if (!tabs.some(t => t[0] === state.tab)) state.tab = tabs[0][0]
    const skillActions = `<button id="export-item-zip">匯出技能</button><button id="export-related">匯出相關技能</button><button id="delete-item" class="danger" ${item.personal ? '' : 'disabled title="專案快照不可刪除"'}>刪除技能</button><button id="delete-related" class="danger">刪除相關技能</button><button id="edit-item">內容編輯</button>`
    const otherActions = `<button id="export-item">匯出md檔</button><button id="export-item-zip">匯出此${exportLabel}（ZIP，含關聯）</button><button id="export-item-json">單項備份（JSON，含關聯）</button><button id="edit-item">內容編輯</button>${item.personal ? '<button id="delete-item" class="danger">刪除個人資料</button>' : ''}`
    $('detail').innerHTML = `<div class="detail-heading"><div><span class="tag ${item.personal ? 'green' : ''}">${escape(item.origin || '個人新增')} · ${singular[item.type]}</span><h2>${escape(item.title)}</h2><div class="name">${escape(item.name)}</div></div></div><p class="detail-summary">${escape(item.summary)}</p><div class="detail-actions">${guide ? skillActions : otherActions}</div>${item.conflicts?.length ? `<div class="notice"><strong>本專案適用提醒</strong><ul>${item.conflicts.map(s => `<li>${escape(s)}</li>`).join('')}</ul></div>` : ''}<div class="tabs">${tabs.map(([id, name]) => `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${name}</button>`).join('')}</div><div id="detail-body"></div>`
    if (state.tab === 'guide') renderSkill(item)
    else if (state.tab === 'apply') renderApply(item)
    else renderContent(item)
    if ($('export-item')) $('export-item').onclick = () => {
      const name = safeName(item.name)
      download(/\.md$/i.test(name) ? name : `${name}.md`, item.content, 'text/markdown;charset=utf-8')
    }
    $('export-item-zip').onclick = () => guide ? exportOriginalZip([item]) : exportData(exportWithRelated(item), 'zip')
    if ($('export-related')) $('export-related').onclick = () => exportOriginalZip(exportWithRelated(item))
    if ($('export-item-json')) $('export-item-json').onclick = () => exportData(exportWithRelated(item), 'json')
    $('edit-item').onclick = () => openEditor(item)
    if ($('delete-item')) $('delete-item').onclick = () => confirmDelete(item.personal ? [item] : [], `確定刪除「${item.title}」？此動作只會刪除目前瀏覽器中的個人資料。`)
    if ($('delete-related')) $('delete-related').onclick = () => {
      const related = exportWithRelated(item).filter(i => i.personal)
      confirmDelete(related, `確定刪除 ${related.length} 筆技能／知識／規則（包含目前技能）？${related.map(i => i.title).join('、')}。專案快照不會刪除。`)
    }
    renderExtras(item)
  }
  function renderExtras(item) {
    const panel = document.createElement('section')
    panel.innerHTML = `<h3>附件與版本</h3><p>目前 ${item.attachments?.length || 0} 份附件 · ${item.history?.length || 0} 個舊版本（最多保存最近 20 次更新前版本）。</p><div class="detail-actions"><button id="history-btn">版本紀錄與還原</button>${item.rawFile ? '<button id="download-original">下載原始檔案</button>' : ''}</div>${(item.attachments || []).map((file, n) => `<button data-attachment="${n}">下載 ${escape(file.name)} (${window.HandbookArchive.fileBytes(file).length} bytes)</button>`).join('')}`
    $('detail').append(panel)
    $('history-btn').onclick = () => showHistory(item)
    if ($('download-original')) $('download-original').onclick = () => download(item.sources[0].split('/').pop(), new Blob([window.HandbookArchive.fileBytes(item.rawFile)]))
    panel.querySelectorAll('[data-attachment]').forEach(button => { button.onclick = () => { const file = item.attachments[Number(button.dataset.attachment)]; download(file.name.split('/').pop(), new Blob([window.HandbookArchive.fileBytes(file)])) } })
  }
  function showHistory(item) {
    const versions = [...(item.history || [])].reverse()
    $('history-list').innerHTML = versions.length ? versions.map((version, n) => `<div class="import-item"><strong>${escape(new Date(version.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }))} · ${escape(version.reason)}</strong><p>${escape(version.snapshot.title)} · ${version.snapshot.attachments?.length || 0} 份附件</p><button data-version-preview="${n}">查看版本</button> <button data-version-restore="${n}">還原此版本</button></div>`).join('') : '<p>目前沒有舊版本；編輯或匯入更新後會自動保存。</p>'
    $('version-preview').textContent = ''
    $('history-list').querySelectorAll('[data-version-preview]').forEach(button => { button.onclick = () => { const old = versions[Number(button.dataset.versionPreview)].snapshot; $('version-preview').textContent = `目前：${item.title}\n分類：${item.category}\n${item.content}\n\n舊版本：${old.title}\n分類：${old.category}\n${old.content}` } })
    $('history-list').querySelectorAll('[data-version-restore]').forEach(button => { button.onclick = async () => {
      const current = state.personal.find(i => i.domain === state.domain && i.id === item.id)
      if (!current) return toast('此資料已不存在。')
      const previous = versions[Number(button.dataset.versionRestore)].snapshot
      const next = withVersion(current, { ...previous, id: current.id, domain: state.domain, personal: true }, '還原版本前')
      state.personal = state.personal.map(i => i === current ? next : i)
      const stored = await save(); $('history-dialog').close(); render(); if (stored) toast('已還原；還原前的版本也已保存。')
    } })
    $('history-dialog').showModal()
  }
  function renderSkill(i) {
    $('detail-body').innerHTML = `<div class="section-label">使用前要準備</div>${i.fields?.length ? `<ul class="plain-list">${i.fields.map(f => `<li><strong>${escape(f[1])}</strong> ${f[3] ? '<span class="required">必填</span>' : '<span class="muted">選填</span>'}<br><span class="muted">${escape(f[2])}</span></li>`).join('')}</ul>` : '<p>此技能尚未設定輸入欄位，請先查看來源全文或編輯補齊。</p>'}<div class="section-label">如何使用</div><p class="browse-help">可在 Codex 選取此技能，或描述需求並寫明「使用 ${escape(i.name)}」。先填下一頁的資料，再複製完整指令。</p>${i.steps?.length ? `<ol class="step-list">${i.steps.map(s => `<li>${escape(s)}</li>`).join('')}</ol>` : '<p>請依技能全文操作；尚未整理步驟的匯入技能不會自動推斷操作。</p>'}${i.outputs?.length ? `<div class="section-label">會得到什麼</div>${list(i.outputs)}` : ''}${i.checks?.length ? `<div class="section-label">驗收與注意事項</div>${list(i.checks)}` : ''}${relatedSection(i)}${sources(i)}<div class="notice">此工作台產生需求指令。請回到能使用此技能所需工具的 Codex 對話執行；網頁本身不會啟動技能或修改外部資料。</div>`
  }
  function list(a) { return `<ul class="plain-list">${a.map(x => `<li>${escape(x)}</li>`).join('')}</ul>` }
  function sources(i) { return `<h3>來源與適用範圍</h3>${(i.sources || []).map(p => `<div class="source-path"><span>${escape(p)}</span><button data-copy-path="${escape(p)}">複製路徑</button></div>`).join('')}${i.versionsDiffer ? '<p class="muted">四套工具的技能副本存在差異，說明以 .agents 版本為基準；可到來源全文切換比對。</p>' : ''}<p class="muted">${i.personal ? '個人資料，尚未安裝或寫回專案。' : '來源為實際檔案快照；敏感設定與長識別碼已遮蔽。'}</p>` }
  function relatedSection(i) { const rows = relatedItems(i); return rows.length || i.relatedNotes ? `<h3>其他相關技能與知識</h3>${i.relatedNotes ? `<p class="browse-help">${escape(i.relatedNotes).replace(/\n/g, '<br>')}</p>` : ''}${rows.length ? `<div class="related">${rows.map(r => `<button data-jump="${escape(r.id)}">${escape(r.title)}</button>`).join('')}</div>` : ''}` : '' }
  function renderApply(i) {
    const fields = i.type === 'skill' ? (i.fields || []) : [['goal', '要應用的任務', '描述問題、目標檔案與預期結果', true], ['scope', '使用範圍／補充資料', '只查閱、分析、規劃或執行；可填相關路徑', false]]
    const inputKey = `${state.domain}:${i.id}`
    state.inputs[inputKey] ||= {}
    $('detail-body').innerHTML = `<p class="browse-help">${i.blocked ? '此技能只能盤點與尋找遊戲層方案，不能修改共用 InitScene。' : '填入必要資料，產生可貼回 Codex 的完整需求。'}</p><div class="form-grid">${fields.map(f => `<label class="field">${escape(f[1])} ${f[3] ? '<span class="required">必填</span>' : '<small>選填</small>'}<textarea rows="2" data-field="${escape(f[0])}" placeholder="${escape(f[2])}">${escape(state.inputs[inputKey][f[0]] || '')}</textarea></label>`).join('')}</div><label class="field">補充要求<textarea id="extra-prompt" rows="3" placeholder="例如：只做唯讀盤點、測試情境、已確認素材與限制">${escape(state.inputs[inputKey]._extra || '')}</textarea></label><div class="input-status" id="input-status"></div><h3>應用指令</h3><pre id="generated-prompt" class="prompt"></pre><div class="detail-actions"><button class="primary" id="copy-prompt">複製完整指令</button><button id="download-prompt">下載指令 .txt</button></div>${sources(i)}<p class="muted">匯入或新增的技能尚未安裝時，指令會包含技能內容供此次使用。下載／匯出不等於安裝。</p>`
    const update = () => {
      const input = state.inputs[inputKey]
      const missing = fields.filter(f => f[3] && !input[f[0]]?.trim())
      $('input-status').textContent = missing.length ? `尚缺 ${missing.length} 項必填資料：${missing.map(f => f[1]).join('、')}。` : '必要資料已填齊，可複製至 Codex。'
      let prompt = `請${i.type === 'skill' ? `使用 ${i.name} 技能` : `查閱並應用「${i.title}」`}，協助${domains[state.domain]}相關任務。\n${i.action || '依下列任務與文件內容處理，先確認適用範圍。'}\n\n`
      prompt += fields.map(f => `${f[1]}：${input[f[0]]?.trim() || (f[3] ? `【待提供：${f[1]}】` : '未指定')}`).join('\n')
      if (input._extra?.trim()) prompt += `\n補充要求：${input._extra.trim()}`
      prompt += state.domain === 'slot' ? '\n\n專案規範：先讀 AGENTS.md 與對應知識庫；所有溝通使用繁體中文；五個共用 submodule 絕對禁止修改；程式修正僅在遊戲層 G1028 腳本。scene／prefab／meta 操作須透過 Cocos MCP。不得照抄其他遊戲 ID、舊路徑或不可用的工具 API。' : '\n\n請依股票分析分頁中的相關規則與知識查證來源、日期、假設與風險；需要最新市場資料時先查證。'
      if (i.conflicts?.length) prompt += '\n\n適用提醒：\n' + i.conflicts.map(c => `- ${c}`).join('\n')
      if (i.sources?.length) prompt += '\n\n來源：\n' + i.sources.join('\n')
      if (i.personal) prompt += `\n\n此資料尚未安裝，請將下列內容作為本次需求參考${state.domain === 'slot' ? '；與 AGENTS.md 衝突的部分不執行' : ''}：\n\n` + i.content
      $('generated-prompt').textContent = prompt
      $('copy-prompt').disabled = !!missing.length; $('download-prompt').disabled = !!missing.length
    }
    $('detail-body').querySelectorAll('[data-field]').forEach(el => el.oninput = () => { state.inputs[inputKey][el.dataset.field] = el.value; update() })
    $('extra-prompt').oninput = e => { state.inputs[inputKey]._extra = e.target.value; update() }
    $('copy-prompt').onclick = () => copy($('generated-prompt').textContent)
    $('download-prompt').onclick = () => download(`${safeName(i.name)}-request.txt`, $('generated-prompt').textContent, 'text/plain;charset=utf-8')
    update()
  }
  function renderContent(i) {
    const variants = i.sourceVariants || []
    $('detail-body').innerHTML = `${variants.length ? `<label class="field">來源版本<select id="source-version">${variants.map((v, n) => `<option value="${n}">${escape(v.path)}${n === 0 ? ' · 說明基準' : ''}</option>`).join('')}</select></label>` : ''}<div class="detail-actions"><button id="toggle-raw">查看 Markdown 原文</button></div><div id="document-render" class="markdown"></div>${i.pattern ? `<h3>Pattern metadata</h3><pre class="prompt">${escape(JSON.stringify(i.pattern, null, 2))}</pre>` : ''}${relatedSection(i)}${sources(i)}`
    let raw = false
    const update = () => { const text = variants[$('source-version')?.value || 0]?.content || i.content; $('document-render').innerHTML = raw ? `<pre id="raw-text">${escape(text)}</pre>` : markdown(text); $('toggle-raw').textContent = raw ? '閱讀文件' : '查看 Markdown 原文' }
    $('toggle-raw').onclick = () => { raw = !raw; update() }
    if ($('source-version')) $('source-version').onchange = update
    update()
  }
  function inline(s) {
    return escape(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const decoded = url.replaceAll('&amp;', '&')
      if (/^https?:\/\//i.test(decoded)) return `<a href="${escape(decoded)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      return `<span title="來源相對路徑：${escape(decoded)}">${label} <code>${escape(decoded)}</code></span>`
    })
  }
  function markdown(source) {
    const lines = stripFront(source).split(/\r?\n/), out = []
    let n = 0
    while (n < lines.length) {
      const s = lines[n]
      if (!s.trim()) { n++; continue }
      if (/^\s*```/.test(s)) { const block = []; n++; while (n < lines.length && !/^\s*```/.test(lines[n])) block.push(lines[n++]); if (n < lines.length) n++; out.push(`<pre><code>${escape(block.join('\n'))}</code></pre>`); continue }
      const h = s.match(/^(#{1,6})\s+(.+)/)
      if (h) { const level = Math.min(4, h[1].length); out.push(`<h${level}>${inline(h[2])}</h${level}>`); n++; continue }
      if (/^\s*\|/.test(s) && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[n + 1] || '')) {
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim())
        const head = cells(s), rows = []; n += 2
        while (n < lines.length && /^\s*\|/.test(lines[n])) rows.push(cells(lines[n++]))
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map(x => `<th>${inline(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(x => `<td>${inline(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(s)) {
        const ordered = /^\s*\d+\./.test(s), rows = []
        while (n < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[n])) rows.push(lines[n++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))
        out.push(`<${ordered ? 'ol' : 'ul'}>${rows.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue
      }
      if (/^>/.test(s)) { out.push(`<blockquote>${inline(s.replace(/^>\s*/, ''))}</blockquote>`); n++; continue }
      if (/^\s*---+\s*$/.test(s)) { out.push('<hr>'); n++; continue }
      out.push(`<p>${inline(s)}</p>`); n++
    }
    return out.join('')
  }
  function renderHelp() {
    $('detail').innerHTML = `<div class="overview"><span class="tag green">${domains[state.domain]}資料庫</span><h2>逐筆匯入與建立連結</h2><p>目前資料庫沒有預載技能、規則或知識。按「匯入」選擇 Markdown、ZIP、資料夾或工作台 JSON 備份；匯入預覽可勾選與現有資料的相關連結。即使先匯入技能、後匯入知識，也能在第二次匯入時連結兩者。</p><h3>匯出與刪除</h3><p>「匯出技能」只包含目前技能；「匯出相關技能」包含目前技能與整個關聯群組。技能 ZIP 保留匯入時的相對目錄及檔名，只增加一份「匯出說明.md」記錄關聯；重新匯入時可還原連結。刪除相關技能會列出同一關聯群組的個人資料（包含目前技能），確認後一起移至回收桶。</p><h3>附件與版本</h3><p>每筆資料下方可下載原始附件、查看版本並還原。編輯或更新前自動保存最近 20 次快照；刪除後可從上方回收桶還原。ZIP 的匯出說明保存分類、操作指南與版本，全部資料庫備份也包含回收桶。單檔上限 10 MB、單次匯入上限 50 MB。</p><h3>資料保存</h3><p>使用 start.ps1 啟動本機網站時，匯入內容、附件、版本、收藏與回收桶全部保存在專案 data/library.json，每次寫入前保留上一份 library.previous.json。直接開啟 HTML 或遠端靜態網站仍使用原本瀏覽器儲存；請從舊網站匯出 JSON，再於本機網站匯入以搬移資料。原始瀏覽器資料不會因搬移而刪除。</p></div>`
  }  function renderAudit() {
    const conflicts = base.filter(i => i.conflicts?.length || i.versionsDiffer)
    $('detail').innerHTML = `<h2>先看適用範圍，再使用來源</h2><p class="muted">來源全文忠實保留原文件（敏感值已遮蔽），操作指南與應用指令已標示本專案限制。</p><div class="notice">AGENTS.md 禁止修改共用模組並要求 Cocos MCP 操作資產。舊技能若寫「直接改 scene／prefab／meta」或「共用層加 log」，在本專案不可照做。</div>${conflicts.map(i => `<div class="audit-row"><button data-jump="${escape(i.id)}">${escape(i.title)}</button>${i.versionsDiffer ? '<p>技能副本存在版本差異，可切換來源版本查看。</p>' : ''}${(i.conflicts || []).map(c => `<p>${escape(c)}</p>`).join('')}</div>`).join('')}`
  }
  function openEditor(item = null) {
    state.editing = item?.personal ? item.id : null
    $('editor-title').textContent = item?.personal ? '編輯個人資料' : item ? '複製為個人資料' : '新增資料'
    $('edit-type').value = item?.type || 'skill'; $('edit-name').value = item?.name || ''; $('edit-title').value = item?.title || ''; $('edit-category').value = item?.category || '自訂技能'; $('edit-summary').value = item?.summary || ''; $('edit-content').value = item?.content || ''; $('edit-inputs').value = (item?.fields || []).map(f => `${f[3] ? '*' : ''}${f[1]}`).join('\n'); $('edit-related-notes').value = item?.relatedNotes || ''
    $('editor').showModal()
    $('editor-form').onsubmit = async e => {
      e.preventDefault()
      const content = redaction($('edit-content').value), type = $('edit-type').value
      const edited = state.personal.find(i => i.domain === state.domain && i.id === state.editing)
      const i = { ...(item || {}), domain: state.domain, id: state.editing || `personal:${crypto.randomUUID()}`, type, name: $('edit-name').value.trim(), title: $('edit-title').value.trim(), category: $('edit-category').value.trim(), summary: $('edit-summary').value.trim(), relatedNotes: $('edit-related-notes').value.trim(), content, sources: edited?.sources || [`個人資料/${$('edit-name').value.trim()}`], sourceVariants: [], personal: true, origin: item ? '個人編輯' : '個人新增', versionsDiffer: false, fields: $('edit-inputs').value.split('\n').map(x => x.trim()).filter(Boolean).map((x, n) => [`input${n}`, x.replace(/^\*/, '').trim(), '請提供此項資料', x.startsWith('*')]), updatedAt: new Date().toISOString() }
      if (!i.name || !i.title || !i.category || !i.summary || !i.content.trim()) return toast('請填入名稱、標題、分類、說明與內容。')
      if (edited) state.personal = state.personal.map(x => x.domain === state.domain && x.id === i.id ? withVersion(edited, i, '內容編輯前') : x)
      else state.personal.push(i)
      const stored = await save(); $('editor').close(); state.mode = 'mine'; state.type = 'all'; state.category = ''; state.query = ''; $('search').value = ''; $('conflict-only').checked = false; state.selected = i.id; state.tab = type === 'skill' ? 'guide' : 'content'; render(); if (stored) toast('已儲存至此瀏覽器。')
    }
  }
  function safeName(s) { return s.replace(/[^\p{L}\p{N}_.-]/gu, '-').replace(/-+/g, '-').slice(-120) || 'document' }
  function download(name, content, type) {
    const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type })), a = document.createElement('a')
    a.href = url; a.download = name; a.hidden = true; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000)
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('已複製。') }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove(); toast(ok ? '已複製。' : '無法使用剪貼簿，請選取內容手動複製。') }
  }
  function backup(items, full = false) { return { schema: 'slot-handbook/v1', exportedAt: new Date().toISOString(), domain: state.domain, project: domains[state.domain], items, ...(full ? { trash: state.trash.filter(batch => batch.domain === state.domain) } : {}) } }
  function exportWithRelated(item, available = allItems()) {
    const selected = new Map(), queue = [item]
    while (queue.length) {
      const current = queue.shift()
      if (selected.has(current.id)) continue
      selected.set(current.id, current)
      for (const found of relatedItems(current, available)) if (!selected.has(found.id)) queue.push(found)
      for (const id of current.relatedIds || []) {
        const found = available.find(i => i.id === id)
        if (found && !selected.has(id)) queue.push(found)
      }
    }
    return [...selected.values()]
  }
  function archivePath(value) {
    const path = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
    if (!path || /^(?:\/|[A-Za-z]:)/.test(path) || /[\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`來源路徑無法原樣匯出：${value}`)
    return path
  }
  function originalPath(item) {
    let path = item.sources?.[0] || ''
    if (!path || path.startsWith('個人資料/')) {
      path = path || `個人資料/${safeName(item.name)}`
      if (!/\.(?:md|mdc|txt)$/i.test(path)) path += item.type === 'skill' ? '/SKILL.md' : '.md'
    }
    return archivePath(path)
  }
  function originalZipFiles(items, full = false) {
    validateItems({ schema: 'slot-handbook/v1', items })
    const files = [], contents = new Map(), itemPaths = new Map()
    const put = (name, content, encoding) => {
      const path = archivePath(name), value = `${encoding || 'text'}:${content}`, prior = contents.get(path)
      if (prior !== undefined) {
        if (prior !== value) throw Error(`「${path}」有不同內容，無法在同一 ZIP 保留兩份同名檔案。請分開匯出。`)
        return
      }
      contents.set(path, value); files.push(encoding ? { name: path, content, encoding } : { name: path, content })
    }
    for (const item of items) {
      const path = originalPath(item)
      itemPaths.set(item.id, path)
      if (item.rawFile) put(path, item.rawFile.content, item.rawFile.encoding)
      else put(path, item.content)
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
      for (const attachment of item.attachments || []) put(folder + attachment.name, attachment.content, attachment.encoding)
    }
    const relations = items.map(item => ({ path: itemPaths.get(item.id), related: relatedItems(item, items).map(other => itemPaths.get(other.id)) }))
    let note = '匯出說明.md', n = 2
    while (contents.has(note)) note = `匯出說明-${n++}.md`
    const metadata = items.map(item => { const { content, attachments, rawFile, ...rest } = item; return { path: itemPaths.get(item.id), item: { ...rest, ...(rawFile ? { content, fileOnly: true } : {}) }, attachments: (attachments || []).map(file => file.name) } })
    const manifest = JSON.stringify({ relations, metadata, ...(full ? { trash: state.trash.filter(batch => batch.domain === state.domain) } : {}) })
    if (new TextEncoder().encode(manifest).length > 45 * 1024 * 1024) throw Error('版本資料過大，請拆分匯出。')
    put(note, `# ${domains[state.domain]}資料匯出說明\n\n文件保留原始相對目錄與檔名，附件以原始格式保存。下方資料保存分類、操作指南、關聯與最近 20 次更新前版本。重新匯入此 ZIP 可還原。解壓不等於安裝或執行技能。\n\n<!-- AI-HANDBOOK-RELATIONS-V1\n${manifest}\n-->`)
    return files
  }
  function relationManifest(files) {
    const notes = files.filter(f => /(?:^|\/)匯出說明(?:-\d+)?\.md$/i.test(f.name) && f.content.includes('<!-- AI-HANDBOOK-RELATIONS-V1'))
    const excluded = new Set(notes), relations = [], metadata = [], trash = []
    for (const note of notes) {
      const match = note.content.match(/<!-- AI-HANDBOOK-RELATIONS-V1\s*([\s\S]*?)\s*-->/)
      if (!match) throw Error(`${note.name}：關聯資料格式不正確。`)
      const data = JSON.parse(match[1])
      if (!Array.isArray(data.relations) || data.relations.length > 1500) throw Error(`${note.name}：關聯資料格式不正確。`)
      for (const relation of data.relations) {
        if (typeof relation?.path !== 'string' || !Array.isArray(relation.related) || relation.related.length > 1500 || !relation.related.every(path => typeof path === 'string')) throw Error(`${note.name}：關聯資料格式不正確。`)
        relations.push({ path: archivePath(relation.path), related: relation.related.map(archivePath) })
      }
      if (data.metadata !== undefined) {
        if (!Array.isArray(data.metadata) || data.metadata.length > 1500) throw Error('匯出包的分類資料不合法。')
        for (const entry of data.metadata) metadata.push({ path: archivePath(entry.path), item: entry.item, attachments: (entry.attachments || []).map(archivePath) })
      }
      if (data.trash) trash.push(...validateTrash(data.trash))
    }
    return { excluded, relations, metadata, trash }
  }
  function exportOriginalZip(items, full = false) {
    if (!items.length && !(full && state.trash.some(batch => batch.domain === state.domain))) return toast('此範圍沒有可匯出的資料。')
    try {
      const files = originalZipFiles(items, full)
      const name = `${safeName(domains[state.domain])}-${full ? '完整資料庫' : safeName(items[0].name)}${!full && items.length > 1 ? '-相關技能' : ''}.zip`
      download(name, window.HandbookArchive.zip(files))
      toast(`已匯出 ${items.length} 筆資料，保留原始目錄與檔名。`)
    } catch (error) { toast(error.message) }
  }
  function exportData(items, format, full = false) {
    if (!items.length && !(full && state.trash.some(batch => batch.domain === state.domain))) return toast('此範圍沒有可匯出的資料。')
    const json = JSON.stringify(backup(items, full), null, 2), name = `${safeName(domains[state.domain])}-${items.length === 1 ? safeName(items[0].name) : 'ai-handbook'}-${new Date().toISOString().slice(0, 10)}`
    if (format === 'json') {
      try { validateItems(backup(items)); if (full) validateTrash(backup(items, true).trash); if (new TextEncoder().encode(json).length > 50 * 1024 * 1024) throw Error('完整備份超過 50 MB，請拆分匯出。'); download(`${name}.json`, json, 'application/json;charset=utf-8') }
      catch (error) { return toast(error.message) }
    }
    else { exportOriginalZip(items, full); return }
    toast(`已匯出 ${items.length} 筆${format === 'zip' ? '文件包' : '完整備份'}。`)
  }
  function selectedExport() { const s = $('export-scope').value; return s === 'all' ? allItems() : s === 'filtered' ? filtered() : s === 'mine' ? allItems().filter(i => i.personal) : allItems().filter(i => i.type === s) }
  function classifyImport(file, fallback = 'knowledge') {
    const path = file.name.replaceAll('\\', '/'), basename = path.split('/').pop()
    const content = String(file.content).replace(/^\uFEFF/, ''), front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
    const result = (type, reason) => ({ type, reason, automatic: true })
    const declared = front.match(/^type:\s*['"]?([^\r\n'"]+)['"]?\s*$/m)?.[1]?.trim().toLowerCase()
    const declaredTypes = { skill: 'skill', 技能: 'skill', rule: 'rule', rules: 'rule', 規則: 'rule', knowledge: 'knowledge', 知識庫: 'knowledge', pattern: 'pattern' }
    if (/^SKILL\.md$/i.test(basename)) return result('skill', '檔名 SKILL.md：技能定義文件')
    if (declaredTypes[declared]) return result(declaredTypes[declared], `文件前置資料宣告 type: ${declared}`)
    if (/\.mdc$/i.test(basename)) return result('rule', '.mdc：規則文件格式')
    if (/^(?:AGENTS|CLAUDE|RULES|INSTRUCTIONS)\.md$/i.test(basename) || /^rule(?:__|[-_])/i.test(basename)) return result('rule', '檔名表示規則或 AI 指導文件')
    if (/(?:^|\/)(?:\d+[_-])?(?:rules|steering)(?:\/|$)/i.test(path)) return result('rule', '文件位於規則／指導目錄')
    if (/^pattern(?:__|[-_])/i.test(basename) || /(?:^|\/)patterns\/[^/]+\/README\.md$/i.test(path)) return result('pattern', '檔名或目錄表示 Pattern 範本')
    const title = stripFront(content).match(/^#\s+(.+)$/m)?.[1] || ''
    if (/(?:規則|規範|守則|準則|指導書|操作指引|開發約定)(?:$|[（(：:])/.test(title)) return result('rule', '文件標題明確表示規則、規範或指導文件')
    if (/(?:規則|規範|守則|準則|指導書|操作指引|開發約定)/.test(title) && /(?:必須|禁止|不得|一律|應遵守|務必)/.test(stripFront(content))) return result('rule', '標題表示規範，內容包含明確的要求或禁止事項')
    if (/^(?:flow|component|config|event|knowledge)(?:__|[-_])/i.test(basename)) return result('knowledge', '檔名表示流程、元件、設定或知識文件')
    return { type: fallback, reason: `沒有足夠的分類依據，使用「一般文件匯入為：${singular[fallback]}」`, automatic: false }
  }
  function importItem(file, fallback) {
    const content = String(file.content), p = file.name.replaceAll('\\', '/'), front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
    const frontName = front.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    const classification = classifyImport(file, fallback), type = classification.type
    const name = frontName || (type === 'skill' ? p.split('/').slice(-2, -1)[0] : '') || p.split('/').pop().replace(/\.(mdc?|txt)$/i, '')
    const title = stripFront(content).match(/^#\s+(.+)$/m)?.[1] || name
    let description = front.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '')
    if (/^[>|][-+]?\s*$/.test(description || '')) description = front.match(/^description:\s*[>|][-+]?\s*\r?\n((?:[ \t]+.+\r?\n?)+)/m)?.[1]?.trim().replace(/\s+/g, ' ')
    const summary = description || stripFront(content).split('\n').find(x => x.trim() && !/^#/.test(x))?.replace(/[*`]/g, '').slice(0, 210) || '匯入文件，請查看全文並補齊操作說明。'
    return { id: `import:${type}:${p}`, domain: state.domain, type, name, title, category: `匯入${singular[type]}`, summary, content, classificationReason: classification.reason, sources: [p], fields: [], conflicts: type === 'skill' && state.domain === 'slot' ? ['匯入技能尚未安裝；請確認依賴、輸入資料及是否與 AGENTS.md 衝突，再產生應用指令。'] : [], personal: true, origin: '檔案匯入' }
  }
  function validateItems(data) {
    if (data.schema !== 'slot-handbook/v1' || !Array.isArray(data.items) || data.items.length > 1500) throw Error('JSON 必須為 slot-handbook/v1 備份，最多 1500 筆。')
    let total = 0
    return data.items.map(i => {
      if (!i || !types.includes(i.type) || !['id', 'name', 'title', 'content'].every(k => typeof i[k] === 'string') || new TextEncoder().encode(i.content).length > 10 * 1024 * 1024) throw Error('備份有不合法的類型／欄位或超過 10 MB 的文件。')
      total += i.content.length
      if (total > 40 * 1024 * 1024) throw Error('備份內容超過 40 MB，請拆分匯入。')
      const a = (v, max = 100) => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max).map(x => x.slice(0, 2000)) : []
      const id = i.id.startsWith('personal:') || i.id.startsWith('import:') ? i.id : `import:${i.id}`
      const content = i.content
      const fields = Array.isArray(i.fields) ? i.fields.filter(f => Array.isArray(f) && f.length >= 4 && f.slice(0, 3).every(x => typeof x === 'string')).slice(0, 50).map(f => [f[0].slice(0, 100), f[1].slice(0, 300), f[2].slice(0, 1000), !!f[3]]) : []
      if (i.attachments !== undefined && !Array.isArray(i.attachments)) throw Error('附件格式不合法。')
      const attachments = (i.attachments || []).map(x => {
        if (!x || typeof x.content !== 'string' || x.content.length > 14 * 1024 * 1024 || (x.encoding !== undefined && x.encoding !== 'base64')) throw Error('附件格式不合法或超過 10 MB。')
        const name = archivePath(x.name)
        if (x.encoding === 'base64') {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x.content)) throw Error('附件編碼不合法。')
          if (window.HandbookArchive.fromBase64(x.content).length > 10 * 1024 * 1024) throw Error('附件超過 10 MB。')
        }
        return x.encoding ? { name, content: x.content, encoding: x.encoding } : { name, content: x.content }
      })
      if (attachments.length > 1500) throw Error('附件數量超過 1500。')
      if (i.history !== undefined && (!Array.isArray(i.history) || i.history.length > 20)) throw Error('版本格式不合法或超過 20 版。')
      const history = (i.history || []).map(entry => {
        if (!entry || typeof entry.at !== 'string' || typeof entry.reason !== 'string' || !entry.snapshot || entry.snapshot.history?.length) throw Error('版本紀錄不合法。')
        const version = validateItems({ schema: 'slot-handbook/v1', items: [{ ...entry.snapshot, history: undefined }] })[0]
        delete version.history
        total += JSON.stringify(version).length
        return { revisionId: typeof entry.revisionId === 'string' ? entry.revisionId.slice(0, 200) : undefined, at: entry.at.slice(0, 100), reason: entry.reason.slice(0, 200), snapshot: version }
      })
      const sourceVariants = Array.isArray(i.sourceVariants) ? i.sourceVariants.filter(x => x && typeof x.path === 'string' && typeof x.content === 'string' && x.content.length <= 1000000).slice(0, 10).map(x => ({ path: x.path.slice(0, 500), content: x.content })) : []
      let rawFile
      if (i.rawFile) {
        rawFile = validateItems({ schema: 'slot-handbook/v1', items: [{ id: 'personal:file-validation', name: 'file', title: 'file', type: 'knowledge', content: '', attachments: [i.rawFile] }] })[0].attachments[0]
        total += rawFile.content.length
      }
      total += attachments.reduce((n, x) => n + x.content.length, 0) + sourceVariants.reduce((n, x) => n + x.content.length, 0)
      if (total > 40 * 1024 * 1024) throw Error('備份附件超過 40 MB，請拆分匯入。')
      return { id: id.slice(0, 500), domain: state.domain, type: i.type, name: i.name.slice(0, 160), title: i.title.slice(0, 240), category: typeof i.category === 'string' ? i.category.slice(0, 100) : `匯入${singular[i.type]}`, summary: typeof i.summary === 'string' ? i.summary.slice(0, 2000) : '', relatedNotes: typeof i.relatedNotes === 'string' ? i.relatedNotes.slice(0, 4000) : '', content, sources: a(i.sources, 20), fields, steps: a(i.steps), outputs: a(i.outputs), checks: a(i.checks), conflicts: a(i.conflicts), related: a(i.related), relatedIds: a(i.relatedIds, 100).map(x => x.startsWith('personal:') || x.startsWith('import:') ? x : `import:${x}`), action: typeof i.action === 'string' ? i.action.slice(0, 2000) : '', blocked: !!i.blocked, pattern: i.type === 'pattern' && i.pattern && typeof i.pattern === 'object' ? JSON.parse(redaction(JSON.stringify(i.pattern))) : undefined, attachments, sourceVariants, rawFile, fileOnly: !!rawFile, history, updatedAt: typeof i.updatedAt === 'string' ? i.updatedAt : undefined, versionsDiffer: !!i.versionsDiffer, personal: true, origin: '備份匯入' }
    })
  }
  function validateTrash(value) {
    if (!Array.isArray(value) || value.length > 1500) throw Error('回收桶格式不合法。')
    return value.map(batch => {
      if (typeof batch?.at !== 'string' || !Array.isArray(batch.items)) throw Error('回收桶批次不合法。')
      const items = validateItems({ schema: 'slot-handbook/v1', items: batch.items })
      const links = Array.isArray(batch.links) ? batch.links.filter(link => typeof link.id === 'string' && Array.isArray(link.relatedIds)).map(link => ({ id: link.id, relatedIds: link.relatedIds.filter(id => typeof id === 'string') })) : []
      return { at: batch.at, domain: state.domain, items, links }
    })
  }
  function referencesItem(source, target) {
    if (source.type !== 'skill' || !['skill', 'knowledge', 'rule'].includes(target.type)) return false
    const content = source.content.replaceAll('\\', '/')
    const namedSkill = target.type === 'skill' && target.name.length >= 4 && new RegExp(`(^|[^\\w-])/?${target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\w-])`, 'i').test(content)
    const fileRef = (target.sources || []).some(s => {
      const p = s.replaceAll('\\', '/'), basename = p.split('/').pop()
      return (p.length >= 8 && content.includes(p)) || (basename?.length >= 8 && basename.toLowerCase() !== 'skill.md' && content.includes(basename))
    })
    return namedSkill || fileRef
  }
  function linkImported(rows, existing = allItems()) {
    const candidates = [...existing, ...rows]
    for (const item of rows) {
      const refs = new Set(item.relatedIds || [])
      for (const other of candidates) {
        if (other.id !== item.id && (referencesItem(item, other) || referencesItem(other, item))) refs.add(other.id)
      }
      item.relatedIds = [...refs].filter(id => candidates.some(i => i.id === id))
    }
  }
  function importKey(item) {
    const source = item.sources?.[0]?.replaceAll('\\', '/') || ''
    const name = item.type === 'skill' ? item.name : source && !source.startsWith('個人資料/') ? source.split('/').pop() : item.name
    return `${item.type}:${name.normalize('NFC').trim().toLowerCase()}`
  }
  function normalizeImportRows(rows, existing = allItems()) {
    const known = new Map(existing.map(item => [importKey(item), item])), chosen = new Map(), aliases = new Map()
    for (const row of rows) {
      const key = importKey(row), previous = chosen.get(key) || known.get(key), id = previous?.id || row.id
      aliases.set(row.id, id)
      chosen.set(key, { ...row, id, relatedIds: [...new Set([...(previous?.relatedIds || []), ...(row.relatedIds || [])])] })
    }
    return [...chosen.values()].map(row => ({ ...row, relatedIds: [...new Set(row.relatedIds.map(id => aliases.get(id) || id))].filter(id => id !== row.id) }))
  }
  const importDefaults = { preview: $('import-preview').innerHTML, typeHelp: $('import-type-help').textContent, replaceHelp: $('replace-import-help').textContent }
  function resetImport() {
    state.pending = []; state.pendingFiles = []; state.pendingTrash = []; state.pendingCloud = null; state.linkCandidates = []
    $('import-files').value = ''; $('import-folder').value = ''
    $('import-type').value = 'knowledge'; $('import-type').disabled = false
    $('replace-import').checked = true; $('replace-import').disabled = false
    $('import-preview').innerHTML = importDefaults.preview
    $('import-type-help').textContent = importDefaults.typeHelp
    $('replace-import-help').textContent = importDefaults.replaceHelp
    $('confirm-import').disabled = true
  }
  async function prepareImport(files) {
    state.pendingFiles = []; state.pending = []; $('confirm-import').disabled = true; $('import-preview').textContent = '正在讀取並檢查…'
    try {
      if (files.length > 1500) throw Error('檔案數超過 1500，請拆分。')
      let bytes = 0
      for (const f of files) {
        bytes += f.size
        if (bytes > 50 * 1024 * 1024) throw Error('匯入總量超過 50 MB，請拆分。')
        if (/\.zip$/i.test(f.name)) state.pendingFiles.push(...await window.HandbookArchive.unzip(await f.arrayBuffer()))
        else {
          if (f.size > (/^(?:匯出說明(?:-\d+)?\.md|.+\.json)$/i.test(f.name) ? 50 : 10) * 1024 * 1024) throw Error('單檔超過匯入上限。')
          const name = archivePath(f.webkitRelativePath || f.name)
          state.pendingFiles.push(typeof f.arrayBuffer === 'function' ? window.HandbookArchive.readFile(name, new Uint8Array(await f.arrayBuffer())) : { name, content: await f.text() })
        }
      }
      refreshImport()
    } catch (e) { state.pending = []; state.pendingFiles = []; $('import-preview').textContent = `匯入失敗：${e.message}` }
  }
  function refreshImport() {
    const jsonFiles = state.pendingFiles.filter(f => /\.json$/i.test(f.name) && !f.encoding), validBackups = [], errors = []
    let backupFound = false
    state.pendingTrash = []
    state.pendingCloud = null
    let manifest = { excluded: new Set(), relations: [], metadata: [] }
    try { manifest = relationManifest(state.pendingFiles) } catch (e) { state.pending = []; $('confirm-import').disabled = true; $('import-preview').textContent = `匯出包資料不合法：${e.message}`; return }
    for (const f of jsonFiles) {
      let data
      try { data = JSON.parse(f.content.replace(/^\uFEFF/, '')) } catch { continue }
      if (data?.schema === 'ai-handbook-cloud/v1') {
        try {
          state.pendingCloud = validateCloudLibrary(data); state.pending = []
          $('import-preview').innerHTML = `<strong>私人雲端資料備份</strong><p>將合併還原兩個主分頁：${['slot', 'stocks'].map(name => `${domains[name]} ${state.pendingCloud.personal.filter(item => item.domain === name).length} 筆`).join('、')}；包含附件、版本及回收桶。</p>`
          $('confirm-import').disabled = false; $('import-type').disabled = true; $('replace-import').disabled = false
        } catch (e) { state.pendingCloud = null; $('confirm-import').disabled = true; $('import-preview').textContent = `雲端備份不合法：${e.message}` }
        return
      }
      if (data?.schema === 'slot-handbook/v1') {
        try { validBackups.push(...validateItems(data)); state.pendingTrash.push(...validateTrash(data.trash || [])); backupFound = true }
        catch (e) { state.pending = []; $('confirm-import').disabled = true; $('import-preview').textContent = `備份不合法：${f.name}：${e.message}`; return }
      }
    }
    state.pendingTrash.push(...(manifest.trash || []))
    const recordedPaths = new Set(manifest.relations.map(entry => entry.path))
    let rows = backupFound ? validBackups : state.pendingFiles.filter(f => /\.(md|mdc|txt)$/i.test(f.name) && !f.encoding && !manifest.excluded.has(f) && (!recordedPaths.size || recordedPaths.has(f.name))).map(f => importItem(f, $('import-type').value))
    if (!backupFound && manifest.metadata.length) {
      try {
        rows = manifest.metadata.map(entry => {
          const source = state.pendingFiles.find(f => f.name === entry.path)
          if (!source || (source.encoding && !entry.item.fileOnly)) throw Error(`缺少文件：${entry.path}`)
          const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : ''
          const attachments = entry.attachments.map(name => {
            const file = state.pendingFiles.find(f => f.name === folder + name)
            if (!file) throw Error(`缺少附件：${folder + name}`)
            return { ...file, name }
          })
          return validateItems({ schema: 'slot-handbook/v1', items: [{ ...entry.item, content: entry.item.fileOnly ? entry.item.content : source.content, rawFile: entry.item.fileOnly ? source : undefined, attachments, sources: entry.item.sources?.length ? entry.item.sources : [entry.path] }] })[0]
        })
      } catch (e) { state.pending = []; $('confirm-import').disabled = true; $('import-preview').textContent = `無法完整還原：${e.message}`; return }
    }
    if (!backupFound && !manifest.metadata.length) for (const i of rows.filter(i => i.type === 'skill')) {
      const p = i.sources[0], folder = p.replace(/SKILL\.md$/i, '')
      i.attachments = state.pendingFiles.filter(f => f.name.startsWith(folder) && f.name !== p && !manifest.excluded.has(f)).map(f => ({ ...f, name: f.name.slice(folder.length) }))
      const sidecar = i.attachments.find(f => f.name === '操作指南.json')
      if (sidecar) try {
        const g = JSON.parse(sidecar.content), verified = validateItems({ schema: 'slot-handbook/v1', items: [{ ...i, ...g }] })[0]
        i.fields = verified.fields; i.steps = verified.steps; i.outputs = verified.outputs; i.checks = verified.checks
      } catch { errors.push(`${p}：操作指南 JSON 不合法，僅匯入文件全文。`) }
    }
    if (!backupFound && !manifest.metadata.length) {
      const owned = new Set(rows.map(i => i.sources[0]))
      for (const item of rows) {
        const path = item.sources[0], folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
        for (const file of item.attachments || []) owned.add(folder + file.name)
      }
      for (const file of state.pendingFiles.filter(f => !owned.has(f.name) && !manifest.excluded.has(f))) {
        const owners = rows.filter(item => !item.rawFile && file.name.startsWith(item.sources[0].slice(0, Math.max(0, item.sources[0].lastIndexOf('/') + 1)))).sort((a, b) => b.sources[0].lastIndexOf('/') - a.sources[0].lastIndexOf('/'))
        const owner = owners[0]
        if (owner) {
          const folder = owner.sources[0].slice(0, Math.max(0, owner.sources[0].lastIndexOf('/') + 1))
          owner.attachments = [...(owner.attachments || []), { ...file, name: file.name.slice(folder.length) }]
        } else rows.push({ ...importItem({ name: file.name, content: `# ${file.name.split('/').pop()}\n\n原始附件，請下載查看。` }, 'knowledge'), fileOnly: true, rawFile: file })
        owned.add(file.name)
      }
    }
    state.pending = normalizeImportRows(rows)
    const canonical = new Map([...allItems(), ...state.pending].map(item => [importKey(item), item]))
    const byPath = new Map([...allItems(), ...rows].flatMap(item => (item.sources || []).map(path => [path.replaceAll('\\', '/'), canonical.get(importKey(item))])))
    for (const entry of manifest.relations) {
      const item = byPath.get(entry.path)
      if (!item || !state.pending.includes(item)) continue
      item.relatedIds = [...new Set([...(item.relatedIds || []), ...entry.related.map(path => byPath.get(path)?.id).filter(Boolean)])]
    }
    linkImported(state.pending)
    state.linkCandidates = [...new Map([...allItems(), ...state.pending].map(i => [i.id, i])).values()]
    const collisions = state.pending.filter(i => state.personal.some(p => p.domain === state.domain && p.id === i.id)).length
    const hasGeneralFiles = !backupFound && state.pendingFiles.some(f => /\.(md|txt)$/i.test(f.name) && !manifest.excluded.has(f) && !f.encoding && !classifyImport(f).automatic && !manifest.metadata.length && (!recordedPaths.size || recordedPaths.has(f.name)))
    $('import-type').disabled = !hasGeneralFiles
    $('import-type-help').textContent = hasGeneralFiles ? '只套用到缺少明確分類依據的文件；已辨識的文件會顯示分類原因。切換後可在下方預覽確認分類。' : '目前文件已自動分類，或分類由備份決定，因此不需要選擇一般文件類型。'
    $('replace-import').disabled = !collisions
    $('replace-import-help').textContent = collisions ? `有 ${collisions} 筆與目前分頁的既有資料重複。預設更新內容、原始匯出路徑與附件，並保留既有關聯；不勾選則跳過。技能依技能名稱與類型，其餘依檔名與類型判斷，不比較目錄。` : '目前沒有重複資料。技能依技能名稱與類型，其餘依檔名與類型判斷，不比較目錄；同批重複文件以最後讀取的內容為準。'
    const skipped = state.pendingFiles.filter(f => /\.json$/i.test(f.name)).length - (backupFound ? 1 : 0)
    $('import-preview').innerHTML = `<strong>${state.pending.length} 筆可匯入 · ${collisions} 筆重複資料</strong>${backupFound ? '<p class="muted">偵測到完整備份，優先使用備份；包內 Markdown 不重複匯入。</p>' : skipped > 0 ? `<p class="muted">${skipped} 個一般 JSON 會當作附件保存；工作台備份則用於還原結構資料。</p>` : ''}${errors.map(e => `<p class="danger">${escape(e)}</p>`).join('')}${state.pending.map((i, n) => {
      const choices = state.linkCandidates.map((other, k) => ({ other, k })).filter(({ other }) => other.id !== i.id && ['skill', 'knowledge', 'rule'].includes(other.type))
      return `<div class="import-item"><span class="tag">${singular[i.type]}</span> ${escape(i.title)}<br><span class="muted">${escape(i.sources?.[0] || i.name)}</span><p class="muted">分類檢查：${escape(i.classificationReason || (i.fileOnly ? '原始附件，歸入知識庫供下載' : '沿用完整備份／匯出包保存的資料類型'))}</p>${choices.length ? `<details><summary>建立相關連結（已選 <span data-link-count="${n}">${(i.relatedIds || []).length}</span> 筆）</summary><div class="import-links">${choices.map(({ other, k }) => `<label><input type="checkbox" data-link-owner="${n}" data-link-target="${k}" ${(i.relatedIds || []).includes(other.id) ? 'checked' : ''}> ${escape(other.title)} <small>(${singular[other.type]})</small></label>`).join('')}</div></details>` : '<p class="muted">目前沒有可連結的其他資料；之後匯入時可再建立連結。</p>'}</div>`
    }).join('')}${!state.pending.length ? '<p>目前是空白資料庫；請選擇技能、規則或知識庫文件開始匯入。</p>' : '<p class="muted">勾選要建立的相關連結後，再按「合併匯入」。匯入內容只當作文字資料，不會執行腳本。</p>'}`
    $('confirm-import').disabled = !state.pending.length && !state.pendingTrash.length
    if (state.pendingTrash.length) $('import-preview').innerHTML += `<p>另有 ${state.pendingTrash.length} 批回收桶資料可還原。</p>`
    const attachmentCount = state.pending.reduce((n, item) => n + (item.attachments?.length || 0) + (item.rawFile ? 1 : 0), 0)
    $('import-preview').innerHTML += `<p class="muted">已保存 ${attachmentCount} 份附件／原始檔案。非文字附件可下載查看；單檔上限 10 MB、匯入總量 50 MB。</p>`
  }
  $('import-preview').addEventListener('change', e => {
    const box = e.target
    if (!box.matches('input[data-link-owner]')) return
    const item = state.pending[Number(box.dataset.linkOwner)], target = state.linkCandidates[Number(box.dataset.linkTarget)]
    if (!item || !target || item.id === target.id) return
    const ids = new Set(item.relatedIds || [])
    if (box.checked) ids.add(target.id)
    else ids.delete(target.id)
    item.relatedIds = [...ids]
    const count = $('import-preview').querySelector(`[data-link-count="${box.dataset.linkOwner}"]`)
    if (count) count.textContent = item.relatedIds.length
  })
  function jump(id) { const i = allItems().find(x => x.id === id); if (!i) return; state.mode = 'browse'; state.type = 'all'; state.category = ''; state.query = ''; $('search').value = ''; $('conflict-only').checked = false; state.selected = id; state.tab = i.type === 'skill' ? 'guide' : 'content'; render(); if (innerWidth < 850) $('detail').scrollIntoView({ behavior: 'smooth' }) }
  document.addEventListener('click', e => {
    const t = e.target.closest('button')
    if (!t) return
    if (t.dataset.type) { state.type = t.dataset.type; state.mode = 'browse'; state.category = ''; state.tab = 'guide'; render() }
    if (t.dataset.select) { const i = allItems().find(x => x.id === t.dataset.select); state.selected = i.id; state.mode = ['mine', 'stars'].includes(state.mode) ? state.mode : 'browse'; state.tab = i.type === 'skill' ? 'guide' : 'content'; render(); if (innerWidth < 850) $('detail').scrollIntoView({ behavior: 'smooth' }) }
    if (t.dataset.tab) { state.tab = t.dataset.tab; renderDetail() }
    if (t.dataset.close) $(t.dataset.close).close()
    if (t.dataset.jump) jump(t.dataset.jump)
    if (t.dataset.copyPath) copy(t.dataset.copyPath)
  })
  $('domain-nav').addEventListener('click', e => {
    const button = e.target.closest('[data-domain]')
    if (button) switchDomain(button.dataset.domain)
  })
  $('search').oninput = e => { state.query = e.target.value; if (['audit', 'guide'].includes(state.mode)) state.mode = 'browse'; render() }
  $('category').onchange = e => { state.category = e.target.value; if (['audit', 'guide'].includes(state.mode)) state.mode = 'browse'; render() }
  $('conflict-only').onchange = render
  $('guide-btn').onclick = () => { state.mode = 'guide'; render() }
  $('edit-type').onchange = e => { if (!$('edit-name').value) $('edit-category').value = `自訂${singular[e.target.value]}` }
  $('import-btn').onclick = () => { resetImport(); $('import-target').textContent = domains[state.domain]; $('importer').showModal() }
  $('import-files').onchange = e => prepareImport([...e.target.files])
  $('import-folder').onchange = e => prepareImport([...e.target.files])
  $('import-type').onchange = () => { if (state.pendingFiles.length) refreshImport() }
  $('confirm-import').onclick = async () => {
    let added = 0, updated = 0, skipped = 0
    if (state.pendingCloud) {
      for (const item of state.pendingCloud.personal) {
        const n = state.personal.findIndex(current => current.domain === item.domain && current.id === item.id)
        if (n >= 0 && !$('replace-import').checked) { skipped++; continue }
        if (n >= 0) { state.personal[n] = withVersion(state.personal[n], item, '雲端備份還原前'); updated++ }
        else { state.personal.push(item); added++ }
      }
      for (const batch of state.pendingCloud.trash) if (!state.trash.some(old => old.domain === batch.domain && old.at === batch.at)) state.trash.push(batch)
      state.stars = [...new Set([...state.stars, ...state.pendingCloud.stars])]
    }
    for (const i of state.pending) {
      const n = state.personal.findIndex(p => p.domain === state.domain && p.id === i.id)
      if (n >= 0 && !$('replace-import').checked) { skipped++; continue }
      if (n >= 0) { state.personal[n] = withVersion(state.personal[n], i, '匯入更新前'); updated++ } else { state.personal.push(i); added++ }
    }
    for (const batch of state.pendingTrash || []) if (!state.trash.some(old => old.domain === state.domain && old.at === batch.at)) state.trash.push(batch)
    const stored = await save()
    if (!stored) return
    const selected = state.pending[0]?.id
    resetImport(); $('importer').close(); state.mode = 'mine'; state.type = 'all'; state.category = ''; state.query = ''; $('search').value = ''; $('conflict-only').checked = false; state.selected = selected; render(); toast(`已新增 ${added} 筆、更新 ${updated} 筆、跳過 ${skipped} 筆。`)
  }
  $('export-btn').onclick = () => { $('export-target').textContent = domains[state.domain]; $('export-count').textContent = `將匯出 ${selectedExport().length} 筆${domains[state.domain]}資料。`; $('exporter').showModal() }
  $('export-scope').onchange = () => $('export-count').textContent = `將匯出 ${selectedExport().length} 筆${domains[state.domain]}資料。`
  $('export-json').onclick = () => exportData(selectedExport(), 'json', $('export-scope').value === 'all')
  $('export-complete').onclick = () => download(`完整資料庫搬移備份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(cloudLibrary(), null, 2), 'application/json')
  $('export-zip').onclick = () => exportData(selectedExport(), 'zip', $('export-scope').value === 'all')
  $('trash-btn').onclick = () => {
    const batches = state.trash.filter(batch => batch.domain === state.domain)
    $('trash-list').innerHTML = batches.length ? batches.map((batch, n) => `<div class="import-item"><strong>${escape(new Date(batch.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }))}</strong><p>${batch.items.map(item => escape(item.title)).join('、')}</p><button data-trash-restore="${n}">還原這批資料</button></div>`).join('') : '<p>目前分頁的回收桶是空的。</p>'
    $('trash-list').querySelectorAll('[data-trash-restore]').forEach(button => { button.onclick = async () => {
      const batch = batches[Number(button.dataset.trashRestore)]
      if (batch.items.some(item => allItems().some(current => current.id === item.id || importKey(current) === importKey(item)))) return toast('有同名資料存在，請先匯出並移除現有資料，再還原這批資料。')
      state.personal.push(...batch.items); state.trash = state.trash.filter(entry => entry !== batch)
      const restoredIds = new Set(batch.items.map(item => item.id))
      for (const link of batch.links || []) {
        const item = state.personal.find(i => i.domain === state.domain && i.id === link.id)
        if (item) item.relatedIds = [...new Set([...(item.relatedIds || []), ...link.relatedIds.filter(id => restoredIds.has(id))])]
      }
      const stored = await save(); $('trash-dialog').close(); render(); if (stored) toast('已還原刪除的資料與關聯。')
    } })
    $('trash-dialog').showModal()
  }
  document.addEventListener('keydown', e => { if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { e.preventDefault(); $('search').focus() } })
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close() } }))
  render()
  if (window.HandbookStorage.fileBacked || typeof indexedDB !== 'undefined') {
    $('import-btn').disabled = true; $('export-btn').disabled = true; $('trash-btn').disabled = true
    window.HandbookReady = (async () => {
      try {
        const stored = await window.HandbookStorage.read()
        if (stored) { state.personal = stored.personal; state.stars = stored.stars || []; state.trash = stored.trash || []; state.cloudMeta = stored.cloudMeta || {} }
        else await window.HandbookStorage.write({ personal: state.personal, stars: state.stars, trash: [] })
        durableStorage = true; storageLoading = false
        if (!window.HandbookStorage.fileBacked) try { localStorage.removeItem(storageKey); localStorage.removeItem(favoriteKey) } catch {}
        render()
        await connectCloud()
      } catch (error) { toast(`資料庫開啟失敗：${error.message}`); $('detail').innerHTML = `<p>資料庫開啟失敗：${escape(error.message)}</p><p>若要儲存至專案 data 資料夾，請執行 start.ps1，再開啟 http://127.0.0.1:8765。</p>`; $('results').innerHTML = '' }
    })()
  }
  if (storageFailed) toast('無法載入瀏覽器個人資料；可匯入之前的 JSON 備份。')
  // Pure helpers exposed for meaningful data/round-trip verification.
  window.HandbookCheck = { validateItems, classifyImport, importItem, linkImported, importKey, normalizeImportRows, withVersion, exportWithRelated, originalZipFiles, relationManifest, markdown, backup, filtered, allItems, selectedExport }
})()






