# apps/api/backend/alembic —— 数据库迁移

> 这份文件是[根 `CLAUDE.md`](../../../../CLAUDE.md) 的**模块分册**，Claude Code 读到本目录下的文件时才加载它。
> 硬纪律那一句（**改了模型就要生成迁移，没有例外**）留在根文件里，因为它约束的是所有人；这里是理由、坑和守卫。

**改了模型就要生成迁移，没有例外。** 手写 `ALTER` / `drop_all` 重建那条路已经关了。

```bash
pnpm db:current                        # 现在在哪个版本
pnpm db:revision '加 xxx 列'            # 改完模型，生成迁移（--autogenerate）
                                       # ⚠️ 生成的文件**要读一遍再提交**
pnpm db:upgrade                        # 升到 head
pnpm db:history                        # 看链条
```

### 为什么改这条

之前是「改模型 + 手工 ALTER」，两步之间**没有任何东西对账**。少做一步的后果
都是静默的：本机开发库手工改过（能跑），全新环境按模型建出来缺那一列，
要到部署时才炸；或者反过来，模型声明了索引、库上没建，功能全对只是全表扫。

**已有环境**不需要重建：`alembic stamp b0000000baseline` 认领起点，再 `db:upgrade`。

**全新环境**走 `fba init`（`drop_all` + `create_all` + 灌种子），它建完表会
**自动 `alembic stamp head`** —— 表是从当前模型建的，本来就是最新结构，
stamp 只是把这件事声明出来。

> 🔴 **`create_all` 建的库不自带 `alembic_version`** —— 那张表不在
> `MappedBase.metadata` 里。漏掉 stamp 的失败是**延迟且静默**的：库照常能用，
> 直到第 4 条迁移出现，`db:upgrade` 从 base 把前 3 条重跑一遍。
> 现在这 3 条碰巧无害（基线是空的、`c0000000comments` 全程 suppress、
> `d0000000usertz` 有 `_has_column()` 早退），所以这个坑到目前为止**看不出来** ——
> 下一条普通的 `add_column` 就会在部署时炸。
>
> ⚠️ prod 下应用**不再自己建表**：`core/registrar.py` 的 lifespan 改成校验
> `alembic_version` 在不在 head，不在就拒绝启动。开发环境保留 `create_all` 的便利。

### 三条纪律

- 🔴 **基线（`b0000000baseline`）刻意是空的。** 它只标记「起点」，不含建表 DDL——
  把 23 张表的 DDL 写进去就有了两份真相，改模型忘了改它就静默偏离。
  唯一一份真相仍然在模型里，基线之后每次改动一份增量
- 🔴 **`env.py` 必须 `import backend.main`。** `MappedBase.metadata` 只有在模型
  被 import 之后才有内容。原来只 import 了 `MappedBase` 本身 —— metadata 是空的，
  autogenerate 拿「空 metadata」和「有 23 张表的库」做 diff，会安静地写出一份
  **「drop 掉全部 23 张表」**的迁移，而它不会问你
- ⚠️ **「补齐历史遗留」类的迁移必须幂等。** 新建的库天然就是目标状态：
  `c0000000comments` 在老库上要改注释，在刚 `create_all` 出来的库上再执行会报
  `Property 'MS_Description' already exists` —— alembic 在 mssql 上把
  `alter_column(comment=)` 编译成 add 而不是 update。写这类迁移先问
  「新库跑这一步会怎样」

### 守卫（`app/task/tests/test_migrations.py`）

| 测试 | 挡什么 |
|---|---|
| `test_model_matches_migrations` | **改了模型但没生成迁移** —— 这条是整套约定的支点 |
| `test_single_head` | 两个人各自 revision 导致分叉，`upgrade head` 谁都升不了 |
| `test_every_revision_is_reachable_from_base` | 断链的迁移永远不会执行 |
| `test_fresh_database_is_stamped_at_head` | **新建的库没 stamp** —— 将来 `upgrade head` 会把已有迁移重跑一遍 |

⚠️ 这些比对的是 **fba_test**，所以本地跑测试前它要在 head 上
（`pnpm --filter api test:db` 会重建并自动 stamp）。

> 🔴 第 4 条上线时当场抓到一个已经存在很久的 bug：`reset_test_db._stamp_head`
> 一直在 stamp **开发库**而不是测试库。它靠设 `os.environ['DATABASE_SCHEMA']` 切库，
> 但 `settings` 是模块级缓存单例、import 期就构造好了，进程内改 environ 影响不到它；
> 就算改对了也没用，因为 `alembic/env.py` 会**无条件覆盖** `sqlalchemy.url`。
> 两个库都有 `alembic_version` 表、看起来都正常，所以没有任何现象。
> 现在 env.py 改成「调用方设过就不覆盖」，`_stamp_head` 显式写目标库。

