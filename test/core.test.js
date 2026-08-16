import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeInstall, assertPublicHttpsUrl, CatalogService, classifyPlugin, atomicWriteJson, compareVersions, extractRepositoriesFromHtml, manifestIconUrl, normalizeCatalogItem, normalizeRepositoryUrl, safeIconUrl, PluginHealthService, ProfileInspector, SourceStore, stableHash } from '../lib/core.js'

test('normalizes GitHub repository, tree and git URLs', () => {
  assert.deepEqual(normalizeRepositoryUrl('https://github.com/acme/plugin'), { kind: 'github', owner: 'acme', repo: 'plugin', repositoryUrl: 'https://github.com/acme/plugin', installSpec: 'github:acme/plugin' })
  assert.equal(normalizeRepositoryUrl('https://github.com/acme/plugin/tree/main').installSpec, 'github:acme/plugin#main')
  assert.equal(normalizeRepositoryUrl('git+https://github.com/acme/plugin.git').repositoryUrl, 'https://github.com/acme/plugin')
})

test('normalizes npm package URLs including scoped packages', () => {
  assert.equal(normalizeRepositoryUrl('https://www.npmjs.com/package/%40acme%2Fdsh-plugin').installSpec, '@acme/dsh-plugin')
  assert.equal(normalizeRepositoryUrl('https://registry.npmjs.org/example').installSpec, 'example')
})

test('rejects unsafe and unsupported URLs', () => {
  for (const url of ['http://github.com/a/b', 'file:///tmp/plugin', 'https://127.0.0.1/plugin', 'javascript:alert(1)']) assert.throws(() => normalizeRepositoryUrl(url))
})

test('extracts and deduplicates repositories from webpage sources', () => {
  const html = '<a href="/zh/plugins/acme/one">one</a><a href="https://github.com/acme/two">two</a><a href="https://github.com/topics/dsh-plugin">topic</a><a href="/plugins/acme/one">duplicate</a>'
  assert.deepEqual(extractRepositoriesFromHtml(html, 'https://catalog.example/zh').map((item) => item.full_name), ['acme/two', 'acme/one'])
})

test('classifies plugins with scored multi-label evidence', () => {
  const classified = classifyPlugin({ name: 'browser-agent', description: 'Playwright browser automation with Feishu integration', topics: ['automation', 'lark'] })
  assert.equal(classified.primary.id, 'browser'); assert.deepEqual(classified.categories.map((item) => item.id), ['browser', 'integration', 'agent'])
  assert.equal(classifyPlugin({ name: 'opaque-package' }).primary.id, 'other')
})

test('normalizes publicly discovered webpage registries', async () => {
  const { CatalogService } = await import('../lib/core.js'); const service = new CatalogService('/tmp/dpm-web-registry-test', null)
  const rows = service.webRegistryItems({ plugins: [{ owner: 'acme', repo: 'plugin', name: 'plugin', descriptionZh: '中文描述', tags: ['browser'], stars: 7, updatedAt: '2026-01-02T00:00:00Z' }] }, { id: 'web', url: 'https://market.example/' })
  assert.equal(rows.length, 1); assert.equal(rows[0].repositoryUrl, 'https://github.com/acme/plugin'); assert.equal(rows[0].descriptionZh, '中文描述'); assert.equal(rows[0].stars, 7); assert.deepEqual(rows[0].topics, ['browser'])
})

