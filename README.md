# OMP Profile · Astra / Sol 工程工作流

一套用于 [Oh My Pi](https://github.com/can1357/oh-my-pi) 的个人工程工作流：Astra 主控、Sol 执行，可按用户请求切换到全 Astra；通过明确分工、按需技能和真实消费者验证推进任务。

本仓库分享**脱敏后的规则、角色、技能与工作流扩展源码**，同时提供阅读与手动接入说明。它不是 OMP 官方发行版，也不包含账号、模型服务凭据或整机配置。整理日期：2026-10-24。

## 从哪里开始

| 你想做什么 | 阅读入口 |
|---|---|
| 了解设计、分工和完整流程 | [工作流说明](docs/WORKFLOW.md) |
| 在自己的 OMP 环境中借鉴或接入 | [使用与兼容说明](docs/SETUP.md) |
| 查看实际规则与技能 | [主控规则](profile/APPEND_SYSTEM.md) · [工程技能](profile/skills/engineering-workflow/SKILL.md) · [前端设计](profile/skills/frontend-design/SKILL.md) |
| 查看角色边界 | [角色文件](profile/agents/) |
| 了解模型接力的实现 | [工作流扩展](profile/extensions/astra-workflow/) |
| 核对脱敏、来源与验证边界 | [分享范围](docs/SHARING.md) |

## 这套工作流包含什么

- **主控与执行分工**：主控负责目标、关键假设、共享合同和最终证据；执行者自主完成模块探索、实现与排障。简单任务直接做，不为协作而拆分。
- **统一的工程合同**：短核心搭配研究、执行、协作、运行时协议、验证五份按需细则，不为不同模型复制两套规则。
- **有依据的思考分档**：普通任务 high；会改变方案的关键未知用 xhigh；max 需要进一步疑难依据。
- **原位模式切换**：保留代理会话、工具结果和所有权，在安全调用点切换；不把 pending 当作已经生效。
- **真实验收与证据复用**：检查实际 CLI/UI 或消费者行为，不靠测试数量判断完成，也不因换负责人重跑全部成功路径。
- **前端设计模块**：按需应用视觉与交互约束，默认编辑式设计；尊重用户风格与已有设计系统，用真实画面和交互闭环。

## 目录

```text
omp-profile/
├── README.md
├── docs/
│   ├── WORKFLOW.md                 # 方案与协作流程
│   ├── SETUP.md                    # 手动接入、依赖与兼容边界
│   └── SHARING.md                  # 脱敏范围和本次验证
└── profile/                       # 按 OMP agent 目录布局组织的分享文件
    ├── APPEND_SYSTEM.md           # 脱敏主控规则
    ├── agents/                    # 四个工程角色；不覆盖官方 task
    ├── skills/
    │   ├── engineering-workflow/  # 核心与五份按需细则
    │   └── frontend-design/       # 前端体验与视觉设计
    └── extensions/
        ├── astra-workflow/        # 模式、思考档位和服务档位接合
        └── orchestrate-compat/    # 已知通知/汇报冲突的有限适配
```

`profile/` 是手动审阅和合并的来源目录，不会因为 clone 仓库而自动安装。本仓库不提供覆盖整个用户配置目录的一键脚本，也不携带可直接登录模型服务的配置。请先阅读 [使用说明](docs/SETUP.md)，尤其是模型可用性、宿主接口依赖和已知 fallback 风险。
