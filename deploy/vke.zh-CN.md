# 火山 VKE 部署：直接使用公网 IP

本方案不需要域名。独立 CLB 的公网 IPv4 直接作为 `https://<IP>` 入口，Caddy 申请并自动续期 Let's Encrypt 的 IP 证书；Relay 和 Connector 继续严格校验 HTTPS，不开放明文凭据传输。

这份配置已经过本地容器验证及 Kubernetes 服务端 dry-run；**公网 CLB、IP 证书签发、实际跨网链路仍需要部署后验收**。渲染脚本只输出 JSON 清单，不调用 Kubernetes，不创建资源。

## 资源与边界

- 独立 namespace `a2a-relay`，一个 Deployment、一个 Pod、两个容器。
- Relay：requests 250m CPU / 256Mi，limits 1 CPU / 512Mi。
- HTTPS 代理：requests 50m CPU / 64Mi，limits 500m / 256Mi。合计预留 0.3 CPU / 320Mi；这是初始预算，不是并发容量承诺。
- 20Gi EBS 数据卷，独立 `Retain` StorageClass。SQLite、递增发号序列、ACME 账户和证书持久化；不能用临时盘、NAS 或对象存储替代 SQLite 的本地块设备文件系统。
- 单副本 + `Recreate`，不要开启 HPA、滚动扩容或把多个 Relay 接到同一数据库。升级期间会短暂断线，Connector 自动重连；进行中的请求不会自动重放。
- Relay 只监听 Pod 内 `127.0.0.1:8787`，外部只能访问 HTTPS 代理。代理覆盖 X-Forwarded-For，Relay 只信任本机代理；CLB 使用直通 Pod 模式。部署后必须实测代理看到的是访问者真实 IP。
- 80/TCP 用于 ACME HTTP-01，443/TCP 用于 HTTPS/WSS；无需向公网开放 8787。保持 80 端口可访问，以便续期验证。
- 新增 **独立 CLB / 公网 IP、流量和 20Gi 云盘费用**。已有节点足够时不需要新增 ECS；账号余额、配额、IP 带宽和云盘实际价格不属于 Kubernetes API 的核验范围。