test('merges curated metadata with live catalog entries by repository', async () => {
  const { CatalogService } = await import('../lib/core.js')
  const service = new CatalogService('/tmp/dpm-merge-test', null)
  const curated = normalizeCatalogItem({ name: 'plugin', full_name: 'acme/plugin', html_url: 'https://github.com/acme/plugin', packageName: 'acme-plugin', descriptionZh: '精选中文简介', sourceType: 'curated', curatedCategory: 'ui', distribution: 'npm' }, 'curated-awesome-dsh-plugin')
  const live = normalizeCatalogItem({ name: 'plugin', full_name: 'acme/plugin', html_url: 'https://github.com/acme/plugin', description: 'live description', stargazers_count: 9 }, 'github-dsh-plugin')
  const merged = service.mergeCatalogItems([curated, live])[0]
  assert.equal(merged.packageName, 'acme-plugin'); assert.equal(merged.descriptionZh, '精选中文简介'); assert.equal(merged.stars, 9); assert.deepEqual(merged.sources, ['curated-awesome-dsh-plugin', 'github-dsh-plugin'])
})

test('merges catalog records that resolve to the same npm package', async () => {
  const service = new CatalogService('/tmp/dpm-package-merge-test', null)
  const primary = normalizeCatalogItem({ name: 'plugin-a', full_name: 'acme/plugin-a', html_url: 'https://github.com/acme/plugin-a', packageName: '@acme/plugin', descriptionZh: '中文简介', stargazers_count: 3 }, 'curated-awesome-dsh-plugin')
  const mirror = normalizeCatalogItem({ name: 'plugin-mirror', full_name: 'mirror/plugin', html_url: 'https://github.com/mirror/plugin', packageName: '@acme/plugin', description: 'mirror description', stargazers_count: 9 }, 'github-dsh-plugin')
  const merged = service.mergeCatalogItems([primary, mirror])
  assert.equal(merged.length, 1); assert.equal(merged[0].packageName, '@acme/plugin'); assert.equal(merged[0].descriptionZh, '中文简介'); assert.equal(merged[0].stars, 9); assert.deepEqual(merged[0].sources.sort(), ['curated-awesome-dsh-plugin', 'github-dsh-plugin'])
})

test('official Topic catalog loads GitHub API pages up to the bounded limit', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    const parsed = new URL(url); const page = Number(parsed.searchParams.get('page')); requested.push({ page, perPage: parsed.searchParams.get('per_page') })
    const total_count = 250; const start = (page - 1) * 100
    return { ok: true, json: async () => ({ total_count, items: Array.from({ length: Math.max(0, Math.min(100, total_count - start)) }, (_, index) => ({ name: `plugin-${start + index}`, full_name: `acme/plugin-${start + index}`, html_url: `https://github.com/acme/plugin-${start + index}`, stargazers_count: start + index })) }) }
  }
  const service = new CatalogService(await mkdtemp(join(tmpdir(), 'dpm-topic-')), null, fetchImpl)
  const result = await service.officialTopicCatalog('', 'stars')
  assert.equal(result.items.length, 250); assert.equal(result.loaded, 250); assert.equal(result.available, 250); assert.equal(result.capped, false)
  assert.deepEqual(requested.map((request) => request.page).sort((a, b) => a - b), [1, 2, 3]); assert.ok(requested.every((request) => request.perPage === '100'))
})

test('search results prioritize official Topic matches over other sources', async () => {
  const sources = { list: async () => [{ id: 'github-dsh-plugin', name: 'GitHub DSH Plugins', type: 'github-topic', enabled: true }, { id: 'other', name: 'Other', type: 'json', enabled: true }] }
  const service = new CatalogService(await mkdtemp(join(tmpdir(), 'dpm-priority-')), sources)
  service.curatedRegistry = async () => ({ items: [] })
  service.officialTopicCatalog = async () => ({ items: [normalizeCatalogItem({ name: 'official', full_name: 'official/search-plugin', html_url: 'https://github.com/official/search-plugin', stargazers_count: 1 }, 'github-dsh-plugin')], total: 1, loaded: 1, available: 1 })
  service.customSource = async () => ({ items: [normalizeCatalogItem({ name: 'other', full_name: 'other/search-plugin', html_url: 'https://github.com/other/search-plugin', stargazers_count: 999 }, 'other')], total: 1 })
  const result = await service.list('search', 'stars')
  assert.equal(result.items[0].fullName, 'official/search-plugin'); assert.equal(result.items[1].fullName, 'other/search-plugin')
})

