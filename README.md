# DSH 插件中心

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的本地插件市场与生命周期管理插件。

它在 DSH Web 中提供插件发现、分类、安装预检、更新检查、完整性检查、事务式卸载和自定义插件源管理。所有安装和卸载仅作用于当前选择的 DSH Profile。

## 安装

### 从 GitHub 安装

在终端中执行：

```bash
dsh plugin --profile web add github:ckldy/dsh-plugin-manager
```

然后重启 DSH Web：

```bash
dsh web
```

如果你的 DSH Web 使用了额外参数，请沿用原有启动命令。例如：

```bash
dsh web --trusted-host your-domain.example
```

### 安装到其他 Profile

将 `web` 替换为目标 Profile 名称：

```bash
dsh plugin --profile <profile-name> add github:ckldy/dsh-plugin-manager
```

可通过以下命令查看 Profile 配置：

```bash
dsh --profile <profile-name> --dump-config
```

## 打开插件中心

重启后可从两个独立入口进入：

1. DSH 设置主页面中的一级 **插件中心**。它不在 `Plugins` 子页内。
2. 安装了 `dsh-better-sidebar` 时，可从侧边卡片的 **插件中心** 标签打开。

插件中心内部包含四个固定标签：

- **发现**：浏览、搜索、分类、预览和安装插件。
- **已安装**：查看当前 Profile 的插件，执行更新、卸载和完整性检查。
- **任务**：查看安装与卸载事务的进度、日志和失败信息。任务列表会在打开插件中心时自动恢复，并在有任务运行时自动刷新；成功的 Web Profile 任务可直接从任务行重启 DSH Web。
- **插件源**：添加、查看或删除自定义目录来源。

## 发现插件

发现页自动聚合并去重多个来源：

- 精选 DSH 目录：提供中文简介、npm 映射和分类元数据。
- GitHub `dsh-plugin` Topic。
- 自定义 JSON、GitHub Topic 和网页来源。

每个插件条目显示仓库头像或插件图标、Stars、分发方式、精选标记和自动分类。点击 **详情** 可在插件中心内查看 README、依赖、能力、分类依据和图片原图，不会跳转到外部页面。

发现列表每页显示 50 条。可使用 Stars / 最近更新排序与功能分类筛选。侧边卡片模式将常用控件保持在顶部；搜索、Profile 切换和 URL 解析安装位于 **更多** 中。

### 官方 GitHub Topic 目录

