# apps/api —— FBA fork（新增 SQL Server 支持）

> 三层 `api/v1 → service → crud`、插件机制、RBAC/数据权限模型都是 FBA 的设计。
> 上游拒绝合并 SQL Server 支持，永久分叉——现在同时支持 MySQL / PostgreSQL /
> SQL Server 三种数据库，SQL Server 是本仓库新增的那一种，其余两种沿用上游。
> 归属与上游文档链接见根 `CLAUDE.md` 的「fork 管理」。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

## 后端约定

三层：`api/v1/` → `service/` → `crud/`，模型在 `model/`、DTO 在 `schema/`。

- 存中文的列用 `UniversalStr(n)`，**不要** `sa.String(n)`（SQL Server 下要 NVARCHAR）
- 长文本用 `UniversalText`（mssql → `NVARCHAR(MAX)`，不是废弃的 `NTEXT`）
- 分页查询必须带 `ORDER BY`（`select_order`）——SQL Server 的 `OFFSET FETCH` 强制要求
- 唯一约束若含可空列，SQL Server 下要改用筛选唯一索引
  （见 `model/user.py` 的 `_EMAIL_UNIQUE`）
- 返回裸 dict 的接口要过 `stringify_big_ids` / 编码层的 `stringify_unsafe_ints`
- 用户列表的 `role` 入参（本仓库加的）是落在已 join 的 `user_role` 上的，
  **副作用是返回的 `roles` 只剩被过滤的那一个**。要用户的完整角色走 `GET /users/{pk}/roles`。
  改成 `User.id.in_(子查询)` 能拿回完整 roles，但用户会按角色数重复成多行，
  `apaginate` 按行计数 —— total 和翻页会一起错
- 角色 ↔ 用户的增删走 `POST/DELETE /roles/{pk}/users`，**不要**用 `PUT /users/{pk}`：
  后者收整个用户对象，为改一个角色要把 username/email/dept 全带上回传，读漏一个字段就清掉一个
- 关联表写完记得 `user_cache_manager.clear*` —— 权限码和侧边栏缓存在 Redis，
  不清的话新权限要等 token 过期才生效
- 🔴 **给嵌在用户缓存里的 DTO 加必填字段，必须同时清掉 `fba:user:*`。**
  `GetUserInfoWithRelationDetail` 里嵌着 `dept` 和 `roles`，整份序列化后存在
  `fba:user:<id>`（`JWT_USER_REDIS_PREFIX`）。给 `GetDeptDetail` / `GetRoleDetail`
  加了必填字段之后，**旧缓存里没有那个字段** → 每个已登录用户的每个请求都
  `ValidationError: dept.code Field required` → **全站 500**，而代码、数据库、
  语言包全都是对的。实测踩过（加 `code` 时 pytest 13 条全红，报的是文件上传 500）。
  一行的事：`redis-cli --raw KEYS 'fba:user:*' | xargs -r redis-cli DEL`
  —— 它只清缓存，不影响登录态（token 在 `fba:token:*`）
- `xxx_dao.update_*` 返回的是「写了几行」，不是成败。清空类操作（`menus=[]`）本来就是 0，
  接口层拿它判 `response_base.fail()` 会把一次成功的清空报成失败
- **`deleted` 不是布尔，是「0 或这一行自己的 id」**（`LogicalDeleteMixin`，`BigInteger`，
  注释写着「0：否；id：是」）。这样含可空列的唯一约束在软删之后还能再插同一个键。
  **副作用**：任何手写 SQL 忘了 `AND deleted=0`，都会把已删除的行当成活的。
  实测踩过：`UPDATE sys_menu SET path=… WHERE id=…` 改的是一条**已软删**的目录，
  再往它下面 INSERT 子项 —— 父节点不在侧边栏结果集里，`traversal_to_tree`
  把三个子项**当孤儿提到了根**，侧边栏凭空多出三条顶层菜单
- **`.env.example` 和 `cli.py` 是靠精确字符串耦合的**。`setup_env_file()` 用
  `env_content.replace("DATABASE_PORT=1433", …)` 这种字面量替换填用户的输入 ——
  改了模板里的默认值、`cli.py` 那边没跟着改，替换会**静默不生效**：
  `fba init` 一路问完、写出的 `.env` 里还是模板的旧值，报错要等到连数据库时才出现。
  改模板后跑一遍对账（9 处 replace + 1 处 `TOKEN_SECRET_KEY` 正则）
- 记录操作日志的请求/响应头时，`OPERA_LOG_REDACT_HEADERS` 里的字段必须打码 ——
  否则操作日志表本身会变成凭据泄露面
