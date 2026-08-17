import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApi, createRestartScheduler, createServices } from '../lib/index.js'
import { atomicWriteJson } from '../lib/core.js'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dpm-api-')); const dir = join(home, 'profiles', 'web')
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  return { home, dir, api: createApi(createServices(home)) }
}

test('API lists environment and installed plugins', async () => {
  const { api } = await fixture()
  const environment = await api.dispatch('environment', {}, new URLSearchParams())
  assert.deepEqual(environment.profiles, ['web'])
  const profile = await api.dispatch('profile.inspect', { profile: 'web' }, new URLSearchParams())
  assert.equal(profile.profile, 'web'); assert.deepEqual(profile.plugins, [])
})

test('install plan reports dependency reuse and receives a stable plan hash', async () => {
  const { api } = await fixture()
  const plan = await api.dispatch('plan.install', { profile: 'web', items: [{ item: { name: 'demo', fullName: 'demo', repositoryUrl: 'https://github.com/acme/demo', installSpec: 'demo' }, manifest: { name: 'demo', version: '1.0.0', dependencies: {}, dsh: { bundle: { patch: './cordis.patch.yml' } } } }] }, new URLSearchParams())
  assert.equal(plan.kind, 'install'); assert.equal(plan.items.length, 1); assert.equal(plan.items[0].manifest.name, 'demo'); assert.equal(typeof plan.hash, 'string'); assert.equal(plan.summary.requiresRestart, true)
})

test('uninstall plan blocks reverse dependencies and cascade walks transitive dependents', async () => {
  const { home, dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'base'), { recursive: true }); await mkdir(join(dir, 'node_modules', 'consumer'), { recursive: true }); await mkdir(join(dir, 'node_modules', 'wrapper'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { base: '1.0.0', consumer: '1.0.0', wrapper: '1.0.0' }, dsh: { profile: { bundles: [] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'base', 'package.json'), { name: 'base', version: '1.0.0' })
  await atomicWriteJson(join(dir, 'node_modules', 'consumer', 'package.json'), { name: 'consumer', version: '1.0.0', dependencies: { base: '^1' } })
  await atomicWriteJson(join(dir, 'node_modules', 'wrapper', 'package.json'), { name: 'wrapper', version: '1.0.0', dependencies: { consumer: '^1' } })
  const blocked = await api.dispatch('plan.uninstall', { profile: 'web', packageNames: ['base'] }, new URLSearchParams())
  assert.deepEqual(blocked.summary.blockedBy, [{ target: 'base', dependent: 'consumer' }])
  const cascade = await api.dispatch('plan.uninstall', { profile: 'web', packageNames: ['base'], cascade: true }, new URLSearchParams())
  assert.deepEqual(new Set(cascade.packageNames), new Set(['base', 'consumer', 'wrapper']))
})

test('install plan reuses compatible shared dependencies without duplicate additions', async () => {
  const { dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'shared'), { recursive: true }); await mkdir(join(dir, 'node_modules', 'existing'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { shared: '1.2.0', existing: '1.0.0' }, dsh: { profile: { bundles: ['existing'] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'shared', 'package.json'), { name: 'shared', version: '1.2.0' })
  await atomicWriteJson(join(dir, 'node_modules', 'existing', 'package.json'), { name: 'existing', version: '1.0.0', dependencies: { shared: '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const plan = await api.dispatch('plan.install', { profile: 'web', items: [{ item: { name: 'incoming', installSpec: 'incoming' }, manifest: { name: 'incoming', version: '1.0.0', dependencies: { shared: '^1.0.0', fresh: '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } } }] }, new URLSearchParams())
  assert.deepEqual(plan.items[0].analysis.reused.map((entry) => entry.name), ['shared'])
  assert.deepEqual(plan.items[0].analysis.reused[0].sharedWith, ['existing'])
  assert.deepEqual(plan.items[0].analysis.additions.map((entry) => entry.name), ['fresh'])
})

