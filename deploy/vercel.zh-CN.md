# Vercel + Supabase PostgreSQL + Redis

这是一种独立部署模式。`api/relay.mjs` 导出 Node HTTP Server，Vercel Functions 接收 HTTP 和 WebSocket；Redis 协调持有 Connector 连接的实例和接收访客请求的实例。未配置 Redis 的 CLI/容器仍按单进程运行。

本地已用独立 Node 进程、真实 Redis/PostgreSQL 和 Talk2MyAgent Connector 验证跨实例转发。2026-11-03 还完成了 Vercel 云端部署验收：Supabase、Upstash、真实 Agent 经 Microsandbox 调用 read_file、Connector 自动轮换，以及两个不同 Vercel 部署间的转发。线上验收独立于本地测试；部署者仍需按自己的配置和访客网络重新验证。

## 资源与授权

- Vercel：能创建项目、部署及配置环境变量的账号/团队权限；使用 CLI 设备登录，不把 Token 发到聊天或写进仓库。
- Supabase：新建独立项目的组织权限。先检查实际报价，再确认非零费用；已有 Pro 组织的新项目不应假定免费。
- Redis：支持 TLS、原生 Redis TCP、Pub/Sub、Lua、字符串和有序集合。可选 Upstash Redis；先核对所选套餐的命令量、消息/请求大小、连接数和带宽。只提供 REST KV 接口的服务不够。
- 尽量把三者放在同一区域。当前 Vercel 配置 `hnd1`（东京），Supabase 对应 `ap-northeast-1`；选定 Redis 后核实可用区域。

Vercel 已支持 WebSocket，但不会把所有请求固定到同一个实例。Daemons 当前不能接收入站 HTTP/TCP，不能替代这里的 Function 入口。

项目使用已验证的 Node 24.x；`public/` 是唯一静态输出目录，避免把源代码和构建文件作为静态内容发布。Windows 若因符号链接权限导致 `vercel build` 失败，可先执行 `vercel pull` 下载项目设置，再用 `node scripts/check-vercel-build.mjs` 在一次性 Linux 容器中检查打包。脚本只复制白名单内的源文件、项目设置和空的构建环境文件，不复制账号凭据或真实环境变量，也不会发布部署。

## 数据库准备

1. 创建独立 Supabase 项目；检查现有表和暴露给 Data API 的 schema。
2. 使用迁移账户在可直连的终端执行 `pnpm db:migrate`，依次应用 `src/migrations/001-postgres.sql` 和 `002-mobile-contact.sql`，升级到 schema 2。运行进程不自动迁移。旧生产服务升级时先部署兼容 schema 1/2 的新代码，再执行迁移；迁移仅扩展手机号格式约束，不改写已有编号。
3. `a2a_relay` 是私有 schema，不加入 Data API 的 exposed schemas，不给 `anon`、`authenticated` 或 `PUBLIC` 授权读取 Agent 表。
4. 建立独立运行账户：只授予数据库 CONNECT、私有 schema USAGE、`agents`/`contact_number_sequence` 的 SELECT/INSERT/UPDATE、`schema_migrations` 的 SELECT，以及必要函数 EXECUTE。收回不需要的 PUBLIC schema CREATE 权限。迁移账户不进入 Vercel 运行环境。
5. 使用 Supabase Connect 面板给出的 **Shared Pooler（共享连接池）** Host 和事务端口 **6543**。Host 以 `.pooler.supabase.com` 结尾，用户名包含项目引用（如 `a2a_relay_app.<project-ref>`）。若面板只找到 Session pooler，可取其 Host，将 5432 改为事务端口 6543。Dedicated Pooler（`db.<project-ref>.supabase.co:6543`）是另一个端点，可能只有 IPv6。代码没有命名预编译语句，可用于事务连接池；每个 Vercel 实例默认只有 2 个 pg 连接。
6. 在 Database Settings → SSL Configuration 下载项目 CA，使用 `sslmode=verify-full`。目前官方面板链接到 [Supabase Root 2021 CA](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt)，配置新项目时应核对面板当前证书。CA 通过 `RELAY_PG_CA` 环境变量提供，保留证书和主机名校验。需要的 TLS、池化端点和角色能力必须用实际连接测试，不能靠修改为 `rejectUnauthorized:false` 解决。
7. 检查 Supabase advisors，确认运行账户无法建表、删除身份表、读取其他项目数据；确认 Data API 不能读取中继注册信息。

## 环境变量

在 Vercel 项目中设置，分别限定 Production/Preview 的作用域。不要把真实值写进 `vercel.json`。

| 变量 | 设置 |
| --- | --- |
| `RELAY_ORIGIN` | 当前环境的固定 HTTPS 入口，不能从请求 Host 推断 |
| `RELAY_STORE` | `postgres` |
| `RELAY_DATABASE_URL` | 运行账户的 PostgreSQL URL，密码需 URL 编码，`sslmode=verify-full` |
| `RELAY_PG_CA` | 项目 CA 的完整 PEM 内容；若系统根证书可完成验证则可省略 |
| `RELAY_PG_POOL_SIZE` | 默认 2，可按 Supabase 连接预算调整，范围 1–20 |
| `RELAY_REDIS_URL` | 原生 Redis TLS URL：`rediss://<user>:<password>@<host>:<port>` |
| `RELAY_REDIS_NAMESPACE` | 如 `a2a-production`；Preview 必须使用不同值 |
| `RELAY_REGISTRATION` | 上线准备期间 `closed`；完成迁移和验收后按需要开启 |
| `RELAY_MAX_CONCURRENT` | 默认 64，Redis 统一计数；每 Agent 最多 8 |