- 登录失败必须记日志。异常分支要捕获 `errors.BaseExceptionError` 并把
  `BackgroundTask` 挂到**原异常**上再 `raise`（不要包成 `RequestError`，会改掉状态码）
- **socket.io 的命名空间是 `/` 而不是 `/ws`**。`AsyncServer(namespaces=['/ws'])` 极具误导性：
  那个参数只是「额外接受哪些命名空间」，而 `@sio.event` 注册的 connect/disconnect
  处理器绑在**默认命名空间**上。客户端连 `io(base + '/ws')` 会握手成功、日志里也是
  `WebSocket /ws/socket.io/... [accepted]`，但**处理器一行都不执行** ——
  `fba:token_online` 一个都不写，「在线用户」页全是离线。
  正确写法：`io(API_BASE, { path: '/ws/socket.io' })`（路径带 `/ws`，命名空间不带）。
  实测：连 `/` 时 `SCARD fba:token_online` = 1，连 `/ws` 时 = 0
- **`UploadFile.filename` 是攻击面，不是文件名**。Starlette 原样透传
  Content-Disposition 里的值、不做任何过滤，拿它拼 `UPLOAD_DIR / filename`
  就是任意文件写入（`filename=../../../../../x.png` 实测写到了仓库根，接口还返回 200）。
  一律先过 `utils/file_ops.py: strip_path()`，落盘名走 `build_filename()`
  （随机后缀，不复用原名做唯一性）。
  ⚠️ 落盘分**两棵树，别把它们当成一回事**：私有件在 `UPLOAD_DIR`
  （`core/path_conf.py`，= `BASE_PATH / 'upload'`），**不挂静态**，只能走带 JWT 的
  `GET /api/v1/sys/files/{pk}/download`；公开件在 `PUBLIC_UPLOAD_DIR`，由
  `core/registrar.py: register_static_file` 挂在 `/uploads`，**设计上就不鉴权** ——
  富文本正文里的 `<img src>` 带不上 Authorization 头，只能有这么一条。
  进那棵树要显式 `?public=true`，且服务端强制只收图片
  （`app/admin/service/file_service.py: verify_public`）。
  历史上还有一条 `app.mount('/static/upload', …)`，那才是真漏洞（整棵上传目录对
  任何人可读），**已经删了**，回归守在 `test_file.py: test_static_upload_mount_is_gone`。
  🔴 光删 mount 不够：`UPLOAD_DIR` 原来是 `STATIC_DIR / 'upload'`，而 `/static`
  那条挂载会把它连带公开（实测删了 mount 还是 200）—— 所以它搬去了 `BASE_PATH`。
  **别把上传目录挪回 `backend/static/` 下面**，挪回去等于把这个漏洞原样装回来
- 🔴 **前端 `<Can>` 隐藏了按钮，不代表接口有权限校验** —— 这两件事是分开写的，
  加接口时漏挂 `Depends(RequestPermission('...'))` + `DependsRBAC` 不会在任何地方
  报错，只会在"前端按钮权限审计"里被翻出来。`POST/DELETE /sys/files/relations`
  （挂载/卸载附件）踩过：只挂了 `DependsJwtAuth`，前端却用
  `<Can perm="sys:file:upload">` 隐藏了对应按钮 —— 任何登录用户直接调接口，
  就能把任意文件挂到任意业务对象上，跟自己有没有这个权限完全无关。
  这条**已经修了**（`api/v1/sys/file.py` 里那两条 relations 路由都挂上了
  `RequestPermission('sys:file:upload')` + `DependsRBAC`），留着是因为这类漏挂
  还会再发生。
  现在有机器在核对：`app/admin/tests/security/test_permission_codes.py` 把
  后端 `RequestPermission` / 前端 `<Can perm>` / 种子菜单 `sys_menu.perms`
  三份清单做差集，任一方向漂移都会红。**新增接口时照样自己核一遍**，
  但漏了不再只能靠人翻出来

### ⚠️ `.schemas/plugin.schema.json` 是上游带过来的，`sqlserver` 要自己补进去

`plugin.toml` 的 `database` 数组由 `.schemas/plugin.schema.json` 约束
（`pyproject.toml` 的 `[[tool.tombi.schemas]]` 挂上去，pre-commit 的 `tombi-lint` 执行）。
那份 schema 是上游 FBA 的，枚举里只有 `mysql` / `postgresql` —— 而这个 fork
三种库都支持。

**为什么一直没人发现**：pre-commit 只 lint **本次改动的文件**。`notice` / `dict`
的 `plugin.toml` 早就写着 `sqlserver`，但它们已经提交、之后没再动过，
所以那条规则从来没被触发。新加一个插件（或只是改一下现有的 `plugin.toml`）
才会当场被挡住，报的是一句看不出上下文的
`The value must be one of ["mysql", "postgresql"], but found "sqlserver"`。
`sqlserver` 已经补进枚举。**以后 cherry-pick 上游改动碰到这个文件时，
记得别把它覆盖回去。**