test('resolves safe plugin icons with repository fallback', () => {
  assert.equal(safeIconUrl('https://cdn.example/icon.png'), 'https://cdn.example/icon.png')
  assert.equal(safeIconUrl('javascript:alert(1)'), undefined); assert.equal(safeIconUrl('http://cdn.example/icon.png'), undefined)
  assert.equal(manifestIconUrl({ icon: 'assets/icon.png' }, 'https://raw.githubusercontent.com/acme/plugin/main/'), 'https://raw.githubusercontent.com/acme/plugin/main/assets/icon.png')
  assert.equal(manifestIconUrl({ icon: '../icon.png' }, 'https://raw.githubusercontent.com/acme/plugin/main/'), undefined)
  assert.equal(normalizeCatalogItem({ full_name: 'acme/plugin', html_url: 'https://github.com/acme/plugin' }).iconUrl, 'https://github.com/acme.png?size=96')
})

test('catalog item preserves stars, description and install spec', () => {
  const item = normalizeCatalogItem({ name: 'plugin', full_name: 'acme/plugin', html_url: 'https://github.com/acme/plugin', description: 'hello', stargazers_count: 1247 })
  assert.equal(item.stars, 1247); assert.equal(item.description, 'hello'); assert.equal(item.installSpec, 'github:acme/plugin')
})

test('stable hash ignores object key order', () => {
  assert.equal(stableHash({ b: 2, a: { d: 4, c: 3 } }), stableHash({ a: { c: 3, d: 4 }, b: 2 }))
})

test('install analysis detects duplicate plugin, reused dependencies, scripts and capabilities', () => {
  const current = { packages: [{ name: 'shared', version: '1.2.3' }], plugins: [{ packageName: 'existing', repositoryUrl: 'https://github.com/acme/plugin', capabilities: [{ id: 'tool:search', type: 'tool', name: 'search' }] }] }
  const result = analyzeInstall(current, { name: 'candidate', repository: 'https://github.com/acme/plugin', dependencies: { shared: '^1.0.0', fresh: '^2' }, scripts: { prepare: 'build' }, dsh: { plugin: { capabilities: [{ id: 'tool:search', type: 'tool', name: 'search' }] } } })
  assert.equal(result.duplicate.packageName, 'existing'); assert.equal(result.reused.length, 1); assert.equal(result.additions.length, 1); assert.equal(result.scripts[0].name, 'prepare'); assert.equal(result.overlaps[0].severity, 'hard')
})

test('dependency analysis separates incompatible major versions from reuse', () => {
  const result = analyzeInstall({ packages: [{ name: 'shared', version: '1.2.3' }], plugins: [] }, { name: 'candidate', dependencies: { shared: '^2.0.0' } })
  assert.equal(result.reused.length, 0); assert.equal(result.versionConflicts.length, 1)
})

test('custom sources reject loopback and private network targets', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('https://127.0.0.1/plugins.json'), /私有网络/)
  await assert.rejects(() => assertPublicHttpsUrl('https://localhost/plugins.json'), /私有网络/)
})

test('source store keeps builtin official source immutable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-source-')); const store = new SourceStore(home)
  assert.equal((await store.list())[0].builtin, true)
  await store.add({ name: 'Internal', type: 'json', url: 'https://example.com/plugins.json' })
  assert.equal((await store.list()).length, 2)
  await assert.rejects(() => store.remove('github-dsh-plugin'))
})

test('compares semantic release versions conservatively', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1)
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0)
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1)
  assert.equal(compareVersions('not-a-version', '1.0.0'), null)
})

