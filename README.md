# PushHub Server

轻量自托管推送服务：接收 Webhook、ntfy 风格和 Bark 风格请求，通过 WebSocket 将消息推送至已配对的 Android 设备，并提供网页管理控制台。

本仓库包含服务端及 `android/` 目录中的 Android 客户端源码。客户端构建、签名、安装与配对请参阅 [Android 使用文档](android/README.md)。不包含签名私钥或预编译 APK；未安装客户端时仍可使用控制台、Webhook 接入、消息管理与 API。

## 功能

- Web 管理控制台：消息、设备、来源、接入诊断、设置与手动发送。
- 设备二维码配对，支持内网和公网配对地址。
- 通用 JSON、邮件字段适配、ntfy 与 Bark 风格接入。
- 按来源管理密钥、字段映射、收件人过滤与消息优先级。
- WebSocket 实时推送、离线队列、回执、消息重放和设备撤销。
- 图片、视频及文档附件上传与消息携带。
- JSON 文件持久化，无需独立数据库。

## 环境要求

推荐 Docker Engine 与 Docker Compose v2 或以上。也可使用 Node.js 22（源码要求 Node.js >=20）。默认监听端口为 `8095`。

## Docker 部署

```bash
git clone https://github.com/1985773420/pushhub-server.git
cd pushhub-server
cp .env.example .env
openssl rand -hex 32
```

将生成的随机字符串填入 `.env` 的 `ADMIN_TOKEN`。不要沿用示例值，不要提交 `.env`。

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
curl http://127.0.0.1:8095/api/health
```

打开 `http://你的服务器地址:8095`，在控制台输入自己设置的管理员令牌。若部署到公网，请通过支持 WebSocket 的 HTTPS 反向代理访问。

停止：`docker compose down`。更新：拉取代码后再次执行 `docker compose up -d --build`。不要删除 `data/`。

## 直接运行

```bash
npm ci
cp .env.example .env
# 编辑 .env，设置自己的 ADMIN_TOKEN
node --env-file=.env src/index.js
```

Node 本身不会自动加载 `.env`，所以直接运行时必须使用 `--env-file` 或在启动环境中传入配置。

## 配置

| 变量 | 默认值 / 作用 |
|---|---|
| `ADMIN_TOKEN` | 必填，至少 16 字符；建议随机生成 32 字节 |
| `PORT` | 原生启动端口，默认 8095；Compose 中也用于宿主机映射端口 |
| `HOST` | 默认 `0.0.0.0`；Compose 容器内固定监听此地址 |
| `DATA_FILE` | 默认 `data/pushhub.json`，通常无需修改 |
| `PUBLIC_URL` | Webhook 展示使用的外部访问根地址 |
| `WS_PATH` | WebSocket 路径，默认 `/ws` |
| `LOG_BODY` | `1` 时开启请求正文日志，可能包含敏感信息 |
| `MAX_BODY_CHARS` | 消息正文上限，默认 20000 |
| `MAX_UPLOAD_MB` | 上传大小限制；以源码实际默认值为准 |
| `APK_RELEASE_DIR` | 可选 APK 发布目录；未提供 APK 时相关下载功能不可用 |

`DEV_MODE=1` 只用于隔离测试，会允许管理接口显示更多密钥信息，不应在生产环境启用。

## 第一次使用

1. 在控制台使用管理员令牌登录。
2. 在“设置”中配置设备可访问的内网或公网配对地址。
3. 打开设备配对，生成一次性二维码，再通过兼容 Android 客户端扫码。
4. 在来源管理中创建 Webhook 来源，并复制对应来源密钥。
5. 发送测试消息，在控制台检查接入记录、消息和设备回执。

首次启动会创建 `email`、`manual` 两个默认来源。来源密钥与管理员令牌不同，请从控制台或管理 API 获取，勿混用。

## 接入示例

下面仅使用示例域名。将 `SOURCE_SECRET` 设置为来源 `manual` 对应的密钥：

```bash
export PUSH_URL=http://127.0.0.1:8095
read -r -s -p '来源密钥: ' SOURCE_SECRET; echo
curl -X POST "$PUSH_URL/hook/manual" \
  -H "Authorization: Bearer $SOURCE_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"title":"构建完成","body":"项目已部署成功","url":"https://example.com"}'
```

