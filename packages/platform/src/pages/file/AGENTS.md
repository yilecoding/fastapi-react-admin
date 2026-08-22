# 文件管理与附件预览

> `sys_file` + `sys_file_relation`。**这一页刻意不用 `DataTable`** —— 它是文件管理器不是列表页。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

## 文件管理与附件预览

两张表：`sys_file`（物理文件）+ `sys_file_relation`（挂在谁身上）。
**刻意没做**存储抽象（`sys_storage`，S3/MinIO）和个人云盘（目录树 / 分享 / 配额）——
两者后加都不用改已有代码，所以也没留 `storage_id` 这种休眠字段。

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
└─ attachments.tsx    **可复用的附件面板**，任何页面给 targetType + targetId 就能嵌
```

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
xlsx / 图片 / 文本 / 压缩包的是 `@file-viewer/renderer-*`。React 19 + Vite 8 实测无摩擦
（peer 分别是 `react >=17 <20`、`vite >=5 <9`，零 peer warning）。

**喂 `buffer` 而不是 `url`** —— 字节由调用方带 JWT 取回，viewer 只管渲染。
所以不需要「Redis 票据 + 短时效公开 URL」那一套，后端也没有无鉴权直链可给。
（例外：音视频要 Range 拖进度，整块 ArrayBuffer 拖不动，那类得走真实 URL。）

**只在可见处挂载** —— 放 Dialog / Sheet 里，别常驻页面。多页签用 `<Activity>` 保活，
隐藏 tab 是 `display:none`（宽度 0），而 renderer 要测容器尺寸（recharts 栽过同一个坑）。
关闭即卸载，**不要** `keepMounted`，顺带把 ArrayBuffer 让给 GC。

四个只有实测才知道的坑：

| 坑 | 症状 | 修法 |
|---|---|---|
| 没装 `@file-viewer/vite-plugin` | pdf.js 取 `/file-viewer/vendor/pdf/pdf.worker.mjs` 得 404。**viewer 外壳照常显示**，只有正文空白 + 一行 `Setting up fake worker failed` —— 像加载慢，其实是坏的 | 插件 + `copyAssets: { baseDir: 'file-viewer' }` |
| `inject: true` | 注册模块被注入 HTML 入口 → 每个 renderer 一条 `modulepreload`，**登录页预下载约 2.5MB** | `inject: false`，注册改在 `file-viewer/viewer.tsx` 里手动做，靠 `lazy(() => import('./viewer'))` 关进懒加载分片 |
| `chunkStrategy` 用默认的 `'renderer'` | JSZip / libarchive 被归进 `file-viewer-archive` 分片，入口用到一个共享符号就得拉整个 250KB | `chunkStrategy: 'none'`，交给 rolldown 自己分片（入口只静态 import 一个 4KB runtime） |
| `toolbar.position` 写了非法值 | **不报错**、运行时静默回落到默认位置 —— 看着像生效其实是巧合（`top-right` 踩过） | 只有 `auto｜top｜top-center｜bottom-right` 四个。表格类要用 `top-center`：底部有工作表页签，`bottom-right` 会把 `Print` 裁成 `…rt` |

**不要换成 `preset-all` / `@file-viewer/*-full` 包。** 那会把 drawio(66MB) ·
typst(37MB) · cad(20MB) · iwork 全拷进 dist（实测 dist 60MB → 186MB），
而且在插件里 narrow `formats` 是**无效**的 —— `-full` 包静态依赖 `preset-all`，
整个 renderer 图已经在模块图里了。

**增删 renderer 要动三处**，少一处就出错：
`file-viewer/viewer.tsx` 的 import + 数组 · `apps/web/vite.config.ts` 的 `renderers`
（决定 copyAssets 发布哪些资产）· `pages/file/api.ts` 的 `PREVIEWABLE`
（决定界面上哪些能点预览）。

> viewer 渲染在 **Shadow DOM** 里（`.file-viewer-web-shell`）。样式与 Tailwind
> 天然隔离是好事；代价是 `page.evaluate` 里的 `document.querySelector` 穿不进去 ——
> 写 E2E 要用 Playwright 自己的 locator（它会自动穿透 shadow）。
> 实测第一次探测时 host 的 `innerHTML` 只有 63 字符，差点误判成没渲染。