## 种子的一致性有两维，行数/列清单只是其中一维

`tests/test_seed_dialects.py` 原来查四件事：三份文件都在 · 表相同 ·
**行数**相同 · **列清单**相同。漂过的那一维是行数，所以先补了它。

🔴 **但行数和列一致不代表引用对得上**：行还在、只是指向了一个不存在的 ID。
表现是那个方言初始化之后「演示角色一个菜单都没有」/「数据范围没绑上」——
界面上是空的、日志里什么都没有，而另外两个方言完全正常。

这一维特别容易漂，因为**三份种子的 ID 本来就不一样**（实测：postgresql 的
角色在 `4000000000000000xxx`、另两个在 `3000000000000000xxx`）。改一份里的
角色 ID 而忘了改同一份里的 `sys_role_menu`，就是这个 bug。
现在 `test_link_tables_reference_ids_that_exist` 按方言逐份核对，
反向验证过（只在 postgresql 里造一个悬空引用 → 只有那一条红）。

### 写这条测试时连撞了三次解析问题，都记下来

**都是「解析器坏了」，不是「数据坏了」** —— 而识别它的信号是**对称性**：

1. 第一版自己写正则切行切列 → postgresql / sqlserver 报「`sys_user` 没有行」。
   真因是 `CONVERT(varchar(36), NEWID())` 这种**嵌套括号带逗号**、
   `N'...'`、`0x2432...` 十六进制字面量把切分搞乱了
2. 改成「只收长数字做集合运算」→ 三个方言**一起**报同样的悬空引用。
   真因是关联表**自己也有 `id` 列**（`(id, role_id, menu_id)`），
   它们自己的主键被当成了引用
3. 判据：**三份一起坏成同一个样子 = 你的解析器坏了。** 因为行数一致性那条
   测试是过的 —— 数据不可能三份同时漂成一致

所以这条测试里加了「先断言有」：主键数 ≥ 100 · 四张关联表都找到 ·
核对的引用数 ≥ 20。解析器一坏就什么都扫不到，而「没有悬空引用」会照旧通过。

## `alembic.ini` 要写 `path_separator = os`

不写的话每次加载配置都打一条 DeprecationWarning：「No path_separator found in
configuration; falling back to legacy splitting on spaces, commas, and colons」。
补上之后全套 pytest 的警告从 5 条降到 2 条（`test_migrations.py` 一直在报它）。

⚠️ **不只是消警告。** legacy 切分是按**空格 / 逗号 / 冒号**切 `prepend_sys_path`
的 —— 现在那个值只有 `..` 一项，怎么切都一样；但哪天有人加第二个路径，
或者仓库被 clone 到一个**路径带空格**的目录下，它会静默切错，
表现是 `env.py` 里 `from backend...` 突然 ImportError，而配置文件看着没问题。
`os` = 用 `os.pathsep`（Linux 上是 `:`）。

## 后端侧要记的

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

### 🔴 迁移建表时雪花主键会变成 IDENTITY —— 那张表在生产里一行都写不进去

`sys_notification` 是本仓库**第一张真正由迁移创建**的表（基线是空的，之前所有表
都是 `create_all` 建的），一建出来就踩到：

**症状**：任何 INSERT 报 `Cannot insert explicit value for identity column in table
'sys_notification' when IDENTITY_INSERT is set to OFF. (544)`。

**根因**：模型侧的 `id_key` 靠 `default=snowflake.generate`（**Python 侧**默认值）
让 SQLAlchemy 的 `autoincrement='auto'` 判定为「不是自增列」。而 **alembic
autogenerate 渲染不出 Python 侧的 `default=`** —— 它写出来的是一句朴素的
`sa.Column('id', sa.BigInteger(), nullable=False)`，重新命中 auto 规则，
在 mssql 上建成 IDENTITY。于是同一份模型，`create_all` 建的表和迁移建的表
**结构不一样**。

**为什么守卫抓不到**：`test_model_matches_migrations` 比的是「模型 vs fba_test」，
而 fba_test 是 `create_all` 建的 —— 两边都是「非 IDENTITY」，差集为空，全绿。
唯一能暴露它的是「用迁移建出来的库」，也就是**生产**
（prod 下 `core/registrar.py` 要求 alembic 在 head）。

**修法两层**：`common/model.py` 的 `id_key` 显式写 `autoincrement=False`
（`create_all` 行为不变，但 autogenerate 会把它渲染出来）；
新增守卫 `test_created_tables_declare_snowflake_pk_as_non_autoincrement`
静态扫 `alembic/versions/*.py` 里 `create_table` 的 id 列。
**手写迁移建新表时照样要自己写上那一行。**

### 🔴 `paging_data()` 返回的 items 是 **dict**，不是 ORM 实例

