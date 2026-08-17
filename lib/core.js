import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

export const CURATED_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
export const CURATED_SOURCE_ID = 'curated-awesome-dsh-plugin'
export const GITHUB_SEARCH_PAGE_SIZE = 100
export const GITHUB_SEARCH_MAX_RESULTS = 1_000

export const OFFICIAL_SOURCE = Object.freeze({
  id: 'github-dsh-plugin',
  name: 'GitHub DSH Plugins',
  type: 'github-topic',
  topic: 'dsh-plugin',
  url: 'https://github.com/topics/dsh-plugin',
  enabled: true,
  trusted: false,
  builtin: true,
})

export class PluginManagerError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

export function stableHash(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort)
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]))
    }
    return input
  }
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex')
}

export function normalizeRepositoryUrl(input) {
  let value = String(input ?? '').trim()
  value = value.replace(/^git\+/, '').replace(/^github:/, 'https://github.com/')
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)) value = `https://github.com/${value}`
  let url
  try { url = new URL(value) } catch { throw new PluginManagerError('invalid-url', '请输入有效的 HTTPS GitHub、Hugging Face 或 npm URL') }
  if (url.protocol !== 'https:') throw new PluginManagerError('invalid-url', '仅允许 HTTPS 插件地址')
  if (url.username || url.password) throw new PluginManagerError('invalid-url', '插件地址不能包含凭据')
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) throw new PluginManagerError('invalid-url', 'GitHub 地址必须包含 owner/repository')
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/, '')
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new PluginManagerError('invalid-url', 'GitHub owner/repository 格式无效')
    }
    const repositoryUrl = `https://github.com/${owner}/${repo}`
    const refIndex = ['tree', 'commit'].includes(parts[2]) ? 3 : parts[2] === 'blob' ? 3 : -1
    const refPath = refIndex > 0 ? (parts[2] === 'blob' ? parts[3] : parts.slice(refIndex).filter(Boolean).join('/')) : ''
    const ref = refPath || url.hash.slice(1) || undefined
    return { kind: 'github', owner, repo, repositoryUrl, installSpec: `github:${owner}/${repo}${ref ? `#${ref}` : ''}` }
  }
  if (url.hostname === 'npmjs.com' || url.hostname === 'www.npmjs.com' || url.hostname === 'registry.npmjs.org') {
    const marker = url.pathname.includes('/package/') ? url.pathname.split('/package/')[1] : url.pathname.slice(1)
    const packageName = decodeURIComponent(marker).split('/-/')[0].split('/v/')[0].replace(/\/$/, '')
    if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(packageName)) throw new PluginManagerError('invalid-url', 'npm 包地址无效')
    return { kind: 'npm', packageName, repositoryUrl: url.toString(), installSpec: packageName }
  }
  if (url.hostname === 'huggingface.co' || url.hostname === 'www.huggingface.co') {
    const parts = url.pathname.split('/').filter(Boolean)
    const isSpace = parts[0] === 'spaces'
    const offset = isSpace ? 1 : 0
    if (parts.length < offset + 2) throw new PluginManagerError('invalid-url', 'Hugging Face 地址必须包含 owner/repository')
    const owner = parts[offset]; const repo = parts[offset + 1].replace(/\.git$/, '')
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new PluginManagerError('invalid-url', 'Hugging Face owner/repository 格式无效')
    const treeIndex = offset + 2
    const ref = parts[treeIndex] === 'tree' ? parts.slice(treeIndex + 1).join('/') || undefined : url.hash.slice(1) || undefined
    const sourcePath = `${isSpace ? 'spaces/' : ''}${owner}/${repo}`
    const repositoryUrl = `https://huggingface.co/${sourcePath}`
    return { kind: 'huggingface', owner, repo, space: isSpace, sourcePath, repositoryUrl, installSpec: `git+${repositoryUrl}.git${ref ? `#${ref}` : ''}`, ref }
  }
  throw new PluginManagerError('invalid-url', '当前仅支持 github.com、huggingface.co 与 npmjs.com/registry.npmjs.org')
}

export function extractRepositoriesFromHtml(html, sourceUrl, limit = 500) {
  const found = new Map(); const blockedOwners = new Set(['topics', 'marketplace', 'features', 'settings', 'login', 'signup', 'orgs', 'apps', 'collections', 'sponsors'])
  const add = (owner, repo) => {
    repo = String(repo || '').replace(/\.git$/i, '')
    if (found.size >= limit || blockedOwners.has(String(owner).toLowerCase()) || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return
    const fullName = `${owner}/${repo}`; found.set(fullName.toLowerCase(), { name: repo, full_name: fullName, html_url: `https://github.com/${fullName}`, description: `从 ${new URL(sourceUrl).hostname} 网页提取`, sourceType: 'web' })
  }
  for (const match of String(html).matchAll(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi)) add(match[1], match[2])
  for (const match of String(html).matchAll(/(?:href|data-href)=["'][^"']*\/plugins\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[?#"'/]|$)/gi)) add(match[1], match[2])
  return [...found.values()]
}

export const PLUGIN_CATEGORIES = Object.freeze([
  { id: 'agent', label: 'Agent 与编排', terms: ['agent', 'agents', 'harness', 'orchestrat', 'workflow', 'multi-agent', '智能体', '编排', '工作流'] },
  { id: 'skills', label: 'Skill 与知识', terms: ['skill', 'skills', 'prompt', 'memory', 'knowledge', 'rag', '知识', '记忆', '提示词'] },
  { id: 'ui', label: '界面与桌面', terms: ['ui', 'web-ui', 'tui', 'sidebar', 'desktop', 'frontend', 'theme', '界面', '侧边栏', '桌面', '主题'] },
  { id: 'developer', label: '开发工具', terms: ['devtool', 'developer', 'coding', 'code', 'debug', 'mcp', 'cli', 'sdk', 'terminal', '开发', '代码', '调试'] },
  { id: 'browser', label: '浏览器与自动化', terms: ['browser', 'playwright', 'selenium', 'automation', 'crawler', 'scraper', 'web scraping', '浏览器', '自动化', '爬虫'] },
  { id: 'data', label: '数据与搜索', terms: ['data', 'database', 'sql', 'search', 'vector', 'analytics', 'dataset', '数据', '数据库', '搜索', '分析'] },
  { id: 'design', label: '设计与媒体', terms: ['design', 'image', 'video', 'audio', 'diagram', 'canvas', 'media', 'drawing', '设计', '图片', '视频', '音频', '图表'] },
  { id: 'integration', label: '协作与集成', terms: ['integration', 'slack', 'discord', 'telegram', 'lark', 'feishu', 'wechat', 'github', 'notion', '协作', '集成', '飞书', '微信'] },
  { id: 'ops', label: '运维与安全', terms: ['security', 'auth', 'deploy', 'docker', 'kubernetes', 'monitor', 'observability', 'proxy', '安全', '部署', '监控', '运维'] },
  { id: 'collection', label: '插件集合', terms: ['awesome', 'collection', 'marketplace', 'registry', 'directory', 'curated', '合集', '插件市场', '目录'] },
])

export function classifyPlugin(repo) {
  const fields = [
    { value: `${repo.name ?? ''} ${repo.full_name ?? repo.fullName ?? ''} ${repo.packageName ?? ''}`, weight: 4, source: '名称' },
    { value: [...(Array.isArray(repo.topics) ? repo.topics : []), ...(Array.isArray(repo.keywords) ? repo.keywords : [])].join(' '), weight: 3, source: '标签' },
    { value: `${repo.description ?? ''} ${repo.descriptionZh ?? repo.description_zh ?? ''}`, weight: 1, source: '描述' },
  ]
  const ranked = PLUGIN_CATEGORIES.map((category) => {
    let score = 0; const evidence = []
    for (const field of fields) { const text = field.value.toLowerCase(); const matches = category.terms.filter((term) => text.includes(term.toLowerCase())); if (matches.length) { score += field.weight * Math.min(matches.length, 3); evidence.push(`${field.source}: ${[...new Set(matches)].slice(0, 3).join(', ')}`) } }
    return { id: category.id, label: category.label, score, confidence: score >= 8 ? 'high' : score >= 4 ? 'medium' : 'low', evidence }
  }).filter((category) => category.score >= 2).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 3)
  if (!ranked.length) return { primary: { id: 'other', label: '其他', score: 0, confidence: 'low', evidence: ['未匹配到明确功能关键词'] }, categories: [] }
  return { primary: ranked[0], categories: ranked }
}

export function repositoryAvatarUrl(repositoryUrl) {
  try { const url = new URL(repositoryUrl); const owner = url.hostname === 'github.com' && url.pathname.split('/').filter(Boolean)[0]; return owner && /^[A-Za-z0-9-]+$/.test(owner) ? `https://github.com/${owner}.png?size=96` : undefined } catch { return undefined }
}
export function safeIconUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined } catch { return undefined }
}
export function manifestIconUrl(manifest, rawBaseUrl) {
  const value = manifest?.icon ?? manifest?.logo
  const absolute = safeIconUrl(value); if (absolute) return absolute
  if (typeof value !== 'string' || !rawBaseUrl || value.startsWith('/') || value.includes('..')) return undefined
  return safeIconUrl(new URL(value, rawBaseUrl).toString())
}