火山不支持将一个由 Service 自动创建的 CLB 再供第二个 LoadBalancer Service 复用。不要直接绑定其他业务 Service 的 CLB ID，也不要覆盖它的监听器。该方案创建自己的 CLB，保持已有 Ingress 和 80/443 监听器不变。[官方说明](https://docs.volcengine.com/docs/vke/loadbalancer-service-usage-precautions?lang=zh)

## 1. 构建并上传镜像

Node 和 Caddy 基础镜像均固定版本和 digest。HTTPS 镜像去掉了上游二进制的低端口 capability，配合非 root、只读根文件系统、禁止提权和 drop ALL 运行。监听高端口 8080/8443，由 Service 映射到公网 80/443。

以下示例使用 PowerShell。先确认当前 kubectl context 是目标集群；不要依赖另一项任务遗留的 current-context。镜像仓库、子网、正式 IP 由部署者填写，不写入公共仓库。

```powershell
kubectl config get-contexts
$context = '<目标 VKE context>'
$env:RELAY_IMAGE = '<同地域镜像仓库>/a2a-relay:20261031-1'
$env:RELAY_HTTPS_IMAGE = '<同地域镜像仓库>/a2a-relay-https:20261031-1'
docker build -t $env:RELAY_IMAGE .
docker build --target https -t $env:RELAY_HTTPS_IMAGE .
docker push $env:RELAY_IMAGE
docker push $env:RELAY_HTTPS_IMAGE
```

确认新 namespace 有镜像拉取权限；若未启用 VKE 同账号免密拉取，应由部署者配置 `imagePullSecrets`，不要在清单中放仓库密码。

## 2. 分配独立 IP

```powershell
$env:VKE_SUBNET_ID = '<目标集群 VPC 内的子网 ID>'
node deploy/render-vke.mjs bootstrap | Set-Content -Encoding utf8 bootstrap.json
kubectl --context $context apply -f bootstrap.json
kubectl --context $context -n a2a-relay get service a2a-relay-public -w
```

这一步会创建 namespace 和付费 CLB；此时还没有应用后端，不会接待访客。等待 `EXTERNAL-IP` 后，复制实际分配的 IP。该地址不是现有 Ingress 的 IP。

## 3. 启动并验证 TLS

```powershell
$env:RELAY_PUBLIC_IP = '<刚分配的公网 IPv4>'
$env:RELAY_REGISTRATION = 'closed'
node deploy/render-vke.mjs workload | Set-Content -Encoding utf8 workload.json
kubectl --context $context apply -f workload.json
kubectl --context $context -n a2a-relay rollout status deployment/a2a-relay
curl.exe --fail "https://$env:RELAY_PUBLIC_IP/health"
```

必须不加 `-k` 完成 TLS 校验。Caddy 首次申请证书需要连通 ACME 服务，并完成公网 80/443 上的 IP 控制权验证。Pod Ready 和本地 `/health` 成功并不代表公网证书已经签发；应以严格校验的公网 HTTPS 请求为准。签发失败时保留注册关闭，查看 HTTPS 容器日志以及 CLB 事件，不关闭证书校验。

IP 证书有效期为 160 小时，Caddy 持续运行并持久化 `/data/caddy` 后自动续期；部署验收还应覆盖至少一次续期和证书过期告警。[Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/)、[Caddy ACME profile 配置](https://caddyserver.com/docs/caddyfile/directives/tls)

## 4. 开放注册和连接 Portal

完成 TLS、真实来源 IP 和入口隔离检查后：

```powershell
$env:RELAY_REGISTRATION = 'open'
node deploy/render-vke.mjs workload | Set-Content -Encoding utf8 workload.json
kubectl --context $context apply -f workload.json
kubectl --context $context -n a2a-relay rollout restart deployment/a2a-relay
kubectl --context $context -n a2a-relay rollout status deployment/a2a-relay
```

ConfigMap 环境变量更新需要重启 Pod 才生效。设置 Portal 默认入口 `A2A_RELAY_DEFAULT_HOST=https://<IP>`，或在自定义 Relay host 填入它。不要开启 `A2A_RELAY_ALLOW_LOOPBACK_HTTP`。

用一个测试 Agent 完成：离线注册取号 → 本地启动 Connector → 严格校验 WSS → 访客鉴权 → 真实 A2A 调用/SSE → Relay 重启后同地址重连。确认未授权凭据被拒绝、超限返回 429、健康检查仍为 200。使用不同公网来源检查按 IP 限流；勿通过真实访客令牌的访问日志调试。

## 数据备份与回滚

数据库和证书目录都位于 PVC。使用 SQLite 一致性在线备份或停止写入后完整备份；不要只复制正在写入的 `relay.db` 而遗漏 WAL。升级前保留备份，定期验证恢复。`Retain` 防止误删 PVC 后自动删云盘，但不替代备份。

回滚应用镜像要先确认旧版本支持当前数据库结构；正常应用回滚保留现有数据盘，**不要恢复旧发号序列或删除数据库来修复启动问题**。陈旧备份可能丢失已经发出的号码，正式系统发生数据丢失需停止发号并审查恢复。

删除 LoadBalancer Service 会回收它创建的 CLB，原 IP 可能丢失；仅重启 Pod 不会换 IP。不要用 `kubectl delete namespace` 作为常规重启操作。独立 Relay 间仍没有全球号码注册中心。

## 本地验收

```powershell
pnpm test
docker build -t a2a-relay-server:vke-check .
docker build --target https -t a2a-relay-https:vke-check .
node scripts/smoke-container.mjs
```

容器测试使用隔离临时数据卷和本地 CA，并为请求显式信任该 CA；不会关闭 TLS 校验、申请公网证书或创建云资源。覆盖非 root / 只读根文件系统、HTTPS、WSS、SSE 及时输出、伪造转发 IP、健康检查、SIGTERM 和重建容器后的身份保留。临时容器和卷在测试结束时清理。
