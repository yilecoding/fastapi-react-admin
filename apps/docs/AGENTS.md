# apps/docs —— 公开文档站（Astro Starlight）

> 发到 GitHub Pages 的**根路径**（<https://yilecoding.github.io/fastapi-react-admin/>），
> E2E 报告挂在它的 `/e2e/` 下。存在的理由是 SEO / GEO：给搜索引擎和 AI 助手一份
> **静态 HTML** 的、可以引用的项目介绍 —— 后台本身是登录墙后的单页应用，爬虫什么都看不到。
>
> 这份文件是根 [`CLAUDE.md`](../../CLAUDE.md) 的**模块分册**，Claude Code 读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律只在根
> `CLAUDE.md` 里有一份；**新增结论请追加到离代码最近的那一份**。

```bash
pnpm docs:dev                       # http://localhost:4321/fastapi-react-admin/
pnpm --filter @admin/docs build     # 产物在 apps/docs/dist；pnpm build（turbo）也会带上它
pnpm --filter @admin/docs og        # 换了截图或品牌色后重新生成分享卡片 public/og.png
```

刻意**没有 `dev` 脚本**（叫 `start`）：`pnpm dev` 是 `turbo dev`，谁声明了 `dev` 就一起起，
写文档的时候才需要它。和 `apps/mobile` 同一个理由。

## 发布：文档站和 E2E 报告拼成一个 artifact

CI 的 `pages` job（只在 `main` 上跑）先构建本站，再把 E2E job 上传的 `playwright-report`
下载进构建产物的 `e2e` 子目录，**整个 `dist` 作为一个 artifact** 发出去。

🔴 **不能拆成两个 job 各发各的。** Pages 每次部署都是整站替换，后发的那个会把先发的抹掉。

⚠️ E2E job 在装环境阶段就挂了的时候没有报告可下：下载那步是 `continue-on-error`，
`/e2e/` 换成一页「本次没有报告」的说明，文档站照发。报告页同时被注入
`noindex` —— 它和文档站同域，不拦的话「Playwright Test Report」会作为本站的一页被收录。

⚠️ `checkout` 要 `fetch-depth: 0`：每页底部的「最后更新」读 git 历史，浅克隆下每一页都是「今天」。

🔴 **`pnpm-workspace.yaml` 里的 apps 是逐个列名的，不是 `apps/*`。** 建这个包时漏了那一行，
表现全是绿的：`pnpm add` 照常成功，锁文件里也有 `apps/docs` 这个 importer，`pnpm build`
在包目录里也能跑 —— 但 turbo 报 `No package found with name '@admin/docs'`，也就是说
CI 的 `pnpm build` **根本不会构建它**，pages job 的 `--filter @admin/docs` 也匹配不到。
新加一个 app 时先确认 `pnpm -r ls --depth -1` 里有它。

## 国内那一份：挂在 fra.wubunan.com/docs/

GitHub Pages 在国内访问慢、百度基本收录不到，所以同一份文档还挂在自己的服务器上。
`base` 是构建期写死的（`DOCS_SITE` / `DOCS_BASE` 两个环境变量），CI 的 pages job 先按
`/docs` 构建一份打成 `docs-site.tar.gz`，再按 Pages 的路径构建正式那份，包放进 Pages 一起发。
服务器上（宝塔站点 `fra.wubunan.com`，主配置把 `/` 整个反代到 web 容器）：

- nginx 规则放在站点的扩展目录 `/www/server/panel/vhost/nginx/extension/fra.wubunan.com/docs.conf`，
  **不改主配置**：`location ^~ /docs/` 指向站点目录下的 `docs/`（`^~` 压过主配置里那几条按扩展名的正则），
  再给一个 `location = /robots.txt`：只放行 `/docs/`、其余（后台本身）一律不收录，并指向 sitemap
- 更新就是拉包解压：
  ```bash
  cd /www/wwwroot/fra.wubunan.com && rm -rf docs.new && mkdir docs.new \
    && curl -fsSL https://yilecoding.github.io/fastapi-react-admin/docs-site.tar.gz | tar xz -C docs.new \
    && rm -rf docs.old && { [ -d docs ] && mv docs docs.old || true; } && mv docs.new docs
  ```

⚠️ 两份站点内容相同、canonical 各指各的域名。主推国内，所以提交百度站长平台的是
https://fra.wubunan.com/docs/ ；Google / Bing 两份都可能收录，算重复内容但不算作弊。

