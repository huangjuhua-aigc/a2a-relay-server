# A2A Relay Server

[简体中文](README.zh-CN.md) · [English](README.md)

独立部署的开源 A2A 中继服务，MIT 许可。用户本机的 Connector 主动建立出站连接；Relay 为 agent 分配稳定地址，只转发 A2A 和 Agent Card 两个入口，不转发 Portal 和主人管理接口。

## 启动

需要 Node.js **22.13+**、pnpm。SQLite 使用 Node 内置模块。当前在 Windows / Node 24.19 上完成自动化验证。

```powershell
pnpm install --frozen-lockfile
$env:RELAY_ORIGIN='https://relay.example.com'
pnpm start
```

`relay.example.com` 是示例域名，需要替换为实际部署地址。服务默认监听 `127.0.0.1:8787`，前面配置 HTTPS 反向代理，参考 [Nginx 配置](deploy/nginx.conf.example)。开启 WebSocket，关闭流式响应缓冲，保留 `data/relay.db` 及 WAL 文件；当前只支持单进程部署。

本地开发可用 `RELAY_ORIGIN=http://127.0.0.1:8787` 和 `RELAY_ALLOW_LOOPBACK_HTTP=1`。Portal 进程设置 `A2A_RELAY_DEFAULT_HOST=http://127.0.0.1:8787`、`A2A_RELAY_ALLOW_LOOPBACK_HTTP=1` 后即可联调。生产使用 HTTPS，不开启这两个开发开关。

用户在 Portal 选择“公网中继”，后台自动注册并连接；上线后显示地址，按选定访客生成完整聊天邀请。维护者通过 `A2A_RELAY_DEFAULT_HOST` 提供默认入口，用户也可以选择自定义 host。

## 运行边界

- 注册、发布意图和设备凭据摘要持久化到 SQLite；聊天内容不入库、不写日志。设备原始凭据仅保存在用户本机私有目录。
- 访客令牌原样交给本地 agent 验证。TLS 在 Relay/代理终止，Relay 运营者能够看到转发内容及访客令牌；当前不是端到端加密。
- 只支持无签名、单接口的 A2A 1.0 JSONRPC 名片；公开名片和扩展名片中的接口 URL 自动改写。
- 保留 SSE 流式响应，按字节转发，有限窗口控制背压。断线不自动重放请求；已知任务 ID 可由访客继续查询。
- 关闭发布不会停止本地 agent，也不会撤销 agent 已接受的模型任务。没有离线消息队列。
- 不含账号、计费、闭源 agent 入站适配、MCP 桥接或多节点扩容。

完整环境变量、接口和容量限制见[英文运行说明](README.md#configuration)。公开自动注册默认每 IP 每小时 20 次、总容量 10000；管理员可设置 `RELAY_REGISTRATION=closed`。代理须覆盖 `X-Forwarded-For`，并明确设置 `RELAY_TRUSTED_PROXY_IPS=127.0.0.1`，否则按代理自身 IP 计数。

管理员本机执行 `node src/admin.mjs revoke <publicationId>` 撤销设备。新请求立即拒绝，已有连接在下一次心跳关闭（最多 20 秒）；需要立即切断全部连接时重启 Relay。默认凭据长期有效直到撤销，不自动更换身份规避封禁。

## 测试

执行 `pnpm test`。Connector 与 UI 联调需要另外检出 Talk2MyAgent，并给测试进程设置 `A2A_RELAY_SOURCE` 为本仓库绝对路径，命令见[英文测试说明](README.md#tests-and-shared-protocol)。协议代码已随仓库 vendoring，不依赖其他本地仓库才能启动。

公网域名、生产 TLS 代理、Linux 进程生命周期与实际跨网可达性需要在选定部署环境验收；本次没有执行线上部署。
