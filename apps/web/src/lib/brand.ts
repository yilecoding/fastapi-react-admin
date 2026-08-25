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
 * 命名是分两步走的，`wordmark` 现在这个值只是第一步：
 *   1. 现在——描述式命名换搜索可见度，上面那段就是理由
 *   2. 以后——正式改名 "Tenon"，把架构隐喻升格成产品名
 * 反过来先用 "tenon-admin" 起步不划算：搜索引擎和 GitHub 站内搜都靠关键词匹配，
 * 一个没人听过的名字换不来"fastapi react admin"这条查询的曝光，等于把第一步的
 * 流量白丢了。TenonMark 这枚标记提前把视觉识别铺好，就是为了真正改名那天
 * 不用从零建立认知——图形不用换，换的只是 `wordmark` 这一个字段。
 * 触发时机不是日期，是「描述式名字已经跑出可见度」这件事本身发生的时候。
 */
export const BRAND = {
  /**
   * identity 就是仓库名本身 —— 描述式命名的项目，缩写反而没意义
   * （试过 "FRA"，读起来像机场代码）。小写 + 等宽，看着就是个仓库名。
   */
  wordmark: "fastapi-react-admin",
  /** 品类词。放在 identity 对面，别和 tagline 重复说一遍 */
  nameZh: "中后台底座",
  /** 一句话定位。登录页顶栏、侧边栏顶部、站点标题都读它 */
  tagline: "FastAPI + React 19 中后台底座",
  version: "v0.0.1",
  /** 底座里真正承重的那几样，登录页会把它列出来 */
  stack: ["REACT 19", "TANSTACK", "FASTAPI", "SQL SERVER"],
} as const
