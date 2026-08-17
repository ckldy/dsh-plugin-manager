import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeInstall, assertPublicHttpsUrl, CatalogService, classifyPlugin, atomicWriteJson, compareVersions, extractRepositoriesFromHtml, manifestIconUrl, MutationManager, normalizeCatalogItem, normalizeRepositoryUrl, safeIconUrl, PluginHealthService, ProfileInspector, SourceStore, stableHash } from '../lib/core.js'

test('normalizes GitHub repository, tree, blob and git URLs', () => {
  assert.deepEqual(normalizeRepositoryUrl('https://github.com/acme/plugin'), { kind: 'github', owner: 'acme', repo: 'plugin', repositoryUrl: 'https://github.com/acme/plugin', installSpec: 'github:acme/plugin' })
  assert.equal(normalizeRepositoryUrl('https://github.com/acme/plugin/tree/main').installSpec, 'github:acme/plugin#main')
  assert.equal(normalizeRepositoryUrl('https://github.com/acme/plugin/tree/feat/multi-segment').installSpec, 'github:acme/plugin#feat/multi-segment')
  assert.equal(normalizeRepositoryUrl('https://github.com/acme/plugin/blob/main/README.md').installSpec, 'github:acme/plugin#main')
  assert.equal(normalizeRepositoryUrl('git+https://github.com/acme/plugin.git').repositoryUrl, 'https://github.com/acme/plugin')
})

test('normalizes npm package URLs including scoped and versioned packages', () => {
  assert.equal(normalizeRepositoryUrl('https://www.npmjs.com/package/%40acme%2Fdsh-plugin').installSpec, '@acme/dsh-plugin')
  assert.equal(normalizeRepositoryUrl('https://registry.npmjs.org/example').installSpec, 'example')
  assert.equal(normalizeRepositoryUrl('https://www.npmjs.com/package/example/v/1.2.3').installSpec, 'example')
})

test('normalizes Hugging Face models and Spaces repositories', () => {
  assert.deepEqual(normalizeRepositoryUrl('https://huggingface.co/acme/dsh-plugin'), { kind: 'huggingface', owner: 'acme', repo: 'dsh-plugin', space: false, sourcePath: 'acme/dsh-plugin', repositoryUrl: 'https://huggingface.co/acme/dsh-plugin', installSpec: 'git+https://huggingface.co/acme/dsh-plugin.git', ref: undefined })
  assert.equal(normalizeRepositoryUrl('https://huggingface.co/spaces/acme/dsh-ui/tree/main').installSpec, 'git+https://huggingface.co/spaces/acme/dsh-ui.git#main')
})