### 🔴 撤销一个会话 = 删三个 key，漏掉 refresh 那个等于没撤销

`create_new_token()` 只校验「refresh key 存在且值相等」，**从不检查 access key 还在不在**。
所以只要 `fba:refresh_token:{uid}:{sid}` 还活着，那个会话就能随时换回一个全新的 access token。
两个入口都栽在这上面（两个都是**静默**的，界面上该消失的都消失了，人还在）：

| 入口 | 原来的样子 | 后果 |
|---|---|---|
| **强制下线**（`monitor/online.py: delete_session` → `jwt.py: revoke_token`） | 只删 `TOKEN_REDIS_PREFIX` 和 `TOKEN_EXTRA_INFO_REDIS_PREFIX` | 被踢的人立刻打一次 `/auth/refresh` 就回来了；而此时 `token_keys` 恰好是空的，`multi_login` 那道检查**反而更不会拦** |
| **登出**（`auth_service.logout`） | 第一句 `get_token(request)`，拿不到 `Authorization: Bearer` 直接 `return` | 见下 |

`revoke_token()` 现在三个 key 一起删。**新增任何「让某个会话失效」的代码时，
判据是「它还能不能刷出新 token」，不是「在线用户页上还在不在」。**

### 🔴 登出的身份要从 access token **或** refresh cookie 里任取其一

原来只认 access token，于是两类调用方的登出**全都是空操作**，而两边都看不出来：

- **桌面端**：`apps/desktop/src/main/auth.ts` 的 `logout` 只手工带 cookie、不带
  Authorization —— access token 在渲染层的 sessionStorage 里，主进程手上根本没有。
  它本地删了凭据、界面也回到登录页，而那个会话的 refresh token 还能再活 7 天
- **浏览器端**：access token 过期之后点登出，JWT 中间件先 401，请求根本到不了
  `logout()`，连 `response.delete_cookie` 都没执行 —— 浏览器里那个 httpOnly cookie
  既没被清、在 Redis 里也仍然有效。**而那恰恰是最需要登出的时刻**

refresh token 的 JWT 里同样带着 `sub` 和 `session_uuid`（`create_refresh_token`），
它自己就够定位一个会话。安全性不受影响：一种凭据都拿不出时什么都不做，
拿得出也只能撤销**它自己那一个**会话。

⚠️ **不要顺手把 `/auth/logout` 加进 `TOKEN_REQUEST_PATH_EXCLUDE`。** 我试过，
为的是让「access token 已过期时点登出」也进得来 —— 但那条路由是**要记操作日志**的，
白名单会让 `request.user` 变成未认证，`opera_log_middleware` 的 `request.user.username`
走 AttributeError 分支，**每一次登出都记不下用户名**。而它买到的只有那一种情况，
且前端的 401 → 单飞刷新 → 重放已经覆盖了（刷新时 `create_new_token()` 自己就会删掉
旧会话的 access + refresh key）。
只带 cookie 的请求本来就过得了中间件：`extract_token()` 没有 Authorization 头时返回
`None`，那是「未认证」而不是「认证失败」。

⚠️ 写这类测试**不能用 `/auth/login/swagger`**：它只发 access token，
`create_refresh_token` 根本没被调用（`auth_service.swagger_login`），
拿它测 refresh 撤销等于什么都没测。要走真实 `/auth/login`，
并且把 `load_login_config` 一起顶掉 —— 只设 `settings.LOGIN_CAPTCHA_ENABLED = False`
会被它从 sys_config 表里 setattr 回来，而那张表在 `fba_test` 里是什么值
取决于上一次 E2E 的 global-setup 跑没跑过。

## 数据库结构改动一律走 alembic

🔴 **改了模型就要生成迁移，没有例外**（2026-08-22 起）。手写 `ALTER` /
`drop_all` 重建那条路已经关了。

命令、三条纪律、四个守卫，以及后端侧那一串坑（雪花主键被建成 IDENTITY ·
alembic 之前手写 ALTER 加的列守卫抓不到 · 种子数据要配 data migration …）
全在 [`backend/alembic` 分册](backend/alembic/AGENTS.md)。
**动迁移之前先读那一份** —— 少读一条的失败方式都是延迟且静默的。

## 时区：单时区系统，但**下发的时间必须带时区标记**

分两件事，别混：

