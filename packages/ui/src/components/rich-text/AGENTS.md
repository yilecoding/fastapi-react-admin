# 富文本编辑器

> Tiptap 封装 + 内联图片。图片能力由 `platform` 注入，后端那棵公开子树的约定也记在这里。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

## 富文本里的图片（`ui/components/rich-text` + 公开子树）

正文存 HTML，图片存的是**真链接**：`<img src="/uploads/2026/08/22/x.png" data-file-id="220…">`。

### 🔴 为什么必须有一条无鉴权的读取路径

`<img src>` 带不上 Authorization 头（access token 走 `HTTPBearer`，cookie 里只有
refresh token），所以 `/sys/files/{pk}/download` 只会给 401；而 blob URL 活不过一次
刷新，存进 `NVARCHAR(MAX)` 就是死链。base64 更不行 —— 公告**列表接口返回完整
`content`**，一张 300KB 截图变 400KB base64，20 行就是 8MB 响应。

所以后端开了一棵**独立的公开子树**：

| | 目录 | 怎么读 |
|---|---|---|
| 私有（现状） | `UPLOAD_DIR` = `backend/upload/` | `GET /sys/files/{pk}/download`（JWT） |
| 公开（仅内联图） | `PUBLIC_UPLOAD_DIR` = `backend/upload-public/` | `/uploads/<path>` 静态挂载，**不鉴权** |

两棵树**物理分开**而不是在 `UPLOAD_DIR` 里开个 `public/` 子目录：共用一个根就只剩
「谁记得别给根目录加 mount」这一道纪律在守着，而这条纪律已经被破掉过一次
（`/static` 覆盖 `/static/upload`，实测删了那条 mount 还是 200）。

### 🔴 `?public=true` 只能接在富文本的上传路径上

后端只强制「公开的必须是图片」（`file_service.verify_public`），**反过来不成立** ——
文件管理页传的身份证扫描件也是图片。公开性是上传时的显式选择，不是分类的推论。

所以前端拆成两个函数而不是一个带参数的：`useUploadFile()`（私有）和
`uploadInlineImage()`（公开）。通用上传路径**在类型上就产生不了公开文件**。
**绝不要把 `public=true` 接到「文件管理」页那个上传按钮上。**

### `is_public` 要贯到四个地方，漏一个都静默出错

| 地方 | 漏了的表现 |
|---|---|
| `upload_file(public=)` | 落错树 |
| `resolve_path()` 选根 | 公开图走鉴权下载接口一律 404 |
| `delete_file(public=)` | **库里删了、盘上留孤儿，连 warning 都没有**（`missing_ok=True` 静默成功） |
| `get_by_sha256(is_public=)` | 秒传串树：命中私有旧记录 → `public_url` 是 `None` → 裂图；命中公开旧记录去满足私有请求 → **私有文件被按公开直链下发，这个方向是安全问题** |

### src 必须是**相对**路径，dev 靠 Vite 代理

`/uploads/…` 不带 host。`apps/web/vite.config.ts` 有一条 `/uploads` → API 的
`server.proxy`；生产同域天然可用。写成绝对地址就等于把 `http://127.0.0.1:8000`
烙进 `sys_notice.content`，换环境全部裂掉。
落盘名允许 CJK，所以 `public_url` **必须 percent-encode**（`quote(path, safe='/')`——
不留斜杠会把日期目录分隔符编成 `%2F`，静态挂载直接 404）。

### 防孤儿：`NOTICE_CONTENT` 关联

内联图会写 `sys_file` 但不会自动挂 `sys_file_relation` —— 公告删了图就永远留在磁盘和
文件管理里。保存时按正文里的 `data-file-id` diff 挂/卸（`useSyncNoticeImages`）。
用 `NOTICE_CONTENT` 而不是共用 `NOTICE`：正文里十几张图全涌进详情抽屉的「附件」
会把那个概念冲掉。三条：挂载幂等（返回 0 是成功）· 卸载只删关联不删文件 ·
**同步失败不能往上抛**（正文已经存进库了，报「保存失败」会让人再存一遍）。

