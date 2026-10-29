# fastapi-react-admin 系统介绍：一个 FastAPI + React 19 的中后台底座是怎么搭起来的

我开源了一个中后台底座，这篇把整个系统完整介绍一遍：它能做什么，架构怎么分层，几个关键设计为什么这么做，工程上怎么保证质量。具体的实现细节会拆成一篇篇短文，目录在文末。

> **GitHub**：<https://github.com/yilecoding/fastapi-react-admin>
> **在线演示**：<https://fra.wubunan.com>（`admin` / `123456`，公开实例，数据可能被其他访客改动）
>
> MIT 协议，当前版本 v0.5.0

![登录页](https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/01-sign-in.png)

---

## 一、它是什么

一个**开箱即用的中后台底座**：用户、角色、菜单、部门这些基础模块都有，在这之上还有审批流、AI 助手、文件存储、导入导出、开放接口。拿来改一改就能承载具体业务。

和常见模板相比，几个主要区别：

| | 常见做法 | 这里 |
|---|---|---|
| 权限粒度 | 菜单 + 按钮 | 菜单 + 按钮 + **数据范围**，能控制看到哪些**行** |
| 多页签 | React 侧大多切走就丢状态 | 用 React 19.2 的 `<Activity>`，切回来状态还在 |
| 组件库 | 多数还在 Radix 版 shadcn | 已跟进 shadcn 现在默认的 **Base UI** |
| 数据库 | 通常只支持一种 | PostgreSQL / SQL Server / MySQL 三选一 |
| 端 | 只有 Web | Web + Electron 桌面端 + Expo 原生移动 App |
| 测试 | 大多不带 | 后端 1100+ 条、前端 120+ 条端到端，连真实数据库，不 mock |

## 二、功能全景

| 模块 | 能做什么 |
|---|---|
| 权限与组织 | RBAC（菜单 / 按钮 / 数据范围）、行级数据权限、部门树、用户与角色 |
| 登录与安全 | 图形验证码、失败锁定、密码历史与过期、OAuth2（GitHub / Google）、手机验证码登录、会话管理与强制下线 |
| 工作区 | 多页签（固定 / 拖拽 / 重新加载）、⌘K 命令面板、快捷键、功能引导、主题色与圆角、每人自己的时区、中英双语 |
| 审批流 | 表单设计器、流程树（审批 / 抄送 / 条件分支）、或签会签依次审批、退回 / 拿回 / 加签 / 转交、超时自动处理、AI 预审 |
| AI 助手 | 整页对话和侧滑抽屉，工具调用受当前用户的权限和数据范围约束，写操作先预演再确认，全程审计，MCP 网关 |
| 文件与存储 | 文件管理器、在线预览、本地盘或 S3 兼容存储、秒传、分片上传与断点续传、回收站、可嵌入任何页面的附件面板 |
| 导入导出 | 服务端导出 xlsx / csv，大批量转后台；导入带下拉模板、预览校验和错误报告 |
| 消息与通知 | 站内消息实时推送、通知公告（富文本 + 附件） |
| 能力开放 | AK/SK 签名的开放接口，scope、IP 白名单、防重放、限流，附 Python / Node / Java SDK |
| 运维 | 参数配置、数据字典、登录 / 操作日志（自动脱敏）、服务器与 Redis 监控、定时任务、发新版提示 |

几张截图：

![角色权限矩阵](https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/03-role.png)

![数据权限规则](https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/04-data-permission.png)

![审批流程设计](https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/07-workflow-flow.png)

![AI 助手](https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/09-ai-chat.png)

![命令面板](https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/11-command-palette.png)

