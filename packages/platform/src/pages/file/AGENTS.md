# pages/file —— 文件管理与附件预览

> `sys_file` + `sys_file_relation`。**这一页刻意不用 `DataTable`** —— 它是文件管理器不是列表页。
>
> 这份文件是 [`packages/platform/src/pages` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 文件管理与附件预览

两张表：`sys_file`（物理文件）+ `sys_file_relation`（挂在谁身上）。
文件落在哪由 `sys_file.storage_id` 决定（`NULL` = 内置本地存储），存储本身在「存储管理」页
（`pages/storage/`，#122）—— 后端那一层的约束见 [`backend/utils` 分册](../../../../../apps/api/backend/utils/AGENTS.md)
的「存储抽象」一节。**刻意没做**个人云盘（目录树 / 分享 / 配额）。

### 🔴 这一页**刻意不用 `DataTable`**

文件管理不是列表页，是**文件管理器**：左栏分类 + 存储统计，右侧宫格卡片（图片出真实
缩略图），可切列表。第一版拿三件套模板做成了表格，结果是七列等宽表头
（分类/格式/大小/上传时间/校验和…）把最该看的文件名挤成一小格、「校验和」这种排障
字段常驻占位，而「这是张什么图」完全看不出来 —— 实际使用时第一反应就是「难看」。

**表格适合多行同构数据的对齐扫描，文件不是那种数据。** 参照的是 ContiNew Admin 的
`views/system/file`（FileAside + FileGrid/FileList + FileRightMenu 那一套）。

```
pages/file/
├─ api.ts             query key · queryOptions · mutation · formatBytes · PREVIEWABLE · canThumbnail
├─ index.tsx          页面编排：左栏 + 工具栏 + 宫格/列表 + 分页
├─ file-rail.tsx      左栏：分类导航（带数量）+ 已用空间 + 分类占比条
├─ file-grid.tsx      宫格卡片（默认视图）
├─ file-list.tsx      列表视图（**手写的行，不是 DataTable**）
├─ file-icon.tsx      扩展名→图标 · 分类配色 · FileThumb（懒加载真实缩略图）
├─ file-menu.tsx      操作菜单，右键与 ⋯ 下拉共用一份条目定义
├─ detail-sheet.tsx   详情抽屉：落盘名 / MIME / 校验和 / 上传人这些排障字段
├─ preview-dialog.tsx 预览弹窗：取字节 → 交 viewer
├─ image-dimensions.ts 从文件头读图片宽高（不解码），挡像素过多的图
├─ uploader.ts        往全局上传队列塞文件（`shell/upload-store.ts`），页面自己不画队列
└─ attachments.tsx    **可复用的附件面板**，任何页面给 targetType + targetId 就能嵌
```

### 上传走全局队列：`packages/platform/src/upload/`（引擎）+ `shell/upload-store.ts`（队列）+ 右下角浮窗

文件页和附件面板共用 `useFileUploader({ source })`（`./uploader.ts`），它只是往 `shell/upload-store.ts`
的**全局**队列 `enqueue`；进度在右下角的浮窗里（`shell/upload-tray.tsx`，见 [shell 分册](../../shell/AGENTS.md)）。
队列不在页面里：关掉文件页签上传不会被取消，切到别的页面也看得见进度；附件面板的「传完就挂载」跟着那一项走
（`opts.onDone` 存在队列里），面板关了也照常执行（实测）。每个文件：浏览器端分块算 sha256
（`hash-wasm`，不是 `crypto.subtle` —— 后者一次性要整个文件进内存，而且局域网 http 下是 `undefined`）
→ `GET /sys/files/check`（同一人 + 同名 + 同内容传过就**不传**，直接复用旧记录）→ `POST /upload`
走 XHR（`@admin/api` 的 `sendUpload`：fetch 拿不到上传进度）。串行、可取消、可重试，队列状态机在
`packages/platform/src/upload/queue.ts`，有单测（`pnpm --filter @admin/platform test`）。

- 🔴 **之前的「秒传」是先把整个文件传上去、后端算完 sha256 再发现重复** —— 99 MB 的 zip 重复传一次就是
  99 MB 白跑，而且界面上什么都不说（用户以为「没反应」）。现在命中 `/check` 一个字节都不传，
  列表里显示「已存在同内容的文件，直接复用」
- `/check` 的 `public` 参数要和上传的一致，否则「check 说命中了、upload 还是重传一份」（`uploader.ts` 里一处拼）
- 上传中**不禁用**上传按钮：它是个队列，再选的排在后面。附件面板每个文件传完立刻挂载（挂载幂等，
  同一个文件选两次只有一行）；面板里只留一句「N 个文件上传中，进度在右下角」，点它展开浮窗
- `ui/components/uploader/dropzone.tsx` 的 `useFilePicker` 每次 change 后把 `input.value` 清掉 ——
  不清的话连续选同一个文件不触发 change（用户导入那边踩过）
- 拖拽投放区包住整块内容区（`data-testid="file-dropzone"`），没有 `sys:file:upload` 的人拖进来不收
- 小于 `chunk_threshold`（默认 16 MiB，`GET /sys/files/upload-policy` 下发）的文件浏览器 → 后端是**一个请求**；
  大的走分片 + 断点续传，见下面「分片上传」一节。后端 → S3 那段一律由 OpenDAL 自动 multipart，对浏览器不可见

实测（Playwright，上传限速 3~4 MB/s）：30 MB 的 zip 进度走到 `9.9 MB · 4.0 MB/s · 33%`、浮窗副栏「还剩 8s」；
同文件再传 0 次 `/upload` 请求、显示复用；取消 → 重试 → 完成；拖拽投放进队列；切到存储管理页浮窗还在、继续传；
附件面板传完即挂、重复选同一个文件列表仍只有一行、**传到一半关掉详情抽屉照样挂上**。

几条定下来的约定：

- **交互按文件管理器的习惯**：单击选中 · **双击打开** · 右键出菜单。
  不是表格的「点行进详情」
- **卡片必须定高**（`h-[136px]`，名字区固定两行）。不定高时文件名换两行的卡会比
  邻居高一截 —— 未选中看不出来（边框透明），一选中边框显形就是参差不齐的一排
- 非图片文件的图标要坐在**浅色底块**上（`bg-muted/40`），否则线框图标夹在一排
  实心缩略图中间显得空。视觉重量对齐比图标本身更重要
- **视图（宫格/列表）进 URL**（`view=grid|list`），选中项**不进** ——
  几十个雪花 ID 塞地址栏不现实，和树形展开状态同一个取舍
- 左栏统计走 `/sys/files/statistics`（库里 GROUP BY），是**全量**的、不随筛选变 ——
  这正是它的用处：先看总体分布再钻进去
- 占比条用**纯 CSS 横向堆叠**，不引图表库：饼图要测容器宽度，而隐藏 tab 是
  `display:none`（宽度 0），监控页的趋势线已经因为同一个原因换掉了 recharts
- **列表视图不要退回 `DataTable`**。文件名要吃掉剩余宽度，其余属性靠右排成一条
  次要信息带；用表格会把它变回等宽列，一屏能看的文件数还少一半

### 回收站（#122 第二期）

「删除」= 进回收站：`sys_file.deleted` 置位、附件关联解开，**对象不动**；左栏「回收站」点进去
（`?scope=recycle`，`recycle-bin.tsx`）可以还原 / 彻底删除 / 清空；到期由 `maintenance.purge_recycled_files`
（每天 03:45）彻底删除。保留天数只有一个真相源：`FILE_RECYCLE_DAYS`（默认 30，0 = 不启用、删除即彻底删除），
清理任务、行上的「N 天后清除」、删除确认框的文案都读它（统计接口下发 `recycle_days`）。

- 🔴 **「在回收站里」= `deleted ≠ 0 且 purged_time IS NULL`**，不能只看 `deleted`：第二期之前删的记录对象早没了，
  迁移把它们的 `purged_time` 回填成 `deleted_time` —— 不回填的话它们全进回收站，一还原就是一批「文件已丢失」
- 🔴 **回收站里的文件一律读不到**（详情 / 下载 / `/link` / `/uploads` 都 404）—— 否则「删了」只是界面上看不见。
  所以回收站视图没有预览和下载，要看先还原
- 🔴 **还原 = 撤销那一次删除**：删除时文件和关联用**同一个** `deleted_time`，还原时把 `deleted_time` 相等的关联挂回去；
  之前手动从附件面板「移除」的不挂。先查后改，不用 `UPDATE … WHERE NOT EXISTS(同表)`（MySQL error 1093）
- 🔴 **清空 / 定时清理按 `id > 上一批最后一个` 往后翻（keyset），不能每批从头取。** 变异检验抓到的：让「在回收站里」
  不看 `purged_time`，清空接口直接死循环挂到超时 —— 只要有一行清不掉，「从头取」每批都会把它取回来。
  原来那句 `if purged == 0: break` 拦不住（更新照样「成功」）
- 🔴 **存储页删存储时回收站里的也算**（`get_storage_counts` 返回 正常 / 回收站 两个数）：对象还在那个存储里，
  删了存储它们就永远还原不回来
- 秒传（`/check` 和上传去重）只看正常文件：回收站里的同名同内容不复用 —— 复用了就是「上传成功，但文件在回收站里」
- 删除成功后弹一条带「撤销」的 toast（`ui/toast` 的 action 点完会自动关掉这一条，之前不会）
- 还原 / 彻底删除 / 清空复用 `sys:file:del`（回收站之前「删除」本来就是彻底删除，权限面没变大）；列表要 `sys:file:list`

实测：`app/admin/tests/api_v1/test_recycle.py` 12 条；**变异检验** 6 处各打红（还原不挂关联 · 还原把手动移除的也挂回去 ·
存储计数不算回收站 · 回收站不看 purged_time · 清理任务不看保留期 · 删除时直接清除对象）。迁移在 PostgreSQL 上
up → down → up（开发库 11 条存量已删记录全变墓碑、回收站为 0）。浏览器：删除确认框写「移到回收站」→ toast「撤销」→
批量删 3 个 → 左栏「回收站 3」→ 行上「30 天后清除」→ 还原 / 彻底删除 / 清空全过。
⚠️ 写还原的测试要用**随机的目标 ID**：还原回来的文件会一直挂在目标上，固定 ID 的话第二轮就看到上一轮那条（跑第二遍才红）

### 分片上传 / 断点续传（#122 第三期）

不小于 `FILE_CHUNK_THRESHOLD` 的文件，`upload-store.ts` 的 `upload` 换成 `packages/platform/src/upload/chunked.ts` 的 `uploadChunked`：
`POST /multipart`（init）→ 并发 3 片 `PUT /multipart/{id}/{n}`（裸字节，`FILE_CHUNK_SIZE` 一片，默认 8 MiB）→
`POST /multipart/{id}/complete`。sha256 预检（`/check`）照旧在前面，命中了一片都不传。
会话在 Redis（24 小时没动静过期，每传一片续期），分片落在**目标存储的私有子树** `_multipart/{upload_id}/`，
complete 按片号流式拼成最终对象、边拼边算 sha256、按普通上传的口径去重落库，再删分片。

- 🔴 **五个接口全挂 `sys:file:upload` + `DependsRBAC`，init 和 complete 各过一遍和 `/upload` 同一份的校验**
  （扩展名白名单 + 分类大小上限 + 公开件只收图片，`multipart_service.verify_upload`）。ContiNew 的 GHSA-j7qm-qprw-c53w
  （CVSS 8.5）就是分片接口漏了权限和白名单。complete 再校验一次，挡的是「init 之后管理员调低了上限」
- 🔴 **每一片边收边数**：除最后一片外必须正好 `chunk_size`，超了当场断开（不等收完），少了也不收。
  会话按上传人隔离，别人的 `upload_id` 一律 404
- 🔴 **`upload_id` 先过 `^[0-9a-f]{32}$`**：会话旁边就是 `:parts`（集合）和 `:lock` 两个 key，真实 id 拼上这两个后缀
  不校验的话会被当会话读 —— 前者 WRONGTYPE、后者 json 解出来是个 int，都是 500
- 🔴 **操作日志中间件不读 `application/octet-stream` 的请求体**（`opera_log_middleware.get_request_args`）。
  它在路由之前跑：分块传输没有 Content-Length，原来那道「超过上限就不读」挡不住，会先把整片收进内存；
  带 Content-Length 的小片又会被 `decode('utf-8', 'ignore')` 成乱码写进 `sys_opera_log`
- 🔴 **同时两次 complete（双击、网络重试）只让一个去拼**（Redis `SET NX` 锁），另一个 409 —— 否则是两份对象、两条记录
- **取消 = 放弃**（删服务端会话和分片、删续传记录）；**失败 = 留着**，浮窗里「重试」从断点接着传
- **刷新 / 关掉标签页之后**：`File` 对象没了，只能让用户重新选。`packages/platform/src/upload/resume.ts` 在 localStorage 记
  「指纹（名字 + 大小 + 修改时间）→ upload_id」，浮窗挂载时逐个 `GET /multipart/{id}` 核一遍（404 = 过期，丢掉），
  活着的显示成「N 项上传未完成」+「继续 / 放弃」；点继续弹文件选择框，选的指纹对不上就 toast 报错、不传。
  直接在文件页重新选同一个文件也会自己续上（`enqueue` 时顺手把那一行撤掉）
- 过期会话留下的分片由 `maintenance.purge_stale_multipart`（每天 04:00）清：每个存储的 `_multipart/{upload_id}/` 里，
  Redis 里已经没有会话的目录整个删掉；名字不像 upload_id 的不碰
- 拼接的代价是对象存储上的字节读写两遍（同 Rails ActiveStorage 的 compose）：OpenDAL 没有暴露 UploadPart / ListParts，
  所以不是 S3 原生的 multipart。上限由分类大小上限兜着（压缩包 100 MB），这个代价可接受

实测：`app/admin/tests/api_v1/test_multipart.py` 26 条（PostgreSQL · moto · **RustFS** 真服务 63 条连同 test_storage；
SQL Server 全套 762 条 + 迁移 upgrade）；
**变异检验** 11 处各打红（init 不校验 · complete 不复查上限 · 不边收边断 · 不收短片 · 不查归属 · 没有锁 ·
中间件读二进制 · 清理不看会话 · 清理不认名字 · PUT 漏权限 · upload_id 不校验形状）。
⚠️ **「边收边断」只能经 service 测**：TestClient 会先把整个请求体读完再交给应用 —— 实测服务端第 3 块就判了 400，
生成器照样被读完 50 块 —— 所以经 HTTP 写的测试分不出「当场断」和「收完再判」
**两个后端进程交替接分片**（#122 的验收项）：A / B 两个 uvicorn 共用 `fba_test` + Redis，默认存储是 RustFS ——
A init、片 1/3/5 打 A、2/4 打 B、B complete（两边的访问日志核过确实各自接了那几片），sha256 一致、经 A 下载字节一致、
桶里只剩最终对象；取消也跨进程（B 开、A 传一片、B 取消）→ 桶里那一片被删、A 再查 404。
浏览器（Playwright，上传限速 3 MiB/s，40 MiB = 5 片）：传到一半刷新 → 服务端有 `[1,2,3]`、浮窗「1 项上传未完成 · 已传 60%」→
点继续选同一个文件 → **只 PUT 了 4、5 两片** + complete，sha256 与原文件一致；取消 → `DELETE` 会话；
刷新后选错文件 → toast 报错、那一行原样留着、没有入队；放弃 → `DELETE` + localStorage 记录清空。
⚠️ 前端：`packages/platform/src/upload/chunked.test.ts` 7 条（续传只补缺的片 · 会话过期重开 · 5xx 重试 4xx 不重试 · 取消删会话）

#### 阈值 / 每片大小在参数配置里改（#139）

参数配置 → 文件 → 文件上传（`sys_config` 的 `FILE` 组）。`.env` 的 `FILE_CHUNK_THRESHOLD` / `FILE_CHUNK_SIZE` 只是默认值，
`dynamic_config.load_file_config` 挂在 `GET /upload-policy` 和 init 上把库值读进来。会话在 init 时记下 `chunk_size`，
改配置不影响传到一半的文件。

- ⚠️ **库里按 MiB 存，`settings` 里是字节**（界面上填 `8`，不是 `8388608`）。别把库里的数抄进 `.env` ——
  `FILE_CHUNK_SIZE=8` 在 `.env` 里是 8 **字节**一片
- 🔴 **阈值的上界 99 是跟着 `apps/web/nginx.conf` 的 `client_max_body_size 100m` 定的**：小于阈值的文件是**一个请求**
  传完的，阈值调过 100，100 MB 上下的文件就是 nginx 的 413，应用日志里什么都没有（ContiNew 栽的是同一个坑：Spring 的
  `max-file-size` 和分片阈值不联动）。范围表 `DYNAMIC_INT_BOUNDS` 和前端 `registry.ts` 之间有对账测试，
  **nginx 那个值没有** —— 改它的时候自己同步这两处
- 阈值 < 每片大小时前端两行都报错、挡保存（那段文件会「分片上传但只有一片」，能用、白多两个请求）。
  后端只卡单项范围，没做跨字段（同 `USER_PASSWORD_MIN/MAX_LENGTH`）
- 前端 `upload-store.ts` 的策略**缓存 10 秒**，原来是整个页面会话只取一次 —— 管理员改完回文件页试传，拿到的还是改之前那份
  （这一条是读代码得出的，没在浏览器里复现旧行为）
- **不做按存储配置**：我们的分片是存储里的独立对象，不是 S3 原生 multipart，S3「每片 ≥ 5 MB」的约束不适用。
  ContiNew 4.2 的其余几项（按文件名查重、文件名冲突自动重命名、浏览器直传）为什么不跟，见 issue #139 正文

实测：`app/admin/tests/api_v1/test_upload_policy_config.py` 16 条（改了就生效 · 关组回落 · 库里脏值 · 写入侧范围与边界），
其中关组回落和脏值那两组在旧的 `load_config` 上各自打红（见 [`backend/utils` 分册](../../../../../apps/api/backend/utils/AGENTS.md)
「动态配置的回落」）。迁移在 PostgreSQL 上 up → down → up，先手工插一条同 key 的行：up 不重复插、不覆盖它的值，
down 只删迁移自己那几个 ID。浏览器（Playwright）：阈值填 120 → 「不能大于 99」、填 4（每片 8）→ 两行都报、保存禁用；
存 2 / 1 之后同时选 1.5 MiB 和 3.5 MiB 两个文件 → 前者一次 `POST /upload`，后者 init + 4 片 + complete，
两个文件共用一次 `upload-policy`。⚠️ MySQL / SQL Server 上的种子和迁移只过了离线编译那条守卫，没在真库上灌过

### 缩略图是「把原图当缩略图」，有闸门

后端**没有缩略图列**（ContiNew Admin 有 `thumbnail_name` / `thumbnail_size`），所以
`FileThumb` 是取原图字节转 blob URL。三条约束缺一不可：

- **不能 `<img src={download_url}>`** —— 那地址要 Authorization 头，裸 src 只会拿到 401
- **必须懒加载**（IntersectionObserver，提前 200px）。副作用是隐藏 tab
  永远不进视区、一个请求都不发，正好是想要的
- **blob URL 必须 revoke** —— 不 revoke 整张图的字节会挂在 document 上直到刷新页面

闸门是 `canThumbnail()`：只对 `type === 'image'`、**≤ 1MB**、非 svg 的文件出真图
（svg 走 `<img>` 会把外链/脚本一起解析，当缩略图不值这个风险）。
一屏 30 张 5MB 的图就是 150MB，这条线不能放开。
**真正的解法是后端出缩略图**（Pillow + 一列 `thumbnail_name`），那时把
`canThumbnail` / `fileThumbQuery` 一起删掉。

缩略图**不需要**像素上限（预览需要，见下面「预览器」那节）：实测 48MP / 144MP / 400MP 的图在宫格里
主线程最长 18–40ms —— `<img>` 按显示尺寸解码。但浏览器**不肯解**的图（实测 30000×30000 的 PNG，
`naturalWidth` 是 0）原来显示成一个破图标，像文件坏了；现在 `onError` 退回类型图标。

### 菜单图标要在 `icon-registry.tsx` 里登记

菜单表的 `icon` 是 Iconify 命名，而 UI 包用 Tabler —— 没登记的会**静默回落成
`IconPoint`（一个小圆点）**，只在开发期 console 告警。
`文件管理` 第一版填了 `ant-design:folder-outlined`（表里没有），于是侧边栏里它旁边
全是正经图标、只有它是个 `○`，用户一眼就看出来了。
现在是 `lucide:files` → `IconFiles`，和页面左栏「全部」同一个图标，菜单和页面对得上。

> 顺带一条命名上的取舍：我们**没有目录**，所以不用文件夹图标 —— 那是过度承诺。

### 读文件一律走带鉴权的接口

`GET /api/v1/sys/files/{pk}/download`，地址由 `GetFileDetail.download_url`
（**computed_field**）下发。

- **`download_url` 必须挂在详情模型上，不要只给上传响应加。**
  曾经只有上传/详情带它，列表接口返回不带的版本 →
  前端预览拼出 `http://127.0.0.1:8000undefined` → 弹窗「文件加载失败」。
  每个读取路径都要这个地址，那它就该长在唯一的详情模型上
- **对象存储上的文件下载走 `/{pk}/link` 拿预签名地址**，浏览器原生下载（不经后端中转、不整块读进内存）；
  本地存储那个接口返回 `url: null`，回落到下面这条。🔴 **不要**改成「fetch 带头去跟后端的 302」——
  跨域重定向时浏览器剥掉 Authorization 头（Fetch 规范），不剥的老客户端会让 S3 收到两种鉴权直接 400
  （这两条是规范和别人的案例，**没有实测**）。
  预览仍走 `download_url`（后端流式代理），所以**桶不需要配 CORS**
- **不能做成 `<a href={download_url} download>`** —— 那个地址要 Authorization 头，
  裸链接带不上，结果是把 401 的 JSON 当文件存下来。走 `fetchBytes` → Blob →
  临时 `<a>` 点一下 → **立刻 `revokeObjectURL`**（不 revoke 整个文件的字节会留在内存里）
- `UPLOAD_DIR` 在 `BASE_PATH / 'upload'`，**不在 `STATIC_DIR` 里面**。
  ⚠️ 只删 `/static/upload` 那条 mount 是**没用的**：它原来在 `STATIC_DIR` 下，
  被 `app.mount('/static', …)` 连带公开（实测删了还是 200）。
  改回去之前先想清楚：文件表里有别人的文件

### 落盘按 `YYYY/MM/DD` 分目录

`sys_file.path` 存**相对 UPLOAD_DIR 的路径**（`2026/08/21/报告_a1b2….pdf`），
`sys_file.name` 只是纯文件名。读写磁盘一律用 `path`，`name` 给展示和排障。

分目录不是为了「一个目录放不下」（ext4 有 dir_index，几十万文件也撑得住），
是为了三件事后补不回来的运维能力：按周期备份/归档/过期（`rsync upload/2026/07`）、
`ls`/`tar`/`find` 在几十万文件之后还能用、以及换对象存储后是同一套
（S3 的「目录」就是 key 前缀，日期前缀仍是惯例）。

- 日期目录**只由服务端拼**（`build_date_dir()`），客户端输入进不了这一段
- 用**本地时区**（`timezone.now()`）而不是 UTC —— 运维想的是「昨天」，
  不是「UTC 的昨天」
- 删除时**顺手回收空掉的日期目录**，否则跑几年会剩一堆空的 `YYYY/MM/DD`
- **老数据不用迁移**：`resolve_path` 是 `UPLOAD_DIR / file.path`，
  path 是裸文件名的老记录照样解析得到（实测混存下新旧都能下载、都能删）

### 🔴 `delete_file` 不能用 `strip_path()`

这是加日期目录时踩到的，**而且是静默的**：

```python
name = strip_path(relative_path)   # ← 把全部路径成分剥掉
```

`2026/08/21/x.docx` 会被剥成 `x.docx` → 指向 `UPLOAD_DIR` 根 → 文件不存在 →
`missing_ok=True` 一声不响地什么都没删。表现是「库里删干净了、磁盘越积越多」，
日志里连一条 warning 都没有。

越界防护要换成 `is_relative_to`：它**允许子目录、拦得住 `../../`**，
正是这里要的语义（`strip_path` 仍然用在**客户端文件名**上，那里剥路径是对的）。

`test_file.py` 里 `test_delete_removes_nested_file_and_prunes_dirs` 是这条的回归测试，
做过变异验证 —— 把 `strip_path` 打回去，它和批量删除那条会一起失败。

### 秒传去重的 key 必须带文件名

只按 `sha256` + `created_by` 去重会**丢掉用户起的名字**：把 `a.docx` 改名成
`季度报告.docx` 再传会命中旧记录、列表里仍显示 `a.docx`、按新名字还搜不到（实测）。
同内容不同名 = 两条记录、磁盘各存一份 —— 它们能被独立删除，**不能共享落盘文件**。

`/check` 也要接受 `name` 参数，否则它回答的问题和 `upload` 的去重口径不一致，
「命中」了却还是会重新传一份。

### 上传白名单是分类表，不是 if/else

`utils/file_ops.py: _upload_rules()` 返回 (分类, 扩展名, 大小上限, 人话名字)。
原来只有图片/视频两类且 `else: raise`，于是 pdf/docx/xlsx 一律「此文件格式暂不支持」。
写成函数而不是模块级常量 —— `settings` 会被 `sys_config` 在运行时 `setattr` 覆盖。

`FileType` 的 `other` 是兜底档：白名单放开了但没归类的扩展名落这里，不会因为漏配分类而拒传。

### 附件面板（`sys_file_relation` 的唯一入口）

```tsx
<FileAttachments targetType={NOTICE_ATTACHMENT_TARGET} targetId={notice.id} />
```

- **「移除」只解开关联、不删文件** —— 文件仍在「文件管理」里，可以再挂到别处。
  所以移除**不加二次确认**（误点的代价是重新挂一次）。真要删文件去文件管理页，
  那边会连带清掉所有关联
- `target_type` 后端**不校验**（新业务挂附件不改表不改后端），拼错不会报错、
  只会读到空列表 —— **必须走常量**（如 `NOTICE_ATTACHMENT_TARGET`），别在 JSX 里手敲字面量
- 挂载是**幂等**的（后端跳过已挂的），所以 `attach` 返回 0 是成功不是失败，
  接口层不能照抄别处的 `if count > 0 else fail()`
- 面板放**详情抽屉**而不是编辑表单：挂载需要 id，而新建表单在保存前还没有 id

### 雪花 ID 的类型账（既有欠账）

`SchemaBase` 的 `field_serializer` **只认字段名 `id`**。其他雪花字段声明成 `int` 时
openapi 生成 `number`，而编码层 `stringify_unsafe_ints` 运行时下发的是**字符串** ——
类型和运行时对不上。`sys_file` 的 `created_by` 已写成 `int | str`；
**`dept_id` / `parent_id` 那笔账还欠着**，改的时候记得连 `schema.d.ts` 一起重新生成。

> 入参方向不用改：pydantic 会把 JSON 字符串 `"2202…"` 无损转成 Python int
> （任意精度），所以前端必须发字符串、后端声明 `int` 是对的组合。

### 预览器是第三方包 `@file-viewer`（Apache-2.0）

我们只写了一层壳（`packages/ui/src/components/file-viewer/`），渲染 pdf / docx /
xlsx / pptx / 图片 / 文本 / 压缩包 / 音视频的是 `@file-viewer/renderer-*`（3.x）。
React 19 + Vite 8 实测无摩擦（peer 分别是 `react >=17 <20`、`vite >=5 <9`）。

**喂 `buffer` 而不是 `url`** —— 字节由调用方带 JWT 取回，viewer 只管渲染。
所以不需要「Redis 票据 + 短时效公开 URL」那一套，后端也没有无鉴权直链可给。
**音视频也走这条**：media renderer 把 buffer 转成对象 URL 交给 `<video>` / `<audio>`，
拖进度没问题（实测 wav / mp3 / mp4），代价是播放前要整块下载 —— 所以
`preview-dialog.tsx` 给音视频另设了 100MB 的硬上限（`MEDIA_MAX`），超过只给下载。
后端默认只收 20MB 以内的音视频，这条线是给 `.env` 调大上限之后兜底的。
真要边下边播得做带票据的 Range URL，还没做。

🔴 **图片按像素数拦，不按字节数拦。** 76KB 的 PNG 可以是 20000×20000，后端 5MB 的图片上限挡不住，
解码出来是 1.6GB。实测（Playwright · 生产构建）交给 viewer 时主线程最长卡顿：

| 样本 | 卡顿 |
|---|---|
| 图片 8000×6000（48MP，手机原图量级） | 191ms |
| 图片 12000×12000（144MP） | 548ms |
| 图片 20000×20000（400MP） | **5232ms** |
| 图片 30000×30000 | 浏览器解不了，renderer 自己报「预览失败」（不卡） |
| 日志 5 / 20 / 45MB | 79 / 65 / 72ms，1.7 秒内全部显示（3.x 的文本 renderer 是虚拟滚动） |

所以 `preview-dialog` 取回字节后先过 `image-dimensions.ts`（只读文件头），超过 150MP 只给下载。
线画在 144MP 之上 —— Orca 那条 32MP 照抄会把手机原图也挡掉。
**文本不需要另设门槛**：最初的计划是「按类型分档」，实测 45MB 日志都不卡，那一项删了。
单测用 Pillow 真编码的样本（`image-dimensions.test.ts`，变异过：JPEG 宽高读反当场红），
E2E 现造一张 20000×20000 的 PNG（`file-preview.spec.ts`）。

**只在可见处挂载** —— 放 Dialog / Sheet 里，别常驻页面。多页签用 `<Activity>` 保活，
隐藏 tab 是 `display:none`（宽度 0），而 renderer 要测容器尺寸（recharts 栽过同一个坑）。
关闭即卸载，**不要** `keepMounted`，顺带把 ArrayBuffer 让给 GC。

五个只有实测才知道的坑：

| 坑 | 症状 | 修法 |
|---|---|---|
| 没装 `@file-viewer/vite-plugin` | pdf.js 取 `/file-viewer/vendor/pdf/pdf.worker.mjs` 得 404。**viewer 外壳照常显示**，只有正文空白 + 一行 `Setting up fake worker failed` —— 像加载慢，其实是坏的 | 插件 + `copyAssets: { baseDir: 'file-viewer' }` |
| `inject: true` | 注册模块被注入 HTML 入口 → 每个 renderer 一条 `modulepreload`，**登录页预下载约 2.5MB** | `inject: false`，注册改在 `file-viewer/viewer.tsx` 里手动做，靠 `lazy(() => import('./viewer'))` 关进懒加载分片 |
| `chunkStrategy` 用默认的 `'renderer'` | JSZip / libarchive 被归进 `file-viewer-archive` 分片，入口用到一个共享符号就得拉整个 250KB | `chunkStrategy: 'none'`，交给 rolldown 自己分片（入口只静态 import 一个 4KB runtime） |
| `toolbar.position` 写了非法值 | **不报错**、运行时静默回落到默认位置 —— 看着像生效其实是巧合（`top-right` 踩过） | 只有 `auto｜top｜top-center｜bottom-right` 四个。表格类要用 `top-center`：底部有工作表页签，`bottom-right` 会把 `Print` 裁成 `…rt` |
| 🔴 3.x 下没设资源根目录 | **预览看起来全是好的**：PDF 照样画出来（pdf.worker 404 → 退回主线程跑 PDF.js，控制台一条 warning）；压缩包照样列目录（libarchive worker 404 → ZIP/TAR 兼容模式，界面一行小字）—— 只有 rar / 7z 打不开。2.3 → 3.2 升级时两处同时出现 | 3.x 的资产地址由插件**注入的运行时代码**调 `setDefaultFileViewerAssetBaseUrl` 设置，而我们 `inject: false`，没人调 → renderer 去站点根目录取 `/vendor/...`。`viewer.tsx` 里手动设，`"file-viewer"` 要和 `copyAssets.baseDir` 一致。守卫：`e2e/tests/file-preview.spec.ts`（断言资产请求都在 `/file-viewer/vendor/` 下 —— 只看「画出来没有」是假绿，兜底也画得出来；做过变异，去掉那行当场红） |

**不要换成 `preset-all` / `@file-viewer/*-full` 包。** 那会把 drawio(66MB) ·
typst(37MB) · cad(20MB) · iwork 全拷进 dist（实测 dist 60MB → 186MB），
而且在插件里 narrow `formats` 是**无效**的 —— `-full` 包静态依赖 `preset-all`，
整个 renderer 图已经在模块图里了。

**增删 renderer 要动三处**，少一处就出错：
`file-viewer/viewer.tsx` 的 import + 数组 · `apps/web/vite.config.ts` 的 `renderers`
（决定 copyAssets 发布哪些资产）· `pages/file/api.ts` 的 `PREVIEWABLE`
（决定界面上哪些能点预览）。三处的名字还不是一套：

- `viewer.tsx` 一律**具名**导入插件（`pptxRenderer`…）。`renderer-pptx` 的默认导出是渲染函数
  `renderPptx`，不是插件 —— 其余几个包的默认导出才恰好是插件，照着抄就中招
- `vite.config.ts` 写的是插件自己的 id：pptx 那条叫 `presentation-openxml`
  （写 `presentation` 会连旧版 .ppt 的 WASM 和字体一起拉进来）
- 3.x 把几样东西改成了**另装的 capability**，没装时 renderer 只显示一行安装命令：
  RTF（`capability-rtf`）、Mermaid、HLS（`.m3u8`）、MIDI。所以 `PREVIEWABLE` 里刻意没有 `rtf`，
  后端白名单里的 `ppt` / `mov` / `avi` / `flv` / `mkv` 也没列（理由写在 `PREVIEWABLE` 上面）

> 插件 3.x 默认开着 `stabilizeInteropChunks`：入口里那 1.5KB 的 `w3c-keyname` 被拆成独立的
> `vendor-codemirror` 分片、多一条 modulepreload。**字节没变**（入口 chunk 实测 -454B），
> 只是多一个请求 —— 别以为是 renderer 漏进了入口。

> viewer 渲染在 **Shadow DOM** 里（3.x 由 `styleIsolation: "shadow"` 决定，外壳里写死了；
> shadow root 挂在 viewer 自己的根节点上，2.x 的 `.file-viewer-web-shell` 宿主类名已经没了）。
> 样式与 Tailwind 天然隔离是好事；代价是 `page.evaluate` 里的 `document.querySelector` 穿不进去 ——
> 写 E2E 要用 Playwright 自己的 locator（它会自动穿透 shadow）。
> 实测第一次探测时 host 的 `innerHTML` 只有 63 字符，差点误判成没渲染。
>
> 工具栏语言由 `FileViewer` 的 `locale` prop 决定，不传是 `auto`（跟浏览器走）。
> 用户在系统里选的语言可能和浏览器不同，所以 `preview-dialog` 把 `i18n.language` 传进去。

## 🔴 私有文件谁能读：不是「登录了就行」

`GET /sys/files/{id}/download`、`GET /sys/files/{id}`、`GET /sys/files/targets/...` 原来只要登录 ——
雪花 ID 不是秘密（URL、日志、审批单的表单数据里都有），拿到 ID 就能下载任何人的私有文件。

现在走 `file_service.can_read`：公开的 · 自己传的 · 文件管理员（`sys:file:list`）· **业务模块登记的判断**
（`register_file_access`）任一成立才给，读不了一律 **404**（403 等于告诉对方 ID 存在）。
文件模块是底座、不 import 业务插件：通知公告（挂在没删的公告上）和审批（能看这张单、且那个附件字段对他
不是 hidden —— 和详情接口同一个 `_viewer()`）各自在自己的 service 里登记。

🔴 **取文件要 `bypass_data_scope()`。** 这几个接口只挂登录，而 `CRUDFile` 按数据范围过滤 ——
种子里 STAFF 那种「开了过滤、一个范围都没配」的角色**一个文件都看不见**：改之前普通员工就已经
下不了公告附件（实测 404，只有管理员测过下载，所以一直没暴露）。能不能读由 `can_read` 决定。

测试 `app/admin/tests/api_v1/test_file_access.py` + `plugin/workflow/tests/test_attachments.py` 末尾。
变异验证：恢复「登录即可」/ 去掉 bypass / 审批那支不看 hidden，各自对应的测试红。

⚠️ 写下载类测试时上传内容要带随机串：上传按「同一人 + 同名 + 同内容」秒传复用**上一轮**的记录，
它指向的 tmp 目录早没了，下载 404 —— 看起来像是权限拦的。

