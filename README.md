# Grok Register Agent (GRA)

来都来了 不点个⭐再走吗~?

可自部署的 Grok 注册机 Web 控制台（Grok Register Agent）：Docker 多架构镜像、DrissionPage / Hybrid 注册、邮件验证码、SSO 号池、Auth mint、NSFW 标签与本地账号管理。

> 本项目与 xAI、Grok、X 没有官方关联。请仅在合法、合规、获得许可的研究、学习或自托管实验环境中使用。


---

## 功能一览

| 模块 | 说明 |
|------|------|
| **Web 控制台** | 注册机 / SSO 号池 / Auth / 配置 四个页；启动·停止·实时日志 |
| **注册方案 A/B/C** | Plan A 浏览器主流程、Plan B 拟人兜底、Plan C Hybrid（浏览器 harvest + 协议）；可单独开关，全开则 A→B→C 顺序兜底 |
| **邮件后端** | Cloudflare Temp Email / DuckMail / YYDS Mail / GPTMail |
| **SSO 号池** | 本地保存账号与 SSO；注册成功可自动 SSO 验活并刷新徽章 |
| **Auth mint** | PKCE / Device / Double 双通道；可后台延迟队列；可选 grok-4.5 校验 |
| **NSFW 标签** | 可选 mint 后打标；侧车 `account_tags.json` 优先落在 `DATA_DIR`；UI 始终显示 `NSFW` / `NSFW×` / `NSFW—` |
| **代理** | 设置页仅 **Sing-Box** / **直连**；支持订阅解析、分享链接与 http(s)/socks 节点；mint 路径须有可用代理 |
| **外置 Turnstile Solver** | 可选 compose profile；设置页开关 + 探活；多架构 amd64/arm64 |


---

## 快速部署（GHCR 镜像，推荐）

```bash
git clone -b beta https://github.com/MurasameCyan/GrokRegisterAgent.git
cd GrokRegisterAgent
cp .env.example .env
# 按需编辑 .env：邮件 / 端口 / 初始密码 / 存储加密 / Solver 等
docker compose up -d --pull always --remove-orphans
```

### 可选：外置 Turnstile Solver

默认**不**拉取 Solver 子容器。需要时：

```bash
docker compose --profile solver pull
docker compose --profile solver up -d
# 或在 .env：
# COMPOSE_PROFILES=solver
# TURNSTILE_SOLVER_ENABLED=1
```

- 设置页：**注册方案 → 外置 Turnstile Solver**
- Solver 镜像：`ghcr.io/murasamecyan/grok-turnstile-solver:beta`  
- ARM 可运行；Turnstile 成功率通常仍低于 x86  


### 访问

```text
http://你的服务器IP:6657
```

初始 Web 登录：

- 用户名默认是 `admin`
- 若设置 `GRA_INITIAL_PASSWORD`，首次密码直接取该值
- 若未设置 `GRA_INITIAL_PASSWORD`，服务端首次启动会随机生成初始密码，打印到日志，并落盘到 `/data/auth-bootstrap.json`

```bash
docker logs grok-register-agent
```

首次登录后必须修改用户名和密码。公网部署建议同时设置 `GRA_MASTER_KEY`，避免敏感配置和账号凭据明文落盘。
直接用 `http://IP:6657` 访问时，`COOKIE_SECURE` 请留空
仅 HTTPS 反代时建议 `COOKIE_SECURE=1`

---

## 环境变量（`.env`）

复制自根目录 [`.env.example`](.env.example)：