## 写内容

页面在 `src/content/docs/`（简体中文，根路径 —— 先推国内）和 `src/content/docs/en/`（英文）。
浏览器语言不是中文的访客进中文页，右下角会出「Read in English」提示（`astro.config.mjs` 的 `EN_HINT`），
**只提示不跳转**：按地区 / 语言自动跳转会让爬虫只看得到一种语言。
**两种语言都写**：缺译的页面 Starlight 会用英文顶上，但顶上去的那一页是同内容换 URL。

GEO 调研（2026-10-31）得出的写法 —— 依据是 KDD 2024 的 GEO 论文（arXiv 2311.09735）和
Google 的 AI features 文档：

- **标题和小标题写成人会问的问题**，每节第一段直接给答案
- **具体**：真实的文件路径、行为、数字，源码用完整 GitHub 链接指过去。论文实测里
  「加引用原话 / 加统计数字 / 注明出处」让 AI 回答里引用的篇幅涨了 28%～41%，
  而**堆关键词是 −8%**
- 数字只写仓库里查得到出处的。测试条数和 README 同源 —— **改 README 的数字时这里一起改**
- 只写 `main` 上已有的功能；不评价别的项目
- `description` 会成为 meta description 和分享卡片的摘要，写成一两句具体的话

## 功能页：按任务组织 · 分组登记 · 总览和 README 同步（#285）

`features/` 下每一页先说明读者能完成什么，再按实际操作组织（样板是 [`login-security.mdx`](src/content/docs/features/login-security.mdx)）。
调研过 vben / RuoYi-Vue-Plus / FBA / Refine / react-admin 的文档站，几家都只写给开发者；
管理员操作放在前面，开发细节放在后面；内容过长时可拆成互相链接的任务页与配置参考页，**不复制维护同一份参数表**。下面是需要覆盖的内容，不要求每页机械地重复所有章节：

| # | 章节 | 写什么 |
|---|---|---|
| 1 | 开头一段 + 界面预览 | 一段话说清能做什么；`ProductShot` 可放在折叠预览中，避免大图挡住操作步骤。属于插件的写明插件名 |
| 2 | 在界面上哪里找？ | 表：入口（菜单路径）· 路由 · 谁能用（**权限码**，或写明按超级管理员判）· 做什么 |
| 3 | 若干问题式小标题 | 按管理员要完成的事组织，不按代码模块 |
| 4 | 有哪些开关？ | **两张表**：参数配置页能改的（界面上改、不用重启）和只能 `.env` 改的。键 · 默认值 · 说明。默认值抄 `conf.py` 和参数配置的种子 SQL，别凭印象 |
| 5 | 加 xxx / 接自己的业务要注意什么 | 扩展点；没有就写不支持 |
| 6 | 它不做什么 | 已知限制。**核对时发现的代码缺口也写在这里**（如密码到期提醒网页端没显示），不要替代码圆 |
| 7 | 代码在哪 · 怎么测的 | 完整 GitHub 链接（上面那道检查会核对）；测试写文件名、条数和它证明了什么 |
| 8 | 在演示站里试试 | 推荐一条操作路径；演示站是共用的，会影响别人的操作要提醒 |

教程按「执行目录 → 前提 → 编号步骤 → 当步验收 → 常见问题 → 下一步」组织；删除或覆盖数据的提醒放在命令**之前**。折叠块用于可选排查和实现细节，必做步骤、权限和已知限制保持可见。拆页保留原 URL 和已有锚点，原位置放指向新内容的链接。

🔴 **内页的顶部分类和左侧文章来自同一份登记表**：`src/navigation.mjs` 的 `DOC_SECTIONS`。
左侧只平铺当前分类的文章；原有页面路径保持不变，不能为了分类移动内容文件，否则已有链接会 404。
手写分类的失败方式是「新加一页忘了登记」：页面能访问、导航里没有、构建全绿。
`astro.config.mjs` 的 `checkDocSections()` 会核对中英两份**全部文章**（首页除外）恰好登记一次，
漏页、重复登记或缺译都会让构建失败。新增页面时同时补中英文内容和登记表。

**总览页（`features/overview.md`）和 README「功能一览」逐行对应。** 改 README 那张表时一起改这里，
和测试条数同源是同一条规矩 —— 建这条规矩时两边已经漂开了（总览漏了 MFA、会话管理、Webhook、AI 预审）。
第二张表「在哪个菜单 / 哪个插件 / 手机 App 支持到哪」里的手机一列，要对着 `apps/mobile/src/app/` 下实际有的屏写。

