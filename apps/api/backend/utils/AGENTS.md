# backend/utils —— 通用工具

> 这份文件是 [`apps/api/AGENTS.md`](../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 上传的表格一律过 `utils/excel_ops.py`，不要自己 `load_workbook`

Excel 有一大票**「解析成功、有数据、就是错的」**的坑，没有一个会报错。
这一层把它们一次性挡住，业务侧只声明列（`TableColumn`），拿回来的每个值
要么是 `None`、要么是归一过的字符串，读不出来的一律变成显式的 `RowIssue`。

依赖是 `openpyxl`。选它而不是快 20 倍的 `python-calamine`（实测 5000 行：
425 ms / 0.9 MB vs 21 ms / 2.3 MB）是因为**calamine 是纯只读库**，而下载导入
模板要写 xlsx——选它就得再引一个写库，而这个量级下 425 ms 根本不是问题。

下面每一条都实测过，且**每一条都配了一个变异检验**（摘掉防御、确认对应测试
真的变红，见 `backend/tests/test_excel_ops.py`）：

| 坑 | 表现 |
|---|---|
| 🔴 `wb.active` **不是**第一个工作表 | 它是「保存时停在哪个页签」。实测第一个表叫 `data`、第二个叫「临时草稿」，保存时停在第二页，`wb.active` 读的就是草稿——**解析成功、有数据、读的是另一张表**。一律 `wb.worksheets[0]` |
| 🔴 `data_only=True` 让公式变成 `None` | 它换的是**缓存值**，而程序生成的表格没有缓存值。于是「用户拿公式拼了用户名」静静变成「这行用户名没填」。用 `data_only=False` 读到公式原文，`data_type == 'f'` 显式拒掉；代价只有 7%（5000 行 186→199 ms） |
| 🔴 `ws.max_row` 是文件**自己声明**的 | 实测把 sheet XML 里的 `<dimension ref="A1:B3" />` 改成 `A1:B1048576`，`max_row` 就返回 1048576 而真实只有 2 行。拿它判行数上限 = 改一行 XML 就能触发的拒绝服务。边迭代边数 |
| 🔴 xlsx 就是 zip，天然是解压炸弹载体 | 实测 **199 KB** 的上传能声明出 **200 MB** 解压体积，上传大小那道闸门完全无感。好在 zip 中央目录里就写着 `file_size`，**不用真解压**就能拦 |
| 🔴 19 位数字在 Excel 里已经塌了 | Excel 所有数值都是 IEEE double，`1234567890123456789` 存进去就是 `1.234567890123457e+18`，换任何库都一样。此时 `int()` 给出 `1234567890123456768`——看起来完全正常、但不是同一个数。超 2^53 一律拒（同硬纪律 6） |
| 夹在中间的 NBSP | `'zhang\xa0san'` 和 `'zhang san'` 肉眼一样、`==` 为 False，且**躲得过 `strip()`**（首尾的 NBSP 倒是会被剥掉——`'\xa0'.isspace()` 是 `True`）。归一成普通空格 |
| 半空行 vs 全空行 | 尾部空行极常见要跳过，但半空的行必须报——两者混为一谈时「用户名忘填了」会被当成「这行不存在」而消失，用户只发现少了一个人 |
| 表头拼错 | 非必填列拼错是**纯静默**的（整份文件照样解析成功，那列数据全丢）。没认出来的表头要回报给调用方 |

两条给写这一层的人的提醒：

- ⚠️ **一个格子只报一条错。** 公式格会先被判「不支持公式」、值回落 `None`，
  然后又撞上必填校验——用户看到同一格两条错，第二条还是误导的（他明明填了）
- 🔴 **`_normalize_value` 的 float 分支经过 openpyxl 是走不到的**，因为它读回来时
  会把整数值的 float 收成 int（实测：写 `13800138000.0` 读出 `int`）。
  留着是防换库（calamine 对同一格给的就是 float，裸 `str()` 得到 `'13800138000.0'`）。
  **所以那个分支只能直接单测真值表**——经过 openpyxl 写的测试是绿的，但什么也没测到。
  这条是变异检验抓出来的，不是看出来的

## 存储抽象（`utils/storage_ops.py` · #122 第一期）

本地盘和 S3 兼容存储收成同一个 OpenDAL `AsyncOperator`。表是 `sys_storage`，文件记 `sys_file.storage_id`
（**`NULL` = 内置本地存储**，它不是表里的一行 —— 两棵根目录是代码常量，做成一行只会多出「库里的值和代码
对不上」这种状态；所以迁移对存量文件零数据变更）。

🔴 **读 / 删 / 签地址一律按文件记录上的 `storage_id`，不按当前默认存储。** 切默认只影响新上传；
秒传也只在同一个存储里复用（跨存储命中 = 新记录指向别的存储里的对象，那个存储一删就 404）。

### OpenDAL 0.47.12 的实测坑（隔离 venv + moto 模拟的 S3）

| 坑 | 表现 | 处理 |
|---|---|---|
| 🔴 默认会捡运行环境的凭据 | 存储里的 AK **为空**时，预签名地址里的 `X-Amz-Credential` 是环境变量 `AWS_ACCESS_KEY_ID` 那把（= 拿服务器自己的身份去访问用户指定的桶）；配了 AK 时用配的那把（两种都实测过） | 每个 operator 都写 `disable_config_load='true'`（S3 存储的 AK/SK 本来也是必填，这是第二道） |
| 🔴 只关上一条、凭据为空 | 每次调用先去连 169.254.169.254，**卡 30 秒**再报一句 `signing http request` | 同时写 `disable_ec2_metadata='true'` |
| 选项值必须是**字符串** | 构造器传 `True` 抛 `TypeError: 'bool' object is not an instance of 'str'` | 一律 `'true'` |
| 🔴 异常类是平的 | 0.47 起 `except opendal.exceptions.Error` **接不住** `NotFound`（0.46 还接得住） | 逐个点名（`_reason()`），依赖锁 `<0.48` |
| 流式读取的「不存在」是裸 `OSError` | `open(不存在, 'rb')` 本身成功，第一次 `read()` 才抛 | 读之前先 `stat_size()`，响应头发出去之后就改不成 404 了 |
| `AsyncFile.read(n)` 短读 | 要 1 MiB 回来十几 KB | 读到 `b''` 才算完 |
| fs 后端没有预签名 | `capability().presign == False`，调用抛 `Unsupported` | 本地存储 `/{pk}/link` 返回 `url: null` |

上传按 1 MiB 一块喂给 writer（不用 `UPLOAD_READ_SIZE` 那 1 KB —— 每次 write 都要跨进 Rust 层）；
S3 上 writer 自己攒成 ≥5 MiB 的分片走 multipart（实测 12 MiB → 3 片）。

### 多副本：operator 按 `(id, updated_time)` 缓存

只按 id 缓存的话，A 机改了配置，B 机进程里还拿着旧 operator（ContiNew 就是只在本进程卸载重注册，
多副本要重启才生效）。现在每次都用**刚从库里读出来的那一行**取 operator，配置一变 `updated_time` 就变 ——
不靠广播，也就没有「消息丢了」这回事。代价是每次读文件多一次按主键查 `sys_storage`。

### 配置校验

- 🔴 **端点挡链路本地 / 未指定 / 组播地址**（含 `169.254.169.254`、`fd00:ec2::254`）：「测试连接」从服务器发请求，
  配成元数据地址就是 SSRF（Label Studio CVE-2025-25297、Coolify CVE-2026-42147）。⚠️ **刻意不挡私网** ——
  MinIO 跑在内网是这个功能最主要的用法。测试连接的失败原因只回归类后的人话，上游原文只进日志
- 🔴 **公开件的 MIME 按扩展名定（`content_type_from_key`），不信 multipart 里声明的。** `x.png` 配 `text/html`
  声明 + HTML 内容，无鉴权的 `/uploads/…/x.png` 就在应用自己的域上以 HTML 下发（原来的 StaticFiles 是按扩展名猜的，
  换成路由时漏了；S3 上还会原样写进对象的 Content-Type、预签名的 response-content-type）。代码审查抓到的，
  守卫 `test_file.py::test_public_uploads_ignore_client_content_type`
- 🔴 `check_endpoint` 的 DNS 解析走 `loop.getaddrinfo`，不是同步的 `socket.getaddrinfo` —— 后者会把整个 worker
  冻住，解析不了的主机名本机实测卡 10 秒，期间所有人的请求都停（代码审查抓到的）
- 🔴 本地存储的根目录不能在 `STATIC_DIR` 下（`/static` 无鉴权挂出去，`UPLOAD_DIR` 当年就是这么被连带公开的）
- 阿里 OSS（`SecondLevelDomainForbidden`）、腾讯 COS 新桶（`PathStyleDomainForbidden`）只认虚拟主机风格，
  OpenDAL 默认是路径风格 —— `addressing=auto` 按端点域名判。**这一条只看了文档、只离线生成过 URL，没对真账号发过请求**

### 实测证据

- `app/admin/tests/api_v1/test_storage.py` 30 条，走进程内的 moto S3（真 HTTP）；设 `STORAGE_TEST_S3_ENDPOINT`
  就改打真实服务，多 4 条只在真服务上成立的（凭据错误 · 桶不存在 · 凭据错时上传不留记录 · 预签名改 key / 签名 /
  有效期一律 403）。**变异检验** 3 处各打红：operator 只按 id 缓存 · 秒传不带 `storage_id` · `/uploads` 不判
  `is_public`（这条连 `test_file.py` 的私有件那条一起红）。
  🔴 **去掉 `disable_config_load` 没有任何测试会红**（moto 和 RustFS 上都跑过，34 条照绿）：S3 存储的 AK 是必填的，
  配了 AK 时环境凭据根本用不上。第一次写这段时说它打红了一条 —— 那是秒传复用上一轮记录的 flake，不是它。
  这条防线只靠上面那张表里「AK 为空时签名用的是环境 key」的脚本实测 + 代码审读
- 🔴 写这个文件的测试时踩了第二次「秒传复用上一轮记录」：内置存储上的文件内容要带随机串，否则同名同内容命中
  上一轮指向已删 tmp 目录的记录，下载 404 —— 表现得像「按存储读」的逻辑坏了（跑两遍才会出现，第一遍永远绿）
- **RustFS 1.0.3**（真实 S3 兼容服务；现在是 `docker-compose.dev.yml` 的 `--profile s3`，当时是二进制跑在本机）：两个 uvicorn 进程连同一个库 + 同一个 RustFS，
  A 传 12 MiB（multipart）、B 下载字节一致；B 签的预签名地址直连取回，中文文件名经
  `response-content-disposition` 带过去；公开图片经 B 的 `/uploads` 302 到桶里；凭据错的存储测试连接报
  「凭据无效」、上传报错且不留记录；桶不存在报「桶不存在」；删文件后桶里的对象真的没了。
  浏览器全流程（表单建存储 → 测试连接 → 设默认 → 文件页 `<input type=file>` 传 6 MiB → ⋯ 菜单下载落到
  RustFS 的预签名地址、字节一致 → 预览 → 还是默认时删被拦 → 切回内置 → 有文件时删被拦 → 停用后 B 实例照常读 →
  删文件后删存储）全过，无 page error
- ⚠️ moto **不校验签名**，「错误的 SecretKey」只能靠 `STORAGE_TEST_S3_ENDPOINT` 指到真服务测
- ⚠️ 阿里 OSS / 腾讯 COS 仍然**没有**对真账号发过请求（见上面「配置校验」那条）

## 动态配置的回落（`utils/dynamic_config.py` · #139）

`load_config` 把 `sys_config` 的值 `setattr` 到 `settings` 上。**`settings` 是进程级单例** —— 写进去的值一直留着，
直到下一次加载显式改掉它。这条事实踩出了两个静默的坑，都在给参数配置加「文件上传」组时撞见：

### 🔴 关掉组总开关，进程里还是上一次的库值

**症状**：参数配置页关掉某一组的总开关，横幅写着「后端整组不加载，回落 .env」，界面也降了透明 ——
而接口给出的仍然是关之前的库值，要**重启**才回落。多副本时更糟：加载过的那台是库值、没加载过的那台是 `.env` 值。

**根因**：原来关组时直接 `return`、行被删时 `continue`、值转换失败时 `continue` —— 三条路都**什么都不写**，
于是留下的是「上一次加载的值」而不是「`.env` 的值」。转换失败那条的注释还写着「回落到 .env 默认值」，
只在进程从没加载过时才成立。

**修法**：import 时 `settings.model_copy(deep=True)` 存一份 `_ENV_DEFAULTS`，三条路都**显式写回**它。
⚠️ 不能拿「当前的 `settings`」当回落值，那正是被污染的那份；也不要在第一次用到时才懒取 —— 测试会先 monkeypatch
`settings` 再触发加载，懒取会把 monkeypatch 的值记成默认值，而且跨用例留着。

### 🔴 读取侧只接住「转换失败」不够，范围也要卡

**症状**：库里的 `FILE_CHUNK_SIZE` 被直接写成 `'0'`（写入侧的 422 闸门挡的只是接口，挡不住直接写库 / 迁移 / 闸门之前的历史行），
之后**每一次**分片上传 init 都是 500。

**根因**：`'0'` 过得了 `int()`，loader 照单全收，然后 `multipart_service.init` 里 `ceil(size / 0)`。
`'-1'` / `'65'` 同样被收下（每片 -1 MiB / 65 MiB）。

**修法**：`load_config` 读取时也过 `DYNAMIC_INT_BOUNDS`（`check_dynamic_int_bounds`），不合格的按键回落 `.env` + 一条 error 日志。
口令策略那批键走的是同一条路，所以直接写库的 `USER_PASSWORD_MIN_LENGTH = 999` 也会回落（同一段代码推出来的，没单独测）。

**实测**：`app/admin/tests/api_v1/test_upload_policy_config.py`。把 `load_config` 改回原样跑：
`test_turning_the_group_off_falls_back_to_env` 报 `4194304 == 8388608`（关组之后还是 4 MiB）；
`test_a_dirty_chunk_size_in_the_db_does_not_break_init` 的 `[0]` 报 `ZeroDivisionError`、`[-1]` 报 `-1048576`、`[65]` 报 `68157440`
（`['']` / `['abc']` 两条旧代码下本来就绿 —— 转换失败那条路一直在）。

⚠️ 写这类测试的回落真值用**重新构造的 `Settings()`**（重新读 `.env`），不要拿 `_ENV_DEFAULTS` 自己 —— 那是拿被测代码验被测代码。

## 附件 → 纯文本（`utils/doc_text.py` · #111 AI 预审）

给模型读的。支持 txt / md / csv / json / xml / log · xlsx · docx · pdf；扫描件、图片、doc / xls / ppt 这类老格式
不读。两条约定：

- 🔴 **读不出来要说原因，从不抛异常。** 返回空串的话，模型会以为附件本来就是空的，进而下「缺少附件」这种错的结论；
  抛异常的话一份坏附件拖垮整次预审。所以要么有 `text`，要么有 `note`（「没有可读的文字（多半是扫描件）」「只读了前 N 字」）
- **读出来的是不可信输入**，这一层不过滤 —— 过滤挡不住注入，隔离（只进 user 消息）才挡得住

xlsx 走 `excel_ops.xlsx_text`，⚠️ 那里**反着**用 `data_only=True`：上面那张表说的是导入（公式要认出来、拒掉），
这里要的是 Excel 存下的计算结果（报销单的「合计」）。程序生成、没有缓存值的公式格读成空 —— 给模型参考可以接受，
导入不行。解压炸弹的检查照旧，docx 按同一组上限（也是 zip）。PDF 用 `pypdf`，最多读 20 页。

**实测证据**：`tests/test_doc_text.py` 16 条（PDF 是手写的一页带文字层 / 无文字层两种，没为测试引生成库）。
变异：docx 不查解压炸弹 · 扫描件返回空串不给原因，各自红。

