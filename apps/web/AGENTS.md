# apps/web —— 业务应用（壳 + 路由 + 构建）

> 路由只声明 schema 与守卫，页面由 `TabOutlet` 挂载（根 `CLAUDE.md` 硬纪律 1/3）。
> 这份分册放**只在这一层才有的东西**：构建注入、发版相关、错误页。
> E2E 单独一份：[`e2e/AGENTS.md`](e2e/AGENTS.md)。
>
> 这份文件是根 [`CLAUDE.md`](../../CLAUDE.md) 的**模块分册**，Claude Code 读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律只在根
> `CLAUDE.md` 里有一份；**新增结论请追加到离代码最近的那一份**。

## 「服务端发新版了，请刷新」

多页签保活鼓励用户**长时间开着一堆 tab 不刷新**，而 `nginx.conf` 那套缓存防护
（`/assets/` 永久缓存 + `index.html` `no-store`）只保证「**下一次**加载拿到的是
配套的壳子和 chunk」—— 对一个已经开了一天的页面什么都做不了。那个页面上：

- 后端接口做了破坏性变更（哪怕只是加个必填字段），旧前端拿到不认识的结构
- 点到懒加载分片（文件预览那条链是真的 `lazy(() => import('./viewer'))`），
  而那个 hash 文件已被新构建覆盖删除 → `import()` 直接 404

两种都表现成「一个说不清原因的报错」，而用户不知道**刷新一下就好了**。

实现是两条检测、一个出口（`src/lib/app-version.ts`）：

| 路径 | 触发 | 覆盖面 |
|---|---|---|
| `version.json` 轮询 | 切回标签页（60 秒节流）/ 每 10 分钟 | 全部，**包括「旧前端 + 新后端」这种前端根本不报错的情形** |
| 懒加载失败特征串 | 真的取不到分片时 | 精准，但只覆盖动态 import |

🔴 **只做「捕获懒加载失败」是不够的**，尽管它更便宜（不需要新文件/接口）：
这个仓库**几乎没有路由级代码分割** —— `src/lib/page-registry.tsx` 把每个页面都
**静态** import 进主 bundle（隐藏 tab 要能自己解析组件，见硬纪律 1），全仓只有
file-viewer 一条真的懒加载链。所以那个触发点很窄，而更常见的「旧前端配新后端」
不产生任何前端错误，没有轮询就完全检测不到。

三条纪律：

- 🔴 **`version.json` 必须 `no-store`**（`nginx.conf` 里单独一条 `location`）。
  被缓存住的话前端永远比对到那个旧 `buildId`，提示再也不会出现 ——
  而且**看不出坏了**，界面上一切正常
- 🔴 **不自动刷新，只给一个按钮。** 中后台的用户可能正在填一张长表单，
  替他刷新等于把没提交的东西扔了
- ⚠️ **`buildId` 不能用 vite 的产物 hash。** `import.meta.env` 的替换发生在
  转换阶段，而产物 hash 要等 bundle 生成完才知道。现在的值是
  `git sha + 时间戳`（`vite.config.ts` 的 `buildIdPlugin`），生产镜像里没有
  `.git`（Dockerfile 只 COPY 源码），所以真正兜底的是时间戳 —— 每次构建必然不同

开发期 `apply: 'build'` 让插件整个不生效，`BUILD_ID` 回落成 `dev`，
`/version.json` 404 → 检测静默跳过（dev 没有「发版」这件事）。
E2E 靠 `page.route` 造一个不同的 `buildId` 来验，见
[`e2e/AGENTS.md`](e2e/AGENTS.md)。

## 错误页分两支（`src/routes/-error.tsx`）

「分片取不到」不是 500，**它是版本不一致**。照旧渲染 `500` + 原始文案的话，
用户读到的是 `Failed to fetch dynamically imported module: …/assets/viewer-D3f1.js`
—— 没人会从这句话想到「刷新一下就好了」。所以 `isStaleAssetError(error)` 单独一支，
说人话 + 一个刷新按钮。

⚠️ 特征串判**过宽**的代价是把普通网络错误说成「发新版了」，所以只认那几条
明确和模块加载相关的文案（Chrome / Firefox / Safari 各不相同，是一组不是一条），
**不要**放宽到 `Failed to fetch`。

## 登录页左栏的 3D 榫卯（`src/routes/_guest/-tenon-stage.tsx`）

纯 CSS 3D：每片零件是 30 层 `clip-path` 薄片沿 Z 轴叠出来的，轮廓和侧边栏那枚
`TenonMark` 共用 `src/components/tenon-outline.ts`。尺寸全走 `cqw`，舞台边长随左栏变。

🔴 **`prefers-reduced-motion` 的覆盖规则，选择器必须和挂动画的那条一样具体。**
症状：系统开了「减弱动态效果」，榫块照样来回滑，而且截图那一刻停在离卯最远的位置 ——
看起来像两块不相干的方块，不像一枚标记。
根因：动画挂在 `.tenon-piece--t .tenon-slide`（特异性 0,2,0）上，减弱动效里写的是裸
`.tenon-slide { animation: none }`（0,1,0）。`@media` 不加特异性，于是输给了前者，
`animation` 一个字都没被覆盖，`transform` 的静止值也就轮不到。
修法：媒体查询里逐条写成同样的复合选择器（`.tenon-piece--t .tenon-slide, .tenon-piece--m .tenon-slide`）。
**不要靠 `!important` 压**：以后有人给某一片加更具体的动画规则，`!important` 会把它也一起吃掉，
而那正是这里要避免的「改一处、另一处静默跟着变」。
实测：Playwright `reducedMotion: "reduce"` 截图，修前榫块停在 `translateX(-24%)`（动画起点），
修后停在 `translateX(3%)`、光缝半亮，与设计一致。

⚠️ 换主题、换语言都不用碰舞台：配色是 `.tenon-stage-box` / `.dark .tenon-stage-box` 上的一组
自定义属性，文案在 `-sign-in-brand.tsx`。验收截图要覆盖 390 / 1024 / 1280 / 1440 / 1920 五档宽度、
浅深两套、英文一套、减弱动效一套 —— 英文标题会换成三行，最容易在 1024 宽把舞台挤扁。