| | 谁决定 | 影响什么 |
|---|---|---|
| **服务端时区** | `DATETIME_TIMEZONE`（默认 `Asia/Shanghai`），**进程级单例**（`utils/timezone.py` 的 `timezone` 就一个实例），Celery 同一个值（`enable_utc=False`） | 落库时怎么算、定时任务什么时候跑、日志时间戳 |
| **显示时区** | `sys_user.timezone`（IANA 标识，每人一份，`PUT /sys/users/me/timezone`） | **只影响前端怎么显示**，不参与任何服务端计算 |

所以服务端仍然是单时区的（一个进程一个时区，没有「按请求切时区」的机制），
而**展示是多时区的**。`timezone.py` 这个文件名容易让人以为前者也能按用户切，不能。

- 🔴 **`sys_user.timezone` 这个列名会遮蔽同文件的 `timezone` 导入。**
  `model/user.py` 里必须把导入起别名（现在是 `tz_helper`）——不起的话类体里
  后面的 `default_factory=timezone.now` 拿到的是那个 `MappedColumn`，
  直接 `AttributeError: 'MappedColumn' object has no attribute 'now'`。
  好在它是 import 期就炸、不是静默的。（和前端 `shadowed-t` 同一个物种。）
- 🔴 **给 `GetUserInfoDetail` 加字段必须带默认值。** 它的子类
  `GetUserInfoWithRelationDetail` 整份序列化后存在 `fba:user:<id>`，
  旧缓存里没有新字段 —— 写成必填就是每个已登录用户的每个请求都
  `ValidationError` → 全站 500（同 `dept.code` 那次）。带默认值时旧缓存能过校验、
  先回落默认值。改完照样把 `fba:user:*` 清一遍拿到真值
- 🔴 **`TimeZone.process_bind_param` 不能对 naive datetime 调 `astimezone()`。**
  查询参数（如 `/tasks/results?start_time=2026-08-19 18:24:29`）经 pydantic 解析出来
  是没有 tzinfo 的 naive datetime，原来的判断是「偏移不等于当前时区偏移就转换」——
  naive 值的 `.utcoffset()` 是 `None`，恒不等，于是一律走
  `timezone.from_datetime(value)`（= `value.astimezone(self.tz_info)`）。
  Python 对 **naive** datetime 调 `astimezone()` 是按**操作系统本地时区**重新解释，
  不是按应用配置的 `DATETIME_TIMEZONE`——本机系统时区恰好也是 UTC+8
  （`Asia/Taipei`）时两次转换抵消，看不出问题；GitHub Actions runner 系统时区是
  UTC，同一个 naive 查询参数被当成 UTC 时刻再转成 `+08:00`，静静地被加了 8
  小时。实测：`test_range_is_inclusive_on_both_ends`（起止都是记录自己的精确
  时刻的闭区间查询）本地绿、`TZ=UTC` 下红，`assert set() == {'d5'}`——边界查询
  直接查空。修法是分两支：naive 值只 `value.replace(tzinfo=timezone.tz_info)`
  补时区标记，不做时区换算；只有**真带时区但偏移不同**的值才继续走
  `astimezone()` 转换。验证不能只跑默认时区：`TZ=UTC uv run --no-sync pytest`
  复现，`git stash` 掉修复后同一条测试在 `TZ=UTC` 下应该会红，反过来才是真的修对了。
- **写入侧必须校验是合法 IANA 标识**（`common/schema.py: IanaTimeZone`，
  拿 `zoneinfo.available_timezones()` 对）。这个值会被前端直接交给
  `Intl.DateTimeFormat(..., { timeZone })`，而那个 API 对不认识的时区是**抛异常** ——
  存进一个拼错的名字，那个用户所有带时间的页面都白屏，**而且自己改不回来**
  （偏好设置页本身也要渲染时间）。不维护白名单：前端选项来自浏览器的
  `Intl.supportedValuesOf('timeZone')`，两边各自跟着自己的 tzdata 走
- **改完要清 `fba:user:<id>`**（`user_service.update_timezone` 里做了）。
  `/users/me` 读的是缓存里那份 DTO，不清的话前端存完立刻重取还是旧值，
  表现成「点了保存没生效」

下发格式方面：

- 🔴 **不要给 `SchemaBase` 加回 datetime 的 `json_encoders`。**
  原来那个 encoder 把所有时间格式化成 `'%Y-%m-%d %H:%M:%S'` —— **丢掉了时区**。
  ES 规范对无时区标记的串，`T` 分隔的按**浏览器**时区解释、空格分隔的干脆没定义
  （Safari 历史上直接 Invalid Date），于是前端只能靠猜，猜错不报错、只是偏几小时。
  前端为此长出过两处 hack（`log-online/api.ts` 自己写解析器、
  `profile/recent-logins.tsx` 干脆放弃解析原样摊字符串），现在都删了。
  pydantic v2 的**默认**行为正好是要的（`2026-08-22T11:59:47+08:00`），
  而且那个 `json_encoders` 本身是 pydantic v2 已废弃的 API