export function normalizeCatalogItem(repo, sourceId = OFFICIAL_SOURCE.id) {
  const topics = Array.isArray(repo.topics) ? repo.topics.filter((x) => typeof x === 'string') : []
  const packageName = typeof repo.packageName === 'string' ? repo.packageName : undefined
  const fullName = String(repo.full_name ?? repo.fullName ?? repo.name ?? '')
  const htmlUrl = String(repo.html_url ?? repo.repositoryUrl ?? repo.url ?? '')
  const owner = fullName.split('/')[0]
  const iconUrl = safeIconUrl(repo.icon ?? repo.logo ?? repo.image ?? repo.owner?.avatar_url) ?? (owner && /^[A-Za-z0-9-]+$/.test(owner) ? `https://github.com/${owner}.png?size=96` : undefined)
  return {
    id: `${sourceId}:${fullName || htmlUrl}`,
    name: String(repo.name ?? fullName.split('/').pop() ?? 'Unnamed plugin'),
    displayName: typeof repo.displayName === 'string' && repo.displayName.trim() ? repo.displayName.trim() : undefined,
    fullName,
    description: typeof repo.description === 'string' ? repo.description : '',
    descriptionZh: typeof (repo.descriptionZh ?? repo.description_zh ?? repo.descriptionChinese) === 'string' ? (repo.descriptionZh ?? repo.description_zh ?? repo.descriptionChinese) : undefined,
    repositoryUrl: htmlUrl,
    iconUrl,
    homepageUrl: typeof repo.homepage === 'string' && repo.homepage ? repo.homepage : undefined,
    packageName,
    installSpec: packageName ?? (fullName ? `github:${fullName}` : htmlUrl),
    stars: Number(repo.stargazers_count ?? repo.stars ?? 0),
    forks: Number(repo.forks_count ?? repo.forks ?? 0),
    language: repo.language ?? undefined,
    license: typeof repo.license === 'string' ? repo.license : repo.license?.spdx_id ?? repo.license?.name ?? repo.license?.key ?? undefined,
    topics,
    defaultBranch: repo.default_branch ?? repo.defaultBranch ?? undefined,
    updatedAt: repo.updated_at ?? repo.updatedAt ?? undefined,
    pushedAt: repo.pushed_at ?? repo.pushedAt ?? undefined,
    sourceId,
    sourceType: repo.sourceType ?? 'github-topic',
    curatedCategory: typeof repo.curatedCategory === 'string' ? repo.curatedCategory : undefined,
    distribution: repo.distribution ?? (packageName ? 'npm' : 'github'),
    classification: classifyPlugin(repo),
    verification: repo.verification ?? {
      hasPackageJson: false,
      declaresDshBundle: false,
      packageNameMatched: false,
      hasInstallScripts: false,
      hasNativeDependencies: false,
    },
  }
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
function isPrivateAddress(address) {
  let host = String(address ?? '').trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host || host === '::1' || host === '::' || host.toLowerCase().startsWith('fc') || host.toLowerCase().startsWith('fd') || host.toLowerCase().startsWith('fe80:')) return true
  const mapped = host.toLowerCase().match(/^::ffff:(.*)$/)
  if (mapped) {
    const tail = mapped[1]
    if (tail.includes('.')) return isPrivateIpv4(tail.replace(/^0+:/, '').split(':').pop() ?? '')
    const groups = tail.split(':').filter(Boolean)
    if (groups.length === 2) {
      const a = Number.parseInt(groups[0] || '0', 16); const b = Number.parseInt(groups[1] || '0', 16)
      if (Number.isInteger(a) && Number.isInteger(b)) return isPrivateIpv4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`)
    }
    return true
  }
  return isPrivateIpv4(host)
}
export async function assertPublicHttpsUrl(input) {
  let url
  try { url = new URL(String(input ?? '').trim()) } catch { throw new PluginManagerError('invalid-source', '插件源地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new PluginManagerError('invalid-source', '插件源必须使用无凭据的 HTTPS 地址')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || isPrivateAddress(hostname)) throw new PluginManagerError('unsafe-source', '插件源不能指向本机或私有网络')
  let addresses
  try {
    addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new PluginManagerError('dns-timeout', '插件源域名解析超时', 422)
    throw error
  }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new PluginManagerError('unsafe-source', '插件源解析到本机或私有网络')
  return url
}
function majorOf(range) {
  const match = String(range).match(/(?:^|[^0-9])(\d+)(?:\.|$)/)
  return match ? Number(match[1]) : undefined
}
function rangesCompatible(installed, requested) {
  const have = majorOf(installed); const want = majorOf(requested)
  return have === undefined || want === undefined || have === want
}
function packageRepo(manifest) {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (typeof raw !== 'string') return undefined
  try { return normalizeRepositoryUrl(raw).repositoryUrl.toLowerCase() } catch { return raw.replace(/^git\+/, '').replace(/\.git$/, '').toLowerCase() }
}
function capabilitiesOf(manifest) {
  const declared = manifest.dsh?.plugin?.capabilities
  if (Array.isArray(declared)) return declared.filter(isObject).map((x) => ({ id: String(x.id ?? x.name ?? ''), type: String(x.type ?? 'service'), name: String(x.name ?? x.id ?? '') })).filter((x) => x.id)
  const caps = []
  if (manifest.dsh?.bundle?.patch) caps.push({ id: `profile-bundle:${manifest.name}`, type: 'profile-bundle', name: manifest.name })
  return caps
}
function dependencyRecord(manifest) {
  return { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}), ...(manifest.peerDependencies ?? {}) }
}

function dependencyOwners(current, excluded = new Set()) {
  const owners = new Map()
  for (const plugin of current.plugins ?? []) {
    if (excluded.has(plugin.packageName)) continue
    for (const [name, requested] of Object.entries(dependencyRecord(plugin.manifest ?? {}))) {
      const entries = owners.get(name) ?? []
      entries.push({ plugin: plugin.packageName, requested: String(requested) })
      owners.set(name, entries)
    }
  }
  return owners
}

export function analyzeInstall(current, candidate) {
  const installed = current.plugins ?? []
  const repo = packageRepo(candidate)
  const duplicate = installed.find((plugin) => plugin.packageName === candidate.name || (repo && plugin.repositoryUrl?.toLowerCase() === repo))
  const reused = []
  const versionConflicts = []
  const additions = []
  const owners = dependencyOwners(current)
  const currentVersions = new Map(current.packages.map((entry) => [entry.name, entry.version]))
  for (const [name, range] of Object.entries(dependencyRecord(candidate))) {
    const requested = String(range)
    const sharedWith = owners.get(name) ?? []
    if (currentVersions.has(name)) {
      const row = { name, currentVersion: currentVersions.get(name), requested, sharedWith: sharedWith.map((entry) => entry.plugin) }
      if (rangesCompatible(row.currentVersion, row.requested)) reused.push(row)
      else versionConflicts.push(row)
    } else additions.push({ name, requested, sharedWith: sharedWith.map((entry) => entry.plugin) })
  }
  const incomingCaps = capabilitiesOf(candidate)
  const overlaps = []
  for (const capability of incomingCaps) {
    for (const plugin of installed) {
      const match = (plugin.capabilities ?? []).find((existing) => existing.id === capability.id || (existing.type === capability.type && existing.name === capability.name))
      if (match) overlaps.push({ capability, plugin: plugin.packageName, severity: 'hard' })
    }
  }
  const conflictsWith = new Set(candidate.dsh?.plugin?.conflictsWith ?? [])
  for (const plugin of installed) {
    for (const capability of plugin.capabilities ?? []) {
      if (conflictsWith.has(capability.id) || conflictsWith.has(plugin.packageName)) overlaps.push({ capability, plugin: plugin.packageName, severity: 'hard' })
    }
  }
  const scripts = Object.entries(candidate.scripts ?? {}).filter(([name]) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(name)).map(([name, command]) => ({ name, command: String(command) }))
  const nativeDependencies = Object.keys(dependencyRecord(candidate)).filter((name) => /(?:node-pty|better-sqlite3|sharp|canvas|ffi|native|binding)/i.test(name))
  const text = `${candidate.name ?? ''} ${candidate.description ?? ''} ${(candidate.keywords ?? []).join(' ')}`
  const risks = [
    ...scripts.map((script) => ({ level: 'warning', kind: 'install-script', label: `安装脚本：${script.name}`, detail: script.command })),
    ...nativeDependencies.map((name) => ({ level: 'warning', kind: 'native-dependency', label: `原生依赖：${name}`, detail: '可能需要本机构建工具或预编译二进制' })),
    ...overlaps.filter((overlap) => overlap.severity === 'hard').map((overlap) => ({ level: 'error', kind: 'capability-conflict', label: `能力冲突：${overlap.capability.name || overlap.capability.id}`, detail: `与已安装插件 ${overlap.plugin} 重叠` })),
    /\b(tui|cli|tty|terminal)\b|终端|命令行/i.test(text) ? [{ level: 'info', kind: 'terminal-surface', label: '终端/CLI 表面', detail: '该插件可能不提供 Web UI 功能' }] : [],
  ].flat()
  const integration = dshIntegrationOf(candidate)
  if (!integration.eligible) risks.unshift({ level: 'error', kind: 'not-dsh-plugin', label: '未声明 DSH Bundle', detail: '插件中心只安装可自动集成并启用的 DSH 插件；package.json 必须声明 dsh.bundle.patch。' })
  return { duplicate, reused, additions, versionConflicts, overlaps, capabilities: incomingCaps, scripts, nativeDependencies, risks, integration }
  }

export function dshIntegrationOf(manifest) {
  const patch = manifest?.dsh?.bundle?.patch
  return { eligible: typeof patch === 'string' && patch.trim().length > 0, patch: typeof patch === 'string' ? patch : undefined }
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (fallback !== undefined && error?.code === 'ENOENT') return fallback
    throw error
  }
}
export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}
export async function exists(path) { try { await access(path, fsConstants.F_OK); return true } catch { return false } }

export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    let child
    try { child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { reject(error); return }
    const timeout = Number(options.timeout ?? 0)
    let timedOut = false
    let timer
    if (timeout > 0) timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    let stdout = ''; let stderr = ''
    const onData = (kind) => (chunk) => { const text = chunk.toString(); if (kind === 'stdout') stdout += text; else stderr += text; options.onLog?.(kind, text) }
    child.stdout.on('data', onData('stdout')); child.stderr.on('data', onData('stderr'))
    child.once('error', (error) => { if (timer) clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { if (timer) clearTimeout(timer); resolveRun({ code: code ?? 1, signal, timedOut, stdout, stderr }) })
  })
}

async function profilePnpmEnv(dir) {
  const modules = await readJson(join(dir, 'node_modules', '.modules.yaml'), {})
  const storeDir = typeof modules.storeDir === 'string' && modules.storeDir.startsWith('/') ? modules.storeDir : undefined
  return storeDir ? { ...process.env, npm_config_store_dir: storeDir } : process.env
}

export class SourceStore {
  constructor(home) { this.path = join(home, 'plugin-sources.json') }
  async list() {
    const document = await readJson(this.path, { schemaVersion: 1, sources: [] })
    return [OFFICIAL_SOURCE, ...document.sources.filter((source) => source.id !== OFFICIAL_SOURCE.id)]
  }
  async save(sources) {
    await atomicWriteJson(this.path, { schemaVersion: 1, sources: sources.filter((source) => source.id !== OFFICIAL_SOURCE.id) })
    return this.list()
  }
  async add(input) {
    const sources = await this.list()
    const url = await assertPublicHttpsUrl(input.url ?? '')
    const type = String(input.type ?? '')
    if (!['json', 'github-topic', 'web'].includes(type)) throw new PluginManagerError('invalid-source', '仅支持 JSON、网页与 GitHub Topic 插件源')
    if (type === 'github-topic' && url.toString() === OFFICIAL_SOURCE.url) throw new PluginManagerError('builtin-source', '官方 dsh-plugin Topic 已内置，无需重复添加')
    if (sources.some((source) => source.type === type && source.url === url.toString())) throw new PluginManagerError('duplicate-source', '相同地址与类型的插件源已经存在')
    let topic
    if (type === 'github-topic') {
      topic = String(input.topic ?? url.pathname.split('/').filter(Boolean).pop() ?? '').trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(topic)) throw new PluginManagerError('invalid-source', 'GitHub Topic 名称无效')
    }
    const id = input.id ? String(input.id) : `source-${stableHash(url.toString()).slice(0, 10)}`
    if (sources.some((source) => source.id === id)) throw new PluginManagerError('duplicate-source', '插件源已经存在')
    sources.push({ id, name: String(input.name || url.hostname), type, url: url.toString(), topic, enabled: input.enabled !== false, trusted: input.trusted === true, builtin: false })
    return this.save(sources)
  }
  async remove(id) {
    if (id === OFFICIAL_SOURCE.id) throw new PluginManagerError('builtin-source', '官方插件源不能删除')
    return this.save((await this.list()).filter((source) => source.id !== id))
  }
}

export class CatalogService {
  constructor(home, sources, fetchImpl = fetch) { this.home = home; this.sources = sources; this.fetch = fetchImpl; this.cacheDir = join(home, 'cache', 'plugin-manager') }
  async cached(key, ttl, loader) {
    const path = join(this.cacheDir, `${stableHash(key)}.json`)
    let cached
    try { cached = await readJson(path, null) } catch { cached = null }
    if (cached && Date.now() - cached.savedAt < ttl) return { ...cached.value, cache: { stale: false, savedAt: cached.savedAt } }
    try { const value = await loader(); await atomicWriteJson(path, { savedAt: Date.now(), value }); return { ...value, cache: { stale: false, savedAt: Date.now() } } }
    catch (error) { if (cached) return { ...cached.value, cache: { stale: true, savedAt: cached.savedAt, error: error.message } }; throw error }
  }
  headers() { return { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-manager', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } }
  async curatedRegistry() {
    return this.cached('curated-registry', 60 * 60_000, async () => {
      const response = await this.fetch(CURATED_REGISTRY_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) throw new PluginManagerError('curated-error', `精选目录返回 HTTP ${response.status}`, 502)
      const data = await response.json()
      if (!Array.isArray(data.plugins) || !data.plugins.length) throw new PluginManagerError('curated-schema', '精选目录格式无效', 502)
      const items = data.plugins.slice(0, 2_000).flatMap((plugin) => {
        try {
          const parsed = normalizeRepositoryUrl(plugin.url); if (parsed.kind !== 'github') return []
          return [normalizeCatalogItem({ name: plugin.name ?? parsed.repo, full_name: `${parsed.owner}/${parsed.repo}`, html_url: parsed.repositoryUrl, packageName: typeof plugin.npm === 'string' && plugin.npm ? plugin.npm : undefined, description: plugin.description?.en ?? '', descriptionZh: plugin.description?.zh, stargazers_count: plugin.stars ?? 0, updated_at: plugin.added, topics: [plugin.category].filter(Boolean), sourceType: 'curated', curatedCategory: plugin.category, distribution: plugin.npm ? 'npm' : 'github' }, CURATED_SOURCE_ID)]
        } catch { return [] }
      })
      return { items, total: items.length, registryUpdated: data.updated }
    })
  }
  async githubSearch(topic, query = '', sort = 'stars', page = 1, sourceId = OFFICIAL_SOURCE.id) {
    const q = [`topic:${topic}`, query.trim()].filter(Boolean).join(' ')
    return this.cached(`github:v3:${q}:${sort}:${page}`, 5 * 60_000, async () => {
      const url = new URL('https://api.github.com/search/repositories'); url.searchParams.set('q', q); url.searchParams.set('sort', sort === 'updated' ? 'updated' : 'stars'); url.searchParams.set('order', 'desc'); url.searchParams.set('per_page', String(GITHUB_SEARCH_PAGE_SIZE)); url.searchParams.set('page', String(page))
      const response = await this.fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(12_000) })
      if (!response.ok) throw new PluginManagerError('github-error', `GitHub API 返回 HTTP ${response.status}`, 502)
      const data = await response.json()
      return { items: data.items.map((repo) => normalizeCatalogItem(repo, sourceId)), total: data.total_count, page, pageSize: GITHUB_SEARCH_PAGE_SIZE }
    })
  }
  async githubTopicCatalog(topic, sourceId = OFFICIAL_SOURCE.id, query = '', sort = 'stars') {
    const first = await this.githubSearch(topic, query, sort, 1, sourceId)
    if (query) return { ...first, loaded: first.items.length, available: first.total, capped: first.total > GITHUB_SEARCH_MAX_RESULTS }
    const pageCount = Math.min(Math.ceil(first.total / GITHUB_SEARCH_PAGE_SIZE), GITHUB_SEARCH_MAX_RESULTS / GITHUB_SEARCH_PAGE_SIZE)
    const pages = await Promise.allSettled(Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => this.githubSearch(topic, '', sort, index + 2, sourceId)))
    const items = [...first.items]
    const errors = []
    for (const page of pages) {
      if (page.status === 'fulfilled') items.push(...page.value.items)
      else errors.push(page.reason?.message ?? String(page.reason))
    }
    return { items, total: first.total, loaded: items.length, available: first.total, capped: first.total > GITHUB_SEARCH_MAX_RESULTS, partial: errors.length > 0, pageErrors: errors, cache: first.cache }
  }
  async officialTopicCatalog(query = '', sort = 'stars') {
    return this.githubTopicCatalog(OFFICIAL_SOURCE.topic, OFFICIAL_SOURCE.id, query, sort)
  }
  async readTextLimited(response, maxBytes = 8 * 1024 * 1024) {
    if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes)
    const reader = response.body.getReader(); const chunks = []; let size = 0
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; const remaining = maxBytes - size; if (remaining <= 0) break; chunks.push(value.length <= remaining ? value : value.slice(0, remaining)); size += Math.min(value.length, remaining); if (size >= maxBytes) break } } finally { await reader.cancel().catch(() => {}) }
    const merged = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
    return new TextDecoder().decode(merged)
  }
  webRegistryItems(data, source) {
    const rows = Array.isArray(data) ? data : Array.isArray(data?.plugins) ? data.plugins : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : []
    return rows.slice(0, 2_000).flatMap((plugin) => {
      const repository = plugin.repositoryUrl ?? plugin.repository ?? plugin.url ?? plugin.github ?? (plugin.owner && plugin.repo ? `https://github.com/${plugin.owner}/${plugin.repo}` : undefined)
      try {
        const parsed = normalizeRepositoryUrl(repository); if (parsed.kind !== 'github') return []
        return [normalizeCatalogItem({ ...plugin, name: plugin.name ?? parsed.repo, full_name: plugin.fullName ?? `${parsed.owner}/${parsed.repo}`, html_url: parsed.repositoryUrl, descriptionZh: plugin.descriptionZh ?? plugin.description_zh, stargazers_count: plugin.stars ?? plugin.stargazers_count ?? 0, forks_count: plugin.forks ?? 0, topics: plugin.topics ?? plugin.tags ?? [], updated_at: plugin.updatedAt ?? plugin.updated_at, pushed_at: plugin.pushedAt ?? plugin.pushed_at, sourceType: 'web-registry', score: plugin.score?.total, scoreConfidence: plugin.score?.confidence }, source.id)]
      } catch { return [] }
    })
  }
  async discoverWebRegistry(url, source) {
    const candidates = [new URL('plugins.json', url), new URL('api/plugins', url)]
    for (const candidate of candidates) {
      try {
        const response = await this.fetch(candidate, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' })
        if (!response.ok) continue
        const contentType = response.headers.get('content-type') || ''; if (!/application\/json|text\/json/i.test(contentType)) continue
        const data = JSON.parse(await this.readTextLimited(response)); const items = this.webRegistryItems(data, source)
        if (items.length) return { items, total: items.length, registryUrl: candidate.toString(), registryGeneratedAt: data.generatedAt ?? data.updated }
      } catch { /* Probe failures are expected for ordinary webpages. */ }
    }
    return undefined
  }
  async customSource(source) {
    return this.cached(`source:${source.id}`, 10 * 60_000, async () => {
      if (source.type === 'github-topic') {
        const topic = source.topic || source.url.split('/').filter(Boolean).pop()
        return this.githubTopicCatalog(topic, source.id, '', 'stars')
      }
      const url = await assertPublicHttpsUrl(source.url)
      if (source.type === 'web') {
        const response = await this.fetch(url, { headers: { accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(20_000), redirect: 'error' })
        if (!response.ok) throw new PluginManagerError('source-error', `网页源返回 HTTP ${response.status}`, 502)
        const type = response.headers.get('content-type') || ''; if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) throw new PluginManagerError('source-type', `网页源返回不支持的类型 ${type || 'unknown'}`, 502)
        const plugins = extractRepositoriesFromHtml(await this.readTextLimited(response), url.toString())
        if (plugins.length) return { items: plugins.map((plugin) => normalizeCatalogItem(plugin, source.id)), total: plugins.length }
        const registry = await this.discoverWebRegistry(url, source)
        if (registry) return registry
        throw new PluginManagerError('source-empty', '网页中未发现 GitHub 插件仓库链接或公开插件目录', 502)
      }
      const response = await this.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000), redirect: 'error' })
      if (!response.ok) throw new PluginManagerError('source-error', `插件源返回 HTTP ${response.status}`, 502)
      const data = await response.json()
      if (data.schemaVersion !== 1 || !Array.isArray(data.plugins)) throw new PluginManagerError('source-schema', '插件源格式无效', 502)
      return { items: data.plugins.map((plugin) => normalizeCatalogItem({ ...plugin, full_name: plugin.fullName ?? plugin.name, html_url: plugin.repository, stargazers_count: plugin.stars ?? 0, sourceType: 'json' }, source.id)), total: data.plugins.length }
    })
  }
  mergeCatalogItems(items) {
    const byRepository = new Map()
    for (const item of items) {
      const key = (item.repositoryUrl || item.fullName).toLowerCase(); const previous = byRepository.get(key)
      if (!previous) { byRepository.set(key, { ...item, sources: [item.sourceId] }); continue }
      const curated = item.sourceId === CURATED_SOURCE_ID ? item : previous.sourceId === CURATED_SOURCE_ID ? previous : undefined
      const realtime = item.sourceId === CURATED_SOURCE_ID ? previous : item
      const merged = { ...curated, ...realtime, packageName: realtime.packageName ?? curated?.packageName, installSpec: realtime.packageName ? realtime.installSpec : curated?.installSpec ?? realtime.installSpec, descriptionZh: realtime.descriptionZh ?? curated?.descriptionZh, description: realtime.description || curated?.description || '', stars: Math.max(Number(realtime.stars ?? 0), Number(curated?.stars ?? 0)), distribution: realtime.packageName || curated?.packageName ? 'npm' : 'github', curatedCategory: curated?.curatedCategory, sources: [...new Set([...(previous.sources ?? [previous.sourceId]), item.sourceId])] }
      merged.classification = classifyPlugin({ ...merged, keywords: merged.topics })
      byRepository.set(key, merged)
    }
    const byPackage = new Map()
    for (const item of byRepository.values()) {
      const key = item.packageName?.trim().toLowerCase()
      if (!key) { byPackage.set(`repository:${item.repositoryUrl || item.fullName}`.toLowerCase(), item); continue }
      const previous = byPackage.get(`package:${key}`)
      if (!previous) { byPackage.set(`package:${key}`, item); continue }
      const score = (candidate) => Number(Boolean(candidate.descriptionZh)) * 4 + Number(Boolean(candidate.description)) * 2 + Number(Boolean(candidate.repositoryUrl)) + Math.min(Number(candidate.stars ?? 0) / 1_000_000, 1)
      const preferred = score(item) > score(previous) ? item : previous; const fallback = preferred === item ? previous : item
      const merged = {
        ...fallback,
        ...preferred,
        packageName: preferred.packageName ?? fallback.packageName,
        installSpec: preferred.installSpec ?? fallback.installSpec,
        descriptionZh: preferred.descriptionZh ?? fallback.descriptionZh,
        description: preferred.description ?? fallback.description ?? '',
        stars: Math.max(Number(preferred.stars ?? 0), Number(fallback.stars ?? 0)),
        topics: [...new Set([...(preferred.topics ?? []), ...(fallback.topics ?? [])])],
        sources: [...new Set([...(previous.sources ?? [previous.sourceId]), ...(item.sources ?? [item.sourceId])])],
      }
      merged.classification = classifyPlugin({ ...merged, keywords: merged.topics })
      byPackage.set(`package:${key}`, merged)
    }
    return [...byPackage.values()].map((item) => ({ ...item, iconUrl: item.iconUrl ?? repositoryAvatarUrl(item.repositoryUrl) }))
  }
  async list(query = '', sort = 'stars') {
    const enabled = (await this.sources.list()).filter((source) => source.enabled !== false)
    const catalogSources = [{ id: CURATED_SOURCE_ID, name: '精选 DSH 目录', type: 'curated', builtin: true }, ...enabled]
    const results = await Promise.allSettled(catalogSources.map((source) => source.type === 'curated' ? this.curatedRegistry() : source.id === OFFICIAL_SOURCE.id ? this.officialTopicCatalog(query, sort) : this.customSource(source)))
    const items = []; const errors = []; const sourceResults = []
    results.forEach((result, index) => { const source = catalogSources[index]; if (result.status === 'fulfilled') { items.push(...result.value.items); sourceResults.push({ sourceId: source.id, name: source.name, status: 'loaded', count: result.value.items.length, available: result.value.available ?? result.value.total, capped: result.value.capped === true, partial: result.value.partial === true, cache: result.value.cache, registryUpdated: result.value.registryUpdated }) } else { const message = result.reason?.message ?? String(result.reason); errors.push({ sourceId: source.id, message }); sourceResults.push({ sourceId: source.id, name: source.name, status: 'error', count: 0, message }) } })
    const unique = this.mergeCatalogItems(items)
    if (query) { const needle = query.toLowerCase(); unique.splice(0, unique.length, ...unique.filter((item) => `${item.name} ${item.fullName} ${item.description} ${item.topics.join(' ')}`.toLowerCase().includes(needle))) }
    const compare = sort === 'updated' ? (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) : (a, b) => b.stars - a.stars
    unique.sort((a, b) => {
      if (query) {
        const officialDelta = Number(Boolean(b.sources?.includes(OFFICIAL_SOURCE.id))) - Number(Boolean(a.sources?.includes(OFFICIAL_SOURCE.id)))
        if (officialDelta) return officialDelta
      }
      return compare(a, b)
    })
    return { items: unique, total: unique.length, errors, sourceResults }
  }
  async resolve(input) {
    const parsed = normalizeRepositoryUrl(input)
    if (parsed.kind === 'npm') {
      const response = await this.fetch(`https://registry.npmjs.org/${encodeURIComponent(parsed.packageName)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) throw new PluginManagerError('resolve-error', `npm registry 返回 HTTP ${response.status}`, 502)
      const data = await response.json(); const latest = data['dist-tags']?.latest; const manifest = data.versions?.[latest] ?? data
      return { item: { ...normalizeCatalogItem({ name: parsed.packageName, full_name: parsed.packageName, html_url: packageRepo(manifest) ?? parsed.repositoryUrl, description: manifest.description, packageName: parsed.packageName, license: manifest.license, sourceType: 'url' }, 'url'), iconUrl: manifestIconUrl(manifest) }, manifest, readme: typeof data.readme === 'string' ? data.readme.slice(0, 200_000) : '', detail: { latestVersion: latest, homepage: manifest.homepage, keywords: Array.isArray(manifest.keywords) ? manifest.keywords.slice(0, 30) : [] } }
    }
    if (parsed.kind === 'huggingface') {
      const apiPath = parsed.space ? 'spaces' : 'models'
      const metadataResponse = await this.fetch(`https://huggingface.co/api/${apiPath}/${parsed.owner}/${parsed.repo}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
      const metadata = metadataResponse.ok ? await metadataResponse.json() : {}
      const ref = parsed.ref ?? metadata.sha ?? 'main'
      const rawBaseUrl = `https://huggingface.co/${parsed.sourcePath}/resolve/${encodeURIComponent(ref)}/`
      let manifest = { name: parsed.repo, repository: parsed.repositoryUrl }
      try {
        const response = await this.fetch(`${rawBaseUrl}package.json`, { signal: AbortSignal.timeout(12_000) })
        if (response.ok) manifest = await response.json()
      } catch { /* Missing manifests are rejected later as non-DSH projects. */ }
      let readme = ''; let readmePath = 'README.md'
      for (const path of ['README.zh.md', 'README_zh.md', 'README.md', 'readme.md']) {
        try {
          const response = await this.fetch(`${rawBaseUrl}${path}`, { signal: AbortSignal.timeout(12_000) })
          if (!response.ok) continue
          readme = await this.readTextLimited(response, 200_000); readmePath = path; break
        } catch { /* Try the next conventional README name. */ }
      }
      const repo = { name: parsed.repo, full_name: parsed.sourcePath, html_url: parsed.repositoryUrl, description: metadata.cardData?.description ?? metadata.description ?? '', tags: metadata.tags ?? [], lastModified: metadata.lastModified }
      return { item: { ...normalizeCatalogItem({ ...repo, packageName: manifest.name, sourceType: 'huggingface', distribution: 'huggingface' }, 'url'), installSpec: parsed.installSpec, iconUrl: manifestIconUrl(manifest, rawBaseUrl) }, manifest, readme, detail: { defaultBranch: ref, homepage: parsed.repositoryUrl, keywords: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 30) : [], repositoryUrl: parsed.repositoryUrl, rawBaseUrl, readmePath, huggingFace: true, space: parsed.space } }
    }
    const response = await this.fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, { headers: this.headers(), signal: AbortSignal.timeout(12_000) })
    const apiAvailable = response.ok
    const repo = apiAvailable ? await response.json() : { name: parsed.repo, full_name: `${parsed.owner}/${parsed.repo}`, html_url: parsed.repositoryUrl, default_branch: undefined }
    const refs = parsed.ref ? [parsed.ref] : [...new Set([repo.default_branch, 'main', 'master'].filter(Boolean))]
    let ref = refs[0]; let manifest = { name: repo.name, repository: repo.html_url }
    const manifestProbes = await Promise.allSettled(refs.map(async (candidateRef) => ({ candidateRef, response: await this.fetch(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(candidateRef)}/package.json`, { signal: AbortSignal.timeout(12_000) }) })))
    for (const probe of manifestProbes) {
      if (probe.status !== 'fulfilled' || !probe.value.response.ok) continue
      try { manifest = await probe.value.response.json(); ref = probe.value.candidateRef; break } catch { /* non-JSON response is not a manifest */ }
    }
    const chinesePaths = ['README.zh.md', 'README_zh.md', 'README-CN.md', 'README.cn.md', 'README_zh-CN.md']
    const readmeCandidates = [...chinesePaths.map((path) => ({ path, language: 'zh' })), { path: 'README.md' }, { path: 'readme.md' }, { path: 'README.MD' }]
    let readme = ''; let readmeLanguage = 'default'; let readmePath = 'README.md'
    const readmeProbes = await Promise.allSettled(readmeCandidates.map(async ({ path, language = 'default' }) => ({ path, language, response: await this.fetch(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(ref)}/${path}`, { signal: AbortSignal.timeout(12_000) }) })))
    for (const probe of readmeProbes) {
      if (probe.status !== 'fulfilled' || !probe.value.response.ok) continue
      readme = await this.readTextLimited(probe.value.response, 200_000); readmeLanguage = probe.value.language; readmePath = probe.value.path; break
    }
    return { item: { ...normalizeCatalogItem({ ...repo, packageName: manifest.name }, 'url'), installSpec: parsed.installSpec, iconUrl: manifestIconUrl(manifest, `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(ref)}/`) ?? normalizeCatalogItem(repo, 'url').iconUrl }, manifest, readme, detail: { defaultBranch: ref, openIssues: apiAvailable ? repo.open_issues_count : undefined, homepage: repo.homepage, keywords: Array.isArray(manifest.keywords) ? manifest.keywords.slice(0, 30) : [], archived: repo.archived === true, fork: repo.fork === true, apiLimited: !apiAvailable, readmeLanguage, readmePath, repositoryUrl: parsed.repositoryUrl, rawBaseUrl: `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(ref)}/` } }
  }
  async readReadme(input, refInput, pathInput) {
    const parsed = normalizeRepositoryUrl(input)
    if (parsed.kind !== 'github') throw new PluginManagerError('bad-request', '页内文档仅支持 GitHub 仓库')
    const ref = String(refInput || parsed.ref || 'main')
    const path = String(pathInput || '').replace(/^\.\//, '')
    if (!/^[A-Za-z0-9._/-]+\.(?:md|markdown)$/i.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new PluginManagerError('bad-request', 'README 文档路径无效')
    if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.split('/').includes('..')) throw new PluginManagerError('bad-request', '仓库 ref 无效')
    const response = await this.fetch(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new PluginManagerError('readme-error', `文档读取返回 HTTP ${response.status}`, response.status === 404 ? 404 : 502)
    const directory = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}` : ''
    return { readme: await this.readTextLimited(response, 200_000), path, detail: { defaultBranch: ref, readmePath: path, repositoryUrl: parsed.repositoryUrl, rawBaseUrl: `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(ref)}/${directory}` } }
  }
}

export class ProfileInspector {
  constructor(home) { this.home = home }
  profileDir(profile) {
    if (!/^[A-Za-z0-9._-]+$/.test(profile)) throw new PluginManagerError('invalid-profile', 'Profile 名称无效')
    return join(this.home, 'profiles', profile)
  }
  async profiles() {
    const path = join(this.home, 'profiles')
    const { readdir } = await import('node:fs/promises')
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  }
  async inspect(profile) {
    const dir = this.profileDir(profile)
    const manifest = await readJson(join(dir, 'package.json'))
    const lock = await readJson(join(dir, 'node_modules', '.modules.yaml'), {})
    const packages = []
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      const installedManifest = await readJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'), null)
      packages.push({ name, version: installedManifest?.version ?? String(spec), requested: String(spec), manifest: installedManifest })
    }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const plugins = packages.map((entry) => ({
      packageName: entry.name, displayName: typeof entry.manifest?.displayName === 'string' && entry.manifest.displayName.trim() ? entry.manifest.displayName.trim() : undefined, version: entry.version, requested: entry.requested, manifest: entry.manifest, manifestPresent: Boolean(entry.manifest),
      repositoryUrl: entry.manifest ? packageRepo(entry.manifest) : undefined,
      description: entry.manifest?.description ?? '', isBundle: Boolean(entry.manifest?.dsh?.bundle?.patch), bundleEnabled: bundles.includes(entry.name),
      dependencies: entry.manifest?.dependencies ?? {}, peerDependencies: entry.manifest?.peerDependencies ?? {}, optionalDependencies: entry.manifest?.optionalDependencies ?? {},
      capabilities: entry.manifest ? capabilitiesOf(entry.manifest) : [], health: entry.manifest ? 'healthy' : 'broken',
    }))
    return { profile, dir, manifest, bundles, packages: packages.map(({ name, version, requested }) => ({ name, version, requested })), plugins, nodeVersion: process.version, platform: process.platform, architecture: process.arch, lockPresent: Boolean(lock) }
  }
}

function versionParts(value) {
  const match = String(value ?? '').trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/)
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0), match[4] ?? ''] : null
}

export function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  if (a[3] === b[3]) return 0
  if (!a[3]) return 1
  if (!b[3]) return -1
  return a[3] > b[3] ? 1 : -1
}

function packageDir(profileDir, packageName) { return join(profileDir, 'node_modules', ...packageName.split('/')) }

/** Resolve a GitHub source for an installed plugin: manifest.repository, the inspected repositoryUrl, or a github: install spec. */
function githubRepoOf(plugin) {
  const candidates = []
  const manifestRepo = plugin.manifest?.repository
  candidates.push(typeof manifestRepo === 'string' ? manifestRepo : manifestRepo?.url)
  candidates.push(plugin.repositoryUrl)
  if (/^github:/i.test(String(plugin.requested ?? ''))) candidates.push(plugin.requested)
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    try { const parsed = normalizeRepositoryUrl(candidate.trim()); if (parsed.kind === 'github') return parsed } catch { /* try the next source */ }
  }
  return null
}
function relativeClientExport(manifest) {
  const entry = manifest.exports?.['./client']
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return entry.default ?? entry.import ?? entry.require
  return undefined
}

export class PluginHealthService {
  constructor(inspector, fetchImpl = fetch, dshCommand = process.env.DSH_CLI_PATH || 'dsh') { this.inspector = inspector; this.fetch = fetchImpl; this.dshCommand = dshCommand }
  async checkUpdates(profile, packageNames) {
    const current = await this.inspector.inspect(profile)
    const wanted = packageNames?.length ? new Set(packageNames) : null
    const plugins = current.plugins.filter((plugin) => !wanted || wanted.has(plugin.packageName))
    return { profile, checkedAt: Date.now(), results: await Promise.all(plugins.map((plugin) => this.checkUpdate(plugin))) }
  }
  async releaseNotes(document, latestVersion) {
    const packageVersion = document.versions?.[latestVersion]
    const direct = document.releaseNotes ?? document.changelog ?? packageVersion?.releaseNotes ?? packageVersion?.changelog
    if (typeof direct === 'string' && direct.trim()) return { text: direct.trim().slice(0, 12_000), source: 'npm' }
    const repository = packageVersion?.repository ?? document.repository
    const repoUrl = typeof repository === 'string' ? repository : repository?.url
    const match = String(repoUrl ?? '').match(/github\.com[/:]([^/]+)\/([^/#.]+?)(?:\.git)?$/i)
    if (match) {
      try {
        const response = await this.fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-manager' }, signal: AbortSignal.timeout(8_000) })
        if (response.ok) {
          const release = await response.json()
          if (typeof release.body === 'string' && release.body.trim()) return { text: release.body.trim().slice(0, 12_000), source: 'github-release', title: release.name || release.tag_name }
        }
      } catch { /* Release notes are optional. */ }
    }
    return { text: '发布者未提供可读取的更新说明，请在确认更新前查看包主页或仓库。', source: 'default' }
  }
  async checkUpdate(plugin) {
    if (!plugin.manifestPresent) return { packageName: plugin.packageName, currentVersion: plugin.version, status: 'unavailable', message: '本地 package.json 缺失，无法检查更新' }
    if (/^(?:link:|file:|workspace:)/.test(plugin.requested)) return { packageName: plugin.packageName, currentVersion: plugin.version, status: 'local', message: '本地链接插件没有可查询的远程版本' }
    const npmResult = await this.checkNpmUpdate(plugin)
    if (npmResult !== null) return npmResult
    const githubResult = await this.checkGithubUpdate(plugin)
    if (githubResult !== null) return githubResult
    return { packageName: plugin.packageName, currentVersion: plugin.version, status: 'unavailable', message: 'npm registry 与 GitHub 均无法确认远程版本' }
  }
  /** npm registry check; null means the package is not resolvable there (404 / no latest tag / network failure) and a GitHub fallback is worth trying. */
  async checkNpmUpdate(plugin) {
    try {
      const response = await this.fetch(`https://registry.npmjs.org/${encodeURIComponent(plugin.packageName)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) return null
      const document = await response.json(); const latestVersion = document['dist-tags']?.latest
      if (!latestVersion) return null
      const comparison = compareVersions(latestVersion, plugin.version)
      const result = { packageName: plugin.packageName, currentVersion: plugin.version, latestVersion, registryUrl: `https://www.npmjs.com/package/${encodeURIComponent(plugin.packageName)}`, status: comparison === null ? 'unknown' : comparison > 0 ? 'available' : 'current', updateAvailable: comparison === null ? false : comparison > 0, source: 'npm' }
      if (result.status === 'available') result.releaseNotes = await this.releaseNotes(document, latestVersion)
      else if (result.status === 'current') result.releaseNotes = await this.releaseNotes(document, plugin.version)
      return result
    } catch { return null }
  }
  /** GitHub fallback for plugins installed from a github: spec or with a GitHub repository field (npm 404). Returns null when no GitHub source is resolvable. */
  async checkGithubUpdate(plugin) {
    const repo = githubRepoOf(plugin)
    if (!repo) return null
    let tag
    try {
      // Redirect-based tag discovery: no api.github.com quota involved.
      const response = await this.fetch(`https://github.com/${repo.owner}/${repo.repo}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      const location = response.headers.get('location') ?? ''
      const match = location.match(/\/releases\/tag\/([^/?#]+)/)
      if (match) tag = decodeURIComponent(match[1])
    } catch { /* fall through to tags API */ }
    if (!tag) {
      try {
        const response = await this.fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/tags`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-manager' }, signal: AbortSignal.timeout(10_000) })
        if (response.ok) { const tags = await response.json(); tag = Array.isArray(tags) ? tags[0]?.name : undefined }
      } catch { /* fall through */ }
    }
    if (!tag) return { packageName: plugin.packageName, currentVersion: plugin.version, status: 'unavailable', message: 'GitHub 仓库没有可读取的 release 或 tag' }
    let releaseNotes
    try {
      const response = await this.fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-manager' }, signal: AbortSignal.timeout(10_000) })
      if (response.ok) {
        const release = await response.json()
        if (typeof release.body === 'string' && release.body.trim()) releaseNotes = { text: release.body.trim().slice(0, 12_000), source: 'github-release', title: release.name || release.tag_name }
      }
    } catch { /* Release notes are optional. */ }
    const latestVersion = String(tag).replace(/^v/i, '')
    const manifestVersion = typeof plugin.manifest?.version === 'string' && plugin.manifest.version.trim() ? plugin.manifest.version.trim() : undefined
    // pnpm writes a placeholder package.json for GitHub tarball packages.
    // In that case, the requested spec is the authoritative local tag.
    const requestedRef = String(plugin.requested ?? '').match(/#([^#]+)$/)?.[1]
    const currentVersion = manifestVersion ?? (requestedRef ? requestedRef.replace(/^v/i, '') : plugin.version)
    const comparison = compareVersions(latestVersion, currentVersion)
    // A package without a semver manifest or tagged install spec cannot be
    // compared, but an update to the latest tag is still offered rather than
    // silently reporting "unknown".
    const updateAvailable = comparison === null ? true : comparison > 0
    // pnpm 11 rejects `github:owner/repo#ref` (it parses the fragment into an
    // invalid dependency alias), while `name@github:owner/repo#ref` resolves.
    // Always carry the installed package name explicitly.
    const githubSpec = `github:${repo.owner}/${repo.repo}#${tag}`
    const installSpec = `${plugin.packageName}@${githubSpec}`
    const result = { packageName: plugin.packageName, currentVersion, latestVersion, ref: tag, registryUrl: `https://github.com/${repo.owner}/${repo.repo}/releases`, status: updateAvailable ? 'available' : 'current', updateAvailable, source: 'github', repositoryUrl: repo.repositoryUrl, installSpec }
    result.releaseNotes = releaseNotes ?? { text: updateAvailable ? '发布者未提供可读取的更新说明，请在确认更新前查看仓库 Releases 页。' : '当前已是最新版本。', source: 'default' }
    return result
  }
  async checkIntegrity(profile, packageNames) {
    const current = await this.inspector.inspect(profile)
    const wanted = packageNames?.length ? new Set(packageNames) : null
    const selected = current.plugins.filter((plugin) => !wanted || wanted.has(plugin.packageName))
    const dump = await run(this.dshCommand, ['--profile', profile, '--dump-config'], { cwd: current.dir, timeout: 30_000 })
    const profileLoads = dump.code === 0 && !dump.timedOut
    const profileError = profileLoads ? undefined : (dump.timedOut ? 'dsh --dump-config 执行超时' : (dump.stderr || dump.stdout).slice(-2000))
    return { profile, checkedAt: Date.now(), profileLoads, profileError, results: selected.map((plugin) => this.inspectPlugin(current, plugin, profileLoads, dump.stdout)) }
  }
  inspectPlugin(current, plugin, profileLoads, configText) {
    const checks = []
    const add = (id, label, state, detail) => checks.push({ id, label, state, detail })
    const dir = packageDir(current.dir, plugin.packageName)
    const manifest = plugin.manifest
    add('manifest', '包清单', manifest ? 'pass' : 'fail', manifest ? `v${manifest.version ?? plugin.version}` : 'node_modules 中缺少 package.json')
    if (!manifest) return { packageName: plugin.packageName, status: 'fail', checks }
    const pluginResolver = createRequire(join(dir, 'package.json'))
    const profileResolver = createRequire(join(current.dir, 'package.json'))
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      try { pluginResolver.resolve(name); add(`dependency:${name}`, '直接依赖', 'pass', `${name} ${range}`) }
      catch { add(`dependency:${name}`, '直接依赖', 'fail', `${name} ${range} 无法解析`) }
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional) continue
      try { profileResolver.resolve(name); add(`peer:${name}`, 'Peer 依赖', 'pass', `${name} ${range}`) }
      catch { add(`peer:${name}`, 'Peer 依赖', 'fail', `${name} ${range} 无法解析`) }
    }
    if (plugin.isBundle) {
      const patch = manifest.dsh?.bundle?.patch
      add('bundle-enabled', 'Bundle 已启用', plugin.bundleEnabled ? 'pass' : 'fail', plugin.bundleEnabled ? '已列入 dsh.profile.bundles' : '未列入 dsh.profile.bundles')
      add('bundle-patch', 'Bundle patch', patch && typeof patch === 'string' && existsSync(join(dir, patch)) ? 'pass' : 'fail', patch ? String(patch) : '未声明 dsh.bundle.patch')
      add('profile-compose', 'Profile 组合', profileLoads && configText.includes(plugin.packageName) ? 'pass' : 'fail', profileLoads ? (configText.includes(plugin.packageName) ? '配置中已发现插件条目' : '配置中未发现插件条目') : 'dsh --dump-config 失败')
    } else add('profile-compose', 'Profile 组合', profileLoads ? 'pass' : 'fail', profileLoads ? 'Profile 组合校验通过' : 'dsh --dump-config 失败')
    if (manifest.dsh?.client?.platform === 'web') {
      const client = relativeClientExport(manifest)
      add('client-export', 'Web 客户端入口', typeof client === 'string' && existsSync(join(dir, client)) ? 'pass' : 'fail', client ? String(client) : 'dsh.client 已声明但未导出 ./client')
    }
    const failures = checks.filter((check) => check.state === 'fail').length
    return { packageName: plugin.packageName, status: failures ? 'fail' : 'pass', checks, summary: { passed: checks.length - failures, failed: failures } }
  }
}

