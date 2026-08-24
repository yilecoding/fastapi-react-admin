# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

**请不要开公开 issue。** 用 GitHub 的
[Private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库 → Security → Report a vulnerability）。

**Please do not open a public issue.** Use GitHub's private vulnerability reporting
(repo → Security → Report a vulnerability).

报告里请尽量写清：受影响的版本或提交、复现步骤、以及你观察到的实际影响
（能读到什么 / 能写到什么 / 能绕过什么）。有 PoC 更好。

尽力在 72 小时内回应。这是一个业余时间维护的项目，**没有 SLA**。

## 适用范围 / Scope

会当作安全问题处理：

- 越权：绕过 RBAC（菜单 / 按钮权限码）或数据权限（`sys_data_rule` 的行级过滤）
- 认证与会话：token 签发/校验、刷新流程、会话失效
- 文件：上传路径穿越、读取越界、未授权访问上传物
- 注入：SQL 注入、模板注入、日志注入
- 敏感信息泄露：凭据、请求头、操作日志内容

**不**会当作安全问题（欢迎开普通 issue）：

- 需要已经拿到超管权限才能做到的事 —— 超管本来就能改配置、改菜单、跑 SQL
- 默认口令 `admin` / `123456`：这是**开发用种子数据**，文档多处标明部署前必须改
- `apps/api/backend/.env.example` 里的占位值（`TOKEN_SECRET_KEY` 是
  `CHANGE_ME__…`，`fba init` 会重新生成）
- 组件沙箱 / `playground-*` 这类开发工具页面里的问题 —— 它们不面向业务用户
- 依赖的已知 CVE：请直接开 issue 或 PR 升级，不必走私密流程

## 已知的、**尚未修复**的问题 / Known unfixed issues

写在这里而不是藏起来，因为它们影响你怎么部署：

| | 现状 |
|---|---|
| **上传大小限制在解析之后才生效** | Starlette 会先把整个请求体收完（> 1 MB 落临时文件）才轮到应用层判 `file.size`，所以 `UPLOAD_*_SIZE_MAX` **拦不住**有人往上传接口灌超大请求。**必须在反代层限 `Content-Length`**（nginx `client_max_body_size`）。 |
| **公开上传子树无鉴权** | `PUBLIC_UPLOAD_DIR` 被挂在 `/uploads`，**设计上就是不鉴权**（供富文本正文的 `<img src>` 直接加载）。落到那棵树是上传时的显式选择（`?public=true`），且服务端强制只允许图片。私有文件走带鉴权的 `GET /sys/files/{pk}/download`。 |
| **`/static` 静态挂载** | `FASTAPI_STATIC_FILES=True` 时 `backend/static/` 整个目录公开可读（里面有 11 MB 的 `ip2region_v4.xdb`）。设 `ENVIRONMENT='prod'` 会自动把它关掉；开发默认是开的。 |
| **按钮级权限无端到端覆盖** | 数据权限的界面语义已由 `apps/web/e2e/tests/data-permission.spec.ts`（25 条）覆盖，但 `<Can>` 门控和路由守卫这一路前端仍无 e2e。服务端侧已经有底：`rbac_verify` 的四道闸有门禁矩阵测试，权限码三份清单（后端 `RequestPermission` / 前端 `<Can perm>` / 种子 `sys_menu.perms`）有静态对账。**服务端始终独立校验权限**，前端门控只是体验层。 |

## 部署前必做 / Before you deploy

1. **`ENVIRONMENT='prod'`** —— 它在 `backend/core/conf.py: check_env()` 里动三样：
   关掉 `/openapi`（连带 `/docs`、`/redoc` 一起失效，它们依赖 openapi schema）、
   关掉 `/static` 静态挂载、**打开** `GRAFANA_METRICS_ENABLE`。
   注意第三条方向和前两条相反 —— `/metrics` 会因此暴露出来，反代层记得挡住或加鉴权。
   ⚠️ 它**不**碰 Celery broker。上游 `check_env()` 里那行「prod 无条件切 rabbitmq」
   已经删掉了，broker 只认 `.env` 的 `CELERY_BROKER`
   （`backend/app/task/celery.py: get_broker_url`）—— 要用 rabbitmq 就自己写进 `.env`

2. **剩下的不用你记，`prod` 起不来会告诉你。** `check_production_settings()`
   在 `ENVIRONMENT='prod'` 时逐项校验并**一次列出全部问题**后拒绝启动：
   TOKEN_SECRET_KEY / DATABASE_PASSWORD / REDIS_PASSWORD 是否还是占位符或太弱
   （长度 + 去重字符数 + Shannon 熵三道闸，把 `CHANGE_ME` 改成 `123` 一样过不去）、
   DEMO_MODE / LOGIN_CAPTCHA_ENABLED / REQUEST_LIMITER_ENABLED 的开关方向、
   CORS 有没有留着本地来源、DATABASE_USER 是不是数据库超级用户。
   缺 `.env` 时也不再自动拷 `.env.example`（容器内一律拒绝）。

3. **默认口令由代码把关，不靠流程。** `fba init` 收尾强制设置 admin 密码
   （非交互用 `FBA_INIT_ADMIN_PASSWORD`）；绕过 init 直接灌种子 SQL 那条路，
   由 prod 启动时扫库兜底（按种子 hash 字面量比对）。

4. **数据库必须在 alembic head 上。** prod 下应用**不再自己建表**，
   启动时校验 `alembic_version`，不在 head 就拒绝启动。

5. 反代层限 `Content-Length`（见上表第一条）—— 应用层拦不住。
   `apps/web/nginx.conf` 里已经按 100MB 配好

6. 收紧 `CORS_ALLOWED_ORIGINS`（默认放行的是本地开发端口 8888），
   并同步 `backend/plugin/oauth2/plugin.toml` 的四条回调 URI

7. **配上 `TRUSTED_PROXIES`。** 默认是空的（= 只认直连对端地址，直连场景正确）。
   部署在 nginx / LB 后面却不配，`X-Real-IP` 全部被忽略，日志里记的是代理的地址；
   而配错成「谁都信」则更糟 —— 限流 key 就是 `{IP}:{path}`，客户端换个 header
   就是一份新配额。同时确认 uvicorn 的 `--forwarded-allow-ips` 是同一个范围，
   写 `*` 会把这层白名单架空