## 🔴 站内链接：正文写 `/xxx/`，但组件和 frontmatter 里不行

站点挂在 `/fastapi-react-admin` 子路径下，Astro 只给自己生成的链接（侧边栏、上下篇、
语言切换）补 base。`astro.config.mjs` 里的 remark 插件把**正文** markdown 里以 `/` 开头的
站内链接补上 base，所以正文照常写 `/features/multi-tab/`、`/en/features/multi-tab/`。

**插件管不到的两处**，实测都是生成了不带 base 的 `href`（点进去落在 yilecoding.github.io 域名根下，404）：

| 位置 | 例子 | 写法 |
|---|---|---|
| frontmatter 里的 `hero.actions[].link` | 首页「快速开始」按钮 | 相对链接（去掉开头的斜杠） |
| MDX 组件属性 | `<LinkCard href="…">` | 同上 |

首页的 URL 以 `/` 结尾，相对链接在中英文首页下都能解析对。

**这些错法 Astro 构建全部放行**，所以 `build` 脚本后面接了 `scripts/check-links.mjs`：
扫 `dist` 里每一页的站内 `href` 和 `#锚点`，漏了 base、页面不存在、锚点不存在都会让构建失败，
PR 的 CI（`pnpm build`）就会红。反向验证过：把一页里的一条链接改成不带 base，它报
「没带 /fastapi-react-admin，会落到域名根上」并退出 1。外链不查（网络抖动会把它带红），
`/e2e/` 不查（CI 的 pages job 在构建之后才拼进来）。

**例外：指向本仓库 `main` 的源码链接要查**（#285）—— `github.com/yilecoding/fastapi-react-admin/blob|tree|edit/main/<路径>`
指向的就是这份检出，离线核对 `<路径>` 在不在，不联网。功能页靠「代码在哪」那一节和代码对上，
文件改名或挪目录之后这些链接照样 404，而原来的检查把它们当外链放过了。每页底部的「编辑此页」
也是这种链接，所以顺带核对了每一页的源文件。2026-11-10 第一次接上时全站 422 条都有效；
反向验证：把一页里指向 totp.py 的链接改成一个不存在的文件名，报「仓库里没有 …」并退出 1。

## 🔴 Astro 锁在 7.3.x —— 7.4 抬高了 Node 下限

`astro@7.4.4` 要求 Node **≥ 22.23.4**（7.4.0 起是 ≥ 22.22），而仓库的 `engines` 是 ≥ 22.13。
`pnpm build` 会经 turbo 构建本站，所以升到 7.4 就等于把**整个仓库**的 Node 下限抬上去 ——
实测在 22.23.3 上直接报 `Node.js v22.23.3 is not supported by Astro!` 退出。
要升，先在根 `package.json` 的 `engines` 和 CI 的 Node 版本上做决定。

⚠️ 正文用了 remark 插件，就必须装 `@astrojs/markdown-remark`：Astro 7 默认的 Markdown
处理器换成了 Sätteri，不装的话构建直接失败（报错会提示装它）。

⚠️ 侧边栏分组写成 `{ label, items: [{ autogenerate: { directory } }] }` ——
Starlight 0.39 起不再支持 `autogenerate` 和 `label` 写在同一层。

## 视觉：和后台、登录页同一套品牌

- 正文表格沿用 Starlight 的 `display: block; overflow: auto`，圆角外框配 `width: fit-content; max-width: 100%`。否则外框占满正文、表头只占实际列宽，短表右侧就会留下大块空白。实测登录安全页的二次验证表修前外框 720px、表头 283px；修后外框 285px、表头 283px。显式的 `.doc-table-scroll` 宽表仍铺满容器，小屏只在表格区域滚动。
- **主题**在 `src/styles/theme.css`：品牌紫 + Inter / JetBrains Mono（`@fontsource-variable` 自托管 ——
  不走 Google Fonts，国内打不开会卡住首屏）。⚠️ Starlight 的 `:root` 是**深色**、浅色挂在
  `:root[data-theme='light']`，和后台的 `.dark` 方向相反，从后台抄颜色时别抄反
