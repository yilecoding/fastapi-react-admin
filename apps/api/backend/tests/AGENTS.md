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

### ⚠️ conftest 的 fixture 只对**它所在目录树**可见

`temp_user` 一开始放在 `api_v1/` 自己的 conftest 里，`security/` 下的
测试立刻 `fixture 'temp_user' not found`。两边都要用的东西放**共同父目录**
（现在在 `app/admin/tests/conftest.py`）。

### 缓存失效：每个入口都要单独测，共用的 manager 证明不了接线

`user_cache_manager.clear_*` 清的是 `fba:user:{id}` —— JWT 鉴权用的用户快照，
而它装着 `roles[].menus[]` 和 `roles[].scopes[].rules[]`
（`GetUserInfoWithRelationDetail`）。**不清的后果不是报错，是权限改了不生效**，
最长一天（`TOKEN_EXPIRE_SECONDS`）：

| 忘了清 | 用户看到的 |
|---|---|
| 菜单变更 | 收回的按钮**还能继续点** |
| 数据规则变更 | 收窄了数据范围，**还能看到本该看不到的行** |

`security/test_user_cache_invalidation.py` 现在覆盖五个入口（改角色菜单 ·
登出 · 改部门 · **改菜单** · **改数据规则**）。单测 `UserCacheManager` 证明不了
这些 —— mock 不会漏接，但**接口层可能忘了把 `background_tasks` 一路传下去**，
所以每个入口都要走真实请求。

写这类测试的两条：

- 🔴 **先把快照焐热**（打一个认证接口并断言 key 在），否则「被清掉」和
  「本来就没有」分不开
- ⚠️ **受害者要选对**。数据范围在种子里绑的是 MANAGER / FINANCE_STAFF /
  VIEWER，**不是 ADMIN**（超管绕过数据权限）—— 拿 admin 当受害者的话，
  改数据规则根本不会碰它的快照，测试会**永远绿**。要造一个真的落在那条链上的
  用户（临时用户 → 加进 MANAGER → 用它自己登录焐热）

### 🔴 断言「没有」之前，先断言「有」

**一条永远绿的测试比没有测试更糟** —— 它在覆盖率里是正数，在保护上是零。
这个仓库里最容易造出它的形态就是：**只断言一个「不存在 / 空 / 0 条」**，
而那个状态在「被测的操作压根没生效」时也成立。

实测抓到两条（用「让所有写入静默回滚」的突变扫出来的）：

| 测试 | 为什么永远绿 |
|---|---|
| `test_assigning_an_empty_scope_list_is_not_a_failure` | fixture 挑的角色是 **STAFF**（`/sys/roles/all` 按 id 排序，第一个非 ADMIN），而它**本来就没有数据范围** —— 「清空后是空」在接口什么都不做时也成立 |
| `test_soft_delete_hides_from_list` | 建了再删，然后断言列表 0 条 —— 而**创建静默失败**时列表也是 0 条 |

修法都是加一句前置断言：先绑上/先确认在列表里，再断言它没了。

⚠️ 这条原则在 `security/test_user_cache_invalidation.py` 里早就写对了
（「先把快照焐热，否则『被清掉』和『本来就没有』分不开」）——
**它不只对 Redis 成立**，对数据库、对列表、对任何「断言缺失」都成立。

### prod 启动检查：两个函数，两批问题，都要测「拦得住」和「放得过」

prod 启动路径上有**两个**检查，缺一个的后果都是「带着问题正常启动」：

| 函数 | 查什么 | 补之前的覆盖 |
|---|---|---|
| `check_production_settings`（`core/conf.py`） | 配置（密钥强度、占位符…） | 17 条 |
| `_verify_production_database`（`core/registrar.py`） | 数据库（迁移版本、种子密码） | **0 条** |

第二个此前零覆盖 —— 实测把它末尾那句 `if problems:` 改成 `if False`（永不拦），
全套 266 条**一条都不红**。而它整个存在的理由就是「启动即失败」。

补了两条，各盯一个方向（都做过反向验证）：

- **拦得住**：库里还有账号用种子密码（123456）→ 必须抛。测试库正好就是那个
  状态，所以不用造数据 —— 它测的就是「这种库不许上生产」
- **放得过**：把那些密码改掉 → 必须不抛。只验前者的话，一个**永远抛**的实现
  也是绿的，而那种实现会让任何生产环境都起不来、还报一条看起来很正当的错

