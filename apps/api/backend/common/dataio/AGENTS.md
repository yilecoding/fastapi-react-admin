# backend/common/dataio —— 导入导出框架（#11 · v0.4）

> 这份文件是 [`backend/common` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。前端那一半见
> [`pages/_shared/data-io` 分册](../../../../../packages/platform/src/pages/_shared/data-io/AGENTS.md)。

每个资源**登记一份定义**，模板、预览、令牌、错误报告、后台生成、过期清理都在框架里：

| 文件 | 管什么 |
|---|---|
| `cells.py` | 单元格怎么写：公式注入、超长截断、非法字符、19 位 ID、时区 |
| `writers.py` | `XlsxSheetWriter`（openpyxl write-only）· `CsvSheetWriter`（UTF-8 BOM + CRLF） |
| `exporting.py` | `ExportSpec` / `ExportColumn` + 登记表 |
| `importing.py` | `ImportSpec` / `ImportColumn` / `ImportRow` + 登记表 + 三种模式 |
| `app/admin/service/export_service.py` | 发起 · 小批量当场生成 · 大批量投 Celery（`export.run`）· 下载 · 过期清理 |
| `app/admin/service/import_service.py` | 模板 · 预览 · 提交 · 错误报告 |
| `app/admin/dataio.py` · `plugin/*/dataio.py` | 各资源的定义（用户 / 部门 / 两种日志 · 字典 · 公告） |

## 加一个资源的导出

1. 在 `dataio.py` 里 `register_export(ExportSpec(...))`：**取数调列表接口用的那个 DAO 查询**
   （`get_select`），筛选模型继承 `_Filters`（`extra='forbid'`），字段名和列表接口的查询参数同名
2. 路由 `POST /xxx/export`，挂 `RequestPermission('xxx:export')` + `DependsRBAC`
3. 种子菜单加一个按钮（三个方言 + 插件的 `init*.sql`）+ 幂等的数据迁移 + `seed_manifest.json`
   —— 权限码三方对账（`test_permission_codes.py`）少一处就红
4. 列名、取值、资源名的翻译键进两个语言包的 `export.*`（`test_export.py` 遍历登记表逐个核对）
5. 前端 `<Can perm="xxx:export"><ExportButton path=… filters=… /></Can>`

## 🔴 导出：写进文件的东西都要当成不可信输入

| 坑 | 实测 | 修法 |
|---|---|---|
| openpyxl 见到 `=` 开头的字符串就当**公式**写（`<f>`） | 登录日志的用户名里放 `=HYPERLINK(…)`，导出的 xlsx 里就是 `<f>` 公式（失败登录记的是请求里填的用户名，没登录的人也写得进去）。变异检验：去掉 `data_type='s'`，`test_formula_payloads_stay_text_in_xlsx` 红 | 文本格一律 `data_type='s'` + `quotePrefix`；CSV 前面补 `'`（OWASP）。触发字符按 OWASP 那组 + 全角 `＝＋－＠`，**先跳过开头的空白 / 控制字符再判**（`  @SUM(…)`、`\t=…` 同样会被 Excel 执行，EspoCRM CVE-2026-55154 就是只查了第一个字符） |
| int 写进去是 **float** | 19 位雪花 ID 写成 `2.0496291082452337e+18`，精度没了（硬纪律 6） | ID 一律按文本写（`id_cell`） |
| 一格里有非法 XML 字符时 write-only 流**写坏** | `IllegalCharacterError` 之后再 append 就是 `StopIteration` —— 文件只有一半，而前面那些行看起来都好好的 | 写之前 `clean_text()`：非法字符换成 `U+FFFD`（�），超过 32,767 字符截断并标注 |
| 时间带时区写不进 Excel | openpyxl 拒绝 tz-aware datetime | 先换到**导出人的时区**再去掉 tzinfo（文件里没有时区，看的是那个人） |

速度（本机 8 核）：openpyxl write-only 约 1.4 万行/秒；XlsxWriter 约快 2.5 倍，
为了不多一个依赖没换 —— 20 万行的上限下差几秒，而且都在后台。

## 🔴 导出：「生成了、内容是错的」那一类

- **数据范围在 worker 里不生效。** `DataScopedCRUD` 靠 ContextVar 里的当前用户加条件，Celery 里那个变量是
  `None` —— 而 `None` 的意思是「不过滤」（fail-open）。worker 里取数必须 `scoped_to_user(user)`。
  变异检验：去掉它，`test_background_export_is_scoped_to_the_requester` 红
- **筛选参数拼错要拒绝，不能忽略**（`extra='forbid'`）。忽略 = 导出全表，而用户以为是筛过的那批
- **超过上限拒绝，不截断。** 原来两个日志页的前端导出拉到第 20 页就停：4,000 行之后**静默截断**
- **发起时和 worker 执行时各查一次权限。** 排队期间被收回了导出权限的人，文件不该再生成出来
- **Celery 会重投**（`acks_late` + `reject_on_worker_lost`）：两个 worker 拿到同一个任务会各生成一份。
  开始前用一条**条件 UPDATE** 抢（`crud_export_job.claim`），抢到的才执行
- **`celery_aio_pool` 不认 `time_limit`**：任务要自己 `with_timeout()`，否则卡住的导出永远是「生成中」。
  兜底是清理任务把超时的结成失败
- **导出文件不进 `sys_file`**：删存储时「还有文件不能删」那道检查看不见它们。`storage_service.delete`
  另查一次未过期的导出（变异检验：去掉这道检查，`test_storage_with_live_exports_cannot_be_deleted` 红）
- 文件名和表头按**发起人的语言**出（`i18n.use_language`）：worker 里没有请求，不切的话英文界面的人拿到中文文件

## 🔴 导入：「预览说能导、提交却不对」

- **文件内重复要单独查。** 库里没有、文件里有两行同一个键：逐行对着库查全都「通过」，提交时撞唯一约束 ——
  而那时前面的行已经写进去了
- **令牌用 `GETDEL` 抢。** 「先读再删」不是原子的：双击、重试、两个标签页会把同一批写两遍
- **提交前再校验一遍。** 预览到提交之间库里可能变了 —— 「新增并更新」模式下，预览时还不存在、
  提交前被别人建了的编码，要按**那一刻**判成更新（`test_upsert_follows_the_database_at_commit_time`）
- **一行一个保存点。** PostgreSQL 上一句失败整个事务就作废（`current transaction is aborted`），
  只吞异常是不够的
- **全有或全无有两个出口**：校验时就有行失败（一行都不写），和写到一半某一行库报错（**已经写进去的要撤掉**）。
  后一个只能打桩测（`test_a_write_that_fails_after_other_rows_were_written`），自然跑不出来
- 🔴 **会话关着 autoflush**：`dept_service.create()` 之后紧跟着按编码查，查到的是 `None`（实测：整棵树的提交
  全挂在 `'NoneType' object has no attribute 'id'` 上）。建完先 `flush()`
- 🔴 **缓存要在提交之后清，而且清一次。** `dict_data_service.create` 挂着 `@cache_invalidate`，函数一返回就清：
  一千行就是一千次按前缀扫 Redis，而且清完到提交之间别人的读会把旧值重新缓存回去。导入走 service 的
  `check_*` + DAO，用 `ctx.after_commit()` 在提交之后清一次（回滚了就不清）。变异检验：去掉它，
  `test_dict_import_creates_and_updates_by_type_and_label` 读带缓存的接口拿到旧值，红

## 🔴 导入：报错要是填表的人看得懂的那句话

- **pydantic 的报错不能直接摊。** 邮箱错报的是 `value_error` + `{reason}`，而 `pydantic.value_error` 的译文是
  「值错误，{error}」—— 原来填不上就原样返回模板，预览里写着「邮箱：值错误，{error}」；手机号 / 编码错报的是正则。
  现在 `import_service._cell_msg`：邮箱给「不是有效的邮箱地址」、格式错指向模板的说明页，其余填不上的用 pydantic 原句
- **取值认常见别名**（`ENABLE_STATUS_ALIASES`）：模板下拉是「正常 / 停用」，人手打的是「启用 / 禁用」
- 这两条都是**目测截图**看出来的：原来的断言只查了「邮箱」两个字在不在，模板没填上照样绿。现在断言整句，
  并且断言没有残留的 `{xxx}`（`test_cell_errors_read_like_sentences_not_templates`）

## 🔴 部门导入：按「导完之后的树」查环

同一份文件可以既建部门、又挪部门，于是有两个只在树上才有的坑：

- **环可以一半在库里。** 库里 P ── Q，文件把 P 挂到 Q 下面 —— 只看文件里的行之间查不出来。
  而**修这个之前，接口本身就允许**：`PUT /sys/depts/{A}` 把 A 挂到它的孙子下面，实测返回 200，
  A 和整棵子树从部门树里消失（找不到根）。`dept_service.check_update` 现在查「新上级是不是自己的下级」
  （`test_dept_tree.py`，修之前两条红）
- **按库里现在的树查会误报。** 库里 R1 ── A ── B，文件里 A 写在前面：A 挂到 B 下面、B 挪到 R2 下面。
  导完是 R2 ── B ── A，没有环；按现在的树查，A 的新上级 B 还是它的下级 —— 误报。所以预览按
  「库里的现状叠上文件里每一行要改成的」那棵树查环（`_check_tree`），`check_update` 传
  `check_ancestry=False`；提交时按那棵树里的**深度从浅到深**写，service 那道成环检查（这时按当时的库查）
  就不会误判。两种错法各有一个变异体，都红在 `test_reorganizing_in_one_file_is_not_a_false_cycle`

上级是**同一份文件里新建的**那一行时，库里还没有它，service 的校验（同级重名、负责人……）只能留到提交；
这种行在预览时只有导入自己那几道（可见性、负责人是否启用、文件内同级重名、环）。这几道的变异体都要专门造
「上级是文件里新建的」那种行才测得出来 —— 普通的行有 service 那道兜着，去掉导入自己的检查测试照样绿。

## 实测证据

- `app/admin/tests/api_v1/test_export.py`（27 条）· `test_import.py`（35 条）· `test_user_import.py`（19 条）·
  `test_dept_tree.py` · `test_storage.py` 的导出那一条 · `plugin/config/tests/test_config_conflict.py`
- 变异检验：导出 12 个变异体全红；导入 27 个红 26 个 —— 剩下那个（「校验失败时不回滚」）是**等价变异**：
  后面「写入失败」那个出口会把同一件事做一遍，只是多写了几行再撤掉
- PostgreSQL、SQL Server 全套绿（2026-10-22）。SQL Server 上第一次跑红了两条，是测试自己的问题（`text()` 写时间偏八小时，见 [`backend/tests` 分册](../../tests/AGENTS.md)）

## 还没做 / 刻意不做

- **空白单元格表示「不改」**，所以导入**清不掉**一个字段，也没法把部门挪成顶级。要么在界面上改，要么以后加一个显式的「清空」标记
- 受限的导入人（数据范围只到本部门）新建的子部门，**他自己可能看不见**（看不看得见由数据规则定）——
  同一份文件里再往那个子部门下面挂一层，预览说能导、提交时会报「上级不存在」。和在界面上一层层建是同一个结果。
  （**推断**，从 `check_create` 按数据范围查上级读出来的，没有专门写测试）
- 同一份文件里**两个兄弟互换名字**，提交时按当时的库查同级重名，会撞上；分两次导。（**推断**，同上）
- 前端导出的是资源定义的全量字段；后端的 `columns` 入参（按列表上看得见的列裁剪）还没接到界面上
