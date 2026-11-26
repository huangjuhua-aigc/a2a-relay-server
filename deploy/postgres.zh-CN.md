# PostgreSQL / 火山 RDS 部署

SQLite仍为默认选项；PostgreSQL保存注册、号码分配、设备凭据摘要和发布状态，不保存对话内容。当前仍要求单副本，数据库共享不会解决内存隧道的跨实例路由。

## 开通实例

创建与新VKE集群同地域、同VPC的RDS PostgreSQL，提供引擎版本、内网host/port、库名（建议`a2a_relay`）、迁移/运行账号和TLS CA。允许实际Pod来源子网访问数据库，并配置备份。密码放本机仓库外私密文件，不放聊天、Git或部署清单中。

本地使用真实PostgreSQL 17完成测试；RDS的网络、证书链、权限和实际版本仍需实例开通后验证。

也已在 PostgreSQL 14.17 上运行完整集成套件。火山 RDS 14 的 `public` schema 可能由系统角色持有，数据库拥有者不一定能撤销它向 PUBLIC 授予的 CREATE。执行 REVOKE 后应使用 `has_schema_privilege` 核验结果，不能只检查命令是否报错；默认 search_path 也不能替代权限撤销。

## 连接配置

| 变量 | 用途 |
|---|---|
| `RELAY_STORE=postgres` | 明确选择PostgreSQL；未指定时，有URL则选PostgreSQL，否则选SQLite |
| `RELAY_DATABASE_URL_FILE` | 推荐：只包含一行连接URL的私密文件 |
| `RELAY_DATABASE_URL` | 环境变量形式的连接URL，不能与FILE同时设置 |
| `RELAY_PG_CA_FILE` | 可选RDS服务端CA PEM；未设置时使用系统信任根 |
| `RELAY_PG_ALLOW_INSECURE_LOOPBACK=1` | 仅供本机临时测试，配合URL中的`sslmode=disable`；不适用于远程地址 |

连接文件格式（密码需要URL编码）：

```text
postgresql://a2a_relay_app:<URL编码后的密码>@<内网地址>:5432/a2a_relay?sslmode=verify-full
```

默认验证证书和主机名；远程`sslmode=require`、`disable`和跳过校验均被拒绝。URL仅接受`sslmode`查询参数，其他TLS设置使用CA文件变量。不要设置`NODE_TLS_REJECT_UNAUTHORIZED=0`。连接池最多10个连接，有连接、SQL和锁等待超时；不自动重试写操作，不打印原始SQL错误或连接字符串。

## 初始化与权限

应用启动不自动执行DDL。先用迁移账号运行：

```powershell
$env:RELAY_STORE='postgres'
$env:RELAY_DATABASE_URL_FILE='C:\private\a2a-relay\migration.url'
$env:RELAY_PG_CA_FILE='C:\private\a2a-relay\rds-ca.pem'
pnpm db:migrate
pnpm db:check
```

迁移账号需要在数据库内创建schema、表、索引、函数和触发器，不需要云账号管理员权限。对象位于`a2a_relay` schema。为实际运行账号授权：

```sql
GRANT CONNECT ON DATABASE a2a_relay TO a2a_relay_app;
GRANT USAGE ON SCHEMA a2a_relay TO a2a_relay_app;
GRANT SELECT, INSERT, UPDATE
  ON a2a_relay.agents, a2a_relay.contact_number_sequence TO a2a_relay_app;
GRANT SELECT ON a2a_relay.schema_migrations TO a2a_relay_app;
GRANT EXECUTE ON FUNCTION a2a_relay.protect_contact_id() TO a2a_relay_app;
```

运行账号不需要DELETE或CREATE。发号和注册在同一行锁事务中完成，并有唯一约束；重复请求保留原号，撤销不回收，号池耗尽不回绕。发布修订号按锁定后的最新行检查。

切换`RELAY_DATABASE_URL_FILE`到运行账号文件，设置`RELAY_ORIGIN=https://<最终入口>`后启动。`/health`仅表示进程存活；`/ready`检查数据库/schema。数据库故障时ready返回503，存活探针不会触发反复重启。新请求无法通过校验时拒绝转发；已有隧道在下一次心跳验证失败后关闭（20秒心跳，另加有界数据库等待）。

## SQLite导入（可选）

新生产环境可以使用空库。如果要保留本机身份，先停止旧中继写入并制作一致性备份，再用迁移账号导入空的PostgreSQL注册表：

```powershell
node src/database.mjs import-sqlite 'C:\private\a2a-relay\backup\relay.db'
```

来源必须已含服务端contactId及发号序列。导入只读来源，在目标单一事务中完成，目标非空时拒绝；保留编号、UUID路径、凭据哈希、启用/撤销状态、修订号、连接代数和发号进度，失败全部回滚。不会回退目标序列。不能让旧、新环境继续双写，也不能通过恢复陈旧发号数据回滚代码。

完整地址还取决于`RELAY_ORIGIN`。更换host时，Connector凭据按origin隔离，数据库导入不会自动迁移Connector身份缓存。可信host迁移需单独安排，不能自动把旧凭据发送给任意新host。

## VKE内网清单

可设置 `RELAY_NAMESPACE` 为独立命名空间（默认 `a2a-relay`），设置 `RELAY_IMAGE_PULL_SECRET` 引用该命名空间内的镜像拉取 Secret。迁移 Job、Service 和 Deployment 都使用同一命名空间；`kubectl -n` 也必须对应。独立 Relay 应使用独立数据库及运行账号，仅换命名空间不会隔离注册表或防止设备密钥跨服务复用。