- **首页**覆盖了 Starlight 的 `Hero`（`astro.config.mjs` 的 `components`）。2026-11-05 改成「克制」路线：
  不套渐变面板，白底大留白 + 立体榫卯（`src/components/TenonStage.astro`）+ 几圈发丝细的同心圆（外加一圈慢转的刻度、两颗绕行的光点和一片点阵底），
  按钮一种墨色，技术栈是带色点的小标签。榫卯轮廓**直接 import**
  `apps/web/src/components/tenon-outline.ts`，不抄坐标 —— 改了图形，侧边栏、登录页、这里和收尾的水印一起变
- 首页其余几块都在 `src/components/`：`SectionTitle`（左对齐标题 + 右侧「看文档」）· `Showcase`（特色场景卡片）·
  `Diagram*`（多端界面切换 / 角色范围切换 / AI 工程保障）· `FeatureLine`（发丝线隔开的小功能）· `Closing`（水印 + 终端卡片）。
  文案一律从页面的 MDX / frontmatter 传进去（`landing` 字段是 `src/content.config.ts` 里扩出来的），
  组件里不写给人看的话 —— 中英文各管各的，图示里的字也走 props
- hero 正下方是 `ProductTour`：真实截图自动轮播 + 一排带进度的页签（2026-11-11，原来压在页面最底部的「截图」一节挪上来的）。
  **用截图、不用 HTML 画假后台**：截图重拍就和真界面对上，画出来的没有东西能核对。不放 `dashboard.png` —— 下面多端展示已经用了它
- ⚠️ `ProductTour` 的翻页节拍是 CSS 动画（当前页签那条进度），脚本只听 `animationend`。所以悬停 / 滚出屏幕时的暂停
  是 `animation-play-state`，减少动效时进度条没有动画、自然不自动翻。**别改成 `setInterval`**，那三种情况都得自己再管一遍。
  实测（1440 宽）：停在视口里 7 秒后从第 1 张翻到第 2 张，地址栏和说明跟着换
- ⚠️ 手机上把当前页签挪到中间只能动页签带自己的 `scrollLeft`：`scrollIntoView` 会在自动翻页时把整页也拽着滚
- 首页各块滚动时浮现（脚本在 `Hero.astro` 末尾）。隐藏态挂在脚本加的 `:root.reveal-on` 上 —— 脚本没跑（爬虫、禁用 JS、减少动效）
  时内容直接可见。**不要把 `opacity: 0` 写成默认样式**，那样脚本一挂就是一页空白，而且构建和链接检查全绿
- ⚠️ `DiagramMonorepo` 的共享包高亮是各客户端 `package.json` 里**真实**的直接 workspace 依赖，改了依赖要同步组件里的映射
- 多端展示的 Web 画面直接用 `docs/screenshots/dashboard.png`；桌面复用该画面。手机是按
  `apps/mobile/src/components/brand-top.tsx`、`grouped.tsx` 和原生首页还原的示意，注明非设备实拍；
  调整这块时对照现有客户端界面与 `features/clients.md`，不要为三端杜撰同一套仪表盘
- ⚠️ hero 的同心圆和收尾水印会伸出内容列：横向溢出裁在 `.main-frame` 上（`overflow-x: clip`）。
  裁 `html` / `body` 没用 —— 那会传给视口变成 `hidden`，实测 `scrollTo` 照样横移 230px（触屏能不能拖没测）
- ⚠️ 只给首页加样式时选择器挂在 `:root[data-has-hero]` 上（Starlight 只给带 hero 的页加这个属性），
  否则会漏到功能页里
- ⚠️ 顶栏要写 `header.header`：Starlight 里外两层都叫 `.header`，裸写会把那道渐变线画到里层，
  实测是一截只从搜索框画到右边的线

## 截图怎么重拍（`docs/screenshots/`）

README、文档站首页和分享卡片（`og.png`）用的是同一批图，界面一改就该重拍 ——
2026-11-01 发现首页截图还停在 08-26，工作台改版（#203）后已经完全对不上。
**用一套隔离的环境拍**，别拿自己的开发库随手截：

1. 在现有 PostgreSQL 里建一个单独的库（如 `fba_shots`），Redis 号全被占时起一个一次性容器；
   所有进程用环境变量覆盖 `DATABASE_SCHEMA` / `REDIS_PORT` / `REDIS_PASSWORD`
2. `pnpm db:init`：非交互时必须给 `FBA_INIT_ADMIN_PASSWORD`（种子里的 admin/123456 不许留下）。
   种子里 admin 的昵称是「用户88888」，截图前只在这个库里改成「系统管理员」