⚠️ 这条测试会**改真库**，两个讲究：

- 换会话（`registrar.async_db_session` 连的是开发库 fba，不换就是拿开发库
  的数据判定）+ 每次独立引擎（复用模块级的会撞事件循环）
- **逐个用户记下原值再改，不能拿 `SEEDED_PASSWORD_HASHES` 集合回写** ——
  那是个集合，两个账号的 hash 万一不同，循环回写会把它们设成同一个值，
  而测试照旧绿（登录只验 hash 对不对，不验「是不是原来那一个」）。
  还原放 `finally`，不放测试体末尾 —— 中途红了不还原的话，后面所有
  用 admin 登录的测试**跨轮**全部 403

### 🔴 「第二道防线」要靠**打桩掉第一道**来测

防御纵深有个天然的测试盲区：第一道防线让第二道永远到不了，于是第二道
**一行覆盖都没有**，而注释还写着「两道防线是刻意的」。

实测样本：`upload_file` 里那句
`target.resolve().is_relative_to(root.resolve())`，注释自己写着
「这一条挡的是『将来有人改了 `build_filename`』」。把它改成 `if False`，
全套 265 条**一条都不红** —— 因为 `build_filename` 已经把路径成分剥干净了
（第一道，由 `test_upload_strips_path_traversal` 盯着）。

唯一的测法就是**模拟第一道失守**：`monkeypatch.setattr(file_ops,
'build_filename', lambda file: '../../../../escaped.png')`，然后断言
`upload_file` 抛错、且越界位置没有文件。

⚠️ 两个实测出来的讲究：

- **打桩要打模块属性**（`file_ops.build_filename`），不是 import 进来的引用 ——
  `upload_file` 是在同模块里直接调它的
- **`../` 要给足四层。** 落点是 `root/<Y>/<m>/<d>/<name>`，日期目录那三层会
  **吸收掉三个 `../`**，`../../escaped.png` 解析完还在 root 里、检查不该拦、
  也确实没拦（第一版就是两层，测试报 `DID NOT RAISE`）。
  载荷长度是跟着 `build_date_dir()` 的层数走的

判据：**看到「兜底」「第二道防线」「将来有人改了 X 的时候」这类注释，
先问一句「它现在有测试吗」。** 大概率没有 —— 因为写它的人正是因为
「正常路径到不了」才把它叫做兜底。

### 怎么找出永远绿的测试：让写入静默回滚

比逐条读测试便宜得多的办法 —— 临时把 `backend/tests/utils/db.py` 的
`override_get_db_transaction` 改成不提交：

```python
async with async_test_db_session() as session:   # 原本是 .begin()
    yield session
    await session.rollback()
```

写入全部无效、响应照旧成功，然后看**哪些发了写请求的测试仍然通过**。
用 `--junit-xml` 拿逐条结果，再和「函数体里有 `client.put/post/delete`」交叉比对。

⚠️ **存活不等于弱。** 实测 58 条发写请求的测试里有 28 条存活，但大部分是合法的：

| 合法存活 | 为什么 |
|---|---|
| 断言「被拒绝」的（非法扩展名 · 空串 avatar · 拼错的时区 · 不存在的 pk） | 回滚不改变一次拒绝 |
| 断言 Redis 状态的（登出 · 缓存失效） | 效果不在数据库里 |
| 断言响应内容的（上传返回的分类 / 去重结果） | 测的是响应契约，不是持久化 |

**要看的是「写完读回来验证」那一类** —— 它们存活就说明读回来的断言太弱。

⚠️ 收尾必须还原 `db.py` 并清残留：突变期间失败的 teardown 会留下 live 行
（实测留下过一个 `pytest_tmp_writes`，下次运行直接 `409 用户名已注册`）。

### 线上格式的两条纪律现在有专门的守卫

`backend/tests/test_wire_format.py`：从 OpenAPI **枚举**所有无参 GET 端点
（44 个），一次遍历、递归走 JSON，两条断言：

| 断言 | 纪律 | 补之前的覆盖 |
|---|---|---|
| 不存在超出 `2^53-1` 的裸整数 | 硬纪律 6（ID 一律字符串） | 只有 `test_file.py` **2 条**顺带罩着 |
| 每个时间串都带 `Z` 或 `±HH:MM` | 时间必须带时区标记 | **零** |

