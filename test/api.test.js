import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApi, createServices } from '../lib/index.js'
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
  assert.equal(plan.kind, 'install'); assert.equal(typeof plan.hash, 'string'); assert.equal(plan.summary.requiresRestart, true)
})

test('uninstall plan blocks reverse dependencies and cascade includes dependents', async () => {
  const { home, dir, api } = await fixture(); await mkdir(join(dir, 'node_modules', 'base'), { recursive: true }); await mkdir(join(dir, 'node_modules', 'consumer'), { recursive: true })
  await atomicWriteJson(join(dir, 'package.json'), { name: 'profile', dependencies: { base: '1.0.0', consumer: '1.0.0' }, dsh: { profile: { bundles: [] } } })
  await atomicWriteJson(join(dir, 'node_modules', 'base', 'package.json'), { name: 'base', version: '1.0.0' })
  await atomicWriteJson(join(dir, 'node_modules', 'consumer', 'package.json'), { name: 'consumer', version: '1.0.0', dependencies: { base: '^1' } })
  const blocked = await api.dispatch('plan.uninstall', { profile: 'web', packageNames: ['base'] }, new URLSearchParams())
  assert.deepEqual(blocked.summary.blockedBy, [{ target: 'base', dependent: 'consumer' }])
  const cascade = await api.dispatch('plan.uninstall', { profile: 'web', packageNames: ['base'], cascade: true }, new URLSearchParams())
  assert.deepEqual(new Set(cascade.packageNames), new Set(['base', 'consumer']))
})

test('catalog readme dispatches safe in-page document request', async () => {
  const { home } = await fixture(); const services = createServices(home)
  services.catalog.readReadme = async (url, ref, path) => ({ readme: '# 中文', path, detail: { repositoryUrl: url, defaultBranch: ref } })
  const value = await createApi(services).dispatch('catalog.readme', { url: 'https://github.com/acme/demo', ref: 'main', path: 'README_ZH.md' }, new URLSearchParams())
  assert.equal(value.readme, '# 中文'); assert.equal(value.path, 'README_ZH.md')
})

test('unknown endpoint fails closed', async () => {
  const { api } = await fixture()
  await assert.rejects(() => api.dispatch('unknown', {}, new URLSearchParams()), /未知插件管理方法/)
})