- **`to_str()` 不出网，出网用 `to_iso()`。** `to_str()` 输出不带时区标记，
  只能用在日志前缀、和 `from_str()` 成对的 Redis 读写（用户锁定到期时间）、
  以及靠字符串等值比较的地方（celery 的 `last_update`）。
  绕过了 pydantic 自己拼字符串下发给前端的那几处（token 里的 `last_login_time`、
  监控页 `startup`）必须用 `to_iso()`
- ⚠️ **改格式后旧 token 里还存着旧格式**：`last_login_time` 是签发时写进
  token payload 的，实测切换后在线会话里 200+ 条旧格式和新登录的 ISO 并存，
  要等 token 过期才换完。前端的解析对无标记串保留了按 `Asia/Shanghai` 的兜底，
  就是为了这段过渡期（见 [i18n 分册](../../packages/i18n/AGENTS.md)）
- **输入方向不用管**：pydantic 对 `'2026-08-22 17:00:00'` / 带 `Z` / 带 `+08:00`
  全都收，改下发格式不会让任何表单提交失败

> **存储不需要改成 UTC** —— 一开始以为要，实测之后发现前提就不成立。
>
> `TimeZone` 的 `impl = DateTime(timezone=True)` 在 SQL Server 下落成
> **`datetimeoffset`**（不是 `datetime2`），这个类型**每行自己存着偏移**。
> 实测同一张 `sys_user` 里两种偏移并存且都正确：种子 SQL 用 `GETDATE()` 插的
> `admin` 行是 `+00:00`（容器时区是 UTC），应用自己写的行是 `+08:00`
> （`timezone.now()`）。两者是同样自描述的瞬间，读出来 tzinfo 就是当初存进去的那个。
>
> 所以「改了 `DATETIME_TIMEZONE` 配置会让历史数据静默重新解释」这个担心
> **在这套 schema 上不存在**（那是 `datetime2` 才有的问题：不存偏移、
> 靠一个配置值隐式决定）。`process_result_value` 里那个
> `if value.tzinfo is None` 分支是给不存偏移的方言兜底的，SQL Server 走不到。
>
> 留下的只是「不齐」——同一列里有 `+00:00` 也有 `+08:00`。不影响正确性
> （前端拿到的都是无歧义的 ISO），要归一的话直接 `UPDATE` 一遍就行，
> 不用重建库、也不必改模型。

## 部门与角色的编码（稳定引用键）

`sys_dept.code` / `sys_role.code` 是 2026-08-22 加的。**加它的理由不是「别人都有」**，
而是这套数据本来没有任何一个「跨环境稳定 + 人可读 + 能写进配置」的键：

| 候选 | 为什么不行 |
|---|---|
| 名字 | 管理员在界面上随时能改。硬编码它，改个名字业务逻辑就静默不走 |
| 雪花 ID | 每套环境不同。种子里那串 `2048601263515500544` 只在这份种子里成立 |

上游 FBA 没有这两列（菜单靠 `perms`、字典靠 `code`、配置靠 `key`，**凡是被代码
引用的表都有编码，只有这两张没有** —— 因为它们此前只被界面引用）。

四条约定：

- **格式是 `^[A-Z][A-Z0-9_]*$` + 2–32 位**，定义在 `common/schema.py: CustomCode`，
  前端 zod 各有一份同样的正则（那份只为当场报错，**后端才是权威**）。
  限大写是因为编码和中文名同排显示，混排就分不出哪个是标识；
  首字符限字母是为了排除「纯数字编码」—— 那种一旦在某处被 `Number()` 掉不会被发现（同硬纪律 6）
- 🔴 **`code` 创建后不可改，靠「`UpdateDeptParam` / `UpdateRoleParam` 里没有这个字段」实现**，
  不是靠前端禁用输入框。改编码会让所有引用方静默指向空（不报错，只是查不到），
  所以这道门要在契约上就关掉。要换编码就删了重建
- 🔴 **部门名称的唯一性从「全局」改成了「同级」。** 原来是 `(name, deleted)` 全局唯一，
  于是整棵树里只能有一个「测试组」—— 而「技术中心/测试组」和「质量中心/测试组」
  在真实组织里是常态，第二个建不出来、报的还是「部门名称已存在」。
  现在库上只有 `(code, deleted)` 唯一，同级重名由 `dept_service` 拦
  （`get_sibling_by_name`）。**刻意不建库约束**：`parent_id` 可空，而各方言对
  「唯一索引里的 NULL」语义相反（SQL Server 认为多个 NULL 相等、MySQL/PG 认为互不相等），
  建了只会得到一条在某一种库上生效、在另一种上静默失效的约束。
  ⚠️ 更新时要按**目标**父级判：只挪了上级、名字没动，一样可能撞到新兄弟
