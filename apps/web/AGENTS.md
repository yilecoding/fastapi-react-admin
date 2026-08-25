# apps/web —— 业务应用（壳 + 路由 + 构建）

> 路由只声明 schema 与守卫，页面由 `TabOutlet` 挂载（根 `CLAUDE.md` 硬纪律 1/3）。
> 这份分册放**只在这一层才有的东西**：构建注入、发版相关、错误页。
> E2E 单独一份：[`e2e/AGENTS.md`](e2e/AGENTS.md)。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

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
