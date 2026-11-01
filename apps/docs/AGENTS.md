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

## 写内容

页面在 `src/content/docs/`（英文，根路径）和 `src/content/docs/zh-cn/`（简体中文）。
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

## 🔴 站内链接：正文写 `/xxx/`，但组件和 frontmatter 里不行

站点挂在 `/fastapi-react-admin` 子路径下，Astro 只给自己生成的链接（侧边栏、上下篇、
语言切换）补 base。`astro.config.mjs` 里的 remark 插件把**正文** markdown 里以 `/` 开头的
站内链接补上 base，所以正文照常写 `/features/multi-tab/`、`/zh-cn/features/multi-tab/`。

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

## 🔴 Astro 锁在 7.3.x —— 7.4 抬高了 Node 下限

`astro@7.4.4` 要求 Node **≥ 22.23.4**（7.4.0 起是 ≥ 22.22），而仓库的 `engines` 是 ≥ 22.13。
`pnpm build` 会经 turbo 构建本站，所以升到 7.4 就等于把**整个仓库**的 Node 下限抬上去 ——
实测在 22.23.3 上直接报 `Node.js v22.23.3 is not supported by Astro!` 退出。
要升，先在根 `package.json` 的 `engines` 和 CI 的 Node 版本上做决定。

⚠️ 正文用了 remark 插件，就必须装 `@astrojs/markdown-remark`：Astro 7 默认的 Markdown
处理器换成了 Sätteri，不装的话构建直接失败（报错会提示装它）。

⚠️ 侧边栏分组写成 `{ label, items: [{ autogenerate: { directory } }] }` ——
Starlight 0.39 起不再支持 `autogenerate` 和 `label` 写在同一层。

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
