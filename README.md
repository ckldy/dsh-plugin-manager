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
- **任务**：查看安装与卸载事务的进度、日志和失败信息。
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

网页源在保存前会自动解析验证：必须至少发现一个可安装的 GitHub 插件，否则该来源不会保存。

例如，添加以下网页源时，插件中心会自动发现同源公开目录：

```text
https://dsh.market/
```

其目录会自动解析 `https://dsh.market/plugins.json`。同样也支持 DSHFind 等在页面中公开列出仓库链接的网站。

为安全起见，插件源必须使用无凭据的 HTTPS 地址，不能指向本机或私有网络。网页源不会执行页面 JavaScript、表单或页面中的命令。

## 安装插件

### 从发现页安装

1. 点击单个插件右侧的 **安装**，或勾选多个插件后点击 **安装所选**。
2. 阅读安装评估。
3. 检查依赖复用、新增依赖、版本冲突、能力冲突、安装脚本和原生依赖风险。
4. 点击确认安装。

安装前会创建 Profile 快照。安装失败时，插件中心会尝试恢复 manifest、锁文件与依赖状态。安装完成后通常需要重启目标 DSH Profile 才会生效。

### 通过 URL 安装

在发现页输入 GitHub 仓库 URL 或 npm 包 URL，点击 **解析并安装**。例如：

```text
https://github.com/example/dsh-example-plugin
https://www.npmjs.com/package/example-dsh-plugin
```

## 已安装插件管理

在 **已安装** 标签中，每个插件按以下顺序提供操作：

1. **更新**：仅检查 npm registry 或安装来源，不直接修改 Profile。
2. **卸载**：先生成卸载计划，检测反向依赖与级联影响；确认后执行真实卸载。
3. **更多**：查看仓库链接和运行 **完整性检查**。

完整性检查是只读操作，会检查包清单、依赖、Bundle、客户端入口和 Profile 配置组合，不会执行插件代码。

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
- 所有变更限定在选中的本地 DSH Profile，安装与卸载使用快照、基线哈希与回滚保护。

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
