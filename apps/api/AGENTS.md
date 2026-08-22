# apps/api —— FBA fork（SQL Server 适配）

> 三层 `api/v1 → service → crud`。上游拒绝合并 SQL Server 支持，永久分叉。
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
  ⚠️ `/static/upload` 是**无鉴权**静态挂载 —— 上传物对任何人可读，
  只靠文件名不可猜兜着。要真正的访问控制得改成带鉴权的下载接口

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

## 跑测试

```bash
pnpm test                     # = turbo test → apps/api 的 pytest
cd apps/api && uv run pytest backend/app/admin/tests/api_v1/test_file.py -q
```

**测试跑在独立的 `fba_test` 库上**（`backend/conftest.py` 覆盖了 `get_db`），
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

### 有测试的部分 / 没测试的部分

| | 状态 |
|---|---|
| 文件模块接口（上传 · 去重 · 穿越 · 日期目录 · 列表 · 统计 · 下载 · 附件 · 删除） | `test_file.py` 23 条 |
| `/auth/logout` | 上游留下的 1 条 |
| **其余所有模块** | **没有测试** |
| **前端** | Playwright E2E 3 条种子用例（登录 · 部门 CRUD · 多页签保活），见下节 |

> `test_file.py` 里两条标了 🔴 的是**回归测试**，对应两个真出现过的 bug
> （去重丢文件名 · 列表缺 `download_url`）。做过变异验证：把修复分别打回去，
> 对应的测试会失败 —— 它们不是摆设。
