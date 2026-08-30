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

## 数据库结构改动一律走 alembic

**改了模型就要生成迁移，没有例外。** 手写 `ALTER` / `drop_all` 重建那条路已经关了
（2026-08-22 起）。命令、三条纪律和守卫写在根 `CLAUDE.md`
的「数据库结构改动一律走 alembic」一节，这里只补后端侧要记的：

- 迁移在 `backend/alembic/versions/`，命令要在 `backend/` 下跑
  （`alembic.ini` 的 `script_location` 是相对它的）。走 `pnpm db:upgrade` / `pnpm db:revision` 就不用管
- `env.py` 里那句 `import backend.main` **不能删**。它不是多余的 import ——
  `MappedBase.metadata` 靠它才有内容，删了 autogenerate 会生成一份
  「drop 掉全部 23 张表」的迁移，而且不会问你
- `pnpm --filter api test:db` 重建测试库之后会**自动 stamp 到 head**
  （`reset_test_db.py: _stamp_head`）。不 stamp 的话
  `test_model_matches_migrations` 会红 —— 它比对的就是 fba_test
- 🔴 `_stamp_head()` 必须在 `asyncio.run()` **之外**调用：alembic 的
  `command.stamp` 会执行 `env.py`，而那份 env 里是 `asyncio.run(...)`，
  在已经跑着的循环里再调直接
  `asyncio.run() cannot be called from a running event loop`

- pnpm --filter api db:reset 必须直接走 `fba init --auto`（drop_all + create_all + 灌种子）。
  不再暴露 `db:init:auto` 别名，避免和 reset 形成重复入口。不要把 alembic downgrade base && upgrade head 当成重置：空基线的 downgrade
  不会删表或业务数据，它只适合验证迁移链。

### 🔴 alembic 引进来**之前**手写 ALTER 加的列，守卫测试抓不到

`test_model_matches_migrations` 比对的是**模型 vs fba_test**。如果一列是手写
`ALTER` 加进去的（alembic 之前的做法），那两边本来就一致 —— 测试全绿，
而迁移链里**没有任何一条创建这一列**。`sys_user.timezone` 就是这样漏的。

漏了之后的失败是双重静默的：

1. `c0000000comments` 那种「补齐历史遗留」的迁移里每一步都包着
   `contextlib.suppress(ProgrammingError)`，在缺列的库上 `alter_column`
   抛错被吞掉，`db:upgrade` 一路绿到 head，**列还是不存在**
2. 要等下一次读那张表的请求才炸，报 `Invalid column name 'xxx'`

所以：**凡是 alembic 之前手工改过结构的列，逐个回头补一条迁移。**
补的时候两件事：

- **必须幂等**（先 `sa.inspect(bind).get_columns()` 查在不在）——
  新建的库是 `create_all` 从模型建的，天然就有那一列，无条件 `add_column`
  会报 `Column names in each table must be unique`
- **加完要 `alter_column(server_default=None)`**。回填存量行要
  `server_default`，但模型侧的默认值是 Python 级的（`default=`）——
  库上留着 DEFAULT 约束的话，`create_all` 建的新库和迁移升上来的旧库不一致，
  `test_model_matches_migrations` 会报一条 server_default 差异

⚠️ **验证不能只跑 `upgrade head`**（在已经有那一列的库上它就是个 no-op，
证明不了任何事）。要 `downgrade -1` → 确认列真的消失 → `upgrade head` →
确认列回来**且存量行被回填**。`d0000000usertz` 是这么验的。

## 后端国际化（i18n）

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

## 数据权限（data scope / data rule）

一条链：**角色 → 数据范围（`sys_data_scope`）→ 数据规则（`sys_data_rule`）→ 一个 WHERE 条件**，
拼装在 `common/security/permission.py: filter_data_permission()`。
用例在 `backend/app/admin/tests/api_v1/test_data_permission.py`（22 个真实账号，
每个账号一种配置，全部走 `/auth/login/swagger` + `GET /sys/depts` 断言可见集合）。

### 🔴 它是 fail-open 的：规则「落不到列上」= 完全不过滤

`filter_data_permission()` 遍历规则时，遇到下面任一情况就 `continue`，
一条条跳完之后 `where_list` 是空的 —— 返回的是 **`or_(1 == 1)`**，也就是**放行全部**：