- 角色的 `(name, deleted)` 全局唯一**保留** —— 角色是平的，没有层级，全局唯一是对的

列表接口都收 `code` 入参，且**大小写归一**（`code.upper()`），所以 `?code=fin`
命中 `FIN`。部门页有独立的编码筛选框；角色页没有（一共几条，编码在每行里都显示着），
这是**取舍不是遗漏**。

> 存量行的编码推不出来（中文名推不出真实编码），开发库和 `fba_test` 是按 id 序
> 回填的占位码（`DEPT_0001` / `ROLE_0001`）。真要用的话得人工改一遍 —— 但改不动，
> 见上面那条。这批占位码要换只能删了重建。

## 🔴 改完再读同一个 ORM 实例，读到的是新值

密码历史这条控制**从来没生效过**，根因就是这个：

```python
user = await user_dao.get(db, user_id)
...
count = await user_dao.reset_password(db, user_id, new)   # 改
history_obj = CreateUserPasswordHistoryParam(password=user.password)  # 再读 → 已经是新值
```

`user` 和 `reset_password` 动的是**同一个 ORM 实例**，所以历史表里存进去的是
「刚设的那个密码」，而不是被换掉的那个。

实测（改一次密码后直接查 `sys_user_password_history`）：那一行
`password_verify(新密码, hash)` 是 **True**、`password_verify(旧密码, hash)`
是 **False**。后果是「不许复用最近 N 个密码」形同虚设 —— 改回上一个密码
照样 `code=200`，而界面上没有任何异常，配置页里那个「历史检查次数 3」
看起来也在生效。

修法：**在改之前把旧值抓成局部变量**（`previous_password = user.password`）。
两处同构（超管的 `reset_password` 和自助的 `update_password`）都改了。

判据：**「先改后读同一个对象」是个静默错误源。** 凡是要用「改之前的值」，
一律先存进局部变量，不要指望改完之后那个属性还是旧的 ——
ORM 的身份映射让这件事看起来像它会是旧的。

## 雪花节点的心跳必须明显快于 TTL

节点号（datacenter/worker）是从 Redis 抢的：`SET <key> <pid> NX EX=TTL`，
抢到之后靠一个心跳任务 `EXPIRE` 续期。这套设计本身是稳的 —— NX 原子占位，
漏释放也会 TTL 过期自动回收。

🔴 **但它有一个没人校验过的配置不变式：心跳要明显快于 TTL。**
心跳慢了，进程**还活着** key 就过期了 —— 另一个副本
`acquire_node_id()` 扫一圈看见槽位空着，就占走**同一个号**。
于是两个实例用同样的 datacenter/worker 发号，**雪花 ID 开始重复**。

而全仓所有 ID 都是雪花（硬纪律 6），症状是「偶尔两条记录 ID 一样」——
从这个现象追回「心跳配置」几乎不可能。

默认值 `SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS=30` / `SNOWFLAKE_NODE_TTL_SECONDS=60`
是对的（正好一半）。现在 `_check_snowflake_node_lease()` 会拦住不合格的比例
（由 `check_production_settings` 收集），守卫测试三条
（太慢 / 刚好一半要放过 / 两个值调反）。

⚠️ 判据是 `心跳 * 2 > TTL`，**不是 `>=`** —— 写成后者会把默认配置本身拒掉，
那种误杀比漏判更糟：所有人第一次上生产就起不来，而报错指着一份没改过的配置。
反向验证过：改成 `>=`，「刚好一半该放过」那条会红。

⚠️ 只在 prod 校验，因为它只在**多副本**时咬人（单副本没有第二个抢号的）。
这也是 `check_production_settings` 那批检查的共同前提。

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

## 请求 IP 只在可信代理后面才作数

🔴 `utils/request_parse.py: get_request_ip()` 原来**无条件信任** `X-Real-IP`，
其次取 `X-Forwarded-For` 的第一段。而它的返回值决定了限流的 key
（`utils/limiter.py: default_identifier` = `{IP}:{path}`）、登录日志的来源和 IP 属地。

**症状**：限流形同虚设 —— 每个请求换一个 `X-Real-IP` 就是一份全新配额，
登录爆破和验证码刷取无损通过。**这个失败完全静默**：限流看起来在工作，
日志里的 IP 看起来也很正常，只是全都是攻击者填的。

**修法**：`conf.py: TRUSTED_PROXIES`（IP / CIDR 列表，**默认空 = 谁都不信**）。
只有直连对端落在白名单里才采信转发头，且从**右往左**取第一个非可信地址 ——
XFF 是追加的，左侧可以被客户端预填。