| 变量 | 说明 |
|------|------|
| `WEB_PORT` | 宿主机端口，默认 `6657` |
| `RUN_COUNT` | 注册轮数默认值 |
| `MAIL_API_BASE` | cloudflare_temp_email 后端 API 根地址 |
| `MAIL_ADMIN_AUTH` | admin 密码 → `x-admin-auth` |
| `MAIL_DOMAIN` | 可收信域名 |
| `HTTP_PROXY` / `BROWSER_PROXY` | 可选全局代理（更推荐在 Web「配置」里用 Sing-Box） |
| `COOKIE_SECURE` | HTTPS 反代时设 `1`；纯 HTTP 留空 |
| `GRA_INITIAL_PASSWORD` | 可选。指定 Web 控制台首次启动的初始密码；不填则自动生成并写入 `/data/auth-bootstrap.json` |
| `GRA_MASTER_KEY` | 可选但强烈建议。用于加密 `/data/config.json`、`/data/accounts.json` 中的敏感字段 |
| `GRA_CONFIG_PATH` | 内部运行时变量。每个注册任务启动时自动指向独立临时配置文件，通常不要在 `.env` 中手工设置 |
| `TURNSTILE_SOLVER_ENABLED` | `1` 启用外置 Solver 客户端 |
| `TURNSTILE_SOLVER_URL` | 默认 `http://turnstile-solver:5072` |
| `TURNSTILE_SOLVER_THREADS` / `BROWSER` | Solver 容器线程与浏览器类型 |
| `YESCAPTCHA_KEY` | 可选第三方打码 |

---


### 注册方案

| 开关 | 含义 |
|------|------|
| **Plan A** | 浏览器主流程（默认开） |
| **Plan B** | 拟人兜底（默认开） |
| **Plan C** | Hybrid：浏览器 harvest Castle/CF/Turnstile + 协议 CreateEmail / Server Action（默认**关**，需显式开启） |

全开时顺序兜底：**A → B → C**。

### Auth / Mint

| 项 | 说明 |
|----|------|
| `auto_auth_export` | 拿到 SSO 后后台 mint / 推送（默认开） |
| `auto_auth_delay_*` | 入队前随机延迟（秒） |
| `cpa_mint_mode` | `pkce`（推荐）/ `device` / `double`（两通道各一份并分别测活） |
| `require_grok_45` | mint 后无 grok-4.5 则不进 CPA |
| `enable_nsfw` | mint 后尝试打开 NSFW  |
| `enable_disable_zdr` | 已从主流程断开（保留模块，当前不生效） |


### 代理

- 仅保留 **Sing-Box** 与 **直连**
- Sing-Box 二进制由镜像 / Actions 附带（`register/bin/sing-box/`）
- 状态图标：直连常绿；Sing-Box 按连通性 R/Y/G
- **节点列表** 支持：
  - 分享链接：`ss` / `vmess` / `vless` / `trojan` / `hysteria2` / `hy2` / `tuic` / `anytls`
  - 上游代理：`http` / `https` / `socks4` / `socks4a` / `socks5` / `socks5h`（含 `host:port` 默认可按 socks5）
- **订阅链接**（设置项 `singBoxSubscriptionUrl`，随配置保存）：
  - 点 **「解析」** 拉取并**替换**节点列表
  - 支持：Base64 / URL-safe Base64、明文分享链接、Clash YAML `proxies`
  - 拉取为**直连** HTTP(S)，不经本地 Sing-Box 代理
- 开启 Sing-Box 时**允许空节点保存**（可先开模式再填订阅/节点；无节点时启动会失败）
- 启动可在 draft 未保存时 **force** 临时启用（持久化仍依赖「保存」）

### Turnstile

- 页面内 1×1 点击路径为主；短 token 有重试
- 可选外置 Solver + YesCaptcha；**Solver 设置块默认折叠**

---

## 注册方案说明（简表）

```text
Plan A  浏览器填表 + Turnstile + 同意流（Allow-only；勿点 Continue 当同意）
Plan B  拟人节奏 / 兜底路径
Plan C  harvest Castle/CF → CreateEmail（可无 castle 继续）→ 邮件码 → Turnstile
        → Server Action → SSO materialize → 入号池 + 可选 auto sso-check
```

**Plan C 注意（现网行为）：**

- CreateEmail 可能 **HTTP 200 且 body 很短（无 castle）**，流程可 **continue without castle**，不因缺 `IBYIll` 整轮失败
- Castle 依赖页面原生捕获；CDN 注入 token 通常对 x.ai **无效**
- Turnstile 1×1 在部分 ARM 环境更不稳定；可开外置 Solver

---

## 号池 / Auth / NSFW

### SSO 页

- 筛选区标题（SSO / Auth / 验活 等）
- 账号卡展示 **NsfwBadge**：`NSFW`等
- 注册成功可自动写回 SSO 验活结果

### Auth 页

- 授权记录列表、批量 mint、导出
- 同样展示 NSFW 与筛选标签