| 情况 | 例子 |
|---|---|
| 字段在目标模型上不存在 | 种子里的「本部门数据权限」= `Dept.__dept_id__`，而 `__dept_id__` 解析成 `dept_id`，`sys_dept` **没有这一列** |
| 字段名拼错 | 建规则时后端**不校验** model/column 是否存在（`CreateDataRuleParam` 只有 `str`），前端那个框还允许手填 |
| 字段在 `DATA_PERMISSION_COLUMN_EXCLUDE` 里 | `id` / `created_time` / `sort` / `deleted…` |
| 规则打在别的模型上 | 规则是 `User.xxx`，而接口 `DataPermissionFilter(Dept)` |

对比之下，「开了过滤但一个数据范围都没配」返回的是 `or_(1 != 1)`（**一条都看不见**）。
同一个函数里两种相反的兜底，而**配错的那一种恰好是放行的那一种**：
一个名字叫「本部门数据权限」的范围，实际效果是「全部部门」，界面上没有任何提示。

要收紧的话改 `filter_data_permission()` 里那三处 `continue` —— 但那是产品决定
（现有配置会立刻从"能看"变成"看不见"），不是 bug 修复，所以**没有动**，只用
`test_rule_on_missing_column_fails_open` 等四条钉住了当前行为。

### 🔴 AND 组和 OR 组在**顶层是 OR** —— 一条 OR 规则能抬掉所有 AND 规则

```python
return or_(and_(*where_and_list), or_(*where_or_list))
```

配「`parent_id == RA`（AND，想收紧）」+「`status == 1`（OR）」，结果是**并集**不是交集，
那条 OR 规则把限制整个抬掉了。界面上这两个下拉都叫「运算符」，看不出会有这个后果。
实测：`test_or_rule_defeats_and_rule`。

### 多角色取**最宽**，不是取交集

`for role in request.user.roles: if role.status and not role.is_filter_scopes: return or_(1 == 1)`
—— 只要有一个启用角色勾了「不过滤数据权限」，其它角色配的限制**一条都不看**。
给人加角色是「加能力」，这里同时也在「减限制」。实测：`test_one_unfiltered_role_defeats_all_restrictive_roles`。

### 🔴 覆盖面：不是每个接口都挂了 `DataPermissionFilter`

`GET /sys/depts` 是最早接上的一个，后来 `GET /sys/users` 也接了
（`test_user_list_endpoint_is_filtered`）。**但覆盖面不是靠数一个固定数字来钉的**——
旧版本这里有一条 `test_data_permission_filter_is_wired_to_exactly_one_endpoint`
断言"全仓只有一个接口挂了 `DataPermissionFilter`"，覆盖面一扩大它就必然红，
本身是在记录缺口而不是校验行为。现在换成了
`test_every_crud_class_declares_its_data_scope_stance`：每个 DAO 类要么继承
`DataScopedCRUD`（默认过滤），要么显式写 `data_scope_enabled = False` 并说明理由，
"忘了想这件事"会红——这才是原来那个洞真正的成因。

`PUT/DELETE /sys/depts/{pk}`、文件、任务执行记录……这类写接口目前仍然全部无过滤，
所以配「仅本人数据权限」`__ALL__ + __created_by__` 时不要以为它作用于所有模型 ——
`__ALL__` 说的是「规则匹配哪些模型」，不是「过滤器挂在哪些接口上」。

### 🔴 GET 也要 RBAC——只挂 `DependsJwtAuth` 等于这条路由退出了鉴权（issue #30）

行级数据权限和接口级 RBAC 是两道**独立**的闸，`filter_data_permission` fail-open
不代表 `DependsRBAC` 也可以不挂。2026-08-26 之前，`GET /sys/users`、
`/sys/configs`（+`/all`）、`/sys/data-rules`（+`/all`）、`GET /sys/menus`、
`GET /monitors/redis`、`/logs/login`、`/logs/opera` 这批读接口**只有
`DependsJwtAuth`**，没有 `RequestPermission(...)`，也没有 `DependsRBAC`——
`rbac.py: rbac_verify` 对没声明权限标识的路由是直接 `return`（放行），
所以这不是漏配一个字符串，是这条路由整个退出了鉴权。实测：一个只绑「仪表盘」
菜单的账号，直接打 `GET /sys/users` 能拿到全量用户列表（含 email/phone/dept_id），
打 `GET /logs/opera` 能拿到全量操作日志（含别人的 trace_id/username/IP）。
`GET` 还额外免了 `is_staff` 校验（`method not in {GET, OPTIONS}` 那个判断），
读接口比写接口更容易被这类漏配放过。