test('marks projects without a DSH bundle as not installable', () => {
  assert.equal(analyzeInstall({ plugins: [], packages: [] }, { name: 'plain', dependencies: {} }).integration.eligible, false)
  assert.equal(analyzeInstall({ plugins: [], packages: [] }, { name: 'dsh', dependencies: {}, dsh: { bundle: { patch: './cordis.patch.yml' } } }).integration.eligible, true)
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

test('custom GitHub Topic catalogs paginate up to the bounded limit like the official topic', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    const parsed = new URL(url); const page = Number(parsed.searchParams.get('page')); requested.push({ page, q: parsed.searchParams.get('q') })
    const total_count = 230; const start = (page - 1) * 100
    return { ok: true, json: async () => ({ total_count, items: Array.from({ length: Math.max(0, Math.min(100, total_count - start)) }, (_, index) => ({ name: `custom-${start + index}`, full_name: `acme/custom-${start + index}`, html_url: `https://github.com/acme/custom-${start + index}`, stargazers_count: start + index })) }) }
  }
  const service = new CatalogService(await mkdtemp(join(tmpdir(), 'dpm-custom-topic-')), null, fetchImpl)
  const result = await service.githubTopicCatalog('my-topic', 'custom-source', '', 'stars')
  assert.equal(result.items.length, 230); assert.equal(result.loaded, 230); assert.equal(result.available, 230); assert.equal(result.capped, false)
  assert.deepEqual(requested.map((request) => request.page).sort((a, b) => a - b), [1, 2, 3])
  assert.ok(requested.every((request) => request.q.includes('topic:my-topic')))
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

test('catalog item preserves stars, description, display name, license and install spec', () => {
  const item = normalizeCatalogItem({ name: 'plugin', full_name: 'acme/plugin', html_url: 'https://github.com/acme/plugin', description: 'hello', stargazers_count: 1247, displayName: '中文名', license: { spdx_id: 'MIT' } })
  assert.equal(item.stars, 1247); assert.equal(item.description, 'hello'); assert.equal(item.installSpec, 'github:acme/plugin'); assert.equal(item.displayName, '中文名'); assert.equal(item.license, 'MIT')
  assert.equal(normalizeCatalogItem({ full_name: 'acme/plain', html_url: 'https://github.com/acme/plain', license: 'Apache-2.0' }).license, 'Apache-2.0')
})

test('catalog cache tolerates a corrupted cache file and refreshes through the loader', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-cache-')); const key = 'corrupt-key'
  const cachePath = join(home, 'cache', 'plugin-manager', `${stableHash(key)}.json`)
  await mkdir(join(home, 'cache', 'plugin-manager'), { recursive: true })
  await writeFile(cachePath, '{not-json')
  const service = new CatalogService(home, null, async () => ({ ok: true, json: async () => ({ total_count: 0, items: [] }) }))
  const result = await service.cached(key, 60_000, async () => ({ fresh: true }))
  assert.equal(result.fresh, true); assert.equal(result.cache.stale, false)
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

test('custom sources reject loopback, private network and IPv4-mapped IPv6 targets', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('https://127.0.0.1/plugins.json'), /私有网络/)
  await assert.rejects(() => assertPublicHttpsUrl('https://localhost/plugins.json'), /私有网络/)
  await assert.rejects(() => assertPublicHttpsUrl('https://[::1]/plugins.json'), /私有网络/)
  await assert.rejects(() => assertPublicHttpsUrl('https://[::ffff:127.0.0.1]/plugins.json'), /私有网络/)
  await assert.rejects(() => assertPublicHttpsUrl('https://[::ffff:7f00:1]/plugins.json'), /私有网络/)
  await assert.rejects(() => assertPublicHttpsUrl('not a url'), /地址无效/)
})

test('source store keeps builtin official source immutable and rejects duplicates', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-source-')); const store = new SourceStore(home)
  assert.equal((await store.list())[0].builtin, true)
  await store.add({ name: 'Internal', type: 'json', url: 'https://example.com/plugins.json' })
  assert.equal((await store.list()).length, 2)
  await assert.rejects(() => store.add({ name: 'Internal copy', type: 'json', url: 'https://example.com/plugins.json' }), /已经存在/)
  await assert.rejects(() => store.add({ name: 'Official duplicate', type: 'github-topic', url: 'https://github.com/topics/dsh-plugin' }), /已内置/)
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

test('update checker falls back to GitHub releases for non-npm plugins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-gh-update-')); const dir = join(home, 'profiles', 'web'); const moduleDir = join(dir, 'node_modules', 'Vibe-Skills')
  await mkdir(moduleDir, { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { 'Vibe-Skills': 'github:owner/Vibe-Skills#v2.3.0' } })
  await atomicWriteJson(join(moduleDir, 'package.json'), { _pnpmPlaceholder: 'This file was generated by pnpm. The original package did not contain a package.json.' })
  const requested = []
  const health = new PluginHealthService(new ProfileInspector(home), async (url) => {
    requested.push(String(url)); const value = String(url)
    if (value.includes('registry.npmjs.org')) return new Response('not found', { status: 404 })
    if (value.endsWith('/releases/latest')) return new Response('', { status: 302, headers: { location: 'https://github.com/owner/Vibe-Skills/releases/tag/v2.3.0' } })
    if (value.includes('/releases/tags/')) return new Response(JSON.stringify({ tag_name: 'v2.3.0', name: 'v2.3.0', body: 'GitHub 更新说明' }), { status: 200 })
    return new Response('', { status: 404 })
  }, process.execPath)
  const result = await health.checkUpdates('web')
  const entry = result.results[0]
  assert.equal(entry.status, 'current'); assert.equal(entry.currentVersion, '2.3.0'); assert.equal(entry.latestVersion, '2.3.0'); assert.equal(entry.source, 'github')
  assert.equal(entry.ref, 'v2.3.0'); assert.equal(entry.installSpec, 'Vibe-Skills@github:owner/Vibe-Skills#v2.3.0'); assert.equal(entry.releaseNotes.text, 'GitHub 更新说明')
  assert.ok(requested.some((url) => url.includes('github.com/owner/Vibe-Skills/releases/latest')))
})

