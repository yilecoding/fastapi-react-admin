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