`/monitors/redis` 那条更离谱：同一个 `/monitors` 前缀下 `/server`、`/sessions`
都是 `DependsSuperUser`，就它一条是 `DependsJwtAuth`——三条本来就该同一套门槛。

修法是给这批读接口补 `RequestPermission('xxx:list')` + `DependsRBAC`
（新权限码统一用 `:list` 后缀，跟现成的 `sys:file:list` 对齐，不是随手起的名字），
**同时必须在种子菜单里补上对应的权限锚点菜单、并挂到需要保留访问的角色上**——
光加校验不加种子授权，会把当前能用的页面全锁死，这正是 #30 的建议里特别提醒的坑。
补的时候顺带发现：`test_data_permission.py` 那张自建图（`dp` fixture）里的角色
一个菜单都没挂——以前用不上，因为它打的接口都没有 `DependsRBAC`；这次给
`/sys/users` 补上之后必须给每个建出来的角色都挂一份权限锚点菜单（`add_role()`
里统一处理），不然 `rbac_verify` 里"用户未分配菜单"那道更早的闸就先炸了。

🔴 **`test_permission_codes.py` 那三条三方对账测试抓不住"接口压根没声明权限码"
这类洞**——它们做的是"后端声明的权限码 vs 前端 vs 种子菜单"三边 diff，一条路由
如果从来没调用过 `RequestPermission(...)`，根本不会进入被比较的集合，不会有
任何差集，测试照样全绿。这类洞目前只能靠人工审计接口清单发现，同 `sys/depts`
那批写接口的裸奔状态一样——不是这次的范围，留作已知缺口。

🔴 **给一个通用读接口补权限码之前，先搜一遍谁在拿它当"只要登录就行"的旁路用。**
这条修完当场炸了一个：`packages/platform/src/pages/dev-sandbox/api.ts` 一直在打
`GET /sys/configs/all?type=DEV`，代码注释原话是"只要 `DependsJwtAuth`，所以任何
登录用户都读得到"——组件沙箱故意不挂业务权限码（`sandbox/components.tsx`：
"只要登录就能进，不挂业务权限码"），是因为它假设了这条读接口的旧门槛。
`/sys/configs/all` 补上 `sys:config:list` 之后，没有这个权限码的账号（这次新加的
8 个演示账号一个都没有）打组件沙箱直接吃 403——不是显示"沙箱已关闭"那条降级
文案（那条走的是 `readSandboxGate` 的正常分支），是 `useQuery` 的 `error` 分支，
`QueryError` 报接口出错。硬纪律 9 在这起事故里表现是"失败确实可见"，但可见
不等于对：用户看到的是一个跟真实原因（RBAC）毫不相关的报错页。
修法不是把 `sys:config:list` 加进 `RBAC_ROLE_MENU_EXCLUDE`——那会把整张参数
配置表（含邮件服务器地址这类真敏感字段）重新对所有登录用户开放，等于把
#30 刚堵上的洞挖回去。而是新开一条**只读 DEV 组、type 写死不接受入参**的
`GET /sys/configs/dev-sandbox-gate`，只挂 `DependsJwtAuth`——暴露面从"整张
配置表"缩到"两个布尔开关"，跟沙箱本来的设计初衷（"不碰业务数据"）对上号，
不是给旧漏洞开后门。**一般结论**：改一个被多处复用的通用接口的权限门槛前，
`grep` 一遍调用方，尤其是那些没有专属业务权限码、靠"反正只要登录就行"这个
隐含假设活着的旁路用途。

### 已修：三个让接口直接 500 的坑