---

## 常用路径

| 用途 | 路径 |
|------|------|
| 容器内注册脚本（运行目录） | `/app/register` |
| 宿主机脚本挂载（热更新源） | `./register` → `/opt/register-host` |
| 镜像种子（防空挂载恢复） | `/opt/register-seed` |
| Python 入口 | `/app/register/runner.py` |
| 容器内数据目录 | `/data`（`DATA_DIR`） |
| 宿主机数据（GHCR compose） | `./data` |
| 宿主机数据（本地 build） | `docker/data` |
| Web 初始密码引导文件 | `/data/auth-bootstrap.json` |
| 服务端设置持久化 | `/data/config.json` |
| 账号主库 | `/data/accounts.json` |
| NSFW 侧车标签 | `/data/account_tags.json` |
| SSO 输出 | `./data/sso` 或 `docker/data/sso` |
| Python 基础配置模板 | `/app/register/config.json` |
| Python 运行时临时配置 | `/app/register/config.runtime.*.json`（由 `GRA_CONFIG_PATH` 指向，任务结束自动清理） |

### 并发运行配置

- Web 设置保存在 `/data/config.json`
- Python 仍以 `/app/register/config.json` 作为基础模板
- 每次点击“开始注册”时，Node 会为该次任务生成独立的 `config.runtime.*.json`
- 子进程通过 `GRA_CONFIG_PATH` 读取这份临时配置，避免并行任务互相覆盖轮数、代理或邮件配置

---

## 本地从源码构建

推荐使用本地部署脚本，它会检查 Docker、创建 `docker/.env`、自动生成 `GRA_MASTER_KEY`，并等待容器健康检查通过：

```powershell
.\scripts\deploy-local-docker.ps1
```

手动执行 compose 时：

```bash
cd docker
cp .env.example .env
# 编辑 .env，至少填写 GRA_MASTER_KEY
docker compose up -d --build
```

---

## 邮件后端配置

推荐对接 [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email)。

请先按其官方文档部署 Worker/API。本 README 只列本项目必填项：

| 配置项 | 填写内容 |
|--------|----------|
| `MAIL_API_BASE` | cloudflare_temp_email 后端 Worker/API 根地址 |
| `MAIL_ADMIN_AUTH` | 网站 admin 密码（`x-admin-auth`） |
| `MAIL_DOMAIN` | 已配置并可收信的域名 |

调用关系：请求 `MAIL_API_BASE + /admin/new_address` 创建邮箱，用返回的 `jwt` 轮询邮件并提取验证码。  
`register/config.example.json` 中还可配置 `cloudflare_auth_mode`（`x-admin-auth` / `bearer` / `none` 等）。

---

## 注意事项

- 不要提交 `.env`、`docker/.env`、`docker/data/`、`./data/` 中的 SSO / token、邮件凭据或代理密钥
- 公网部署请使用强密码并限制访问来源
- 使用前请确认目标平台条款与所在地法律法规
- 本工具会控制真实浏览器会话，请注意资源占用（compose 默认 `shm_size: 1gb`）

---

## 目录结构（简）

```text
.
├── docker-compose.yml          # 生产：只 pull GHCR
├── .env.example
├── docker/                     # Dockerfile、entrypoint、本地 build compose、solver
├── register/                   # Python 注册机
│   ├── runner.py
│   ├── DrissionPage_example.py # Plan A/B 入口与浏览器编排
│   ├── hybrid_register.py      # Plan C
│   ├── browser/                # token harvest 等
│   ├── protocol/               # gRPC-web / server action
│   ├── account_tags.py         # NSFW 侧车
│   └── config.example.json
├── server/src/                 # Node 控制面、号池、设置、sso-check
├── src/renderer/               # Web UI
└── .github/workflows/          # multi-arch 镜像 + solver
```

---

## 致谢

- 感谢 [ReinerBRO/grok-register](https://github.com/ReinerBRO/grok-register)，自动化注册思路与 Python 流程受其启发
- 感谢 [dreamhunter2333/cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email)，默认邮件后端适配对象
- [LINUX DO](https://linux.do/)
---

## 开源协议

本项目基于 [MIT 开源协议](LICENSE) 开源。