两条都是拿突变体量出来的，不是推的：

- 把 `stringify_unsafe_ints` 改成 `return obj`（大整数原样下发）→ 全套 261 条里
  只有 2 条红，而它们红是因为恰好 `assert isinstance(data['id'], str)`，
  不是在测这件事。那两条断言一改，全仓引用最多的那条硬纪律就没人看着了。
- 给 `SchemaBase` 加一个把时间格式化成 `'%Y-%m-%d %H:%M:%S'` 的序列化器
  （正是 `common/schema.py` 那段长注释在拦的事）→ 全套 **262 条一条都不红**。
  **注释拦不住代码。**

⚠️ 端点是枚举的，新加只读接口自动罩上，不用改清单。遍历提成 module 级
fixture 共用 —— 拆成两个文件就要把 44 个请求打两遍。

它同时示范了「先断言『有』」：除了两条「没有」，还断言**扫到的端点数 ≥ 30**、
**见到的雪花字符串 ≥ 20**、**见到的时间串 ≥ 100** —— 否则库空了、
或者枚举挑不出端点时，这条测试会以「什么都没扫到」的方式假绿。

### 🔴 「过滤器」的测试：断言的结果必须和「过滤器完全失效」不一样

数据权限这类过滤器的假绿有个固定形状：**「不过滤」的结果是「全可见」，
而很多规则本来就匹配全部行** —— 于是「规则生效」和「规则压根没生效」
落在同一个断言上，测试永远绿。

实测样本：`test_all_model_rule_applies_when_column_exists`（名字就写着「才真正
生效」）断言 `__ALL__ + status == 1` 的账号看得到全部 5 个部门。但图里的部门
**全都是 `status=1`** —— 把 `__ALL__` 规则改成永不生效（`target_models = []`），
这条照旧绿。27 条数据权限测试里只有 1 条发现了那个突变。

修法是加一个**匹配 0 行**的对照账号：`__ALL__ + status == 0`（图里没有停用部门）。
规则不生效 → 全可见；生效 → 全不可见，两个结果相反，才区分得开。
补完再跑一遍那个突变，从 1 红变 2 红。

判据：**写完一条过滤器的测试，先问「把过滤器整个拆掉，这条会红吗」。**
不确定就真去拆一次 —— 拆的方法见下面那节。

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

### 🔴 清理不能写在测试体最后一行 —— 断言一红它就跑不到

文件模块的测试自我中毒过一次，链条值得记全：

1. 清理写在测试体末尾：`client.request('DELETE', FILES, ..., {'pks': [data['id']]})`
2. 一次突变实验让 `test_upload_document` 在中间某句断言红了 → 那行 DELETE 没跑
3. 漏下一条**存活**的 `sys_file` 行
4. 文件模块按 **sha256 去重** → 之后**每次**跑都命中去重分支、不写盘
5. 于是每轮都红在 `assert (isolated_upload_dir / today / name).is_file()` 上

第 5 步那个症状和真正的原因**毫无关系**（看起来像日期目录不对、像时区问题 ——
当时正好跨了午夜，我第一反应就是去查 UTC/本地时差）。真相是隔离目录压根是空的。

而且它**同一轮里就会级联**：实测人为让上传测试中途红，结果是 **2 failed** ——
第二条（`test_check_by_sha256`）红的原因和自己无关，是红鲱鱼。

两层修法，各治一种：

| 修法 | 治什么 |
|---|---|
| 每条测试收尾扫一遍存活行（autouse，走接口，逻辑删除够了） | **轮内**级联 |
| 模块收尾硬清 `sys_file` + `sys_file_relation` | **跨轮**中毒 + 软删除堆积 |

实测：清空前测试库里堆了 **1029 行**、14 种夹具文件名、47 轮的量，
而这些一直不影响测试绿 —— 唯一的现象就是上面那条中毒。

判据：**凡是「建了东西」的测试，清理一律进 fixture 的 teardown 或 `finally`，
不要放在测试体最后一行。** fixture teardown 断言红了照样跑，测试体最后一行不会。
去重键、唯一约束这类「存量会改变行为」的模块尤其致命。

⚠️ autouse 的清理 fixture 要留意它依赖的东西的作用域：`client` 是 session 级、
`token_headers` 是 module 级，所以挂 autouse 不会让每条测试重新登录
（写成 function 级就是每条测试打一次登录接口，而登录是有限流的）。

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
