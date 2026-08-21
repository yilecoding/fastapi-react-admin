import { Image } from "@tiptap/extension-image"

/**
 * 富文本里的图片。
 *
 * ## 为什么 src 存的是「真链接」而不是文件 ID
 *
 * 正文是 HTML，存进 `sys_notice.content`（NVARCHAR(MAX)）。里面的 `<img src>`
 * 必须是浏览器**裸加载**就能取到的地址 —— 而带鉴权的 `/sys/files/{pk}/download`
 * 要 Authorization 头（access token 走 HTTPBearer），裸 `src` 只会拿到 401；
 * blob URL 又活不过一次刷新。所以后端专门开了一棵公开子树
 * （`PUBLIC_UPLOAD_DIR` → `/uploads` 静态挂载），只允许图片进去。
 *
 * 代价说清楚：**知道 URL 的人不登录也能看这张图**。落盘名里那 16 位随机
 * （`build_filename`，64 bit）是它唯一的访问控制。公告正文里的图本来就是给
 * 全体用户看的，所以这个面基本等于零新增 —— 但**别把公开上传接到别处**。
 *
 * ## 为什么 src 必须是相对路径
 *
 * `/uploads/2026/08/21/x.png`，不带 host。dev 下靠 `apps/web/vite.config.ts`
 * 的代理转到 API，生产同域天然可用。写成绝对地址就等于把
 * `http://127.0.0.1:8000` 烙进数据库，换环境全部裂掉。
 */

/** 上传一张图之后，插进文档需要的三样东西 */
export type RichTextUploadResult = {
  /** 无鉴权直链（相对路径），直接进 `<img src>` */
  src: string
  /**
   * 文件 ID。**雪花字符串，永远不要 `Number()`**（CLAUDE.md 硬纪律 6）。
   *
   * 渲染用不到它 —— 它写进 `data-file-id`，供保存时 diff
   * `sys_file_relation`：不挂关联的话，删掉公告之后这些图会永远留在
   * 磁盘和「文件管理」里，没人知道它们是谁的。
   */
  fileId: string
  /** 无障碍文本，默认取原始文件名 */
  alt?: string
}

/**
 * 图片能力的注入口。
 *
 * 做成 prop 而不是让编辑器自己去调接口 —— `ui` 不能 import `platform`
 * （依赖方向单向）。实现在 `platform/pages/file/rich-text-images.ts`。
 * 不传这个 prop = 图片功能整块关掉（工具栏没有插图按钮、粘贴图片不上传），
 * 沙箱 demo 就是这么用的。
 */
export type RichTextImages = {
  /** 传一张图，回直链 + 文件 ID */
  upload: (file: File) => Promise<RichTextUploadResult>
  /** `<input accept>` 与粘贴/拖拽的 MIME 白名单，默认见 DEFAULT_IMAGE_MIME */
  mimeTypes?: string[]
  /**
   * 客户端体积闸门。**服务端才是权威**（`UPLOAD_IMAGE_SIZE_MAX`，而且会被
   * `sys_config` 在运行时覆盖），这里只是为了不把注定被拒的字节先传一遍。
   */
  maxBytes?: number
}

/**
 * 默认接受的图片 MIME。
 *
 * 和后端 `UPLOAD_IMAGE_EXT_INCLUDE` 对齐，但**刻意少了 svg**：
 * svg 是可执行文档（内嵌 script / 外链），当正文插图不值这个风险。
 * 后端仍然允许 svg 走普通上传，只是不从富文本这个口进来。
 */
export const DEFAULT_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
]

/** 公开子树的 URL 前缀。后端 `GetFileDetail.public_url` 拼的就是这个 */
const PUBLIC_PREFIX = "/uploads/"

/**
 * 这个 src 是我们自己的公开图吗。
 *
 * 只认**相对**的 `/uploads/…`。绝对地址一律不认，包括指向自己 API 的那种 ——
 * 认了就等于鼓励把 host 写进正文（见文件头那段）。
 */
export function isOwnImageSrc(src: string | null | undefined): boolean {
  return typeof src === "string" && src.startsWith(PUBLIC_PREFIX) && !src.includes("..")
}

/**
 * Image 扩展 + 一个 `fileId` 属性。
 *
 * `resize` 是 `@tiptap/extension-image` 3.30 自带的（`ResizableNodeView`），
 * 拖角改尺寸会把 `width` / `height` 写成 HTML 属性 —— 所以 `PROSE` 里
 * `max-w-full` 和 `h-auto` 必须成对出现，只钳宽度会把图压扁。
 *
 * `allowBase64` 保持默认的 `false`：它让 `parseHTML` 用
 * `img[src]:not([src^="data:"])`，于是从 Word / 网页粘过来的 base64 内联图
 * 在解析阶段就被丢掉 —— 白拿一道防线，不然一张图能给 NVARCHAR(MAX) 灌几百 KB。
 */
export const InlineImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-file-id"),
        // 没有 fileId 就不写属性 —— 写成 `data-file-id="null"` 之后
        // 保存时的关联 diff 会拿到字符串 "null" 当 ID 去挂载
        renderHTML: (attributes) =>
          attributes.fileId ? { "data-file-id": String(attributes.fileId) } : {},
      },
    }
  },
}).configure({
  resize: { enabled: true, minWidth: 80, minHeight: 40, alwaysPreserveAspectRatio: true },
})

/**
 * 从粘贴进来的 HTML 里剥掉**外链图片**，返回剥了几张。
 *
 * 为什么剥而不是留：外链图有两个说不清的问题 —— 它会随对方删除而裂掉
 * （而且是几个月后才裂，那时没人记得这张图从哪来），以及每次有人浏览这篇公告，
 * 浏览器都在向第三方发一次请求。
 *
 * 为什么不「转存到本地」：浏览器里做不到。跨域取字节要对方给 CORS 头，
 * 而图床基本都不给 —— 真要转存得后端出一个「按 URL 抓取」的接口，
 * 那是另一个量级的东西（SSRF 防护、超时、大小限制）。
 *
 * ⚠️ 这一步只作用于**粘贴路径**（`transformPastedHTML`），不碰
 * `setContent` 加载的库里既有内容 —— 那些是历史数据，静默改写用户存过的东西
 * 比留一张裂图更糟。
 */
export function stripForeignImages(html: string): { html: string; removed: number } {
  // 没有 img 就别劳烦 DOMParser（粘纯文本是最常见的情况）
  if (!html.includes("<img")) return { html, removed: 0 }

  const doc = new DOMParser().parseFromString(html, "text/html")
  const foreign = Array.from(doc.querySelectorAll("img")).filter(
    (img) => !isOwnImageSrc(img.getAttribute("src"))
  )
  if (foreign.length === 0) return { html, removed: 0 }

  for (const img of foreign) img.remove()
  return { html: doc.body.innerHTML, removed: foreign.length }
}
