# backend/app/admin —— 后台管理模块

> 这份文件是 [`apps/api/AGENTS.md`](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 批量建号：不要循环调 `user_service.create()`

`crud_user.add()` 每建一个用户都跑一次 `bcrypt.gensalt()` + `get_hash_password()`，
而那是**同步**调用。实测（8 核）：

| 做法 | 87 行 |
|---|---|
| 串行（= 循环调 `create()`） | **16.75 s** |
| 线程池 4 / 8 并发 | 4.31 s / 2.32 s（bcrypt 会释放 GIL，实测 7.2×） |
| 整批共用一次 hash | **0.19 s** |

🔴 **16.7 秒不是「这个请求慢」，是整个事件循环被占住** —— 所有人的所有请求
一起停 16.7 秒，而日志里只会看到一片莫名其妙的慢请求，没有一条指向 bcrypt。
`crud_user.bulk_add()` 整批只算一次 hash。

⚠️ 代价是这批用户在库里是**同一个 hash + 同一个 salt**。他们本来就共用同一个
默认密码，所以泄露的信息只有「这几个人密码相同」，而那本来就是真的；
任何人改一次密码，`reset_password()` 会重新 `gensalt()`。

## 用户批量导入（`POST /sys/users/import/{preview,commit}`）

两阶段：预览只校验不落库 + 一个存 Redis 的短期 token；提交带 token、允许部分成功。
解析走 [`utils/excel_ops.py`](#上传的表格一律过-utilsexcel_opspy不要自己-load_workbook)。

- 🔴 **明文密码在整条链路上一次都不出现**：模板里没有密码列（一律用系统默认
  密码 `USER_IMPORT_DEFAULT_PASSWORD`），请求、响应、Redis 里也都没有。
  理由是 `opera_log_middleware` 会把 JSON 响应体写进 `sys_opera_log.response_body`
  —— 把生成的密码放进响应 = 永久写进日志表，而那张表有自己的查看权限
- 🔴 **默认密码放 `.env` 不放 `sys_config`**。那张表的值会原样显示在参数配置页上，
  而且 `PUT /sys/configs` 的请求体会进操作日志（`value` 不在 `OPERA_LOG_REDACT_KEYS` 里）
- 🔴 **默认密码必须自己过 `validate_password_strength()`**。`123456` 过不了
  （`is_has_letter`）。不校验的失败是**延迟且分裂**的：导入成功、用户能登录，
  但他改密码时被「必须含字母」挡住，两件事看不出是同一个原因。空串 = 功能关闭，
  **不给内置兜底值**（内置值会跟着仓库公开，而每套部署都会照抄）
- 🔴 **重复要查两个维度**。库里没有、文件里有两行同名时，逐行对着库查**全都通过**，
  然后在提交阶段撞唯一约束 —— 而那时第一行已经落库了
- 🔴 **提交前先删 token**。不删的话重放一次就是重复建号：第二次撞唯一约束报
  「导入失败」，而库里已经多了第一批人
- ⚠️ **导入路由必须声明在 `GET /{pk}` 之前**。现在是两段路径（`/import/xxx`）撞不上，
  但以后加一条**一段**的放在后面就会被吞掉，表现是 `422 pk 不是合法整数`，
  看着像参数写错了
- ⚠️ **没有强制首次改密的机制**。`last_password_changed_time` 建号时就是当下，
  所以导入的账号在 `USER_PASSWORD_EXPIRY_DAYS`（默认 365 天）内不会被要求改掉默认密码

## 已经删掉的东西，不要照上游加回来

`sys_menu` 的两列已从**模型、DTO、种子 SQL 和数据库**里彻底删除：

| 列 | 上游的用途 | 为什么这里不需要 |
|---|---|---|
| `component` | Vue 运行时动态路由的组件路径 | 前端是编译期文件路由，`page-registry.tsx` 按 routeId 挂载 |
| `cache` | Vben `<KeepAlive>` 的 per-page 开关 | `TabOutlet` 用 `<Activity>` 一律保活，没有 per-page 概念 |

侧边栏也不再下发 `meta.keepAlive`（`utils/build_tree.py`）。

> 想给某一页关掉保活时**不要复活这个字段**，直接在 `TabOutlet` 里判断。
> 另外记住 `update` 走 `model_dump(exclude_unset=True)`：前端不传的字段不会被写 ——
> 这条在「前端删字段」时是好事（不会静默重置老数据），但要归一老值就得显式传一次。
