const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mergeLibraries, normalizeImportRows } = require('../library-merge.js')
const at = '2026-10-19T00:00:00.000Z'
const library = personal => ({ schema: 'ai-handbook-cloud/v1', personal, stars: [], trash: [] })
function item(id, source, extra = {}) { return { id, domain: 'slot', type: 'knowledge', name: source.split('/').pop(), title: 'Document', content: 'content', sources: [source], ...extra } }

test('import maps renamed IDs to existing records while preserving new content and links', () => {
  const existing = item('canonical', 'pkg/doc.md', { mergedIds: ['retired'], relatedIds: ['keep'] })
  const rows = normalizeImportRows([item('retired', 'different-root/pkg/doc.md', { content: 'updated' }), item('ref', 'other/doc.md', { relatedIds: ['retired'] })], [existing])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'canonical')
  assert.equal(rows[0].content, 'updated')
  assert.deepEqual(rows[0].relatedIds, ['keep'])
  assert.deepEqual(rows[1].relatedIds, ['canonical'])
})

test('full backup import normalizes both domains and keeps different same-named files', () => {
  const existing = [item('slot-old', 'pkg/RULES.md'), item('stocks-old', 'pkg/RULES.md', { domain: 'stocks' })]
  const rows = normalizeImportRows([item('slot-new', '.claude/skills/pkg/RULES.md'), item('stocks-new', 'skills/pkg/RULES.md', { domain: 'stocks' }), item('different', 'other/RULES.md')], existing)
  assert.deepEqual(rows.map(row => row.id), ['slot-old', 'stocks-old', 'different'])
})

test('same document with wrapper directory or classification change merges once', () => {
  const old = item('old', 'pkg/references/rules.md')
  const fresh = item('new', '.claude/skills/pkg/references/rules.md', { type: 'rule', updatedAt: at })
  const result = mergeLibraries(library([old]), library([fresh]), { at }).library
  assert.equal(result.personal.length, 1)
  assert.equal(result.personal[0].id, 'old')
  assert.equal(result.personal[0].type, 'rule')
  assert.ok(result.personal[0].mergedIds.includes('new'))
  assert.deepEqual(mergeLibraries(result, library([fresh]), { at: '2099-01-01T00:00:00.000Z' }).library, result)
})

test('same skill name merges across different import folder roots', () => {
  const old = item('old', 'pkg/SKILL.md', { type: 'skill', name: 'pkg' })
  const fresh = item('new', 'folder/.claude/skills/pkg/SKILL.md', { type: 'skill', name: 'pkg', content: 'new content', updatedAt: at })
  const result = mergeLibraries(library([old]), library([fresh]), { at }).library
  assert.equal(result.personal.length, 1)
  assert.equal(result.personal[0].content, 'new content')
  assert.ok(result.personal[0].history.some(entry => entry.snapshot.content === 'content'))
})

test('same basenames from different skills and different domains remain distinct', () => {
  const rows = [item('one', 'pkg/RULES.md'), item('two', 'other/RULES.md'), item('three', 'pkg/RULES.md', { domain: 'stocks' }), item('four', 'pkg/references/pitfalls.md'), item('five', 'other/references/pitfalls.md')]
  assert.equal(mergeLibraries(library(rows), {}, { at }).library.personal.length, 5)
})

test('relationships and favorites follow canonical IDs after deduplication', () => {
  const current = library([item('one', 'pkg/doc.md'), item('two', 'skills/pkg/doc.md'), item('ref', 'other/ref.md', { relatedIds: ['two', 'one'] })])
  current.stars = ['slot:two', 'slot:one', 'two']
  current.trash = [{ at, domain: 'slot', items: [item('deleted', 'old/deleted.md', { relatedIds: ['two'] })], links: [{ id: 'two', relatedIds: ['ref'] }] }]
  const result = mergeLibraries(current, {}, { at }).library
  assert.equal(result.personal.length, 2)
  assert.deepEqual(result.personal.find(row => row.id === 'ref').relatedIds, ['one'])
  assert.deepEqual(result.stars, ['slot:one', 'one'])
  assert.equal(result.trash[0].links[0].id, 'one')
  assert.deepEqual(result.trash[0].items[0].relatedIds, ['one'])
})

test('different attachment payloads and historical versions survive repeated migration', () => {
  const old = item('old', 'pkg/doc.md', { attachments: [{ name: 'a.txt', content: 'older bytes' }], history: [{ revisionId: 'h1', at, reason: 'before', snapshot: item('old', 'pkg/doc.md', { content: 'original' }) }] })
  const fresh = item('new', '.agents/skills/pkg/doc.md', { updatedAt: at, content: 'fresh', attachments: [{ name: 'a.txt', content: 'new bytes' }] })
  const first = mergeLibraries(library([old]), library([fresh]), { at }).library
  assert.equal(first.personal[0].attachments.length, 2)
  assert.ok(first.personal[0].history.some(entry => entry.revisionId === 'h1'))
  assert.ok(first.personal[0].history.some(entry => entry.snapshot.content === 'content'))
  const again = mergeLibraries(first, library([old, fresh]), { at: '2099-01-01T00:00:00.000Z' }).library
  assert.deepEqual(again, first)
})

test('a bridge row merges every existing duplicate group and rewrites their aliases', () => {
  const a = item('a', 'pkg/a.md'), b = item('b', 'pkg/b.md')
  const bridge = item('bridge', 'pkg/a.md', { sources: ['pkg/a.md', 'pkg/b.md'] })
  const result = mergeLibraries(library([a, b]), library([bridge]), { at }).library
  assert.equal(result.personal.length, 1)
  assert.deepEqual(result.personal[0].mergedIds, ['b', 'bridge'])
})