test('npm registry takes precedence over the GitHub fallback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-npm-first-')); const dir = join(home, 'profiles', 'web'); const moduleDir = join(dir, 'node_modules', 'demo')
  await mkdir(moduleDir, { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: '1.0.0' } })
  await atomicWriteJson(join(moduleDir, 'package.json'), { name: 'demo', version: '1.0.0', repository: { type: 'git', url: 'https://github.com/owner/demo' } })
  const githubHits = []
  const health = new PluginHealthService(new ProfileInspector(home), async (url) => {
    const value = String(url)
    if (value.includes('registry.npmjs.org')) return new Response(JSON.stringify({ 'dist-tags': { latest: '1.2.0' } }), { status: 200 })
    githubHits.push(value); return new Response('', { status: 404 })
  }, process.execPath)
  const entry = (await health.checkUpdates('web')).results[0]
  assert.equal(entry.status, 'available'); assert.equal(entry.source, 'npm'); assert.equal(githubHits.length, 0)
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

test('install planning rejects projects that cannot be integrated into DSH', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-non-plugin-')); const dir = join(home, 'profiles', 'web')
  await mkdir(join(dir, 'node_modules'), { recursive: true }); await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } } })
  const mutations = new MutationManager(home, new ProfileInspector(home), process.execPath)
  await assert.rejects(() => mutations.planInstall('web', [{ item: { installSpec: 'plain' }, manifest: { name: 'plain', version: '1.0.0' } }]), { code: 'not-dsh-plugin' })
})

test('install mutation executes once, lists tasks and removes success snapshots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpm-mutation-')); const dir = join(home, 'profiles', 'web'); const moduleDir = join(dir, 'node_modules', 'demo')
  await mkdir(moduleDir, { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } } })
  await atomicWriteJson(join(dir, 'node_modules', '.modules.yaml'), { storeDir: '/tmp/pnpm-store-v11' })
  const fakeCli = join(home, 'fake-dsh.cjs')
  await writeFile(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path')
const args = process.argv.slice(2); const home = ${JSON.stringify(home)}
const p = args.indexOf('--profile'); const dir = path.join(home, 'profiles', args[p + 1]); fs.writeFileSync(path.join(dir, 'received-store.txt'), process.env.npm_config_store_dir || '')
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
if (args[0] === '--dump-config') { console.log('plugins: ok'); process.exit(0) }
const op = args.includes('add') ? 'add' : 'remove'; const specs = args.slice(args.indexOf(op) + 1)
if (op === 'add') { for (const spec of specs) { manifest.dependencies[spec] = spec; const target = path.join(dir, 'node_modules', spec); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: spec, version: '1.0.0' })) } }
else { for (const spec of specs) delete manifest.dependencies[spec] }
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
process.exit(0)
`)
  await import('node:fs/promises').then(({ chmod }) => chmod(fakeCli, 0o755))
  const inspector = new ProfileInspector(home)
  const mutations = new MutationManager(home, inspector, fakeCli)
  const plan = await mutations.planInstall('web', [{ item: { installSpec: 'demo' }, manifest: { name: 'demo', version: '1.0.0', dependencies: {}, dsh: { bundle: { patch: './cordis.patch.yml' } } } }])
  const task = await mutations.execute(plan.id, plan.hash)
  while (!task.finishedAt) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(task.status, 'success'); assert.equal(task.rolledBack, undefined)
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles, ['demo'])
  assert.equal(await readFile(join(dir, 'received-store.txt'), 'utf8'), '/tmp/pnpm-store-v11')
  assert.equal(mutations.listTasks().length, 1); assert.equal(mutations.listTasks()[0].status, 'success')
  await assert.rejects(() => mutations.execute(plan.id, plan.hash), /已经执行过/)
  await assert.rejects(() => readFile(join(dir, '.dsh-plugin-snapshots', task.id, 'package.json')), { code: 'ENOENT' })
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
