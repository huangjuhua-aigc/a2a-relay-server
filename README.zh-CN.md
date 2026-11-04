# A2A Relay Server

[简体中文](README.zh-CN.md) · [English](README.md)

独立部署的开源 A2A 中继服务，MIT 许可。用户本机的 Connector 主动建立出站连接；Relay 为 agent 分配稳定地址，只转发 A2A 和 Agent Card 两个入口，不转发 Portal 和主人管理接口。

## 启动

现已支持 PostgreSQL/RDS，SQLite 仍为默认选项。云数据库的 TLS、迁移和运行账号权限、SQLite 导入及内网 Kubernetes 清单见 [PostgreSQL 部署说明](deploy/postgres.zh-CN.md)。多实例运行还需启用 Redis 协调层，见 [Vercel + Supabase 部署说明](deploy/vercel.zh-CN.md)；仅共享 PostgreSQL 不能跨实例转发活动连接。

需要 Node.js **22.13+（22.x）或 24.x**、pnpm。SQLite 使用 Node 内置模块。当前在 Windows / Node 24.19 上完成自动化验证；Vercel 项目固定使用 24.x。

```powershell
pnpm install --frozen-lockfile
$env:RELAY_ORIGIN='https://relay.example.com'
pnpm start
```

`relay.example.com` 是示例域名，需要替换为实际部署地址。服务默认监听 `127.0.0.1:8787`，前面配置 HTTPS 反向代理，参考 [Nginx 配置](deploy/nginx.conf.example)。开启 WebSocket，关闭流式响应缓冲。SQLite 模式保留 `data/relay.db` 及 WAL 文件并使用单进程；多实例模式使用共享 PostgreSQL 和 Redis。

本地开发可用 `RELAY_ORIGIN=http://127.0.0.1:8787` 和 `RELAY_ALLOW_LOOPBACK_HTTP=1`。Portal 进程设置 `A2A_RELAY_DEFAULT_HOST=http://127.0.0.1:8787`、`A2A_RELAY_ALLOW_LOOPBACK_HTTP=1` 后即可联调。生产使用 HTTPS，不开启这两个开发开关。

用户保存 Agent 后，在 Portal 获取中继地址和编号，无需先启动 Agent；可以先准备邀请，之后启动时自动连接同一路径。维护者通过 `A2A_RELAY_DEFAULT_HOST` 提供默认入口，用户也可以选择自定义 host。

## 统一分配通讯录编号

火山 VKE 的 IP 直连部署见 [部署说明](deploy/vke.zh-CN.md)：包含容器镜像、单副本持久卷、独立公网入口和 IP 证书自动续期。清单生成脚本本身不创建云资源。健康检查 `/health` 独立于访客限流，避免高流量触发错误重启。

`POST /v1/agents/register` 支持用户填写 `contactId`：以 `1[3-9]` 开头的 11 位手机号，用作公开 Agent 编号。**暂不验证手机号归属**，编号会出现在邀请和 `/r/<contactId>/a2a` 地址中，不能代替访客 Token。同一 Relay 中一个号码只能注册一个 Agent，重号返回 HTTP 409 和 `CONTACT_ID_TAKEN`；不能覆盖原注册。注册后编号固定，同一身份重试和重启复用原号；关闭、撤销或重置设备身份不会释放号码。

旧客户端不传 `contactId` 时仍自动分配 `13800000000` 到 `13999999999`，跳过已占用号码。SQLite 使用 `BEGIN IMMEDIATE`，PostgreSQL 锁定发号行，唯一索引保证多实例并发注册不重号。号池耗尽时报错而不循环复用。返回值保留旧 UUID URL，并增加 `contactRpcUrl` / `contactCardUrl`；新版 Connector 对自填号码使用数字地址，两种路径都指向同一个内部注册，访客鉴权不变。PostgreSQL 需先使用迁移角色执行 `pnpm db:migrate` 升级到 schema 2；SQLite 打开旧库时在事务内升级约束并保留全部记录。

启动时会在事务中为旧 SQLite 数据库补号，保留原访问路径、设备凭据和发布状态。PostgreSQL 需先显式执行 `pnpm db:migrate`，导入 SQLite 的步骤见部署说明。请保留完整数据库及 `contact_number_sequence`；删除数据库或恢复过时备份会丢失发号历史。升级顺序为 Relay → Connector/Portal；旧 Connector 进程需重启，新版通过带设备认证的 `GET /v1/publication` 取回号码。此前本地生成的号码改由服务端号码替代，用户需重新复制邀请。

唯一性范围是同一个 Relay 数据库。若多个独立自建 Relay 也要使用全球唯一号码，需要共享号码注册中心或由中心划分互不重叠的号段，当前尚未实现；不能仅凭号码在全网查找 Agent。多实例模式共享 PostgreSQL 注册表和 Redis namespace；不配置 Redis 时仍要求单进程部署。

## 运行边界

- 注册、发布意图和设备凭据摘要持久化到 SQLite 或 PostgreSQL；聊天内容不入库、不写日志。设备原始凭据仅保存在用户本机私有目录。
- 访客令牌原样交给本地 agent 验证。TLS 在 Relay/代理终止，Relay 运营者能够看到转发内容及访客令牌；当前不是端到端加密。
- 只支持无签名、单接口的 A2A 1.0 JSONRPC 名片；公开名片和扩展名片中的接口 URL 自动改写。
- 保留 SSE 流式响应，按字节转发，有限窗口控制背压。断线不自动重放请求；已知任务 ID 可由访客继续查询。
- 关闭发布不会停止本地 agent，也不会撤销 agent 已接受的模型任务。没有离线消息队列。
- 已有 Redis 跨实例路由；不含账号、计费、闭源 agent 入站适配或 MCP 桥接。
- Vercel Function 有执行时长限制，连接轮换可能中断正在进行的同步响应；需要按已知 A2A 任务 ID 查询，不自动重发原消息。具体限制见 Vercel 部署说明。

完整环境变量、接口和容量限制见[英文运行说明](README.md#configuration)。公开自动注册默认每 IP 每小时 20 次、总容量 10000；管理员可设置 `RELAY_REGISTRATION=closed`。代理须覆盖 `X-Forwarded-For`，并明确设置 `RELAY_TRUSTED_PROXY_IPS=127.0.0.1`，否则按代理自身 IP 计数。

管理员本机执行 `node src/admin.mjs revoke <publicationId>` 撤销设备，使用与应用相同的数据库配置。新请求立即拒绝，已有连接在下一次心跳关闭（20 秒间隔，另加有界数据库查询时间）；需要立即切断全部连接时重启 Relay。默认凭据长期有效直到撤销，不自动更换身份规避封禁。

## 测试

执行 `pnpm test`。Connector 与 UI 联调需要另外检出 Talk2MyAgent，并给测试进程设置 `A2A_RELAY_SOURCE` 为本仓库绝对路径，命令见[英文测试说明](README.md#tests-and-shared-protocol)。协议代码已随仓库 vendoring，不依赖其他本地仓库才能启动。

Docker 运行时，将 `A2A_CONNECTOR_SOURCE` 设置为 Talk2MyAgent 的 `packages/a2a-connector` 目录，执行 `pnpm test:postgres` 和 `pnpm test:cluster`，可测试一次性数据库与独立中继进程之间的完整传输。测试使用真实 Connector 和受控本地 HTTP 响应，不调用付费模型。

公网域名、生产 TLS 代理、Linux 进程生命周期与实际跨网可达性需要在选定部署环境验收；本次没有执行线上部署。