⚠️ 两层要配一致：uvicorn 的 `--forwarded-allow-ips` 写 `*` 等于在更底一层
把「谁都信」重新打开，上面的白名单就白配了（`Dockerfile.prod` 里限到了容器网段）。

## 依赖注入覆盖不到直接 import 了 `async_db_session` 的模块

🔴 `conftest.py` 重载 `get_db` 只换得掉 `Depends(get_db)` 那条路。请求路径上
还有几处是在模块顶层 `from backend.database.db import async_db_session` 拿会话的，
它们连的始终是**开发库**：`common/security/jwt.py`（JWT 用户解析）、
`app/admin/service/login_log_service.py`、`middleware/opera_log_middleware.py`、
`app/task/tasks/maintenance/tasks.py`（定时清理任务）。

**前三处的后果都是静默写错库**：跑一次 pytest 会往开发库写登录日志和操作日志
（实测本机 `fba.sys_login_log` 积了 880 行，全是历次测试留下的）；
全新环境里开发库是空的，任何带 token 的请求都在 `get_jwt_user()` 里 `TokenError` ——
本机从没暴露过，是因为两个库里**恰好都有同 ID 的 admin**（种子雪花 ID 是写死的常量）。

🔴 **第四处的后果不是写错库，是删错库。** `maintenance/tasks.py` 是全仓唯一会
`DELETE` 数据的定时任务，之前只靠它自己测试文件（`test_prune_logs.py`）里
`run_prune()` 手工 monkeypatch 才连得到测试库——那只保护了"经过 `run_prune()`
调用"这一条路径，换个新测试直接 import `prune_logs` 跑，退回去连的就是开发库
`fba`，真的会删掉真实数据。这类代码新增时容易被漏掉，是因为它不在"请求路径"上
（前三处都是 HTTP 中间件/依赖），review 时按"这条路会不会被请求打到"筛查会跳过它。