`paging_data()` 里那句 `paginated_data.model_dump()` 已经把 ORM 实例展开成 dict 了
（模型是 `MappedAsDataclass`，pydantic 的 dump 会照 dataclass 展开）。
分页之后想再加工一遍结果（比如站内通知要按 `sys_notification_read` 回填
`read_time`），按属性取 `item.id` 会直接
`'dict' object has no attribute 'id'` → 500。用 `item['id']`，
往 dict 里塞新键即可，FastAPI 那层照样按 response_model 校验得过。

### 🔴 改了种子 SQL，已存在的库不会跟上 —— 要补一条 data migration（issue #86）

schema 和种子数据走的是**两条完全不同的路**：

| | 谁执行 | 已存在的库会不会跟上 |
|---|---|---|
| schema | 部署时 `alembic upgrade head` | ✅ 会，且 `test_model_matches_migrations` 兜着「忘了生成迁移」 |
| **种子数据** | 只有 `fba init`（`drop_all` + `create_all` + 灌种子 + `stamp head`） | 🔴 **不会。** 没有版本号、没有「这批种子进过这个库吗」的记录 |

**漏过两次，两次都是真的用户可见回归**：`5c1d594` 加的三条 RBAC 权限锚点菜单从没进
生产库，而校验在部署那一刻就生效了 —— MANAGER 演示账号原本能看的部门树当场 403；
`256beae` 加的「每日问候」调度同理，功能部署了、从来没跑过。

**机制就是普通的 alembic revision**，只是 `upgrade()` 里不是 DDL 而是幂等 INSERT。
白拿三样：`alembic_version` 天然记录每个库跑到哪、部署已经在跑 `upgrade head`、
`fba init` 末尾的 `stamp head` 会把它标成已应用而**不执行**（新库的行来自种子 SQL，
不会插两遍）。helper 在 `backend/utils/data_migration.py`，样板见
`alembic/versions/*33ffb491b69f*.py`。

三条纪律：

- 🔴 **外键按业务键解析，不要硬编码 ID。** `sys_menu.name` / `sys_role.code` 这类键
  跨环境稳定；而三个方言的种子各有一套 ID（postgresql 的角色在 `4000000000000000xxx`、
  另两个在 `3000000000000000xxx`），生产库的 ID 又只在生产库里成立
- 🔴 **幂等靠业务键判存在，不要吃唯一约束冲突** —— 三种方言的冲突语法各不相同
  （`MERGE` / `ON CONFLICT` / `INSERT IGNORE`），写任一种都会在另外两种上炸
- 🔴 **不要在数据迁移里调 `snowflake.generate()`。** 它要读环境变量或去 Redis 抢节点号，
  而 `alembic upgrade` 是部署时一个独立的 `migrate` 容器 —— 把 Redis 变成它的前置依赖
  是个新耦合，失败时还报「雪花 ID 生成失败」，完全看不出跟数据迁移有关。
  有语义的行（菜单）**照抄种子里那个 ID**（三个方言的 `sys_menu` 是同一套，抄过来能让
  「升级上来的库」和「新建的库」收敛）；纯连接行（`sys_role_menu`）用
  `DATA_MIGRATION_PK_BASE` 那一段
- ⚠️ **不要重新灌整份种子** —— 会把别人在界面上改过的数据覆盖回去。只补「按业务键查不到」的行

守卫是 `test_seed_files_have_a_matching_data_migration_decision`：种子文件的 sha256
变了而 `backend/sql/seed_manifest.json` 没更新就红。它**证明不了**那条迁移真的插了
同样的行，只强迫你看一眼并做决定（和 `test_every_crud_class_declares_its_data_scope_stance`
同一个物种）。确认过之后 `pnpm --filter api seed:manifest --write` 更新清单。

⚠️ 清单覆盖**插件的 `sql/` 也算** —— `#81` 的消息中心菜单就是从插件那份漏掉的，
机制和漏法与基础种子一模一样。

🔴 **守卫只看得见清单建立那一刻之后的改动 —— 建基线会把当时已有的缺口一次性洗白。**
实测踩到：引进这份清单时（`33ffb491b69f`），`#83`（每日问候调度）的种子改动已经落地
且没有对应的数据迁移。清单一算，那次改动就被记成「已确认」，守卫此后再也看不见它、
而且是**绿的** —— 缺口比引进守卫之前更难发现，最后靠人肉对账才捞出来
（`677aa7aa0f73` 补的）。

所以 **`seed:manifest --write` 之前必须先确认当前种子与迁移链是一致的**。
在一个「已知落后」的状态上建基线，等于把缺口永久藏起来。
接手一个不确定的状态时，先按种子文件逐块对一遍库，别先跑 `--write`。
