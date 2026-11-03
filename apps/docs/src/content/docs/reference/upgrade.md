---
title: 版本升级
description: 怎么从旧版本升级：直接用镜像部署的拉新镜像即可；fork 后写了业务的按 tag 合并上游，再跑迁移。附兼容承诺和升级前检查清单。
sidebar:
  order: 2
---

升级方式取决于你怎么用这个项目：**直接用镜像部署、没改过代码**的，拉新镜像、重启就行，迁移会自动跑；**fork 之后在上面写了自己业务**的，要把上游的新版本合并进你的仓库，再跑迁移和测试。每个版本的变化写在 [GitHub Releases](https://github.com/yilecoding/fastapi-react-admin/releases) 里，每份发版说明都有一节「升级」，写明有没有数据库迁移、要不要改配置。

## 版本号怎么定

按 semver：破坏下面兼容约定里的任何一条升主版本号（1.x → 2.0），合进一个大功能升次版本号（1.0 → 1.1），只有修复升修订号（1.0.0 → 1.0.1）。1.0.0 起正式按这套约定执行。

移动端 App 在 1.0 里是**预览版**，不在兼容约定范围内（已有 / 还没有的功能见 README「移动端（预览版）」）。

## 哪些东西承诺不破坏

下表来自根目录 [`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md) 的「1.0 起的兼容约定」。破坏其中任何一条都要升主版本号。

| 对外的面 | 承诺 |
|---|---|
| 开放接口 `/api/open/v1/*` 和三语言 SDK | 路径、参数、响应字段、错误码、签名算法不删、不改语义；只加可选参数和新字段。真要破坏就开 `/api/open/v2/*`，v1 保留 |
| Webhook 事件 | 事件名不改，载荷字段不删、不改名，签名方式不变；可以加事件、加字段 |
| 数据库迁移链 | 从任何一个已发布的版本都能 `pnpm db:upgrade` 升到最新；进过 tag 的迁移文件不再改，修错写新迁移 |
| 插件接口 | `plugin.toml` 字段、安装流程、扩展点保持可用，第三方插件照旧能装能跑 |
| 配置键 | `.env` 的键名和参数配置的键不改名；真要改，新旧键并存一个次版本 |
| 内部接口 `/api/v1/*` | 不是公共 API，但会照顾已经装出去的桌面端和移动端：删字段、改路径前会让新旧并存一个次版本 |

不在表里的（页面、组件、`packages/*` 的内部导出）可能随版本调整。如果你直接改过这些地方，合并时留意冲突。

迁移链的承诺实测过：2026-10-31 在 MySQL 8.4 上，用 v0.0.1 建的库一路升到当时的最新版，和模型比对结构差异为 0。

## 直接用镜像部署的怎么升级？

```bash
bash prod.sh status   # 服务器上跑的是哪个提交、落后 main 多少
bash prod.sh pull     # 拉新镜像
bash prod.sh up       # 先跑迁移（一次性的 migrate 容器），成功了才启动服务
```

**验收**：`bash prod.sh status` 显示的提交和你要升的版本一致；`https://<你的域名>/api/health/status` 返回 200。

升级前先备份数据库。新版本有问题时，按提交号回滚到旧镜像：

```bash
TAG=sha-abc1234 bash prod.sh pull
TAG=sha-abc1234 bash prod.sh up
```

:::caution
回滚镜像**不会回滚数据库**。新版本如果带了迁移，回到旧镜像前要确认旧代码能跑在新表结构上，或者先用备份恢复数据库。发版说明的「升级」一节会写这一版有没有迁移。
:::

详细命令见[部署到服务器](/getting-started/deployment/)。

## fork 后写了自己业务的怎么升级？

把上游加成一个远程仓库，**按 tag 合并**（不要直接合 `main`，`main` 上可能有还没发版的改动）：

```bash
git remote add upstream https://github.com/yilecoding/fastapi-react-admin.git   # 只需一次
git fetch upstream --tags
git merge v0.12.0            # 换成你要升到的版本
```

解决完冲突后：

```bash
pnpm install:all             # 依赖可能有变化
pnpm db:upgrade              # 跑上游新加的迁移
pnpm typecheck --force       # 类型检查别信缓存
pnpm test                    # 后端测试（需要本地 fba_test 库，见 CONTRIBUTING.md）
```

**验收**：`pnpm db:current` 显示在 head；`pnpm typecheck --force` 和后端测试全绿；`pnpm dev` 起来后登录、打开几个你自己的业务页面看一眼。

### 合并后出现两个迁移 head 怎么办？

你自己写过迁移、上游这一版也加了迁移时，迁移链会分叉成两个 head，`pnpm db:upgrade` 会报多个 head。用 Alembic 生成一个合并迁移：

```bash
cd apps/api/backend
uv run alembic heads                       # 确认是两个 head
uv run alembic merge heads -m "merge upstream v0.12.0"
cd ../../.. && pnpm db:upgrade
```

仓库里的守卫测试 `test_single_head` 也会在出现两个 head 时变红，提醒你做这一步。

:::caution
**不要改上游的迁移文件**，哪怕合并冲突落在里面。已经升级过的库不会重新执行旧迁移，改了只会让新装的库和老库对不上，而且不会报错。修错写一个新迁移。
:::

### 冲突一般出在哪？

出在你和上游都改过的文件。常见的有：菜单和权限的种子数据（`backend/sql/*/init_snowflake_test_data.sql`）、前端的页面注册表（`apps/web/src/lib/page-registry.tsx`）、侧边栏和路由文件。把自己的业务尽量放在新文件、新目录、新插件里，不去改底座的文件，以后升级的冲突就少。

## 桌面端和移动端怎么升级？

- 桌面端：从 [Releases](https://github.com/yilecoding/fastapi-react-admin/releases) 下载新安装包覆盖安装。应用内的自动更新要由你的页面主动调用检查，见[桌面端与移动端](/features/clients/)
- 移动端：重新构建并分发 App

旧版客户端会拿旧前端调新后端，所以内部接口的删改会保留一个次版本的过渡期（见上面的兼容约定）。

## 升级前检查清单

- [ ] 读过目标版本（以及跳过的每个版本）发版说明里的「升级」一节
- [ ] 备份了数据库
- [ ] 确认这一版有没有迁移、要不要改配置
- [ ] 测试环境先升一遍，跑过冒烟测试（登录、几个核心页面、一条审批）
- [ ] 准备好回滚用的镜像标签（`sha-<旧提交>`）
- [ ] 生产升级后检查 `/api/health/status` 返回 200