ntfy 风格：

```bash
curl -X POST "$PUSH_URL/ntfy/manual" \
  -H "Authorization: Bearer $SOURCE_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"title":"磁盘提醒","message":"请检查存储空间","priority":4}'
```

Bark 风格支持 `/bark/:sourceId/:key`。密钥包含在 URL 路径中，可能进入代理日志；优先使用带 Authorization 请求头的通用 Webhook。

### 邮件与字段映射

邮件来源可处理 `subject`、`snippet`、`recipient` 等字段，也可按来源配置 `fields` 模板。收到嵌套对象时，需映射到实际文本字段，避免对象被转换为 `[object Object]`。字段模板通过管理 API 更新；请参考 `src/ingest.js` 与 `src/index.js`。

### 上传附件

使用 `/api/admin/upload` 或 `/api/upload` 上传，返回附件信息后将其放入 Webhook 的 `attachments` 数组。管理员接口需管理员令牌。附件链接可能允许持有链接的人访问，上传前确认内容适合分享。

## API 速查

| 接口 | 用途 |
|---|---|
| `GET /api/health` | 健康检查 |
| `POST /api/admin/pair` | 创建一次性设备配对码，需要管理员令牌 |
| `POST /api/pair` | 设备兑换配对码 |
| `GET /api/admin/overview` | 控制台概览 |
| `POST /api/admin/sources` | 创建消息来源 |
| `GET /api/admin/sources/:id/secret` | 获取来源密钥 |
| `POST /hook/:sourceId` | 通用推送接入 |
| `POST /ntfy/:sourceId` | ntfy 风格接入 |
| `GET/POST /bark/:sourceId/:key` | Bark 风格接入 |
| `POST /api/admin/messages` | 管理员手动发送 |
| `GET /api/admin/messages` | 消息查询 |
| `POST /api/admin/messages/:id/replay` | 重放消息 |
| `PATCH /api/admin/settings` | 更新设置 |
| `GET /ws` | WebSocket 设备连接升级 |

管理 API 使用 `Authorization: Bearer <ADMIN_TOKEN>`。完整请求字段与行为以 `src/index.js` 为准。

## 数据和备份

持久数据位于 `data/`，包括消息、设备令牌、来源密钥与上传媒体。整个目录都应视为敏感数据，不可提交到 GitHub。

一致性备份建议先短暂停服，再备份 `data/` 和单独保管的 `.env`：

```bash
docker compose stop
 tar -czf pushhub-data-backup.tar.gz data
docker compose start
```

恢复时先停止容器，将备份还原到 `data/`，确认权限后启动。备份文件也必须保密。

## 测试

```bash
npm ci
npm test
node scripts/auth-check.js
node scripts/lookup-check.js
node scripts/pairing-check.js
node scripts/receipts-check.js
```

测试脚本使用隔离的临时数据和测试端口。`scripts/apk-check.js` 依赖本仓库未发布的 Android APK 固件与发布元数据，不属于纯服务端的默认测试流程。

## 排障

- 启动提示 `ADMIN_TOKEN env is required`：检查 `.env` 及令牌长度。
- 容器健康但浏览器不可达：检查宿主机端口、防火墙及反向代理。
- 客户端配对失败：确认二维码中的地址能从手机访问，内网地址不能直接用于外网。
- 客户端离线：确认反向代理允许 WebSocket、手机网络可达，并检查 Android 后台运行限制。
- APK 下载提示 503：这是未配置 Android APK 时的预期行为；服务端其他功能不受影响。
- JSON 存储适合个人和小规模自托管；不要让多个实例共享写入同一个数据文件。

## 公开发布范围

源码副本不包含生产环境 `.env`、数据库或消息数据、设备令牌、私人部署测试脚本、Android APK、签名密钥和历史 Git 记录。原创代码和文档采用 Apache-2.0 许可证；第三方组件遵循各自条款。


## 开源许可证

Copyright 2026 1985773420。原创代码和文档采用 [Apache License 2.0](LICENSE)，允许商用、修改和分发，并含明确的专利授权及终止条款；使用和分发须遵守许可、保留相关声明并标明修改。软件按原样提供，不提供担保。第三方依赖及资源不因本项目许可而改变其原有条款，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
