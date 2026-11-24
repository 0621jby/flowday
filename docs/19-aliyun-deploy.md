# FlowDay 私有部署与维护

阿里云运行 FlowDay 和保存备份。Supabase Free 运行 PostgreSQL 和 Auth。应用保留 V1.5 的 RLS 隔离、增量写入、请求回执、冲突检测、待保存变更导出及前台同步。主机只需运行应用容器及 HTTPS 反向代理，镜像由 GitHub Actions 构建。每次发布都用 Git 提交标记，并固定到镜像摘要。

## 1. 检查主机和网络

在阿里云控制台 Workbench 中运行 [inspect.sh](../deploy/aliyun/inspect.sh)。它读取系统版本、架构、内存、交换空间、磁盘、监听端口、容器和运行服务。应用初始内存上限为 384 MiB。首次启动后根据实际占用复核余量。

优先在有空余 Free 名额的组织中使用专用项目。可选区域包括首尔、东京和新加坡，区域选择后需要通过新项目迁移才能更改。从实际阿里云主机运行 `bash probe.sh https://实际项目编号.supabase.co`，记录 10 次 HTTPS 的 DNS、连接、TLS、首字节及总耗时。匿名接口返回 401 时，只证明 HTTPS 已连通。部署脚本另外从容器调用带 Publishable Key 的 Auth 接口。数据库维护通道再用 `psql -X -Atc 'select 1'` 验证。应在不同时间段复测，最终以真实登录、读取和保存的端到端结果判断。[Supabase 区域](https://supabase.com/docs/guides/platform/regions)

## 2. 配置 Supabase、应用和 HTTPS

- 在新建 Free 项目选用 **Connect → Session pooler**。在 IPv4 主机使用界面给出的实际主机名、用户名和端口，在 `pg_service.conf` 设置 `sslmode=verify-full` 和 Supabase 发布的 CA 路径。将数据库口令保存在 `pgpass`，权限为 `0600`。这份配置只交给运维进程，应用日常请求只使用 Publishable Key 和用户会话。[连接数据库](https://supabase.com/docs/guides/database/connecting-to-postgres)
- 从 [runtime.env.example](../deploy/aliyun/runtime.env.example) 创建服务器端 `/opt/flowday/runtime.env`，填写项目 URL、Publishable Key、稳定的 AI 签名密钥和正确的 `APP_ORIGIN`。文件权限为 `0600`。将实际 HTTPS 源配置为 Supabase Site URL，同时允许该源的 `/auth/callback`。正式配置校验会拒绝 HTTP 或缺少 Supabase 配置的启动检查。
- 确认服务器上现有反向代理的端口和虚拟主机后，使用 [Nginx 示例](../deploy/aliyun/nginx-flowday.conf.example) 增加单独虚拟主机。后端仅绑定 `127.0.0.1:13100`。对已有配置做语法检查后再重载。页面和用户 API 不经代理缓存，静态资源使用 Next.js 原有的版本化路径。北京主机正式域名按阿里云要求完成备案后上线，早期可用 SSH 隧道访问回环地址做本地模式验收。HTTPS 是录入真实用户数据的上线条件。[阿里云域名与备案说明](https://help.aliyun.com/zh/simple-application-server/user-guide/manage-domain-names/)
- 默认 Supabase 邮件只送达项目团队的预授权地址。个人验收可用控制台预先创建并确认的测试用户，面向普通用户自助注册时配置获准使用的 SMTP。生产验收分别记录控制台建号、应用自助注册、邮箱确认及登录的结果。[Supabase 邮件限制](https://supabase.com/docs/guides/auth/auth-smtp)

## 3. 版本发布和应用回滚

首次初始化由管理员完成。运行目录 `/opt/flowday`、环境变量文件、日志目录和 systemd 单元均归 root 所有。安装 `flowday-release.service`、`flowday-rollback.service`、`flowday-backup.service` 及对应定时器后，专用 SSH 账号只接收 `status`、`logs`、`update` 和 `rollback`。首次初始化和常规发布使用不同的 SSH 公钥。

1. 本地完成修改和测试，提交并推送 GitHub。工作流在 Linux 运行项目测试、PostgreSQL 备份恢复演练和容器验证。仓库变量 `FLOWDAY_PUBLISH_IMAGE=1` 启用通过检查的 `main` 镜像发布。部署侧用该私有镜像的只读凭证登录 GHCR。
2. 复制部署文件至 `/opt/flowday`，将 [operations.env.example](../deploy/aliyun/operations.env.example) 配置在 `/etc/flowday/operations.env`。在日常运行这些脚本的同一账户下确认 Docker 登录和 PostgreSQL 连接。先人工运行一次 `flowday-release.service`，确认容器健康、真实 Supabase 连通和 HTTPS 返回正确；再启用 `flowday-release.timer` 和 `flowday-backup.timer`。
3. [release.sh](../deploy/aliyun/release.sh) 发现新镜像后先生成数据库备份，再运行 [postgres.sh](../deploy/aliyun/postgres.sh)。迁移与校验和登记一起提交，失败会中止发布。新版本启动后，脚本校验 `/api/health` 返回的 Git 提交、云端模式及 Auth 接口可用性。应用检查失败会切回上一个镜像。更新有短暂的容器切换窗口。
4. 查看 `/api/health` 的 `release`、`journalctl -u flowday-release` 或 `/opt/flowday/ops/deployments.log` 可核对版本。人工回滚时，在部署账户的同一环境运行 `bash /opt/flowday/release.sh rollback`。保留当前和上一版镜像。兼容性变更使用先扩展、升级应用、再收缩的顺序。应用回滚保留已写入的用户数据，数据库故障恢复走独立流程。

上述迁移脚本针对由它初始化的专用项目。若选择已有 FlowDay 数据的 Supabase 项目，先备份并核对已执行的 SQL 和版本。建立匹配的迁移登记后再接入自动发布。

## 4. 备份、恢复和额度监控

- 日备份计划为北京时间 03:15。每次发布前也备份。文件位于 `/opt/flowday/ops/backups`，包含应用数据、Auth 数据和迁移账本。备份包含密码哈希等敏感数据，目录权限应限制为运维账户。定期把至少一份加密备份保存在阿里云以外或离线位置，确认保存与恢复后再清理过期副本。外部 Storage 对象需要另备份，当前 FlowDay 的复盘涂鸦保存在数据库中。
- CI 使用隔离 PostgreSQL 恢复测试备份，验证两个虚拟账户的任务、计划和 RLS，并模拟失败迁移。接通 Supabase 后，用真实样本备份向空白测试环境演练，验收前核对用户、任务、计划、复盘、版本和隔离策略，再用测试账号验证登录。恢复到新托管项目时按 Supabase 指引导入托管 Auth 数据和应用结构，恢复前核对源与目标的项目编号，使用独立应用变量。新项目密钥和 Auth 配置需要单独设置，用户会重新登录。[Supabase 恢复指南](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- `journalctl -u flowday-backup` 每日记录数据库大小及可读取的 Storage 对象容量。周期传出量须以 Supabase 组织 **Usage** 中实际的 Cached / Uncached Egress 为准，两项额度独立。Free 当前包括每项目 500 MB 数据库、组织 1 GB 文件存储和每月 5 GB 未缓存及 5 GB 缓存传出。可以用 80% 作为人工检查阈值，并关注阿里云备份目录剩余空间。[Supabase 用量说明](https://supabase.com/docs/guides/platform/billing-on-supabase)
- 备份连接或 Auth 探测连续失败时，从 Supabase 项目列表查看是否暂停，再区分 DNS、TLS、网络和项目故障。Free 项目低活跃时可能暂停，恢复由项目所有者在控制台执行。发现额度异常先核对用量、备份频率和流量来源；套餐变更由项目所有者决定。[Supabase 项目暂停](https://supabase.com/docs/guides/platform/free-project-pausing)