3. 起 api 时加 `REQUEST_LIMITER_ENABLED=false`：造数据要连着登录好几个账号，第 9 个就 429 了
4. 造数据走接口（发起 / 审批请假、发公告），访问柱状图读 `sys_login_log`，直接插近 14 天的记录
5. 拍：`SHOTS_PASSWORD=… pnpm --filter web screenshots`（`apps/web/scripts/screenshots.mjs`，
   登录、逐页摆好状态、七张一次拍完；前端地址 / 取验证码的命令都能用环境变量换，见脚本头注释）。
   拍完跑 `pnpm --filter @admin/docs og` 更新分享卡片
6. 造的数据隔几天再拍会显示「4 天前到你这」：把 `wf_instance` / `wf_task` / `wf_action_record` /
   `sys_notification` / `sys_notice` 的时间列整体往后挪，只在拍图库里改

🔴 **截图要 2 倍图（视口 1600×960、`deviceScaleFactor: 2`，出 3200×1920），而且不做调色板量化。**
症状：首页和 README 的截图在 Mac / 高分屏上发糊。根因有两层：原来那批是 1 倍图又压成了 255 色的
调色板 PNG；`ProductShot` 的候选宽度最大只到 1600，而内容列 68rem 在 2 倍屏上要 2176 物理像素，
浏览器只能拿 1600 那张放大 1.36 倍。修法：脚本出 2 倍真彩 PNG，`ProductShot` 的候选宽度补到
2400 / 3200、webp 质量提到 90。
实测（1440 宽、2 倍屏的 Playwright，看 `currentSrc` 再量那个文件）：线上旧站选中的是 1600×960 那张、
显示在 1088 CSS 像素宽的框里；修后选中 2400×1440 那张。并排截图里修前的字边明显发虚。代价是体积：PNG 一张约 0.25–0.5 MB（登录页的渐变大，
1.6 MB），文档站发出去的 webp 2400 宽一张约 150 KB

🔴 **浏览器要开 `http://127.0.0.1:8888`，不能开 `localhost:8888`。** 前端默认直连
`http://127.0.0.1:8088`（`packages/platform/src/api-client/client.ts` 的 `API_BASE`），
从 localhost 打开时那是跨站请求，刷新令牌的 cookie 浏览器根本不存 —— 登录能成功，
**一整页跳转就回到登录页**（实测：登录后 `context.cookies()` 是空的，`/auth/refresh` 401）。

🔴 **找页面里的元素要限定在当前页签里**（根 `CLAUDE.md` 硬纪律 5）：隐藏页签的 DOM 还在，
实测 `getByText('部门及以下数据权限')` 命中的是角色页里那段说明文字，点了 30 秒点不动。
按 `[data-tab="/_auth/…"]` 限定；另开新页签的页面（流程设计器）用 `[data-visible="true"]`。

### 功能页首图（#285）

功能页的首图也出自同一个脚本（后半段，每张一个干净会话）。除了上面的造数据，它们还要：

| 图 | 要的数据 / 参数 |
|---|---|
| `online` | 几个演示账号**用浏览器**同时登着 —— 页面默认只列有实时连接的会话，接口登录造的会话不显示。脚本按 `SHOTS_DEMO_USERS`（默认 zhoumin,sunqiang,zhaolei，密码 `SHOTS_DEMO_PASSWORD` 默认 123456）自己开上下文登录 |
| `log-change` | 改过几次部门名、参数配置（走接口，才有数据变更记录） |
| `file` · `notice` · `open-app` | 传几个文件、发几条公告、建一两个开放应用 |
| `dept-import` | `SHOTS_IMPORT_FILE` 指向一份按模板填的 xlsx，最好有将新增的行也有出错的行 |
| `monitor-redis` | 拍之前等 20 秒左右攒出趋势点 |

🔴 **不拍「服务器监控」**：那一页有主机名、局域网 IP 和**带本机用户名的解释器路径**（`/home/<你>/…/.venv/bin/python`），
进了公开文档就是泄露。监控页的首图用 Redis 监控（拍图环境里是一次性容器）。新增首图前同样先看一眼有没有本机信息。

🔴 **浏览器 UA 要换成普通 Chrome**（脚本里的 `CONTEXT.userAgent`）：默认的 `HeadlessChrome` 会原样出现在
「在线用户」「登录日志」的浏览器一栏。

