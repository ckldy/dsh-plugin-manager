import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CatalogService, MutationManager, OFFICIAL_SOURCE, PluginHealthService, PluginManagerError, ProfileInspector, SourceStore } from './core.js'

export const name = 'dsh-plugin-manager-local'
export const inject = ['webServer', 'webRuntime']

function header(headers, name) { const value = headers[name]; return typeof value === 'string' ? value : undefined }
function parseAuthority(value) { try { return new URL(`http://${value}`) } catch { return undefined } }
function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function trusted(req, trustedHosts) {
  const host = header(req.headers, 'host'); const hostUrl = host ? parseAuthority(host) : undefined
  if (!hostUrl) return false
  const allowed = isLoopback(hostUrl.hostname) || trustedHosts.some((entry) => {
    const parsed = parseAuthority(entry); return parsed && (parsed.host === hostUrl.host || (parsed.port === '' && parsed.hostname === hostUrl.hostname))
  })
  if (!allowed || header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin'); if (!origin) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}
async function body(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > limit) throw new PluginManagerError('body-too-large', '请求内容过大', 413); chunks.push(buffer) }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PluginManagerError('invalid-json', '请求 JSON 无效') }
}
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)) }
function requireString(value, key) { if (!value || typeof value[key] !== 'string' || !value[key].trim()) throw new PluginManagerError('bad-request', `${key} 为必填项`); return value[key].trim() }

export function createServices(home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')) {
  const sources = new SourceStore(home)
  const catalog = new CatalogService(home, sources)
  const inspector = new ProfileInspector(home)
  const mutations = new MutationManager(home, inspector)
  const health = new PluginHealthService(inspector)
  return { home, sources, catalog, inspector, mutations, health }
}

export function createApi(services) {
  const { sources, catalog, inspector, mutations, health } = services
  return {
    async dispatch(method, payload, query) {
      switch (method) {
        case 'environment': return { nodeVersion: process.version, platform: process.platform, architecture: process.arch, profiles: await inspector.profiles(), dshHome: services.home }
        case 'sources.list': return { sources: await sources.list() }
        case 'sources.add': {
          const updated = await sources.add(payload); const added = updated.find((source) => source.id !== OFFICIAL_SOURCE.id && source.url === new URL(payload.url).toString())
          if (added?.type === 'web') {
            try { const discovery = await catalog.customSource(added); return { sources: updated, discovery: { count: discovery.items.length, registryUrl: discovery.registryUrl } } }
            catch (error) { await sources.remove(added.id); throw new PluginManagerError('source-validation', `网页源无法解析插件：${error.message}`, 422) }
          }
          return { sources: updated }
        }
        case 'sources.remove': return { sources: await sources.remove(requireString(payload, 'id')) }
        case 'catalog.list': return catalog.list(query.get('q') ?? '', query.get('sort') ?? 'stars')
        case 'catalog.resolve': return catalog.resolve(requireString(payload, 'url'))
        case 'catalog.detail': return catalog.resolve(requireString(payload, 'url'))
        case 'catalog.readme': return catalog.readReadme(requireString(payload, 'url'), payload.ref, requireString(payload, 'path'))
        case 'profile.inspect': return inspector.inspect(requireString(payload, 'profile'))
        case 'updates.check': {
          const packageNames = Array.isArray(payload.packageNames) ? payload.packageNames.filter((name) => typeof name === 'string' && name.trim()) : []
          if (packageNames.length !== 1) throw new PluginManagerError('bad-request', '更新检查必须指定一个插件')
          return health.checkUpdates(requireString(payload, 'profile'), packageNames)
        }
        case 'integrity.check': return health.checkIntegrity(requireString(payload, 'profile'), Array.isArray(payload.packageNames) ? payload.packageNames.filter((name) => typeof name === 'string') : undefined)
        case 'plan.install': {
          const profile = requireString(payload, 'profile'); const specs = Array.isArray(payload.items) ? payload.items : []
          if (!specs.length) throw new PluginManagerError('bad-request', '至少选择一个插件')
          const resolved = await Promise.all(specs.map((entry) => entry.manifest && entry.item ? entry : catalog.resolve(entry.url ?? entry.installSpec ?? entry.repositoryUrl)))
          return mutations.planInstall(profile, resolved)
        }
        case 'plan.uninstall': {
          const names = Array.isArray(payload.packageNames) ? payload.packageNames.filter((x) => typeof x === 'string') : []
          if (!names.length) throw new PluginManagerError('bad-request', '至少选择一个待卸载插件')
          return mutations.planUninstall(requireString(payload, 'profile'), names, payload.cascade === true)
        }
        case 'mutation.execute': return mutations.execute(requireString(payload, 'planId'), requireString(payload, 'planHash'), payload.allowConflicts === true)
        case 'task.get': return mutations.task(requireString(payload, 'taskId'))
        default: throw new PluginManagerError('not-found', `未知插件管理方法 ${method}`, 404)
      }
    },
  }
}

export function apply(ctx) {
  const services = createServices()
  const api = createApi(services)
  void mkdir(join(services.home, 'cache', 'plugin-manager'), { recursive: true })
  const fence = (req) => trusted(req, ctx.webRuntime.trustedHosts)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/plugin-manager/api',
    handler: async (req, res) => {
      if (!fence(req)) { json(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } }); return }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const method = url.pathname.startsWith('/plugin-manager/api/') ? url.pathname.slice('/plugin-manager/api/'.length) : ''
      if (!method || method.includes('/')) { json(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown endpoint' } }); return }
      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') { json(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return }
      try {
        const payload = req.method === 'GET' ? {} : await body(req)
        json(res, 200, { ok: true, value: await api.dispatch(method, payload, url.searchParams) })
      } catch (error) {
        const status = error.status ?? 500
        json(res, status, { ok: false, error: { code: error.code ?? 'internal-error', message: error.message ?? String(error), details: error.details } })
      }
    },
  }), 'dsh-plugin-manager-local: API routes')
}