**修法**：`conftest.py` 里一个 session 级 autouse fixture 把这几处一并指到测试库。
**新增「不走依赖注入直接拿会话」的代码时，记得加进那份清单**——判断标准不是
"会不会被 HTTP 请求打到"，而是"模块顶层有没有 `from backend.database.db import
async_db_session`"，定时任务/脚本/CLI 命令这类不经过 FastAPI 依赖注入的代码
一样要算。

⚠️ 相关：限流在测试里默认关闭（`REQUEST_LIMITER_ENABLED`，同一个 IP 反复登录
会互相打成 429）。要验 429 的用例用 `rate_limiter` fixture 显式打开。

## 后端国际化（i18n）

语言包在这个目录，机制在 `../common/i18n.py` 和 `../middleware/i18n_middleware.py`。
前端那一侧（`Accept-Language` 必须跟界面语言同步）见 [`packages/i18n` 分册](packages/i18n/AGENTS.md)。

语言包在 `backend/locale/{zh-CN,en-US}.yml`，**统一用 YAML**（2026-08-22 前
`en-US` 还是 `.json`，已合并）。识别语言靠标准 `Accept-Language` 请求头
（`middleware/i18n_middleware.py`），不是自定义 header/query 参数。

- **不要以为 YAML 性能更好**——实测反过来：同一份内容 `yaml.safe_load`
  比 `json.loads` 慢两个数量级（本机 4.7ms vs 0.02ms/次）。选 YAML 纯粹是
  为了能写注释。反正 `I18n.load_locales()` 只在进程启动时跑一次，这点
  耗时不影响任何请求延迟
- 🔴 **业务错误消息统一走 `t('error.模块.slug', **kwargs)`，不要再用中文原文
  当 key。** 2026-08-22 之前是反过来——`raise errors.XxxError(msg='用户不存在')`
  写中文字面量，响应出口按原文查表翻译（`I18n.tm()`）。这套「中文当 key」
  查出过一整轮真问题（治理记录见下），根子是：中文原文一改字（哪怕改错字）
  翻译就跟着断，两个语言包永远没有机器能查的「对不对齐」标准。现在改法：
  - 键定义在两个语言包的 `error.*`（按模块分：`error.user.*`/`error.dept.*`/…）
    和 `file_type.*`（上传报错要用到的「图片/文档/…」标签，因为标签本身
    也是要翻译的中文词，不能直接拼进英文句子）
  - `t()` 自带 `.format(**kwargs)`，带变量的消息直接 `t('error.file.unsupported_format',
    file_ext=file_ext)`，不再需要正则模板去匹配插值后的字符串
    （`tm()` 的 `_templates()`/`message_templates` 机制已删除）
  - `tm()` 现在只剩一个用途：**反向翻译我们不控制抛出点的框架异常**
    （FastAPI/Starlette 自己抛的 `Not authenticated`/`Method Not Allowed`，
    这类拿不到一个能传参数的调用点，只能反过来拿英文原文当 key）。
    `exception_handler.py`/`response_schema.py` 在 `exc.msg`/`res.msg` 上
    无差别调 `tm()`：业务异常这时已经是 `t()` 的最终产物，查不到表就原样
    返回，对已翻译文本是幂等的
  - **两个语言包在 `error.*`/`file_type.*` 下的键集合必须完全相同**——
    `t()` 查不到键会把键名字符串原样吐出来（比如响应里出现
    `"msg": "error.dept.something"`），这比旧机制的「静默显示中文」更容易
    被发现，但仍然只能靠人看。`backend/tests/test_i18n.py` 机器化了这条：
    一条断言两个语言包键集合对称，一条断言源码里每处 `t('error.xxx')`
    引用的键在语言包里真实存在（两条都做过变异验证，打回问题会红）
  - `pydantic.*` 段是**唯一还保留的不对称**：只在 `zh-CN.yml` 有 100 条
    （pydantic-core 报错原生是英文，中文界面才需要翻），`exception_handler.py`
    里 `if i18n.current_language != 'en-US':` 把英文请求短路掉了，根本不查，
    `en-US.yml` 没有这一段是对的，不要照着补一份对称的过来
- **这次治理连带修了一个更隐蔽的 bug**：`jwt_auth_middleware.py` 的
  `auth_exception_handler`（Starlette `AuthenticationMiddleware` 的
  `on_error` 钩子）直接读 `exc.msg`/`exc.detail` 拼响应，**从来没调用过
  `tm()`**——所有 JWT 鉴权失败（token 无效/过期、账号锁定、部门/角色被禁用…）
  不管 `Accept-Language` 传什么，永远是中文。旧机制下这个旁路必须每加一个
  异常序列化路径就记得手动翻一次，漏了不报错；新机制下翻译在 `raise` 那一刻
  就已经发生（`msg=t(...)`），不管后面被哪条路径读到 `.msg` 都已经是对的
  语言——这类「序列化出口忘了翻」的问题整类消失了，不是又堵上一个洞

## 拆出去的分册

| 我要… | 读 |
|---|---|
| 跑 pytest / 建测试库 / 测试跑不起来 | [`backend/tests` 分册](backend/tests/AGENTS.md) |
| 动权限码 / 数据范围（行级过滤） | [`backend/common/security` 分册](backend/common/security/AGENTS.md) |
| 写迁移 / 改种子数据 | [`backend/alembic` 分册](backend/alembic/AGENTS.md) |
| 动定时任务 / Celery | [`backend/app/task` 分册](backend/app/task/AGENTS.md) |
| 动公共层（校验 / 异常 / 缓存 / 分页） | [`backend/common` 分册](backend/common/AGENTS.md) |
| admin 模块的测试笔记（动态配置 / prod 检查 / 上传） | [`app/admin/tests` 分册](backend/app/admin/tests/AGENTS.md) |

## pre-commit 钩子：必须带 `-C apps/api` 装

🔴 **`pnpm install:all` 会顺带装好本地 pre-commit 钩子，换机器 / 新克隆不用再手动补一步。**
`apps/api/.pre-commit-config.yaml` 早就在（ruff `--fix --unsafe-fixes` + ruff-format + json/yaml/toml
检查 + uv-lock/uv-export），`prek` 也是 `lint` 依赖组、`uv sync` 就带上——但光有配置和
二进制不等于钩子被激活，`.git/hooks/` 不进版本库，得显式 `install` 一次：

```bash
pnpm hooks:install       # = apps/api/.venv/bin/prek install -C apps/api -f
```

❌ **不要在仓库根裸跑 `prek install`（不带 `-C apps/api`）**——`.git` 在根目录、
配置在 `apps/api/` 下，prek 把 cwd 固化进装的时候生成的 shim 里，不会自己向下
搜子目录找配置。裸装**看似成功**，但下一次真正 `git commit` 才报「找不到配置文件」
并挡住提交——静默/延迟失败，且装错了没法从 git diff 里看出来。

实测（造一个带未用 `import os` + `if x: return x else: return None` 的坏 `.py` 文件验证）：

| 装法 | 提交时的表现 |
|---|---|
| 裸 `prek install` | `No .pre-commit-config.yaml found...`，钩子形同虚设 |
| `prek install -C apps/api -f`（= `pnpm hooks:install`） | 正确进 workspace：`ruff check` 自动修了 unused-import + superfluous-else-return，`ruff format` 重新格式化；剩下 2 个缺类型标注的错误改不了，提交被挡住（exit 1） |
