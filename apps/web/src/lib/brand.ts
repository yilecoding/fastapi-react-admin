/**
 * 产品标识。改名字、改版本只动这里。
 *
 * 仓库叫 `fastapi-react-admin` —— 描述式命名，为的是被「fastapi react admin」搜到。
 * 代价是同名仓库不止一个（实测 GitHub 上有 5 个），所以**能不能被选**不靠名字，
 * 靠下面这句 tagline 和 README 里那张对比表：细到数据行的权限、真的保状态的多页签、
 * 原生 SQL Server —— 这三样同类里没人同时有。
 *
 * 那枚咬合标记（TenonMark）留着：它现在表示的不是名字，而是这套架构本身 ——
 * `ui ← platform ← web` 严格单向，每层只暴露形状，不靠胶水粘。
 *
 * 命名分两步走，**但只有一个名字在生效**——现在通通叫 `wordmark`，
 * 挂在 TenonMark 旁边的（侧边栏顶部、登录页角标、页脚落款）读的也是它，
 * 不摆一个独立的中文名去抢跑。以后正式改名 "Tenon" / "榫卯" 是
 * `wordmark` 和中文名**一起**翻过去的一步，不提前分裂成两条时间线——
 * 曾经让中文名先换成"榫卯"、`wordmark` 留着不动，人立刻就问回来了：
 * 「不是先叫 fastapi-react-admin 吗」。这就是当时的答案：对，先叫它，
 * 而且叫得要统一，不要一半已经是新名字、一半还是旧的。
 * 反过来先把 `wordmark` 也换成 "tenon-admin" 起步同样不划算：搜索引擎和
 * GitHub 站内搜都靠关键词匹配，一个没人听过的名字换不来"fastapi react
 * admin"这条查询的曝光，等于把这一步能赚到的流量白丢了。触发时机不是
 * 日期，是「描述式名字已经跑出可见度」这件事本身发生的时候——到了那天，
 * 两个字段一起改。
 * TenonMark 这枚标记提前把视觉识别铺好，就是为了那天不用从零建立认知——
 * 图形不用换，改名那天只是终于有了配它的名字。
 */
export const BRAND = {
  /**
   * identity 就是仓库名本身 —— 描述式命名的项目，缩写反而没意义
   * （试过 "FRA"，读起来像机场代码）。小写 + 等宽，看着就是个仓库名。
   *
   * 这也是**唯一**在用的名字：挂在 TenonMark 旁边的地方（侧边栏顶部、
   * 登录页角标、页脚落款）直接读它，不另设中文名字段——见上面的注释。
   */
  wordmark: "fastapi-react-admin",
  /** 一句话定位，含品类词。站点标题读它，登录页对比表旁边也会引用 */
  tagline: "FastAPI + React 19 中后台底座",
  version: "v0.0.1",
  /** 底座里真正承重的那几样，登录页会把它列出来。不摆 SQL SERVER——数据库是可换的实现细节，不是卖点 */
  stack: ["REACT 19", "TANSTACK", "SHADCN", "TAILWIND", "FASTAPI"],
  /** 仓库地址。顶栏的 GitHub 图标（`components/github-link.tsx`）读它，fork 出去改这一处就行 */
  repoUrl: "https://github.com/yilecoding/fastapi-react-admin",
} as const
