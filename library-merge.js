// Shared by the migration button, import pipeline, and repair/test scripts.
;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.HandbookMerge = api
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const copy = value => JSON.parse(JSON.stringify(value))
  const domainOf = item => item.domain === 'stocks' ? 'stocks' : 'slot'
  const normalize = value => String(value || '').normalize('NFC').trim().toLowerCase()
  function sourceKey(path) {
    return normalize(path).replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/^(?:\.(?:claude|agents|codex)\/)?skills\//, '')
  }
  function itemKey(item) {
    const scope = domainOf(item)
    if (item.type === 'skill') return `${scope}:skill:${normalize(item.name) || item.id}`
    const source = item.sources?.find(path => path && !path.replaceAll('\\', '/').startsWith('個人資料/'))
    return source ? `${scope}:${item.type === 'pattern' ? 'pattern' : 'document'}:${sourceKey(source)}` : `${scope}:id:${item.id}`
  }
  function keys(item) {
    const scope = domainOf(item)
    const result = [itemKey(item), ...[item.id, ...(item.mergedIds || [])].map(id => `${scope}:id:${id}`)]
    if (item.type !== 'skill') for (const path of item.sources || []) {
      if (path && !path.replaceAll('\\', '/').startsWith('個人資料/')) result.push(`${scope}:${item.type === 'pattern' ? 'pattern' : 'document'}:${sourceKey(path)}`)
    }
    return [...new Set(result)]
  }
  function normalizeImportRows(rows, existing = []) {
    const known = new Map(existing.flatMap(item => keys(item).map(key => [key, item])))
    const chosen = new Map(), aliases = new Map()
    for (const row of rows) {
      const previous = keys(row).map(key => known.get(key)).find(Boolean)
      const id = previous?.id || row.id, domain = domainOf(row)
      const mergedIds = [...new Set([...(previous?.mergedIds || []), ...(row.mergedIds || []), row.id])].filter(value => value !== id)
      const next = { ...copy(row), domain, id, mergedIds, relatedIds: [...new Set([...(previous?.relatedIds || []), ...(row.relatedIds || [])])] }
      for (const alias of [id, ...mergedIds]) aliases.set(`${domain}:${alias}`, id)
      for (const key of [...keys(previous || next), ...keys(next)]) known.set(key, next)
      chosen.set(`${domain}:${id}`, next)
    }
    return [...chosen.values()].map(item => ({ ...item, relatedIds: [...new Set(item.relatedIds.map(id => aliases.get(`${item.domain}:${id}`) || id))].filter(id => id !== item.id) }))
  }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
    return JSON.stringify(value)
  }
  function signature(item) {
    const { id, domain, history, updatedAt, personal, origin, sources, mergedIds, relatedIds, ...body } = item
    return stable(Object.fromEntries(Object.entries(body).filter(([, value]) => !(Array.isArray(value) && value.length === 0))))
  }
  function unique(values, key = stable) {
    const seen = new Set()
    return values.filter(value => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true })
  }
  function represents(main, other) {
    const { attachments: mainFiles, sourceVariants: mainVariants, ...mainBody } = main
    const { attachments: otherFiles, sourceVariants: otherVariants, ...otherBody } = other
    return signature(mainBody) === signature(otherBody) && (otherFiles || []).every(file => (mainFiles || []).some(saved => saved.content === file.content && saved.encoding === file.encoding)) && (otherVariants || []).every(variant => (mainVariants || []).some(saved => stable(saved) === stable(variant)))
  }
  function combine(existing, incoming, at) {
    const newer = (incoming.updatedAt || '') > (existing.updatedAt || '')
    const winner = newer ? incoming : existing, other = newer ? existing : incoming
    const result = { ...winner, id: existing.id, domain: domainOf(existing), personal: true }
    result.sources = unique([...(winner.sources || []), ...(other.sources || [])], sourceKey)
    result.mergedIds = [...new Set([...(existing.mergedIds || []), ...(incoming.mergedIds || []), existing.id, incoming.id])].filter(id => id !== result.id).sort()
    result.relatedIds = [...new Set([...(existing.relatedIds || []), ...(incoming.relatedIds || [])])]
    const history = unique([...(existing.history || []), ...(incoming.history || [])], entry => entry.revisionId || stable(entry))
    if (!represents(winner, other) && !history.some(entry => represents(entry.snapshot, other))) {
      const { history: ignored, ...snapshot } = other
      history.push({ at: other.updatedAt || at, reason: '合併重複資料前保留的版本', snapshot: copy(snapshot) })
    }
    result.history = history.sort((a, b) => a.at.localeCompare(b.at)).slice(-20)
    // Keep every attachment payload. Rename older files only on a name collision.
    const attachments = copy(winner.attachments || [])
    for (const attachment of other.attachments || []) {
      if (attachments.some(file => sourceKey(file.name) === sourceKey(attachment.name) && file.content === attachment.content && file.encoding === attachment.encoding)) continue
      const next = copy(attachment)
      if (attachments.some(file => sourceKey(file.name) === sourceKey(next.name))) {
        let n = 1
        const dot = next.name.lastIndexOf('.'), split = dot > next.name.lastIndexOf('/') ? dot : next.name.length
        do { next.name = `${attachment.name.slice(0, split)}.保留版本-${n++}${attachment.name.slice(split)}` } while (attachments.some(file => sourceKey(file.name) === sourceKey(next.name)))
      }
      // A previously renamed copy counts as already preserved on repeated migration.
      if (!attachments.some(file => file.content === next.content && file.encoding === next.encoding && (file.name === next.name || file.name.startsWith(attachment.name.slice(0, attachment.name.lastIndexOf('.') > 0 ? attachment.name.lastIndexOf('.') : attachment.name.length) + '.保留版本-')))) attachments.push(next)
    }
    result.attachments = attachments
    result.sourceVariants = unique([...(winner.sourceVariants || []), ...(other.sourceVariants || [])])
    return result
  }
  function mergeLibraries(current, incoming = {}, options = {}) {
    const result = copy(current), at = options.at || new Date().toISOString()
    const groups = [], byKey = new Map()
    let removed = 0
    for (const raw of [...(current.personal || []), ...(incoming.personal || [])]) {
      let item = { ...copy(raw), domain: domainOf(raw), personal: true, attachments: copy(raw.attachments || []), sourceVariants: copy(raw.sourceVariants || []), history: copy(raw.history || []), mergedIds: [...(raw.mergedIds || [])], relatedIds: [...(raw.relatedIds || [])], sources: [...(raw.sources || [])] }
      const matches = [...new Set(keys(item).map(key => byKey.get(key)).filter(group => group && !group.removed))]
      let group = matches[0]
      if (!group) { group = { item, keys: new Set(), removed: false }; groups.push(group) }
      else {
        for (const other of matches.slice(1)) {
          group.item = combine(group.item, other.item, at); other.removed = true; removed++
          for (const key of other.keys) { group.keys.add(key); byKey.set(key, group) }
        }
        group.item = combine(group.item, item, at); removed++
      }
      for (const key of [...keys(item), ...keys(group.item)]) { group.keys.add(key); byKey.set(key, group) }
    }
    const aliases = new Map()
    result.personal = groups.filter(group => !group.removed).map(group => group.item)
    for (const item of result.personal) for (const id of [item.id, ...(item.mergedIds || [])]) aliases.set(`${item.domain}:${id}`, item.id)
    const resolve = (domain, id) => aliases.get(`${domain}:${id}`) || id
    const rewrite = (item, domain) => ({ ...item, relatedIds: [...new Set((item.relatedIds || []).map(id => resolve(domain, id)))].filter(id => id !== item.id) })
    result.personal = result.personal.map(item => rewrite(item, item.domain))
    result.stars = [...new Set([...(current.stars || []), ...(incoming.stars || [])].map(star => {
      const match = star.match(/^(slot|stocks):(.*)$/)
      return match ? `${match[1]}:${resolve(match[1], match[2])}` : resolve('slot', star)
    }))]
    result.trash = unique([...(current.trash || []), ...(incoming.trash || [])]).map(batch => {
      const domain = domainOf(batch)
      return { ...batch, domain, items: (batch.items || []).map(item => rewrite(item, domain)), links: (batch.links || []).map(link => ({ ...link, id: resolve(domain, link.id), relatedIds: [...new Set((link.relatedIds || []).map(id => resolve(domain, id)))] })) }
    })
    return { library: result, removed, aliases }
  }
  return { sourceKey, itemKey, normalizeImportRows, mergeLibraries }
})