- 🔴 **`UniversalStr` / `UniversalText` 必须显式写 `python_type`。**
  `TypeDecorator` **不会**把 `python_type` 转发给 `impl`，基类实现直接
  `raise NotImplementedError`。而 `filter_data_permission()` 要靠
  `table.columns[c].type.python_type` 做值类型转换 —— 于是**任何打在字符串列上的
  数据规则都让接口 500**（`Dept.code`、`Dept.name`、`User.username`…，
  也就是这个 fork 里几乎所有能写规则的文本列）。种子里的「部门编码等于 TEST」就是一条。
  实测：修之前 `test_eq` 等 5 条直接 `NotImplementedError` → 500。
  （`TimeZone` 早就显式写了一份，是同一个原因 —— 加新 `TypeDecorator` 时记得跟上）
- 🔴 **`${now}` 要放调用结果，不是函数对象。** 原来是 `'${now}': timezone.now`，
  `datetime(<function now>)` 抛 TypeError 被 `except` 吞掉，
  于是 `'${now}'` 这个**字面量**被拼进 SQL —— 规则不是不生效，是让接口 500
- 🔴 **模板变量解析不出值时要 fail-closed，不能把字面量塞进 SQL。**
  用户没有部门时 `${dept_id}` 是 None，`int(None)` 同样被吞，
  `WHERE parent_id = '${dept_id}'` 实测报
  `Error converting data type varchar to bigint (8114)` → 500。
  现在解析失败的规则编译成 `false()`（看不见），不是放行、也不是崩

### ⚠️ 写数据权限测试：JWT 用户解析**不走**依赖注入

`jwt.get_jwt_user()` 里直接用了 `backend.database.db.async_db_session`（**开发库
`fba`**），而 `conftest.py` 只重载了接口层的 `get_db`（→ `fba_test`）。
现有用例从没暴露这条，是因为它们只用 admin，而 `fba` 和 `fba_test` 是同一份种子
建出来的、admin 的雪花 ID 完全相同。**只存在于测试库里的用户会登录成功、
第一个请求就 `TokenError`** —— 必须把 `jwt_module.async_db_session` 也换掉
（见 `test_data_permission.py` 的 `dp` fixture）。

另外那份 fixture 是**自己建图自己拆**（5 个部门 / 16 条规则 / 17 个范围 /
19 个角色 / 22 个用户，每次跑带一个随机后缀），不依赖种子数据，
teardown 里按 id 硬删干净 —— 因为 `fba_test` 同时也是 Playwright E2E 的库。

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

## 跑测试

```bash
pnpm test                     # = turbo test → apps/api 的 pytest
cd apps/api && uv run pytest backend/app/admin/tests/api_v1/test_file.py -q
```

**测试跑在独立的 `fba_test` 库上**（`backend/conftest.py` 覆盖了 `get_db`，
另有一个 autouse fixture 补上三处不走依赖注入的会话，见上一节），
不是开发库。第一次要手工准备，否则报的是一句看不出原因的 sqlalchemy 连接错误：

```bash
# 1. 建库
docker exec fba_mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PW" -C \
  -Q "IF DB_ID('fba_test') IS NULL CREATE DATABASE fba_test;"

# 2. 建表（从模型生成，和开发库同一套路子）
cd apps/api && uv run python -c "
import asyncio, backend.app.admin.model, backend.plugin.config.model, backend.plugin.dict.model
import backend.plugin.notice.model, backend.plugin.oauth2.model
from backend.common.model import MappedBase
from backend.database.db import create_database_async_engine, get_database_url
async def m():
    eng = create_database_async_engine(get_database_url(unittest=True))
    async with eng.begin() as c: await c.run_sync(MappedBase.metadata.create_all)
    await eng.dispose()
asyncio.run(m())"

# 3. 灌种子（登录 fixture 要 admin 账号）
docker cp backend/sql/sqlserver/init_snowflake_test_data.sql fba_mssql:/tmp/seed.sql
docker exec fba_mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PW" -C -I \
  -d fba_test -i /tmp/seed.sql
```

三个坑：

- **`sqlcmd` 灌种子必须加 `-I`**（QUOTED_IDENTIFIER ON）。`sys_user` 上有筛选唯一索引
  （`_EMAIL_UNIQUE`），SQL Server 要求这个选项为 ON 才允许 INSERT，否则报
  `Msg 1934 … SET options have incorrect settings: 'QUOTED_IDENTIFIER'`