> `POST /sys/notices` 因此改成**下发创建结果**（原来是空 `success()`）——
> 拿不到 id 就没法给新公告挂关联。
> ⚠️ `create_model` 默认**不 flush**，`id` 是数据库生成的：不加 `flush=True` 就返回，
> 序列化响应直接 500（`('response','data','id') Input should be a valid integer`，实测踩到）。

### 编辑器侧的四个坑

- **上传占位用 ProseMirror widget decoration，不要往文档里插节点。** 插节点它就会进
  `getHTML()` → `onUpdate` → `form.setValue`，用户在上传没结束时点「发布」，
  存进库的就是一个永远转圈的假节点。decoration 只活在视图层，`getHTML()` 看不见它。
  插件里 `set.map(tr.mapping, tr.doc)` 那一行是全部意义 —— 上传期间用户照常打字，
  不映射位置图就插到句子中间去了。占位找不到（用户撤销了）就**丢掉结果**，别硬插
- **状态提示存结构化数据，`t()` 推到渲染处。** 在事件回调里拼好字符串，会话内切语言
  之后那句话会停在旧语言上（`useMemo` deps 漏 `t` 是同一个 bug 的另一种面目）
- **清提示放在「新动作入口」，不要放在「每个文件成功之后」。** 放成功分支里有两个后果：
  一次粘 5 张第 2 张挂了、第 3 张成功就把失败提示抹了；更糟的是它会清掉**别的来源**的
  提示（「已移除 N 张外链图片」是粘贴时报的、跟上传无关），表现成这条警告**时有时无**，
  取决于上传比下一次粘贴快还是慢 —— e2e 里间歇失败，抓了三轮日志才定位到
- **FileHandler 要在 effect 里用 `FileHandlePlugin` 注册，不能塞进扩展数组。**
  扩展数组只在编辑器创建时求值一次（`useEditor` 的 deps 是 `[]`），塞进去的 `onPaste`
  会永久闭包在首次渲染上

### 工具栏不能裸读 `editor.isActive()`

Tiptap v3 把 `useEditor` 的 `shouldRerenderOnTransaction` 默认改成了 `false`，
于是渲染期裸读只在**父组件**重渲染时才更新：打字时因为
`onUpdate → form.setValue → 父级 setState` 绕了一圈凑巧能刷新，但**只移动光标**
（点进一个 H2 或加粗词里）不产生 update，按钮就不亮 —— 一个只在「不打字」时出现、
看起来像随机的 bug。一律走 `useEditorState`（默认 equalityFn 是深比较，返回新对象没代价）。

### 其余约定

- 外链图（从 Word / 网页粘进来）在 `transformPastedHTML` 里**剥掉 + 给可见提示**。
  浏览器里转存不了（CORS），而留着它会随对方删除而裂、且每次浏览都在给第三方发请求。
  只作用于**粘贴**，不碰 `setContent` 加载的库里既有内容 —— 静默改写用户存过的东西更糟
- `allowBase64` 保持 `false`：它让 `parseHTML` 用 `img[src]:not([src^="data:"])`，
  粘贴来的 base64 内联图在解析阶段就没了，白拿一道防线
- **`Image` 扩展 Viewer 也要装**。少了它 schema 里就没有 img 节点，库里存好的图会在
  解析阶段被静默丢掉 —— 编辑时看得见、发布后看不见
- `PROSE` 的 `[&_img]:max-w-full` 和 `h-auto` **必须成对**：3.30 的 Image 自带 resize，
  拖角会把 `width`/`height` 一起写成属性，只钳宽度会把图压扁。
  图片**没接对齐**是刻意的，理由见 `prose.ts` 里那段注释
- `richTextToPlain(html, max, imageLabel)` 的第三个参数不能省。
  默认会把 `<img>` 连标签一起吃掉，于是**纯图片的公告在列表里是空单元格**，像数据坏了
- 客户端体积闸门（`INLINE_IMAGE_MAX_BYTES` 2MB）只是「别把注定被拒的字节先传一遍」，
  **服务端才是权威**（`UPLOAD_IMAGE_SIZE_MAX` 还会被 `sys_config` 在运行时覆盖）
- 没有 `sys:file:upload` 权限时**抛错而不是藏按钮**：藏了粘贴路径就变成静默失败
  （硬纪律 9），粘一张截图什么都不发生，用户以为是自己操作错了
