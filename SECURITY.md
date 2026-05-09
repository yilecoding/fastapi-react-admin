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
| **前端无自动化测试** | 权限相关的界面逻辑（`<Can>` 门控、路由守卫）目前只有人工验证。**服务端始终独立校验权限**，前端门控只是体验层 —— 但这意味着前端回归只能靠人。 |

## 部署前必做 / Before you deploy

1. **`ENVIRONMENT='prod'`** —— 它一次关掉三样：`/openapi`（连带 `/docs`、`/redoc`
   都失效，因为它们依赖 openapi schema）、`/static` 静态挂载、并强制 Celery 走 rabbitmq。
   这条最容易漏，而漏了等于把接口文档和静态目录一起公开
2. 改掉 `admin` 的默认口令
3. 重新生成 `TOKEN_SECRET_KEY`（`uv run fba init` 会做，或 `secrets.token_urlsafe(32)`）
4. 反代层限 `Content-Length`（见上表第一条）—— 应用层拦不住
5. 收紧 `CORS_ALLOWED_ORIGINS`（默认放行的是本地开发端口 1125）