test('uninstall plan preserves shared dependencies and identifies exclusive dependencies', async () => {
  const { dir, api } = await fixture(); for (const name of ['target', 'other', 'shared', 'exclusive']) await mkdir(join(dir, 'node_modules', name), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { target: '1.0.0', other: '1.0.0', shared: '1.0.0', exclusive: '1.0.0' }, dsh: { profile: { bundles: ['target', 'other'] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'target', 'package.json'), { name: 'target', version: '1.0.0', dependencies: { shared: '^1.0.0', exclusive: '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
  await atomicWriteJson(join(dir, 'node_modules', 'other', 'package.json'), { name: 'other', version: '1.0.0', dependencies: { shared: '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
  await atomicWriteJson(join(dir, 'node_modules', 'shared', 'package.json'), { name: 'shared', version: '1.0.0' }); await atomicWriteJson(join(dir, 'node_modules', 'exclusive', 'package.json'), { name: 'exclusive', version: '1.0.0' })
  const plan = await api.dispatch('plan.uninstall', { profile: 'web', packageNames: ['target'] }, new URLSearchParams())
  assert.deepEqual(plan.summary.sharedDependencies, [{ name: 'shared', usedBy: ['other'] }])
  assert.deepEqual(plan.summary.exclusiveDependencies, [{ name: 'exclusive' }])
})

test('catalog readme dispatches safe in-page document request', async () => {
  const { home } = await fixture(); const services = createServices(home)
  services.catalog.readReadme = async (url, ref, path) => ({ readme: '# 中文', path, detail: { repositoryUrl: url, defaultBranch: ref } })
  const value = await createApi(services).dispatch('catalog.readme', { url: 'https://github.com/acme/demo', ref: 'main', path: 'README_ZH.md' }, new URLSearchParams())
  assert.equal(value.readme, '# 中文'); assert.equal(value.path, 'README_ZH.md')
})

test('update of an already-installed plugin plans a replacement, not a skip', async () => {
  const { home, dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'demo'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: 'github:acme/demo' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'demo', 'package.json'), { _pnpmPlaceholder: 'generated by pnpm' })
  const plan = await api.dispatch('plan.install', { profile: 'web', items: [{ item: { name: 'demo', fullName: 'demo', repositoryUrl: 'https://github.com/acme/demo', installSpec: 'github:acme/demo#v2.0.0' }, manifest: { name: 'demo', version: '2.0.0', dependencies: {}, dsh: { bundle: { patch: './cordis.patch.yml' } } } }] }, new URLSearchParams())
  assert.equal(plan.summary.duplicatePlugins.length, 0)
  assert.equal(plan.summary.updates.length, 1)
  assert.equal(plan.summary.updates[0].packageName, 'demo')
  assert.equal(plan.summary.updates[0].from, 'github:acme/demo')
  assert.equal(plan.summary.updates[0].to, 'github:acme/demo#v2.0.0')
  assert.equal(plan.items[0].analysis.duplicate, undefined)
  assert.equal(plan.items[0].analysis.replacing.packageName, 'demo')
  assert.equal(plan.items[0].analysis.replacing.expectedVersion, '2.0.0')
})

test('update reuses the existing plugin identity without self capability conflicts', async () => {
  const { dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'demo'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: 'github:acme/demo' }, dsh: { profile: { bundles: ['demo'] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'demo', 'package.json'), { name: 'demo', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const plan = await api.dispatch('plan.install', { profile: 'web', items: [{ item: { name: 'demo', repositoryUrl: 'https://github.com/acme/demo', installSpec: 'github:acme/demo#v2.0.0' }, manifest: { name: 'demo', version: '2.0.0', dependencies: {}, dsh: { bundle: { patch: './cordis.patch.yml' } } } }] }, new URLSearchParams())
  assert.equal(plan.summary.updates.length, 1)
  assert.deepEqual(plan.summary.hardConflicts, [])
  assert.equal(plan.items[0].analysis.replacing.packageName, 'demo')
})

test('identical install spec is still a duplicate and is skipped', async () => {
  const { home, dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'demo'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: 'github:acme/demo' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'demo', 'package.json'), { _pnpmPlaceholder: 'generated by pnpm' })
  const plan = await api.dispatch('plan.install', { profile: 'web', items: [{ item: { name: 'demo', fullName: 'demo', repositoryUrl: 'https://github.com/acme/demo', installSpec: 'github:acme/demo' }, manifest: { name: 'demo', version: '1.0.0', dependencies: {}, dsh: { bundle: { patch: './cordis.patch.yml' } } } }] }, new URLSearchParams())
  assert.deepEqual(plan.summary.duplicatePlugins, ['demo'])
  assert.equal(plan.summary.updates.length, 0)
  assert.equal(plan.items[0].analysis.duplicate.packageName, 'demo')
})


test('an identical install plan is marked as current and cannot be executed', async () => {
  const { dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'demo'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { demo: 'github:acme/demo' }, dsh: { profile: { bundles: [] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'demo', 'package.json'), { name: 'demo', version: '1.0.0' })
  const plan = await api.dispatch('plan.install', { profile: 'web', items: [{ item: { name: 'demo', installSpec: 'github:acme/demo' }, manifest: { name: 'demo', version: '1.0.0' } }] }, new URLSearchParams())
  assert.equal(plan.summary.noChanges, true)
  await assert.rejects(() => api.dispatch('mutation.execute', { planId: plan.id, planHash: plan.hash }, new URLSearchParams()), { code: 'already-current' })
})

test('existing externally integrated package can update without a new bundle declaration', async () => {
  const { dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'Vibe-Skills'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { 'Vibe-Skills': 'github:owner/Vibe-Skills#v1.0.0' }, dsh: { profile: { bundles: [] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'Vibe-Skills', 'package.json'), { name: 'Vibe-Skills', version: '1.0.0' })
  const plan = await api.dispatch('plan.install', { profile: 'web', items: [{ item: { name: 'Vibe-Skills', repositoryUrl: 'https://github.com/owner/Vibe-Skills', installSpec: 'github:owner/Vibe-Skills#v2.0.0' }, manifest: { name: 'Vibe-Skills', version: '2.0.0' } }] }, new URLSearchParams())
  assert.equal(plan.summary.updates.length, 1)
  assert.equal(plan.items[0].analysis.replacing.preserveIntegration, true)
})

test('tasks.list returns current in-memory mutation tasks', async () => {
  const { home } = await fixture(); const services = createServices(home)
  services.mutations = { listTasks: async () => [{ id: 't1', status: 'success' }] }
  const value = await createApi(services).dispatch('tasks.list', {}, new URLSearchParams())
  assert.deepEqual(value.tasks, [{ id: 't1', status: 'success' }])
})

test('adding an invalid JSON source rolls the source back with a validation error', async () => {
  const { home } = await fixture(); const services = createServices(home)
  const added = { id: 'custom-json', name: 'Broken', type: 'json', url: 'https://example.com/plugins.json' }
  let removed
  services.sources.add = async () => [added]
  services.sources.remove = async (id) => { removed = id; return [] }
  services.catalog.customSource = async () => { throw new Error('schema mismatch') }
  const api = createApi(services)
  await assert.rejects(() => api.dispatch('sources.add', { name: 'Broken', type: 'json', url: 'https://example.com/plugins.json' }, new URLSearchParams()), /JSON 插件源无法解析/)
  assert.equal(removed, 'custom-json')
})

test('adding a working web source reports its discovered plugin count', async () => {
  const { home } = await fixture(); const services = createServices(home)
  const added = { id: 'custom-web', name: 'Market', type: 'web', url: 'https://market.example/' }
  services.sources.add = async () => [added]
  services.catalog.customSource = async (source) => { assert.equal(source.id, 'custom-web'); return { items: [{ id: 'x' }, { id: 'y' }], registryUrl: 'https://market.example/plugins.json' } }
  const value = await createApi(services).dispatch('sources.add', { name: 'Market', type: 'web', url: 'https://market.example/' }, new URLSearchParams())
  assert.equal(value.discovery.count, 2); assert.equal(value.discovery.registryUrl, 'https://market.example/plugins.json'); assert.equal(value.discovery.sourceId, 'custom-web')
})

test('system.restart dispatches to the process restart hook', async () => {
  const { home } = await fixture(); const services = createServices(home)
  const restart = { schedule: async () => ({ restarting: true, pid: 1234 }) }
  const value = await createApi(services, { restart }).dispatch('system.restart', {}, new URLSearchParams())
  assert.deepEqual(value, { restarting: true, pid: 1234 })
  await assert.rejects(() => createApi(services).dispatch('system.restart', {}, new URLSearchParams()), /当前运行环境不支持进程内重启/)
})

test('restart scheduler creates one detached handoff and confirms only once', async () => {
  const calls = []
  const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); return { once() {}, unref() {} } }
  const scheduler = createRestartScheduler({ launchArgs: ['/opt/node24/bin/dsh', 'web', '--trusted-host', 'dsh.vcncv.com'], confirmDelayMs: 3_600_000, spawnImpl })
  const first = await scheduler.schedule()
  assert.equal(first.restarting, true); assert.equal(first.pid, process.pid)
  const second = await scheduler.schedule()
  assert.equal(second.alreadyScheduled, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].args[0], /dsh-plugin-manager-restart-/)
  assert.equal(calls[0].args[1], String(process.pid))
  assert.deepEqual(calls[0].args.slice(2), ['/opt/node24/bin/dsh', 'web', '--trusted-host', 'dsh.vcncv.com'])
  assert.equal(calls[0].options.detached, true)
  assert.equal(scheduler.confirm(), true); assert.equal(scheduler.confirm(), false)
})

test('unknown endpoint fails closed', async () => {
  const { api } = await fixture()
  await assert.rejects(() => api.dispatch('unknown', {}, new URLSearchParams()), /未知插件管理方法/)
})