⚠️ 正文里出现 `{{n}}` 这类花括号的页面转成 `.mdx` 后会被当成 JSX 表达式，构建报 `ReferenceError`；
写成行内代码。转之前可以先扫一遍代码块之外的 `{` `}` `<`。

## 给 AI 读的那一层：每页 `.md` · `llms.txt` · 页面上的按钮（2026-11-11）

| 什么 | 在哪 | 地址 |
|---|---|---|
| 每页的 Markdown 原文 | `src/pages/[...slug].md.ts` | 页面地址结尾的 `/` 换成 `.md` |
| 索引（每页一行） | `src/pages/[...locale]/llms.txt.ts` | `/llms.txt` · `/en/llms.txt` |
| 全文合并 | `src/pages/[...locale]/llms-full.txt.ts` | `/llms-full.txt` · `/en/llms-full.txt` |
| 标题下的「复制 Markdown / 打开方式」、回到顶部 | `src/components/PageTitle.astro`（覆盖 Starlight 的 `PageTitle`） | —— |

三样都从 `src/lib/markdown.ts` 的 `toMarkdown()` 出：取的是 `.md` / `.mdx` 的**正文源码**，不是渲染后的 HTML。
`.mdx` 里的 import 行和独占一行的组件标签（`<ProductShot … />`）会去掉，代码块里的内容一个字不动。
索引的分类和顺序读 `DOC_SECTIONS`，所以新页面登记进去就自动出现在 `llms.txt` 里，不用另外维护一份。

- 🔴 **「在 ChatGPT / Claude 中打开」带过去的是线上的 `.md` 地址**（`SITE` + `BASE`），不是当前页面的地址：
  对方的服务器要自己去抓，本地预览的 `localhost` 它够不着。所以**新页面没发布之前，这两个入口在本地点了是抓不到的** —— 不是坏了
- ⚠️ `llms.txt` 按约定该在域名根上，而两份站点都挂在子路径下（`/fastapi-react-admin/`、`/docs/`），
  自动发现它的工具找不到。现在靠侧边栏「给 AI 读：llms.txt」那条链接和页面上的按钮把人和 AI 引过去；换成自己的域名根之后才算真正符合约定
- ⚠️ 国内那份站点（宝塔 nginx）默认的 `mime.types` 里**没有 `.md`**，会按 `application/octet-stream` 发 ——
  「查看 Markdown 原文」变成下载，「复制 Markdown」不受影响（脚本 `fetch` 后按文本读）。**没在那台服务器上实测过**；
  要在 `docs.conf` 的 `location ^~ /docs/` 里加 `types { text/markdown md; } charset utf-8;`（`types` 会整块替换，记得把 html / css / js 等也带上，或改用 `location ~ \.md$` 单独一段）
- 实测（本地 dev，2026-11-11）：`/guides/first-module.md` 返回 `text/markdown; charset=utf-8`、53 KB；`/llms-full.txt` 242 KB；
  点「复制 Markdown」后按钮变成「已复制」。复制失败（取不到原文 / 浏览器不给剪贴板）时按钮显示「复制失败」——根 `CLAUDE.md` 硬纪律 9

## 开发指南的「技术架构与项目结构」页（`guides/project-structure.mdx`）

跟着用户列表这一次请求（`GET /api/v1/sys/users`）从路由文件走到数据库，再给一张「想改什么去哪找」的表。
开头那张流向图是 `src/components/DiagramRequestFlow.astro`，文字全走 props，中英文各传各的。

- 表里每个文件都写成指向 `main` 的完整 GitHub 链接 —— `check-links.mjs` 会离线核对路径在不在，文件挪了构建就红。
  **所以别把路径写成不带链接的行内代码**，那样挪了目录没人知道
- ⚠️ 链接只保证「文件还在」，不保证「说的还对」：符号名（`usersQuery`、`get_users_paginated`、`DataScopedCRUD`、
  `resolveEnvelope`、`stringify_unsafe_ints`）和权限码 `sys:user:list` 是 2026-11-11 逐个 grep 核对过的，重构这条链路时回来改这一页
- 刻意没写行号（会漂），也没写路由守卫用的是哪个权限码

## 顶栏：首页是两块咬合的榫卯，内页是通栏（2026-11-11）

`DocsHeader.astro` 按有没有侧边栏分两路：首页走 `HomeHeader.astro`，内页走它自己那套三栏对齐的通栏。

