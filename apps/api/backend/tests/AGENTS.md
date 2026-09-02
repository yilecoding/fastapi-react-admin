# apps/api/backend/tests —— 跑后端测试

> 这份文件是 [`apps/api` 分册](../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载它。

⚠️ 测试**不只在这个目录**：`app/admin/tests/` · `app/task/tests/` ·`plugin/*/tests/` 各有一批。这里记的是「怎么跑」和跑不起来时的判据。

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

### 接口覆盖：跑完整套 pytest 会打印真值

```
===== 接口覆盖 =====
64/137（47%）—— 按测试真正发出的请求算
没被任何测试请求打到的接口：
  DELETE /api/v1/logs/login/all
  ...
```

机制在 `conftest.py`：包一层 `TestClient.request` 记下每个实际请求，
收尾拿 FastAPI 自己的路由表匹配。

🔴 **别用 grep 测试文件里的路径字面量来算这个数。** 试过，两个方向都不可信：

| 判据 | 得到 | 错在哪 |
|---|---|---|
| 只认整条路径字面量 | 55% | **漏判** —— 测试常把路径存成常量再拼（`NOTIFICATIONS = '/sys/notifications'`），字面量永远不出现 |
| 路径每一段都在测试里出现过 | 91% | **误判** —— `sys` / `users` / `permissions` 各自到处都有，碰巧全中就算覆盖 |
| **真记请求** | **47%** | —— |

两个错的数字都足够像结论，会被直接引用（我就引用过 55%）。

⚠️ **报告只在跑整套时出现。** `pytest -k foo` 或指定文件时不打 —— 那时
「没打到」不等于「没测试」，报出来就是谎报一片空缺。判断用的是
`config.invocation_params.args`（真实命令行），**不是 `config.args`** ——
后者被 `pyproject.toml` 的 `testpaths` 填满了四个目录，拿它判断会把整套也
误判成局部，于是报告永远不出现（实测：全绿但一个字都不打）。

⚠️ 输出用 `pytest_terminal_summary`，**不是 `pytest_sessionfinish`** ——
后者里的 `print` 会被 pytest 的输出捕获吞掉（同样实测踩过）。

**47% 是个诚实但不好看的数字**：73 条接口从没收到过一个请求（38 GET · 14
DELETE · 13 PUT · 8 POST）。写入型里最危险的几条已经补了
（`api_v1/test_admin_writes.py`），剩下的按「改错了会不会静默」排优先级，
别为了刷数字去覆盖只读接口。

### 🔴 测试里**不要 `asyncio.run()`** —— 它会关掉共享 Redis 绑的那个循环

想直接调一个 `async` 的 service 函数时很自然会写
`asyncio.run(load_user_security_config(session))`。它**能跑**，但那个循环一关，
共享的 `redis_client`（JWT 解析、`@cached` 都用它）就跟着废了 ——
之后同一 session 里的请求全是 `JWT 授权异常：Event loop is closed`。

**一个测试把后面的测试弄坏了，而全套还是绿的**（靠运行顺序侥幸）。实测踩到：
`test_dynamic_config.py` 第一版就是这么写的，teardown 里那次还原请求当场炸。

修法是**经真实 HTTP 请求触发**那段逻辑（顺带更贴近真实故障）。查「谁会调它」
比自己起循环便宜：

| 想触发 | 打哪个接口 |
|---|---|
| `load_user_security_config` | 任何改密码的接口（走 `password_security.py`） |
| `load_login_config` | `GET /auth/captcha` 或登录 |

⚠️ 只有**真的拿不到 HTTP 入口**时才起独立引擎，而且那时也只碰数据库、
别碰 Redis（见上一节 `temp_user` 的硬删）。

### ⚠️ 还原用的基线可能已经被上一次运行污染了

`test_dynamic_config.py` 的 fixture 把基线值**写死在文件里**，不读「测试开始时
库里的值」。因为后者踩过：一次突变验证让库里留下 `'not-a-number'`，而那个脏值
使**任何加载安全配置的请求都 500，包括 teardown 里那次还原请求本身** ——
当时没断言还原的返回，于是它静默失败，之后每次运行读到的「基线」都是脏值，
再原样写回去。脏值就永久留在 `fba_test` 里了。

那正是被测的那个故障本身：**改坏它的管理员自己也修不回来。**

两条都要做：**基线写死** + **断言还原成功**。

### 🔴 测试里建了数据，收尾必须**硬删** —— 接口的 delete 是逻辑删除

`DELETE /sys/users/{pk}` 这类接口走的是 `LogicalDeleteMixin`：把 `deleted` 从 0
改成**行自己的 id**（`0：否；id：是`），行永久留在表里。

所以「建临时数据 → 用接口删掉」这个套路会**每跑一次 pytest 就往 `fba_test` 里
堆几行**，而且没有任何现象（测试照样绿）。实测跑了几轮就积了 11 行，其中 1 行
还是 **live** 的（`deleted = 0`）—— 那是一次 teardown 自己崩掉留下的，
而它会让下一次运行直接 `409 用户名已注册`，报错完全看不出跟残留有关。

收尾直连库 `DELETE`，并连带关联行（`sys_user_role` 之类），否则留下孤儿。

⚠️ **不能复用共享的 `async_test_db_session`** —— 它已经被 `conftest.py` 的依赖
覆盖绑到 TestClient 自己的事件循环上了，在 `asyncio.run()` 里用会
`attached to a different loop`。每次新建一个独立引擎
（`create_database_async_engine(get_database_url(unittest=True))`），
和 `security/test_user_cache_invalidation.py` 是同一个套路。
范例见 `api_v1/test_admin_writes.py` 的 `temp_user` fixture。

### ⚠️ `count > 0 ? success() : fail()` 这个形状，else 分支不一定走得到

handler 里到处是这个形状，很容易一看到就断言「这里会静默失败」。**要看 service
有没有先做检查**：

| 接口 | else 分支能到吗 |
|---|---|
| `PUT /sys/users/{pk}/password` | **到不了** —— `reset_password` 拿不到用户时先抛 `NotFoundError`，实测返回 **404** 而不是「200 + code 400」 |
| `PUT /sys/users/me/nickname` | 看方言 —— SQL Server / PostgreSQL 的 rowcount 数**匹配**行，设同值也是 1；MySQL 数**变更**行才会是 0（见 `api_v1/test_me_envelope.py`） |

结论不是「信封判定没必要」—— `fail()` 在别处是真会发生的，客户端只看 `!res.ok`
依然是错的。结论是**别拿这个形状当「此处会静默失败」的证据**，要么读 service，
要么写一条测试。

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
  `sql_parser.py` 的白名单校验直接判成非法语句 —— 那个校验只认它列出的
  语句形状，裸注释不在其中），
  上面这些"为什么"只能写在这里，不能写进 SQL 文件本身
- 🔴 **三个方言各自一份文件，靠人工保持同步。** 现在有守卫了 ——
`test_seed_dialects.py` 比三份的**每张表行数**和**列清单**
（4 条，突变验证过：只给一份加一行 / 加一列都会红）。

⚠️ 它**不比 ID 也不比具体值**。三个方言的 ID 段是刻意不同的
（postgresql 的角色在 `4000000000000000xxx`、另两个在 `3000000000000000xxx`），
比 ID 会永远红；比值要一个真正的 SQL 解析器，而行数 + 列清单已经能抓住
**唯一真正发生过的**那种漂移形态：一份加了行/列、另两份没加。

⚠️ 异类是**按多数判定**的，不拿固定某一份当基准 —— 否则被改坏的恰好是基准时，
提示会反过来指着另外两份，把人带向错误的文件。
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