Preview 还必须使用独立数据库/项目或隔离数据库环境；仅分开 Redis namespace 不能隔离 PostgreSQL 中的发布开关和连接代数。不要把生产数据库秘密自动注入任意 PR Preview。

Vercel 入口只在平台环境中运行，并使用平台覆盖的 `x-vercel-forwarded-for` 做全局限流。普通容器仍使用明确配置的可信反向代理 IP。缺少 PostgreSQL 或 Redis 时，Vercel 入口直接拒绝启动，不会退回临时 SQLite。

## 转发与故障处理

- PostgreSQL 保存注册身份、11 位编号、发布开关与连接代数，继续用事务保证不重复发号。
- Redis 只持久到期的连接归属、限流、并发名额和去重请求 ID；Pub/Sub 传递聊天请求/响应字节，不建立聊天消息队列。
- 归属租约绑定 `publicationId + connectionId + generation`，60 秒过期，心跳刷新。新的连接代数取代旧连接。
- 访客 HTTP 请求跨实例发送一次。Redis 命令不启用离线排队或未完成命令重放；转发失败返回错误或结束流，绝不自动重新调用本地 Agent。
- 每 5 秒检查活动请求的连接归属和发布状态；实例退出、归属变更或数据库/Redis 失联时终止旧请求。
- HTTP 写入完成后才向拥有 Connector 的实例返还流量额度，再由它向 Connector 返还额度；慢客户端仍受 256 KiB 窗口约束。
- Redis 中断时已有 Connector 断开，`/ready` 返回 503，`/health` 仍反映进程存活。恢复后 Connector 使用原身份重连。

Redis 运营者和 Vercel Relay 运营者能接触转发内容与访客令牌。这不是端到端加密。生产 Redis 必须使用 TLS 和专用访问凭据，禁止记录消息正文或授权头。

## Function 时间限制

默认 `vercel.json` 的 `maxDuration` 为 300 秒；入口从该文件读取限制，应用请求最长 270 秒，Connector 最长 280 秒。空闲连接在期限的 80% 之后轮换，已有调用也受当前连接剩余寿命限制。

拥有支持更长执行时间的 Vercel 套餐时，可将 `api/relay.mjs` 的 `maxDuration` 改为 800，重新部署后默认请求上限 600 秒、连接上限 780 秒。未验证的 1800 秒 beta 不在此配置范围。

连接轮换不能恢复进行到一半的聊天响应。客户端应查询已知任务 ID；即使已经使用 Redis，也不能承诺任意时点发起的同步请求都完整运行 10 分钟。长任务应通过 A2A 任务查询延续。

## 数据迁移与切换

先保留原服务，完成候选部署的测试，再安排注册冻结和最终数据迁移。必须保留完整 Agent 行、凭据摘要、发布 ID、11 位编号和 `contact_number_sequence`，不得在两套独立数据库同时继续发号。使用相同正式域名能保留 Connector 按 origin 保存的身份；使用新域名则需要明确处理 Connector 注册状态迁移。

默认 Vercel HTTPS 地址可用于候选部署验收，但不应把它和正式域名混用为 `RELAY_ORIGIN`。正式域名绑定、DNS 切换和旧服务停用是上线步骤，不能用健康检查成功代替完整链路验收。

## 验证

```powershell
$env:A2A_CONNECTOR_SOURCE='D:\code\Talk2MyAgent\packages\a2a-connector'
pnpm test
pnpm test:postgres
pnpm test:cluster
```

`test:cluster` 创建一次性本地 PostgreSQL 和 Redis 容器，启动独立中继进程，把 Connector WebSocket 固定送到 A、所有访客 HTTP 固定送到 B。它验证名片、鉴权、大请求、中文流式响应、背压、跨入口并发限制、取消、连接进程退出、连接到期、关闭发布、Redis 故障、去重和 namespace 隔离。结束时只清理该次测试创建的容器和卷。

上线还需完成 Vercel 的实际构建和默认 HTTPS 地址测试、托管数据库权限/TLS验证、真实 Agent 聊天、手机/电脑跨网访问，以及真实平台运行时长后的重连验证。

`scripts/smoke-public.mjs` 支持在关闭新注册时复用已准备的 QA 身份：设置 `RELAY_QA_EXISTING_STATE_FILE`，指向当前测试 origin 的私有 Connector 状态文件，同时设置 `RELAY_QA_STATE_FILE`、`RELAY_QA_ORIGIN` 和 `A2A_CONNECTOR_SOURCE`。状态中的发布意图必须为开启。脚本结束会关闭该 QA 发布，报告会区分“已有身份保留”和“新地址分配”。含凭据的状态文件必须放在代码仓库之外。

参考：[Vercel WebSocket](https://vercel.com/docs/functions/websockets)、[Function 限制](https://vercel.com/docs/functions/limitations)、[可信请求头](https://vercel.com/docs/headers/request-headers)、[Supabase SSL](https://supabase.com/docs/guides/platform/ssl-enforcement)、[Upstash Redis 兼容性](https://upstash.com/docs/redis/overall/rediscompatibility)。