使用已有 ALB 时，为新域名创建单独的 Ingress，并引用证书中心证书 ID 对应的 Secret；不要覆盖其他域名的 Ingress 或默认监听器证书。DNS 可用 CNAME 指向 ALB 实例域名。部署前核对证书 SAN、有效期和私钥匹配。项目本地证书可保存于 `.private-deploy/<deployment>/certs/`，该目录已从 Git、Docker 构建上下文和 Vercel 上传中排除；私钥不要写入清单、日志或文档。

普通容器运行时默认 `RELAY_CONNECTION_MAX_AGE_MS=0`，不会按 Vercel Function 的时限主动轮换连接。网络故障、ALB 超时或服务重启仍可能使连接中断。单副本不需要 Redis；扩到多副本前必须配置同一 Redis 协调层。

公网验收脚本 `scripts/smoke-public.mjs` 覆盖注册、WSS、SSE、文件 GET/HEAD/Range 和鉴权。可选 `RELAY_QA_IDLE_MS=310000` 验证超过 5 分钟空闲仍为同一连接。只有设置 `RELAY_QA_KUBECONFIG` 才执行应用重启；同时用 `RELAY_QA_NAMESPACE` 指定候选服务的命名空间，避免重启其他部署。测试使用本机合成响应和文件，不调用真实模型；结束会关闭测试注册的发布状态。

`deploy/render-postgres.mjs migrate|workload`只渲染namespace、迁移Job或内网应用。它不创建ALB、Ingress、域名和证书。原`render-vke.mjs`仍是独立CLB+Caddy+SQLite方案，不要混用。

先确认镜像仓库拉取权限；以文件创建Secret，不把密码展开到命令参数中：

```powershell
$kube='C:\Users\<user>\.kube\a2a-volc.yaml'
kubectl --kubeconfig $kube create namespace a2a-relay
kubectl --kubeconfig $kube -n a2a-relay create secret generic a2a-relay-db-migration --from-file=url=C:\private\a2a-relay\migration.url
kubectl --kubeconfig $kube -n a2a-relay create secret generic a2a-relay-db --from-file=url=C:\private\a2a-relay\runtime.url
kubectl --kubeconfig $kube -n a2a-relay create secret generic a2a-relay-db-ca --from-file=ca.crt=C:\private\a2a-relay\rds-ca.pem
$env:RELAY_IMAGE='<镜像仓库>/a2a-relay:<固定版本>'
$env:RELAY_ORIGIN='https://<最终公网域名>'
$env:RELAY_PG_CA_SECRET='a2a-relay-db-ca'
node deploy/render-postgres.mjs migrate | Set-Content -Encoding utf8 migration.json
kubectl --kubeconfig $kube apply -f migration.json
kubectl --kubeconfig $kube -n a2a-relay wait --for=condition=complete job/a2a-relay-migrate-001 --timeout=120s
node deploy/render-postgres.mjs workload | Set-Content -Encoding utf8 workload.json
kubectl --kubeconfig $kube apply -f workload.json
```

迁移Job不自动重试，失败需诊断后重新创建；后续迁移使用新的`RELAY_MIGRATION_ID`。更新Secret后重启应用读取新配置。

应用单副本Recreate、非root、只读根目录、私密文件挂载，无SQLite PVC，默认关闭注册。ClusterIP只供内部联调，ALB具体后端类型仍需按实例确认。Ingress上线前验证WSS/SSE、超时、鉴权、来源IP以及HTTPS；`RELAY_TRUSTED_PROXY_IPS`只填确认的代理来源。未配置信任时按TCP对端限流。域名和TLS未就绪前使用内网联调。

## 测试

```powershell
pnpm test
$env:A2A_CONNECTOR_SOURCE='D:\code\Talk2MyAgent\packages\a2a-connector'
pnpm test:postgres
```

后者自动启动并清理本机临时PostgreSQL Docker容器和卷，不读取生产连接文件。覆盖多连接发号、重复注册、容量和号码边界、撤销和修订竞争、导入、DML运行权限、TLS默认拒绝明文，以及真实Connector的流式转发、重连和撤销。Connector后面是受控HTTP测试Agent，不调用付费模型。

### 已部署 HTTPS 服务的验收

`scripts/smoke-public.mjs` 需要显式设置 `RELAY_QA_ORIGIN`、`A2A_CONNECTOR_SOURCE`、`RELAY_QA_STATE_FILE`（仓库外私密路径），可设置 `RELAY_QA_REPORT_FILE` 保存无凭据报告。它会创建一个真实的 QA 注册身份，验证 WSS、访客鉴权、SSE 和重连，结束时停用该发布；编号按正常规则保留、不回收。注册接口必须已开启。

只有显式设置 `RELAY_QA_KUBECONFIG` 时，脚本才会重启该集群 `a2a-relay` namespace 中的 `deployment/a2a-relay`，验证地址持久化与自动重连。重启会中断正在进行的调用，应在首次上线或维护窗口执行。

本机网络受限时，可显式设置 `RELAY_QA_LOOPBACK_TUNNEL=1`，由调用方提前建立 `127.0.0.1:443` 到 ALB 公网 443 的临时通道。脚本只修改自身的 DNS 查询，保留 TLS/SNI/主机名验证，并在报告中标明该路径；该结果不能代替普通外部客户端的直连验收。