- **`test` 脚本用 `uv run --no-sync`**。裸 `uv run` 每次都会重新 sync 依赖，
  那一步要联网 —— 在 turbo 的净化环境里会卡成 `Request failed after 3 retries`。
  代价是要先跑过一次 `uv sync --group dev`
- **`turbo.json` 里 `test` 必须 `cache: false`** —— 测试打真实数据库，
  缓存住「上次通过了」毫无意义

### 写测试时：`UPLOAD_DIR` 必须顶到 tmp

`UPLOAD_DIR` 是在各模块顶层 `from ... import UPLOAD_DIR` 进来的，
改 `path_conf` 上那一个**没用** —— 必须逐个模块 monkeypatch
（`utils.file_ops` 和 `service.file_service` 各一份，见 `test_file.py` 的
`isolated_upload_dir`）。漏掉哪个，那条路径就会读写开发环境真实的 `backend/upload/`。

### 🔴 手搓的 ZIP/docx 测试夹具，逐字节比较前先固定 `date_time`

`test_file.py: _docx_bytes()` 用 `zipfile.ZipFile.writestr(name, data)` 传纯
字符串文件名——内部会拿 `time.localtime()` 把**当前时刻**的 DOS 时间戳
（2 秒精度）写进 local file header。`test_download_inline_and_attachment`
拿它生成两次（一次上传、一次比对）做 `inline.content == _docx_bytes()`
逐字节比较，两次调用只要跨过这个 2 秒边界，固定字节位置就会错开一位——
偶发红，CI 上实测抓到过一次：`At index 10 diff: b'#' != b'$'`，正是那个
mod-time 字段。本地几乎复现不了（两次调用间隔通常远小于 2 秒），只有 CI
偶尔卡在边界上才会红，看起来像随机抽风。
修法：改传 `zipfile.ZipInfo(name, date_time=固定值)`，与调用时刻无关。
同类坑：任何拿标准库时间戳字段做逐字节/逐值比较的测试夹具（ZIP、tar、
某些序列化格式），生成两次要么固定时间戳，要么比较时排除掉那个字段。

### 种子数据里那批 `3000000000000000xxx` 开头的 ID，是公开演示专门加的

`sql/sqlserver/init_snowflake_test_data.sql` 原来只有 1 个部门 + 1 个角色 + 2 个
账号（admin/test），是纯粹的"能跑测试就行"的最小集合。为了公开演示时组织
架构看着像回事，补了一批部门/角色/账号，全部是**纯新增 INSERT**，没有改
admin/test 的 ID、密码或者角色绑定，前后端所有测试用的还是同一个
`admin`/`test`（这两个用户名本身不能改——`test_prod_config.py:
test_init_handles_every_seeded_account` 硬编码断言 `cli.py: _set_admin_password`
处理这两个名字）。

- ID 故意用 `3000000000000000001` 起步的一段独立区间，跟原来 `2048...`/`2049...`
  开头的雪花 ID 肉眼就能分清，不会误以为是同一批
- 8 个新账号（张伟/李娜/王芳/刘洋/陈静/赵磊/孙强/周敏）密码都是种子密码 `123456`，
  **故意永远不重置**——公开演示要的就是"随便挑一个账号登录切换视角"。
  🔴 这批账号的 hash 要补进的是 `password_security.py: SEEDED_DEMO_PASSWORD_HASHES`，
  **不是** `SEEDED_PASSWORD_HASHES`——两份集合语义相反：后者是
  `registrar.py: _verify_production_database()` 拿去扫全库、命中就拒绝启动的
  名单（给 admin/test 这类"必须在 prod 前改掉"的账号用），前者才是"永远保持
  默认密码也没关系"的公开演示账号。**实测事故**：这两份集合曾经合并成一份，
  往生产库同步完这 8 个演示账号后重启 `api` 容器——启动检查一查到它们就拒绝
  启动，容器连续崩溃重启 12 次，`web`/`beat` 因为 `depends_on: api: condition:
  service_healthy` 一直等不到健康的 `api`，卡在 `Created` 没起来，公开演示站点
  整个 502。应急止血是把这 8 个账号的密码用新随机盐重新哈希一遍（明文照旧
  `123456`，只是不再和 `SEEDED_PASSWORD_HASHES` 里那个写死的字面量相等），
  正式修复是拆成两份集合，把 `_verify_production_database()` 的查询钉死在
  只读 `SEEDED_PASSWORD_HASHES`。`test_seeded_password_hashes_cover_every_seeded_account`
  会自动扫 `sql/` 下所有 `init_*.sql` 里的 bcrypt hash，对着**两份集合的并集**
  做覆盖面对账——加新演示账号时补进 `SEEDED_DEMO_PASSWORD_HASHES`，
  加新的"必须改密码"账号才补进 `SEEDED_PASSWORD_HASHES`，别补错集合
