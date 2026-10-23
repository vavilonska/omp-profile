# 使用与兼容说明

## 1. 先选择采用范围

本仓库既可用于阅读，也可作为手动接入来源。不要把整个仓库覆盖到个人配置目录，更不要覆盖现有凭据、会话或模型设置。

- **只借鉴方法**：阅读 [工作流说明](WORKFLOW.md)，按自己的工具和角色改写；不安装文件。
- **采用规则与技能**：审阅主控规则、工程技能与所需角色，合并进自己的环境。尚未加载扩展时，不能声称 `workflow` 模式或精确升档可用。
- **采用完整工程树控制**：在宿主接口匹配、模型可用且完成隔离检查后，再加入两项扩展。

本仓库不附带 OMP 可执行文件、账号配置、模型服务代理、设备技能、个人插件或宿主补丁。也不提供自动覆盖、自动安装或自动更新脚本。

## 2. 前提

### 宿主与模型

方案来自 OMP 18.12.x 环境，原维护记录包含 18.12.6 的定向兼容证据；本分享快照不继承对其他版本的完整兼容保证。扩展依赖原生 agent registry、session setter、模型调用前 hook、持久化与设置覆盖接口，升级时需定向核对。

四个角色的 frontmatter 使用 `model: "@task"` 和 `thinking: high`。你需要通过自己版本的原生配置入口设置可用的 `task` 模型别名；不会因为复制角色文件而自动得到模型服务访问权限。

原方案的模型基线见 [模型模式与思考强度](WORKFLOW.md#3-模型模式与思考强度)。`astra-workflow/relay.ts` 当前固定目标为 `openai-codex/gpt-6-astra`，对应模型必须存在、启用并在宿主内完成认证。标识不适用于自己的服务时，需要审阅并适配源码及规则，不能仅更换显示名或假称切换成功。

完整分档依赖原生 `task.enableEffort` 与允许档位上限，普通任务沿 high 基线。原生 `hi` 不等于 xhigh。应通过实际版本的配置入口核对，不复制私人 `config.yml`，也不为采用此仓库擅自改并发、Fast 或其他角色模型。

### 运行环境

- 扩展是宿主加载的 TypeScript，不是独立 Node.js 服务，也没有独立的 `npm start`。
- 宿主必须支持这里使用的包解析和 Markdown 文本模块导入。
- 全树原位接力要求持久化的根会话；无会话模式不满足其归属与恢复条件。
- Android 相关操作需要自行安装适配设备的技能；本包只保留条件入口，不附带模拟器路径或设备控制配置。
- 中文交流是当前规则选择，可以按使用者需要自行调整；Windows / PowerShell 规则在相应平台使用，不作为其他平台前提。

## 3. 手动合并文件

本文中的“agent 配置根目录”指目标 OMP 安装实际发现全局规则、角色、技能和扩展的目录。默认布局通常是用户主目录下的 `.omp/agent/`；以目标版本文档及实际启动结果为准，勿猜测已有自定义配置位置。

先备份将要修改的同名文件，确认没有其他进程或维护任务正在改写这些文件，再按下表逐项审阅和合并。

| 仓库来源 | 目标相对 agent 配置根目录 | 处理方式 |
|---|---|---|
| `profile/APPEND_SYSTEM.md` | `APPEND_SYSTEM.md` | 合并工程规则，保留自己的其他有效规则；不要机械整份覆盖 |
| `profile/skills/engineering-workflow/` | `skills/engineering-workflow/` | 保留核心及五份 references 的相对结构 |
| `profile/skills/frontend-design/` | `skills/frontend-design/` | 保留技能名称和入口；仅在界面任务触发 |
| `profile/agents/*.md` | `agents/` | 审阅四个角色的工具、派生、模型别名及 autoload 设置 |
| `profile/extensions/astra-workflow/` | `extensions/astra-workflow/` | 整目录接入，包含工具文案及包清单，不只复制 index |
| `profile/extensions/orchestrate-compat/` | `extensions/orchestrate-compat/` | 整目录接入，包含 Markdown notice 与 policy 文件 |
| `docs/` | `docs/` 中对应同名文件 | 本包主控规则按需引用 `docs/WORKFLOW.md`；同时保留其 SETUP/SHARING 相对链接 |

官方 `task`、`scout`、`sonic` 等角色由宿主提供，本仓库不复制或同名覆盖它们。自定义 `reviewer` 的工具白名单也需要目标宿主确实支持；未知工具名应按目标版本适配，不以角色名称推定权限。

接入后正常启动新的 OMP 进程。不要强制重启其他工作窗口，也不要认为已有窗口已自动换用新规则或扩展。

## 4. 扩展入口与依赖

### astra-workflow

`package.json` 的 `omp.extensions` 指向 `./index.ts`，后者读取 `tool-contract.ts` 并调用 `relay.ts`。包内 `private: true` 表示不作为 npm 发布包，不妨碍按宿主本地扩展方式审阅加载。

源码依赖：

- `typebox`
- `@oh-my-pi/pi-ai`
- `@oh-my-pi/pi-catalog/effort`
- `@oh-my-pi/pi-coding-agent`
- 该宿主包的 `config/model-settings`、`config/model-resolver`、`registry/agent-registry`、`registry/persisted-agents`、`session/agent-session`、`session/session-entries`、`session/settings`、`task/settings` 深层接口。

这些依赖由匹配的宿主环境提供。本仓库未独立打包宿主或锁定依赖，不能靠安装任意最新同名包推定兼容。

### orchestrate-compat

入口为目录中的 `index.ts`，依赖 `@oh-my-pi/pi-coding-agent/modes/magic-keywords`，并通过 `with { type: "text" }` 读取 `orchestrate-notice.md`。进度策略文件只匹配已知的宿主协作 / 完成后缀，不通用替换整个系统提示词。

未知模板保持原样；如果目标版本不支持该目录发现方式、文本导入或对应 hook，需要明确处理兼容性，而不是隐藏加载错误。

## 5. 首次检查

先在隔离的配置、会话、缓存和临时目录中验证发现与解析。不要让检查读写真实会话，不额外发起模型请求来“预热”。

1. 确认两项技能、四个角色被实际发现，角色可以解析，工程技能按约定加载。
2. 确认两项扩展正常加载且 `workflow` 工具可见。先查看 `status`，不把说明文字当作运行状态。
3. 只有实际用户要求时才切换 `astra` 或 `mixed`。若要验证真实子代理接力，另行明确模型请求与费用权限，观察同一会话的实际模型和 pending / applied 状态。
4. 精确 xhigh 需要实际子代理 ID；不猜测 ID，不使用 `effort: hi` 冒充 xhigh。
5. 涉及 warm/cold 恢复、取消、跨根归属或 fallback 时，按自己的实际启用路径验证。源码解析或一次 status 返回不足以证明完整生命周期。

## 6. 已知限制

- 当前 relay 已包含工程子代理专属 fallback 链的限制与条件恢复，不全局关闭 `retry.modelFallback`。root 和辅助消费者不属于该子代理覆盖范围；完整语义仍依赖宿主，不能把历史载荷的风险描述或历史通过结论直接套用到此快照。
- 配置中设置服务档位不等于服务商兑现加速；模型长期遵从规则也不能由 loader 检查证明。
- 本包没有将“可阅读源码”包装成跨版本即装即用保证。实际分享检查与未验项见 [分享范围](SHARING.md)。
- 退出或回退时，仅撤回自己接入的文件或准确恢复对应备份，保留用户后续改动；不覆盖整个配置根目录、不删除会话、不杀用户进程。