export class MutationManager {
  constructor(home, inspector, dshCommand = process.env.DSH_CLI_PATH || 'dsh') { this.home = home; this.inspector = inspector; this.dshCommand = dshCommand; this.plans = new Map(); this.tasks = new Map(); this.locks = new Set() }
  async planInstall(profile, resolvedItems) {
    const current = await this.inspector.inspect(profile)
    const items = resolvedItems.map(({ item: rawItem, manifest }) => {
      const item = { ...rawItem, installSpec: typeof rawItem.installSpec === 'string' && rawItem.installSpec ? rawItem.installSpec : rawItem.repositoryUrl }
      const analysis = analyzeInstall(current, manifest)
      // Update semantics: the package is already installed but the requested
      // spec differs (new version or new source). That is a replacement, not a
      // duplicate to skip — `dsh plugin add <new-spec>` upgrades the entry.
      if (analysis.duplicate) {
        const previous = analysis.duplicate
        const spec = typeof item.installSpec === 'string' ? item.installSpec : ''
        if (spec && previous.requested !== spec) {
          analysis.replacing = { packageName: previous.packageName, previousRequested: previous.requested, installSpec: spec, expectedVersion: typeof manifest.version === 'string' ? manifest.version : undefined }
          // The old package is being replaced in place. Its capabilities are
          // not a conflict with the incoming version of the same package.
          analysis.overlaps = analysis.overlaps.filter((overlap) => overlap.plugin !== previous.packageName)
          analysis.risks = analysis.risks.filter((risk) => !(risk.kind === 'capability-conflict' && risk.detail === `与已安装插件 ${previous.packageName} 重叠`))
          analysis.duplicate = undefined
          const dependents = current.plugins
            .filter((plugin) => plugin.packageName !== previous.packageName)
            .filter((plugin) => Object.prototype.hasOwnProperty.call(dependencyRecord(plugin.manifest ?? {}), previous.packageName))
            .map((plugin) => plugin.packageName)
          if (analysis.overlaps.some((overlap) => overlap.severity === 'hard')) {
            if (dependents.length === 0) {
              analysis.replacing.mode = 'remove-add'
              analysis.replacing.conflicts = analysis.overlaps.filter((overlap) => overlap.severity === 'hard')
              analysis.overlaps = []
              analysis.risks = analysis.risks.map((risk) => risk.kind === 'capability-conflict'
                ? { ...risk, level: 'warning', label: '将先卸载旧版本再安装更新', detail: `更新 ${previous.packageName} 时会在快照保护下先卸载旧版本，再安装新版本` }
                : risk)
            } else {
              analysis.replacing.blockedBy = dependents
            }
          }
        }
      }
      if (!manifest.name || typeof manifest.name !== 'string') throw new PluginManagerError('invalid-manifest', 'DSH 插件 package.json 必须声明 name', 422)
      if (!analysis.integration.eligible) {
        if (!analysis.replacing) throw new PluginManagerError('not-dsh-plugin', `项目 ${manifest.name || item.name || 'unknown'} 未声明 dsh.bundle.patch，无法自动集成到 DSH`, 422)
        // Existing external/skill packages may be integrated by the Profile's
        // own patch files rather than a dsh.bundle declaration. Permit an
        // in-place update and preserve that existing integration unchanged.
        analysis.replacing.preserveIntegration = true
        analysis.risks = analysis.risks.filter((risk) => risk.kind !== 'not-dsh-plugin')
        analysis.risks.push({ level: 'warning', kind: 'preserved-integration', label: '保留现有 Profile 集成', detail: '新版本未声明 dsh.bundle.patch；更新将保留当前 Profile 的既有集成配置，不会新增 Bundle 注册。' })
      }
      return { item, manifest, analysis }
    })
    const hardConflicts = items.flatMap((entry) => entry.analysis.overlaps.filter((x) => x.severity === 'hard'))
    const blockedUpdates = items.filter((entry) => entry.analysis.replacing?.blockedBy?.length).map((entry) => ({ packageName: entry.manifest.name, blockedBy: entry.analysis.replacing.blockedBy, conflicts: entry.analysis.replacing.conflicts ?? [] }))
    const duplicatePlugins = items.filter((entry) => entry.analysis.duplicate).map((entry) => entry.item.name)
    const plan = { id: randomUUID(), kind: 'install', profile, createdAt: Date.now(), baselineHash: stableHash({ manifest: current.manifest, bundles: current.bundles }), items, summary: { reuseDependencies: items.reduce((n, x) => n + x.analysis.reused.length, 0), addDependencies: items.reduce((n, x) => n + x.analysis.additions.length, 0), versionConflicts: items.flatMap((x) => x.analysis.versionConflicts), hardConflicts, blockedUpdates, duplicatePlugins, updates: items.filter((x) => x.analysis.replacing).map((x) => ({ packageName: x.analysis.replacing.packageName, from: x.analysis.replacing.previousRequested, to: x.analysis.replacing.installSpec, mode: x.analysis.replacing.mode ?? 'replace' })), requiresRestart: true } }
    plan.hash = stableHash({ kind: plan.kind, profile, baselineHash: plan.baselineHash, specs: items.map((x) => x.item.installSpec) }); this.plans.set(plan.id, plan); return plan
  }
  async planUninstall(profile, packageNames, cascade = false) {
    const current = await this.inspector.inspect(profile); const targets = new Set(packageNames)
    const reverse = []
    const scan = () => {
      let added = false
      for (const plugin of current.plugins) {
        if (targets.has(plugin.packageName)) continue
        for (const target of targets) {
          if (Object.prototype.hasOwnProperty.call(plugin.dependencies ?? {}, target)) {
            reverse.push({ target, dependent: plugin.packageName })
            if (cascade) { targets.add(plugin.packageName); added = true; break }
          }
        }
      }
      return added
    }
    if (cascade) { while (scan()) { /* walk transitive dependents */ } } else scan()
    const targetPlugins = current.plugins.filter((plugin) => targets.has(plugin.packageName))
    const remainingOwners = dependencyOwners(current, targets)
    const dependencyNames = [...new Set(targetPlugins.flatMap((plugin) => Object.keys(dependencyRecord(plugin.manifest ?? {}))))]
    const sharedDependencies = dependencyNames
      .filter((name) => remainingOwners.has(name))
      .map((name) => ({ name, usedBy: remainingOwners.get(name).map((entry) => entry.plugin) }))
    const exclusiveDependencies = dependencyNames
      .filter((name) => !remainingOwners.has(name))
      .map((name) => ({ name }))
    const plan = { id: randomUUID(), kind: 'uninstall', profile, createdAt: Date.now(), baselineHash: stableHash({ manifest: current.manifest, bundles: current.bundles }), packageNames: [...targets], summary: { blockedBy: cascade ? [] : reverse, cascadeAdded: cascade ? [...targets].filter((x) => !packageNames.includes(x)) : [], sharedDependencies, exclusiveDependencies, sharedDependenciesPreserved: true, requiresRestart: true } }
    plan.hash = stableHash({ kind: plan.kind, profile, baselineHash: plan.baselineHash, packageNames: plan.packageNames }); this.plans.set(plan.id, plan); return plan
  }
  task(id) { const task = this.tasks.get(id); if (!task) throw new PluginManagerError('task-not-found', '任务不存在', 404); return task }
  listTasks() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((task) => ({ ...task, logs: (task.logs ?? []).slice(-100) }))
  }
  pruneTasks(limit = 200) {
    const excess = this.tasks.size - limit
    if (excess > 0) for (const id of [...this.tasks.keys()].slice(0, excess)) this.tasks.delete(id)
  }
  async execute(planId, hash, allowConflicts = false) {
    const plan = this.plans.get(planId)
    if (!plan || plan.hash !== hash) throw new PluginManagerError('stale-plan', '计划不存在或摘要不匹配，请重新评估', 409)
    if (plan.consumed) throw new PluginManagerError('stale-plan', '该计划已经执行过，请重新评估后操作', 409)
    if (Date.now() - plan.createdAt > 10 * 60_000) throw new PluginManagerError('stale-plan', '计划已过期，请重新评估', 409)
    if (plan.kind === 'uninstall' && plan.summary.blockedBy.length) throw new PluginManagerError('dependent-plugins', '其他插件仍依赖目标插件', 409, plan.summary.blockedBy)
    if (plan.kind === 'install' && plan.summary.blockedUpdates?.length) throw new PluginManagerError('incompatible-update', '更新版本与其他插件能力冲突，且有插件依赖当前版本，无法安全替换', 409, plan.summary.blockedUpdates)
    if (plan.kind === 'install' && plan.summary.hardConflicts.length && !allowConflicts) throw new PluginManagerError('capability-conflict', '检测到硬功能冲突', 409, plan.summary.hardConflicts)
    if (this.locks.has(plan.profile)) throw new PluginManagerError('profile-locked', '当前 Profile 正在执行插件变更', 409)
    const task = { id: randomUUID(), planId, kind: plan.kind, profile: plan.profile, status: 'queued', phase: 'preflight', progress: 0, logs: [], createdAt: Date.now(), requiresRestart: true }
    this.tasks.set(task.id, task); this.pruneTasks(); this.locks.add(plan.profile); void this.runTask(task, plan); return task
  }
  log(task, line) { task.logs.push({ at: Date.now(), line: line.replace(/(authorization|token|cookie)\s*[:=]\s*\S+/ig, '$1: [REDACTED]') }); if (task.logs.length > 500) task.logs.splice(0, task.logs.length - 500) }
  async snapshot(task, dir) {
    const root = join(dir, '.dsh-plugin-snapshots', task.id); await mkdir(root, { recursive: true })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) if (await exists(join(dir, name))) await cp(join(dir, name), join(root, name))
    return root
  }
  async restore(snapshot, dir) {
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) if (await exists(join(snapshot, name))) await cp(join(snapshot, name), join(dir, name))
    await run('pnpm', ['install', '--offline', '--frozen-lockfile'], { cwd: dir, env: await profilePnpmEnv(dir), timeout: 10 * 60_000 })
  }
  async runTask(task, plan) {
    const dir = this.inspector.profileDir(plan.profile); const pnpmEnv = await profilePnpmEnv(dir); let snapshot
    try {
      const current = await this.inspector.inspect(plan.profile)
      if (stableHash({ manifest: current.manifest, bundles: current.bundles }) !== plan.baselineHash) throw new PluginManagerError('stale-plan', 'Profile 在评估后已发生变化', 409)
      task.status = 'running'; task.phase = 'snapshot'; task.progress = 10; snapshot = await this.snapshot(task, dir)
      task.phase = 'mutating'; task.progress = 25
      const installEntries = plan.kind === 'install' ? plan.items.filter((x) => !x.analysis.duplicate) : []
      const removeAddEntries = installEntries.filter((entry) => entry.analysis.replacing?.mode === 'remove-add')
      const runPluginCommand = async (action, specs) => {
        if (!specs.length) return
        const result = await run(this.dshCommand, ['plugin', '--profile', plan.profile, action, ...specs], { cwd: dir, env: pnpmEnv, timeout: 15 * 60_000, onLog: (_kind, text) => text.split(/\r?\n/).filter(Boolean).forEach((line) => this.log(task, line)) })
        if (result.timedOut) throw new PluginManagerError('package-manager-timeout', 'DSH 插件命令执行超时，已强制终止', 500)
        if (result.code !== 0) throw new PluginManagerError('package-manager-failed', `DSH 插件命令失败，退出码 ${result.code}`, 500)
      }
      if (plan.kind === 'install' && removeAddEntries.length) {
        task.phase = 'removing-old'; task.progress = 32
        await runPluginCommand('remove', removeAddEntries.map((entry) => entry.manifest.name))
        task.phase = 'mutating'; task.progress = 42
        await runPluginCommand('add', installEntries.map((entry) => entry.item.installSpec))
      } else {
        const specs = plan.kind === 'install' ? installEntries.map((entry) => entry.item.installSpec) : plan.packageNames
        if (!specs.length) { this.log(task, '没有需要执行的变更'); task.phase = 'validate' }
        else await runPluginCommand(plan.kind === 'install' ? 'add' : 'remove', specs)
      }
      task.phase = 'reconcile'; task.progress = 65
        const installedManifest = await readJson(join(dir, 'package.json'))
        const currentBundles = installedManifest.dsh?.profile?.bundles ?? []
        const bundles = plan.kind === 'install'
          ? [...new Set([...currentBundles, ...plan.items.filter((x) => !x.analysis.duplicate && !x.analysis.replacing?.preserveIntegration).map((x) => x.manifest.name)])]
          : currentBundles.filter((name) => !plan.packageNames.includes(name))
        await atomicWriteJson(join(dir, 'package.json'), { ...installedManifest, dsh: { ...(installedManifest.dsh ?? {}), profile: { ...(installedManifest.dsh?.profile ?? {}), bundles } } })
        this.log(task, plan.kind === 'install'
          ? `已将 ${bundles.length} 个 DSH Bundle 写入 Profile 启用列表`
          : `已从 Profile 启用列表移除 ${plan.packageNames.length} 个插件`)
      const after = await this.inspector.inspect(plan.profile)
      if (plan.kind === 'install') for (const entry of plan.items.filter((x) => !x.analysis.duplicate)) {
        if (!after.plugins.some((plugin) => plugin.packageName === entry.manifest.name)) throw new PluginManagerError('integrity-failed', `插件 ${entry.manifest.name} 未出现在 Profile 中`, 500)
        if (!entry.analysis.replacing?.preserveIntegration && !after.bundles.includes(entry.manifest.name)) throw new PluginManagerError('integration-failed', `插件 ${entry.manifest.name} 已安装但未启用到 dsh.profile.bundles`, 500)
      }
      if (plan.kind === 'uninstall') for (const name of plan.packageNames) if (after.plugins.some((plugin) => plugin.packageName === name)) throw new PluginManagerError('integrity-failed', `插件 ${name} 仍在 Profile 中`, 500)
      if (plan.kind === 'install') for (const entry of plan.items) {
        const expectedVersion = entry.analysis.replacing?.expectedVersion
        if (!expectedVersion) continue
        const installed = after.plugins.find((plugin) => plugin.packageName === entry.manifest.name)
        if (installed?.version !== expectedVersion) throw new PluginManagerError('update-not-applied', `插件 ${entry.manifest.name} 未更新到目标版本 ${expectedVersion}（当前 ${installed?.version ?? '未安装'}）`, 500)
      }
      task.phase = 'validate'; task.progress = 80
      const validation = await run(this.dshCommand, ['--profile', plan.profile, '--dump-config'], { cwd: dir, env: pnpmEnv, timeout: 30_000, onLog: (_kind, text) => text.split(/\r?\n/).filter(Boolean).slice(-20).forEach((line) => this.log(task, line)) })
      if (validation.timedOut || validation.code !== 0) throw new PluginManagerError('profile-invalid', validation.timedOut ? 'Profile 组合校验超时' : 'Profile 组合校验失败', 500)
      task.validation = { profileLoads: true, originalBundlesPreserved: current.bundles.filter((name) => plan.kind !== 'uninstall' || !plan.packageNames.includes(name)).every((name) => after.bundles.includes(name)), pluginCount: after.plugins.length }
      if (!task.validation.originalBundlesPreserved) throw new PluginManagerError('baseline-regression', '检测到非目标 Bundle 丢失', 500)
      task.phase = 'commit'; task.progress = 100; task.status = 'success'; plan.consumed = true; this.log(task, '变更已提交；当前进程不受影响，重启目标 Profile 后生效')
    } catch (error) {
      task.error = { code: error.code ?? 'operation-failed', message: error.message ?? String(error), details: error.details }
      if (snapshot) {
        task.phase = 'rollback'; this.log(task, `操作失败，开始回滚：${task.error.message}`)
        try { await this.restore(snapshot, dir); task.rolledBack = true; this.log(task, 'Profile 已恢复到操作前快照') } catch (rollbackError) { task.rollbackError = rollbackError.message ?? String(rollbackError) }
      }
      task.status = 'failed'
    } finally {
      this.locks.delete(plan.profile)
      if (snapshot && (task.status === 'success' || task.rolledBack)) await rm(snapshot, { recursive: true, force: true }).catch(() => {})
      task.finishedAt = Date.now()
    }
  }
}