内置的 **GitHub DSH Plugins** 来源对应官方 [dsh-plugin Topic](https://github.com/topics/dsh-plugin)。目录加载使用 GitHub Search API，每页读取 100 项，最多读取 API 允许的前 1,000 项。来源状态会显示“已加载 / 官方总数”；当官方 Topic 超过 1,000 项时会标记 **API 上限**。

这是 GitHub Search API 对单个查询的硬性限制，不表示官方 Topic 页面只有 1,000 项。插件中心不会把该限制误显示为官方目录总数。

当使用搜索框时，插件中心先查询并优先展示来自官方 `dsh-plugin` Topic 的匹配插件，再展示精选目录和其他自定义来源的匹配项；同一来源组内继续按所选的 Stars 或最近更新时间排序。

## 添加插件源

进入 **插件源**，填写名称、HTTPS 地址和来源类型。

支持以下来源：

| 类型 | 用途 |
| --- | --- |
| `网页` | 从公开网页提取 GitHub 仓库，或自动发现同源的 `plugins.json` / `api/plugins` 目录。 |
| `JSON` | 使用插件中心定义的 JSON 目录格式。 |
| `GitHub Topic` | 从 GitHub Topic 检索仓库。 |

网页源和 JSON 源在保存前会自动解析验证：必须至少发现一个可安装的 GitHub 插件，否则该来源不会保存。GitHub Topic 源会校验 Topic 名称，并在发现页按与官方目录相同的规则分页加载（每页 100 项，最多 1,000 项）。

例如，添加以下网页源时，插件中心会自动发现同源公开目录：

```text
https://dsh.market/
```

其目录会自动解析 `https://dsh.market/plugins.json`。同样也支持 DSHFind 等在页面中公开列出仓库链接的网站。

JSON 源使用如下格式（`schemaVersion` 必须为 `1`）：

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "name": "dsh-example-plugin",
      "repository": "https://github.com/example/dsh-example-plugin",
      "npm": "dsh-example-plugin",
      "description": "可选简介",
      "descriptionZh": "可选中文简介",
      "topics": ["ui"],
      "stars": 12
    }
  ]
}
```

同一地址与类型的插件源不能重复添加，官方 `dsh-plugin` Topic 已内置。为安全起见，插件源必须使用无凭据的 HTTPS 地址，不能指向本机或私有网络（包括 IPv4-mapped IPv6 地址）。网页源不会执行页面 JavaScript、表单或页面中的命令。

## 安装插件

### 从发现页安装

1. 点击单个插件右侧的 **安装**，或勾选多个插件后点击 **安装所选**。
2. 阅读安装评估。
3. 检查依赖复用、新增依赖、版本冲突、能力冲突、安装脚本和原生依赖风险。
4. 点击确认安装。

安装前会创建 Profile 快照。安装失败时，插件中心会尝试恢复 manifest、锁文件与依赖状态。

安装或更新成功后需要重启 DSH 才会加载新插件。针对 Web Profile，确认评估时可勾选 **完成后自动重启 DSH Web 并生效**（默认勾选）：任务成功后插件中心会优雅退出当前 DSH Web 进程，由一个临时接管进程用完全相同的命令行参数、工作目录、环境变量和日志输出重新拉起，浏览器恢复后自动刷新页面。也可以在 **任务** 页点击任务行上的 **重启 DSH Web 并生效** 手动重启。其他 Profile（如 headless）仍在下次启动时生效。

### 通过 URL 安装

在发现页输入 GitHub、Hugging Face 仓库/Space 或 npm 包 URL，点击 **解析并安装**。插件中心会读取 `package.json`、README 和安装脚本，生成安装模式、执行命令和风险提示。声明 `dsh.bundle.patch` 的项目会自动注册到目标 Profile 的 `dsh.profile.bundles`；未声明该字段的项目采用通用 Profile 依赖安装模式，不会伪称已集成到 DSH，安装计划会给出命令并提示按 README 完成启动或配置。

```text
https://github.com/example/dsh-example-plugin
https://huggingface.co/example/dsh-example-plugin
https://huggingface.co/spaces/example/dsh-example-plugin
https://www.npmjs.com/package/example-dsh-plugin
```

## 已安装插件管理

在 **已安装** 标签中，每个插件按以下顺序提供操作：

1. **更新**：只检查当前点击的插件，不会扫描或阻塞其他已安装插件。
2. **卸载**：先生成卸载计划，检测反向依赖与级联影响；确认后执行真实卸载。若存在反向依赖，可点击 **级联卸载** 重新生成计划，把直接与传递依赖方一并卸载。
3. **更多**：查看仓库链接和运行 **完整性检查**。

更新检查是只读操作：npm 分发的插件会读取 npm registry 的当前版本与最新版本；npm 中不存在的插件（例如通过 `github:owner/repo` 安装的 GitHub 分发插件）会自动回退到 GitHub Releases/Tags 获取最新版本，并按 `github:owner/repo#版本` 生成更新计划。无论是否有新版本，插件中心都会显示可读取的版本说明；没有说明时会显示默认提示。无论插件是否来自插件中心，只要已接入目标 DSH Profile，都能执行更新与卸载。

仅当发现新版本时才会出现 **生成更新计划**。生成计划后仍需在安装评估中确认，才会实际修改 Profile。更新计划会精确固定目标版本（npm 插件固定为 `包名@版本`，GitHub 插件固定为 `github:owner/repo#tag`），不会依赖默认分支漂移。更新检查本身不会安装、升级或重启任何插件。

完整性检查也是只读操作，会检查包清单、依赖、Bundle、客户端入口和 Profile 配置组合，不会执行插件代码。

## 自动分类

插件中心在本地对插件进行可解释的多标签分类，包括：

- Agent 与编排
- Skill 与知识
- 界面与桌面
- 开发工具
- 浏览器与自动化
- 数据与搜索
- 设计与媒体
- 协作与集成
- 运维与安全
- 插件集合

分类由仓库名、包名、描述、GitHub Topics 和关键词加权得出。详情页会显示主分类、置信度与匹配依据；分类仅用于浏览和筛选，不代表人工安全审核。

## 安全说明

- 插件属于第三方代码。被收录、分类或标记为精选不等于安全背书。
- 安装评估会展示生命周期脚本、原生依赖、终端/CLI 表面和能力冲突等已知风险。
- 自定义网页源仅解析公开文本或 JSON，不运行网页脚本。
- README HTML 在页面内经过清理后渲染；脚本、表单、嵌入页面和危险 URL 协议会被移除。
- 所有变更限定在选中的本地 DSH Profile，安装与卸载使用快照、基线哈希与回滚保护；每个计划只能执行一次，成功后或回滚完成后会清理快照。
- 重启入口只对经过浏览器信任校验的请求开放；重启通过接管进程以原参数拉起 DSH，不会另起一个无人管理的服务。
- 插件 CLI 与配置校验命令带有超时保护，避免某个命令挂起导致 Profile 被永久锁定。
- 已安装列表会优先显示包清单中的 `displayName`，未提供时回退到包名。

## 开发与测试

安装依赖：

```bash
pnpm install
```

运行测试：

```bash
pnpm test
```

项目在本地开发时需要重启实际 DSH Web 进程加载服务端与客户端改动；不要以独立 Vite 开发服务器替代 DSH Web。

## 许可证

MIT