- **首页**是两块零件：左边「榫」（品牌 + 五个分类入口，深紫），右边「卯」（搜索 · GitHub · 主题 · 语言，浅色），对应 logo 里一深一浅两块。
  停在顶部时两块分在两头、没有底色；滚过 28px 后中间的空隙收掉，两块在屏幕中间合上，接缝是榫头的形状，合上那一下接缝亮一次。
  第一版做的是「收拢成一颗居中的胶囊」，和别家文档站撞了，所以换成只有这个项目讲得通的榫卯
- 「滚没滚」是 `<html data-scrolled>` 一个布尔，由哨兵元素 + `IntersectionObserver` 置位，形态和过渡全在 CSS 里。
  合拢靠中间那个空隙的 `flex-grow` 从 1 过渡到 0；外层 `justify-content: center`，所以没分出去的空白由两边平分，两块往中间走
- 🔴 **零件的形状切在 `::before` 上，不能切零件本身**（`clip-path` / `overflow: clip` 都一样）：主题和语言的下拉菜单是零件的后代，
  会被整块裁掉 —— 菜单「打开了」（`hidden` 去掉了、`aria-expanded` 是 true）但屏幕上什么都没有。
  实测：合拢状态下点开语言菜单，`elementFromPoint` 命中的是菜单面板
- 🔴 **不能给 `.home-bar` 加 `filter`（比如 `drop-shadow`）来画影子**：父元素一带 filter，子元素的 `backdrop-filter` 取到的背景就只剩
  父元素自己，毛玻璃变成一块平色。影子画在每块零件各自的 `::after` 上
- **阅读进度线**（`.scroll-progress`，首页和内页共用一份样式）是滚动驱动动画，包在 `@supports (animation-timeline: scroll())` 里，
  不支持的浏览器没有这条线。首页那条画在榫的底边里面（紫底白线），内页贴在通栏底边
- ⚠️ 首页外层的 `header.header` 设了 `pointer-events: none`（合拢后两边空出来的地方不该挡住下面的内容），`.home-bar` 自己再开回 `auto`。
  往首页顶栏里加东西要放进两块零件里面，放在外面点不到
- ⚠️ 内页不做这套：Starlight 的侧边栏、正文、目录三栏都按 `--sl-nav-height` 的通栏顶栏对位，顶栏浮起来它们的 `top` 全要跟着改

## 语言切换不用原生 `<select>`

Starlight 自带的 `LanguageSelect` 是一个原生 `<select>`：下拉列表由操作系统画，Windows 上是一块蓝底的系统列表，
字体、圆角、选中色都不归 CSS 管。换成了 `src/components/LangSelect.astro`（底下是 `Dropdown.astro`，「打开方式」也用它）：
选项是指向「同一页另一种语言」的真链接，点的那一刻把当前 `#锚点` 接上去。

- 🔴 **两处都要换**：`astro.config.mjs` 的 `components.LanguageSelect`（首页顶栏、手机菜单底部走这条），
  和 `DocsHeader.astro` 里那句 import（内页顶栏是直接 import 的，覆盖配置管不到它）。只换一处，另一处还是系统下拉
- ⚠️ 目标地址是自己拼的（base + 语言前缀 + 余下路径），前提是**每一页中英文都有** —— 这一点由 `checkDocSections()` 保证

## SEO 相关的配置在哪

| 什么 | 在哪 |
|---|---|
| canonical · hreflang · og:title / description · sitemap | Starlight 按 `site` / `base` / `locales` 自动生成 |
| og:image / twitter:image | `astro.config.mjs` 的 `head`，指向 `public/og.png` |
| 分享卡片图 | `scripts/gen-og.mjs` 生成；只用英文 —— 别的机器上未必有中文字体，缺字是一排方框且不报错 |
| 网站图标 | `public/favicon.svg` 与 `src/assets/logo.svg` 由根目录的 `pnpm brand:icons` 生成，别手改 |

⚠️ **没有 `robots.txt`**：项目站点在 `yilecoding.github.io` 的子路径下，而爬虫只读域名根上的
`robots.txt`。所以 sitemap（`/fastapi-react-admin/sitemap-index.xml`）要在 Google Search Console /
Bing Webmaster 里手动提交。换成自己的域名后改 `astro.config.mjs` 的 `SITE` / `BASE` 两行，
再在 `public/` 放一份 `robots.txt` 指向 sitemap。
