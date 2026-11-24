# FlowDay

个人执行教练 · Personal Execution Coach

当前已实现 **V1.1 SaaS 基础设施与 V1.2 AI 执行教练接入代码**。Supabase 邮箱认证、用户隔离、云端保存、安全迁移与并发保护保留；新增目标拆解、任务求助、计划调整和执行画像。默认使用明确标识的 Mock 演示，没有真实模型调用。现有 UI、任务、目标、日历、排程确认、专注、规则教练、历史复盘/涂鸦与手机布局保留。

## 启动

V1.5 已加入增量保存、云端历史分页、DeepSeek 兼容适配、新手引导、账户数据控制与权益设置。本地启动无需额外配置，现有云端项目升级需应用 004 和 005。完整步骤见 [V1.5 上线配置](docs/18-v1.5-saas.md)。

使用 Node.js 22+（本次环境 Node 24），安装并启动：

```bash
npm ci
npm run dev
```

打开 http://127.0.0.1:3100。生产构建：`npm run build`；运行构建结果：`npm start`。

未配置云端时，数据仍保存在当前浏览器，首次生成示例任务和目标；请定期导出。云端配置后，首页要求登录，新账户为空，可从个人设置预览并确认迁移本地数据。

## 接入 Supabase

完整步骤、迁移限制和真实云端验收清单见 [V1.1 配置与交付](docs/15-v1.1-saas-setup.md)。

1. 准备空白 Supabase 开发项目，在 SQL Editor 执行 [正式迁移文件](supabase/migrations/202611190001_workspace.sql)。不要执行旧的 `docs/sql` 设计草案，不直接修改生产库。
2. 将 [.env.example](.env.example) 复制为 `.env.local`，填写项目 URL、Publishable key 和本站 APP_ORIGIN。无需 service_role 或数据库密码。
3. 配置 Supabase Email/password 及邮箱确认，Site URL 为 `http://127.0.0.1:3100`，允许回调 `http://127.0.0.1:3100/auth/callback`，然后重新启动。
4. 注册、验证邮箱、登录，进入个人设置迁移本地数据或直接创建自己的任务。

云端请求失败会提示失败或冲突，不会自动转为本地保存。本地迁移不删除原始 localStorage；已有云端修改时拒绝直接覆盖。数据按账户隔离，保存成功后可在另一个设备登录读取；暂不提供实时推送。

## AI 教练体验与配置

点击工作台的“AI 拆解新目标”“AI 调整今日计划”或“查看执行画像”；任务详情中也可展开 AI 求助。建议先预览，确认后才经现有保存接口执行。Mock 演示不会调用外部模型。

云端使用前按顺序应用全部迁移，并配置服务端 AI_PROPOSAL_SECRET（至少 32 个随机字符）。真实模型由项目所有者通过 AI_ENABLE_PAID_CALLS 启用，并配置 AI_PROVIDER、AI_API_URL、AI_API_KEY 和 AI_MODEL。 [DeepSeek 与兼容供应商配置](docs/18-v1.5-saas.md)

## 工程入口

```text
src/app/                     页面、认证回调、受保护的 API
src/components/              保留现有工作台，增加登录和迁移预览
src/modules/core/            模型、本地仓库、异步保存与冲突保护
src/modules/cloud/           云端读写及业务数据校验
src/lib/supabase/             服务端用户会话与配置
src/proxy.ts                 页面请求前刷新会话
src/modules/planning/        确定性排程引擎与日历操作
src/modules/coach/           AI 服务、Provider、建议验证、签名、额度与规则回退
supabase/migrations/         已执行本地 PostgreSQL 测试的数据库迁移
tests/                       单元、接口与数据库隔离/事务测试
e2e/                         原有界面浏览器回归测试
docs/                        架构基线和实施交付
```

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

已验证：85 项自动化测试与 11 项 Chrome 页面测试通过，生产构建通过。数据库测试用 PGlite 的真实 PostgreSQL 引擎，Supabase 身份上下文为模拟；API 测试使用提供方替身。浏览器测试在 3110 端口启动隔离的本地模式生产服务，默认使用本机 Chrome。

尚待开发项目实连：真实注册邮件、会话到期刷新、跨设备云端读写及两个真实账户隔离。真实模型 Adapter 已实现，尚未提供 API 凭证或进行实连；未接入支付、外部日历或后台提醒。完整跨时区/DST、实时同步、离线编辑、增量写入与自动备份恢复演练仍属后续工作。

[文档索引](docs/README.md) · [V1.2 AI 教练](docs/16-v1.2-ai-coach.md) · [V1.1 接入与交付](docs/15-v1.1-saas-setup.md) · [原本地 MVP 交接](docs/12-mvp-handoff.md)