![组件沙箱](https://raw.githubusercontent.com/yilecoding/fastapi-react-admin/blog/images/12-sandbox.png)

## 三、技术栈

| | |
|---|---|
| 前端 | React 19 · TypeScript · Vite · TanStack Router / Query / Table · Tailwind CSS 4 · shadcn/ui（Base UI）· zustand · i18next |
| 后端 | FastAPI · Pydantic 2 · SQLAlchemy 2（async）· Alembic · Redis · Celery · Socket.IO · OpenDAL · pydantic-ai |
| 数据库 | PostgreSQL（默认）· SQL Server · MySQL |
| 多端 | Electron · Expo / React Native |
| 工程 | pnpm + turbo 单仓 · uv · ruff · pytest · Playwright · GitHub Actions |

## 四、整体架构

### 仓库结构

一个 pnpm + turbo 的单仓，前后端、三个端都在里面：

```
apps/
  api/         后端（FastAPI，uv 管理）
  worker/      Celery worker，只有一个启动脚本，为了在开发时单独占一个日志窗格
  web/         Web 应用：路由、构建、部署配置
  desktop/     Electron 桌面端
  mobile/      Expo 原生移动 App
packages/
  i18n/        多语言包（最底层，不依赖任何框架）
  api/         后端契约：OpenAPI 生成的类型、请求客户端、成败判定（最底层）
  ui/          组件库，零业务
  platform/    平台能力：鉴权、外壳（侧边栏 / 多页签）、所有业务页面
```

### 前端：严格单向的分层

```
i18n / api  ←  ui  ←  platform  ←  web
     ↑
   mobile
```

- **`ui` 永远不 import `platform`**。组件库不知道业务的存在，所以能被整包搬到别的项目里。
- **`i18n` 不依赖任何 workspace 包**，连 `react-i18next` 都不依赖，React 绑定在应用层注入。
- **`mobile` 直接依赖最底层的两个包**，不经过 `platform`。`platform` 是 Web 形状的（路由、react-dom、socket.io），塞进 React Native 不合适；但接口契约和多语言是两端共用的。

这个方向有静态检查守着（`pnpm arch:check`，进了 CI）：import 方向、tsconfig 路径映射、`package.json` 的依赖声明三处必须一致。

### 前端：路由和页面分开

```
apps/web/src/routes/     只声明 URL 参数校验和权限守卫，不渲染页面
packages/platform/pages/ 页面组件，只通过 props 拿参数
TabOutlet                按注册表把页面挂进多页签
```

这样分开是多页签的要求：后台页签也挂载着，但拿不到路由上下文，所以页面不能自己读路由。

### 后端：三层 + 插件

```
api/v1    路由、参数校验、权限依赖
service   业务逻辑
crud      数据访问（数据权限在这一层统一加过滤条件）
```

审批流、AI、开放接口、通知、短信、OAuth2、字典、参数配置、通知公告都以**插件**形式组织，各自带路由、模型、种子数据和测试。

### 运行时

```
浏览器 / 桌面端 / 移动端
        │  HTTPS + Socket.IO
        ▼
   FastAPI（api）──── Redis（缓存 · 会话 · 限流 · 雪花节点）
        │                 ▲
        ▼                 │
   PostgreSQL / SQL Server / MySQL
        ▲                 │
        │                 │
   Celery worker（后台导出 · 定时任务）
        │
   本地盘 / S3 兼容存储
```

生产部署走 Docker：`main` 每次通过 CI 都会构建镜像，服务器上用 `deploy/prod.sh` 拉取和更新，见 `deploy/README.md`。

## 五、几个关键设计

每一条后面都会单独写一篇，这里只说结论。

**1. 多页签：`<Activity>` 保活 + URL 持久化**
所有打开的页签同时挂载，后台的只是隐藏；筛选、分页、选中项写进 URL。前者管会话内，后者管刷新，缺一不可。

**2. 数据权限放在 DAO 层**
当前用户放在 ContextVar 里，DAO 查询时统一拼过滤条件，接口代码不用管。后台任务里没有请求上下文，要显式指定按谁的权限取数，否则就是不过滤。

**3. 所有 ID 都是字符串**
雪花 ID 超出 JS 的安全整数范围。后端在编码层统一转字符串，前端的路由解析也要改，否则会静默指向另一条记录。

**4. AI 助手的权限 = 当前用户的权限**
AI 能调用的工具就是当前用户有权限的接口，走同一套权限和数据范围检查，不为 AI 单独开后门。

**5. 前后端契约由 OpenAPI 生成**
`schema.d.ts` 从后端直接生成，不用起服务；请求客户端和成败判定放在 `packages/api`，Web 和移动端共用一份。

## 六、工程化

- **测试不 mock**：后端 pytest 连真实数据库和 Redis，前端 Playwright 连真实浏览器和真实接口。CI 上后端全套在 PostgreSQL 和 SQL Server 各跑一遍。数据权限用 41 个真账号逐个登录验证过。
- **变异检验**：守关键逻辑的测试写完，会故意把代码改坏一次，确认测试真的会红。
- **静态守卫**：`arch:check` 管分层方向和几条硬规则（页面不能读路由、全局 DOM 查询必须限定范围、E2E 断言不能漏 `await`）；`i18n:check` 管两种语言的键是否对齐。
- **文档是踩坑记录**：根目录的 `CLAUDE.md` 加上 40 多份模块分册，记录的都是「违反了会坏，而且多数是静默地坏」的结论，每条都要带实测证据。`ctx:check` 会检查文档里引用的文件、脚本、测试还在不在。
- **公开的测试报告**：`main` 每次跑完的 [E2E 报告](https://yilecoding.github.io/fastapi-react-admin/) 都公开，失败用例带截图和录像。

## 七、跑起来

```bash
git clone https://github.com/yilecoding/fastapi-react-admin.git
cd fastapi-react-admin

docker compose -f docker-compose.dev.yml up -d          # PostgreSQL + Redis
pnpm install:all
cp apps/api/backend/.env.example apps/api/backend/.env
pnpm db:init
pnpm dev                                                # http://localhost:8888
```

需要 Node ≥ 22.13、Python ≥ 3.10、uv 和 Docker。账号 `admin` / `123456`。

## 八、系列文章

- 《用 React 19.2 的 `<Activity>` 做多页签保活，我踩了 6 个坑》
- 《雪花 ID 丢精度不只在 JSON.parse：我在一个中后台里找到了 5 个出口》
- 更多持续更新中

## 致谢

后端从 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture) 分叉而来，三层结构、插件机制、RBAC 与数据权限模型是它的设计，感谢原作者和贡献者。

项目还在 0.x，迭代很快。觉得有用的话欢迎去 [GitHub](https://github.com/yilecoding/fastapi-react-admin) 点个 ⭐，也欢迎提 issue。