- 部门编码从 `TEST` 改成了 `HQ`（"总部"）——`sys_data_rule` 里有一条
  "部门编码等于 xxx" 的规则字面量引用着这个编码（`Dept.code = 'HQ'`），
  改编码的同时要同步改这条规则的 `[value]`，两边不同步的话数据权限演示会
  静默失效（规则匹配不到任何行，等价于清空这条过滤，不会报错）
- 角色编码从 `TEST` 改成了 `STAFF`（"普通员工"），新增 `MANAGER`/`FINANCE_STAFF`/
  `VIEWER` 三个角色，分别挂了 `部门及以下`/`本部门`/`仅本人` 三档数据范围——
  凑够这三种能在数据权限页面演示出可见的差异，不是随便起的名字
- 种子 SQL 文件里**不能加解释性的独立注释块**（`--` 开头的裸注释会被
  `sql_parser.py` 的白名单校验直接判成非法语句，见「跑测试」一节踩过的坑），
  上面这些"为什么"只能写在这里，不能写进 SQL 文件本身
- 🔴 **三个方言各自一份文件，靠人工保持同步——没有任何机器校验三份内容对得上。**
  这批"公开演示"数据最早只加进了 `sql/sqlserver/`，`mysql/`、`postgresql/`
  两份原地放了半年多还是最初那个 1 部门 + 1 角色 + 2 账号的最小种子，没人发现，
  因为两条守卫（`test_seeded_password_hashes_cover_every_seeded_account` /
  `test_model_matches_migrations`）都不比较"三份种子内容是否一致"，只比较
  "种子里出现的 hash 在不在白名单里"——三份缺两份一样能全绿。
  这台生产机跑的是 PostgreSQL，公开演示上线之后组织架构一直是那个最小种子，
  直到有人发现"看着不像回事"才补的。2026-08-26 已把 `mysql`/`postgresql`
  两份补齐到跟 `sqlserver` 同样的内容（部门/角色/账号语义一致，
  ID 各方言自己独立一套——`mysql` 恰好和 `sqlserver` 本来就共用同一批 ID，
  直接照抄；`postgresql` 的基础种子（admin/test/部门/角色）本来就是另一套 ID，
  改名复用 + 新增部分另起一段 `4000000000000000xxx` 区间）。
  **以后改这批演示数据，三份 `init_snowflake_test_data.sql` 一起改，
  改完跑一遍 `test_seeded_password_hashes_cover_every_seeded_account`
  只能保证 hash 有登记，保证不了三份"部门/角色长得一样"，这条得靠人记。**

### 有测试的部分 / 没测试的部分

| | 状态 |
|---|---|
| 文件模块接口（上传 · 去重 · 穿越 · 日期目录 · 列表 · 统计 · 下载 · 附件 · 删除） | `test_file.py` 23 条 |
| 数据权限（表达式矩阵 · 组合语义 · fail-open · 模板变量 · 覆盖面 · 缓存失效） | `test_data_permission.py` 27 条 / 22 个账号 |
| `/auth/logout` | 上游留下的 1 条 |
| **其余所有模块** | **没有测试** |
| **前端** | Playwright E2E 3 条种子用例（登录 · 部门 CRUD · 多页签保活），见下节 |

> `test_file.py` 里两条标了 🔴 的是**回归测试**，对应两个真出现过的 bug
> （去重丢文件名 · 列表缺 `download_url`）。做过变异验证：把修复分别打回去，
> 对应的测试会失败 —— 它们不是摆设。