test('atomic JSON write and profile inspection identify bundles and capabilities', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-profile-')); const dir = join(home, 'profiles', 'web'); const moduleDir = join(dir, 'node_modules', 'demo')
  await mkdir(moduleDir, { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: '1.0.0' }, dsh: { profile: { bundles: ['demo'] } } })
  await atomicWriteJson(join(moduleDir, 'package.json'), { name: 'demo', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' }, plugin: { capabilities: [{ id: 'demo.tool', type: 'tool', name: 'demo' }] } } })
  const inspected = await new ProfileInspector(home).inspect('web')
  assert.equal(inspected.plugins[0].isBundle, true); assert.equal(inspected.plugins[0].bundleEnabled, true); assert.equal(inspected.plugins[0].manifestPresent, true); assert.equal(inspected.plugins[0].capabilities[0].id, 'demo.tool')
})

test('update checker reports available registry versions without mutating profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-update-')); const dir = join(home, 'profiles', 'web'); const moduleDir = join(dir, 'node_modules', 'demo')
  await mkdir(moduleDir, { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: '1.0.0' } })
  await atomicWriteJson(join(moduleDir, 'package.json'), { name: 'demo', version: '1.0.0' })
  const health = new PluginHealthService(new ProfileInspector(home), async () => new Response(JSON.stringify({ 'dist-tags': { latest: '1.2.0' } }), { status: 200 }), process.execPath)
  const result = await health.checkUpdates('web')
  assert.equal(result.results[0].status, 'available'); assert.equal(result.results[0].latestVersion, '1.2.0')
})

test('single-plugin update check does not query other installed plugins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-single-update-')); const dir = join(home, 'profiles', 'web')
  await mkdir(join(dir, 'node_modules', 'first'), { recursive: true }); await mkdir(join(dir, 'node_modules', 'second'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { first: '1.0.0', second: '1.0.0' } })
  await atomicWriteJson(join(dir, 'node_modules', 'first', 'package.json'), { name: 'first', version: '1.0.0' }); await atomicWriteJson(join(dir, 'node_modules', 'second', 'package.json'), { name: 'second', version: '1.0.0' })
  const requested = []; const health = new PluginHealthService(new ProfileInspector(home), async (url) => { requested.push(String(url)); return new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 }) }, process.execPath)
  const result = await health.checkUpdates('web', ['first'])
  assert.deepEqual(result.results.map((entry) => entry.packageName), ['first']); assert.equal(requested.length, 1); assert.match(requested[0], /registry\.npmjs\.org\/first$/)
})

test('update checker returns current version notes when no update is available', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-current-update-')); const dir = join(home, 'profiles', 'web'); const moduleDir = join(dir, 'node_modules', 'demo')
  await mkdir(moduleDir, { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: '1.0.0' } })
  await atomicWriteJson(join(moduleDir, 'package.json'), { name: 'demo', version: '1.0.0' })
  const health = new PluginHealthService(new ProfileInspector(home), async () => new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { changelog: '当前版本更新说明' } } }), { status: 200 }), process.execPath)
  const result = await health.checkUpdates('web')
  assert.equal(result.results[0].status, 'current'); assert.equal(result.results[0].releaseNotes.text, '当前版本更新说明')
})

test('integrity checker finds missing peer and validates bundle files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-integrity-')); const dir = join(home, 'profiles', 'web'); const moduleDir = join(dir, 'node_modules', 'demo')
  await mkdir(moduleDir, { recursive: true }); await writeFile(join(moduleDir, 'cordis.patch.yml'), 'plugins: []\n')
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: '1.0.0' }, dsh: { profile: { bundles: ['demo'] } } })
  await atomicWriteJson(join(moduleDir, 'package.json'), { name: 'demo', version: '1.0.0', peerDependencies: { missing: '^1' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const health = new PluginHealthService(new ProfileInspector(home), fetch, process.execPath)
  const result = await health.checkIntegrity('web')
  assert.equal(result.results[0].status, 'fail')
  assert.equal(result.results[0].checks.find((check) => check.id === 'peer:missing').state, 'fail')
  assert.equal(result.results[0].checks.find((check) => check.id === 'bundle-patch').state, 'pass')
})
