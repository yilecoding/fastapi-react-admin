"use client"

import * as React from "react"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"
import { PluginKey } from "@tiptap/pm/state"
import { useTranslation } from "react-i18next"
import StarterKit from "@tiptap/starter-kit"
import { CharacterCount, Placeholder } from "@tiptap/extensions"
import { FileHandlePlugin } from "@tiptap/extension-file-handler"
import TextAlign from "@tiptap/extension-text-align"

import { cn } from "@admin/ui/lib/utils"

import { PROSE } from "./prose"
import { RichTextToolbar } from "./toolbar"
import {
  DEFAULT_IMAGE_MIME,
  InlineImage,
  stripForeignImages,
  type RichTextImages,
} from "./images"
import {
  UploadPlaceholder,
  addPlaceholder,
  findPlaceholder,
  newPlaceholderId,
  removePlaceholder,
} from "./upload-placeholder"

/**
 * 富文本编辑器（Tiptap / ProseMirror）。
 *
 * 存的是 **HTML 字符串**，直接落 `content` 那种 `NVARCHAR(MAX)` 列，
 * 表单层当普通字符串处理，不用改后端。
 *
 * ⚠️ 关于 XSS：只读渲染请用下面的 `RichTextViewer`，**不要**
 * `dangerouslySetInnerHTML`。Viewer 走的是同一个 Tiptap schema 解析：
 * schema 里没登记的标签和属性（`<script>`、`onerror=`、`javascript:` 链接）
 * 在解析阶段就被丢掉，比事后过滤可靠。
 *
 * 图片见 `./images.ts` 的文件头 —— 简而言之：src 存**相对的真链接**
 * （`/uploads/…`），落在后端一棵只放图片的公开子树上。
 */
export type RichTextEditorProps = {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  /** 编辑区最小高度，默认 min-h-48 */
  minHeight?: string
  maxLength?: number
  disabled?: boolean
  /**
   * 图片能力。**不传就整块关掉** —— 工具栏没有插图按钮、粘贴图片不上传，
   * 而不是给一个点了没反应的按钮。实现见
   * `platform/pages/file/rich-text-images.ts`。
   */
  images?: RichTextImages
  className?: string
  "data-testid"?: string
}

function baseExtensions(opts: {
  placeholder?: string
  maxLength?: number
  /**
   * 装上传占位插件。**Viewer 和「没有图片能力」的编辑器都不该带**。
   *
   * 注意这里**没有** FileHandler —— 它要拿 `onPaste` 回调，而扩展数组只在
   * 编辑器创建时求值一次（`useEditor` 的 deps 是 `[]`），回调会永久闭包在
   * 首次渲染上。所以它改成在 effect 里用 `FileHandlePlugin` 注册，
   * 见下面 `RichTextEditor` 里那段。
   */
  uploads?: boolean
}) {
  return [
    StarterKit.configure({
      // 链接点开要新标签页，站内编辑器里点走当前页很讨厌
      link: { openOnClick: false, HTMLAttributes: { target: "_blank", rel: "noreferrer noopener" } },
    }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    // Image 对**编辑器和 Viewer 都要装**：Viewer 少了它，schema 里就没有 img
    // 节点，库里存好的图片会在解析阶段被静默丢掉 —— 编辑时看得见、
    // 发布后看不见，是最难查的那种不一致
    InlineImage,
    ...(opts.placeholder ? [Placeholder.configure({ placeholder: opts.placeholder })] : []),
    ...(opts.maxLength ? [CharacterCount.configure({ limit: opts.maxLength })] : [CharacterCount]),
    ...(opts.uploads ? [UploadPlaceholder] : []),
  ]
}

/** 粘贴/拖拽处理插件的 key，注册与注销都用它 */
const FILE_HANDLER_KEY = new PluginKey("richTextFileHandler")

/** 状态条要说的话。`error` 会一直留着直到下一次操作 —— 失败必须是可见状态 */
type Notice =
  | { kind: "stripped"; n: number }
  | { kind: "rejected"; n: number }
  | { kind: "failed"; name: string; err: string }

/**
 * 存**结构化数据**而不是已经拼好的字符串，是刻意的。
 *
 * 拼好的字符串要在事件回调里调 `t()`，而那些回调是闭包 —— 会话内切语言之后
 * 状态条里的那句话会停在旧语言上（`useMemo` deps 漏 `t` 是同一个 bug 的另一种
 * 面目，CLAUDE.md 里记过）。把 `t()` 推迟到渲染处，闭包里就只剩稳定的 setState。
 */
function noticeText(n: Notice, t: (k: string, v?: Record<string, unknown>) => string): string {
  switch (n.kind) {
    case "stripped":
      return t("已移除 {{n}} 张外链图片：它们会随对方删除而失效，请改为上传", { n: n.n })
    case "rejected":
      return t("已跳过 {{n}} 个文件：只支持图片，且不能超过体积上限", { n: n.n })
    case "failed":
      return t("{{name}} 上传失败：{{err}}", { name: n.name, err: n.err })
  }
}

const NOTICE_CLASS: Record<Notice["kind"], string> = {
  stripped: "text-amber-600 dark:text-amber-500",
  rejected: "text-amber-600 dark:text-amber-500",
  failed: "text-destructive",
}

export function RichTextEditor({
  value,
  onChange,
  // 默认占位不能写进参数默认值 —— 默认值在 hook 之前求值，调不了 t()
  placeholder,
  minHeight = "min-h-48",
  maxLength,
  disabled,
  images,
  className,
  "data-testid": testId = "rich-text",
}: RichTextEditorProps) {
  const { t } = useTranslation()
  const hint = placeholder ?? t("请输入内容…")

  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [uploading, setUploading] = React.useState(0)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const editor = useEditor({
    extensions: baseExtensions({
      placeholder: hint,
      maxLength,
      // 没有 images 就不装占位插件；粘贴图片会回落成浏览器默认行为
      // （什么都不发生），而不是「装了管道但上传函数是空的」
      uploads: Boolean(images),
    }),
    content: value,
    editable: !disabled,
    // React 19 严格模式下 Tiptap 会警告立即渲染，交给 effect 挂载
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? "" : e.getHTML()),
    editorProps: {
      attributes: {
        class: cn(
          "outline-none px-3 py-2",
          minHeight,
          PROSE,
          // Placeholder 扩展只加 data 属性，占位文字要自己画
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-start [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]"
        ),
      },
      /**
       * 从 Word / 网页粘进来的**外链图**在这里剥掉。
       *
       * 只作用于粘贴，不碰 `setContent` 加载的库里既有内容 —— 静默改写
       * 用户存过的东西，比留一张裂图更糟。理由见 `images.ts: stripForeignImages`。
       */
      transformPastedHTML: (html) => {
        const { html: clean, removed } = stripForeignImages(html)
        // 闭包里只有 setNotice（身份稳定）和一个纯函数，
        // 所以这里放在创建期的 editorProps 里是安全的 —— 没有会过期的东西
        if (removed > 0) setNotice({ kind: "stripped", n: removed })
        return clean
      },
    },
  })

  /**
   * 上传并插入。
   *
   * 逐个串行而不是 `Promise.all`：并发上传会让插入顺序变成「谁先传完谁在前」，
   * 一次粘 5 张图的顺序就随机了。而且上传接口有体积上限，串行也更容易读错误。
   */
  const handleFiles = React.useCallback(
    async (files: File[], dropPos?: number) => {
      if (!editor || !images) return

      /**
       * 清提示放在**新动作的入口**，不放在「每个文件成功之后」。
       *
       * 原来写在成功分支里，有两个后果 —— 第二个是实测踩到的：
       *
       * 1. 一次粘 5 张、第 2 张挂了，第 3 张成功就把那条失败提示抹了，
       *    用户只看到「好像都传上了」，回头才发现少一张图
       * 2. 更糟的是它会清掉**别的来源**的提示。「已移除 N 张外链图片」是
       *    粘贴 HTML 时报的、跟上传无关，而一次还在飞的上传落地时会把它抹掉。
       *    表现是这条警告**时有时无**（取决于上传比下一次粘贴快还是慢）——
       *    e2e 里间歇失败，抓了三轮日志才定位到
       *
       * 「用户又做了一次新动作」才是旧提示该让位的时刻。
       */
      setNotice(null)

      const mime = images.mimeTypes ?? DEFAULT_IMAGE_MIME
      const accepted: File[] = []
      let rejected = 0
      for (const file of files) {
        // 体积闸门只是「别把注定被拒的字节先传一遍」，服务端才是权威
        // （UPLOAD_IMAGE_SIZE_MAX 还会被 sys_config 在运行时覆盖）
        if (!mime.includes(file.type) || (images.maxBytes && file.size > images.maxBytes)) {
          rejected += 1
          continue
        }
        accepted.push(file)
      }
      // 被闸门挡下的必须说出来。默默少插几张图 = 用户以为自己没选中
      if (rejected > 0) setNotice({ kind: "rejected", n: rejected })
      if (accepted.length === 0) return

      setUploading((n) => n + accepted.length)
      for (const file of accepted) {
        const id = newPlaceholderId()
        // 拖拽给的是落点，粘贴用当前光标
        const at = dropPos ?? editor.state.selection.from
        editor.view.dispatch(addPlaceholder(editor.state, id, at, t("正在上传 {{name}}…", { name: file.name })))

        try {
          const result = await images.upload(file)
          const pos = findPlaceholder(editor.state, id)
          const tr = removePlaceholder(editor.state, id)
          // pos 为 null = 用户在上传期间撤销/删掉了那一段。
          // 硬插到「差不多」的位置只会让人莫名其妙，直接丢掉
          if (pos !== null) {
            tr.insert(
              pos,
              editor.state.schema.nodes.image.create({
                src: result.src,
                alt: result.alt ?? file.name,
                fileId: result.fileId,
              })
            )
          }
          editor.view.dispatch(tr)
        } catch (e) {
          editor.view.dispatch(removePlaceholder(editor.state, id))
          setNotice({
            kind: "failed",
            name: file.name,
            err: e instanceof Error ? e.message : t("未知错误"),
          })
        } finally {
          setUploading((n) => Math.max(0, n - 1))
        }
      }
    },
    [editor, images, t]
  )

  /**
   * 粘贴 / 拖拽上传，**在 effect 里注册**而不是放进扩展数组。
   *
   * 扩展数组只在编辑器创建时求值一次（`useEditor` 的 deps 是 `[]`），
   * 塞进去的 `onPaste` 会永久闭包在首次渲染上 —— `images` 换了实现、
   * 语言切了都不会生效。而 `FileHandlePlugin` 是导出的，所以可以在
   * `handleFiles` 变化时重新注册一次，闭包永远是新的。
   */
  React.useEffect(() => {
    if (!editor || !images) return
    editor.registerPlugin(
      FileHandlePlugin({
        key: FILE_HANDLER_KEY,
        editor,
        allowedMimeTypes: images.mimeTypes ?? DEFAULT_IMAGE_MIME,
        // 剪贴板里同时有图和 HTML 时（从 Word 复制就是这样），
        // 不消费掉粘贴事件的话两条路会各插一次 —— 图片重复
        consumePasteEvent: true,
        onPaste: (_e, files) => void handleFiles(files),
        onDrop: (_e, files, pos) => void handleFiles(files, pos),
      })
    )
    return () => {
      // 编辑器可能已经被销毁（卸载顺序不保证），销毁后再动它会抛
      if (!editor.isDestroyed) editor.unregisterPlugin(FILE_HANDLER_KEY)
    }
  }, [editor, images, handleFiles])

  // 外部值变了（编辑不同的记录、表单 reset）要同步进来。
  // 必须比对当前 HTML，否则每次 onUpdate → 父组件 setState → 这里再 setContent，
  // 光标会被打回开头，打字直接不可用。
  React.useEffect(() => {
    if (!editor) return
    if (value !== editor.getHTML() && !(value === "" && editor.isEmpty)) {
      editor.commands.setContent(value || "", { emitUpdate: false })
    }
  }, [value, editor])

  React.useEffect(() => {
    editor?.setEditable(!disabled)
  }, [disabled, editor])

  if (!editor) {
    return <div className={cn("rounded-md border", minHeight, className)} data-testid={testId} />
  }

  const used = editor.storage.characterCount?.characters?.() ?? 0

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-background",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        disabled && "pointer-events-none opacity-60",
        className
      )}
      data-testid={testId}
    >
      <RichTextToolbar
        editor={editor}
        // 有图片能力才给按钮。没有就整个不渲染 —— 给一个点了没反应的按钮更糟
        onPickImage={images ? () => fileInputRef.current?.click() : undefined}
        imageBusy={uploading > 0}
      />
      {images && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={(images.mimeTypes ?? DEFAULT_IMAGE_MIME).join(",")}
          className="hidden"
          data-testid={`${testId}-image-input`}
          onChange={(e) => {
            void handleFiles(Array.from(e.target.files ?? []))
            // 不清空的话，选同一个文件第二次不会触发 change
            e.target.value = ""
          }}
        />
      )}
      <EditorContent editor={editor} data-testid={`${testId}-content`} />
      <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
        <span data-testid={`${testId}-count`} className="shrink-0">
          {maxLength
            ? t("{{used}} / {{max}} 字", { used, max: maxLength })
            : t("{{n}} 字", { n: used })}
        </span>
        {/* 状态条和「Markdown 快捷输入」那句提示**共用**右侧这一格：
            提示是常驻噪音，出了事的时候它应该让位 */}
        {notice ? (
          <span
            role={notice.kind === "failed" ? "alert" : undefined}
            data-testid={`${testId}-notice`}
            className={cn("min-w-0 truncate text-end", NOTICE_CLASS[notice.kind])}
          >
            {noticeText(notice, t)}
          </span>
        ) : uploading > 0 ? (
          <span className="shrink-0" data-testid={`${testId}-uploading`}>
            {t("正在上传 {{n}} 张图片…", { n: uploading })}
          </span>
        ) : (
          <span className="truncate">{t("支持 Markdown 快捷输入，如 `## ` 转二级标题")}</span>
        )}
      </div>
    </div>
  )
}

/**
 * 只读渲染。
 *
 * 用 Tiptap 的不可编辑实例而不是 `dangerouslySetInnerHTML` —— 见上面关于 XSS 那段。
 * 代价是多一个 ProseMirror 实例；换来的是「存进来的 HTML 无论多脏，
 * 渲染出去的一定只在 schema 允许的标签范围内」。
 *
 * 图片不需要注入任何东西：`src` 是无鉴权直链，`<img>` 直接就能加载。
 */
export function RichTextViewer({
  value,
  className,
  "data-testid": testId = "rich-text-viewer",
}: {
  value: string
  className?: string
  "data-testid"?: string
}) {
  const { t } = useTranslation()
  const editor = useEditor(
    {
      extensions: baseExtensions({}),
      content: value || "",
      editable: false,
      immediatelyRender: false,
      editorProps: { attributes: { class: cn("outline-none", PROSE) } },
    },
    [value]
  )

  if (!value) return <p className={cn("text-sm text-muted-foreground", className)}>{t("暂无内容")}</p>
  return (
    <div className={cn("text-sm", className)} data-testid={testId}>
      <EditorContent editor={editor} />
    </div>
  )
}

/**
 * 富文本存的是 HTML，列表页要的是纯文本摘要。
 *
 * `imageLabel` 必须由调用方传（一般是 `t('[图片]')`）—— 这是个纯函数，
 * 调不了 hook。不传就退化成空字符串，那时纯图片的公告在列表里是**空单元格**，
 * 看起来像数据坏了。
 */
export function richTextToPlain(html: string, max = 120, imageLabel = ""): string {
  if (!html) return ""
  const text = html
    // 图片要在剥标签**之前**处理：`/<[^>]+>/g` 会把 <img> 整个吃掉，
    // 于是「一张图 + 一行字」的公告摘要里那张图凭空消失，
    // 而纯图片的公告摘要直接是空串
    .replace(/<img\b[^>]*>/gi, imageLabel ? ` ${imageLabel} ` : " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 正文里引用了哪些文件（`data-file-id`）。
 *
 * 保存时用它 diff `sys_file_relation` —— 不挂关联的话，删掉公告之后
 * 这些图会永远留在磁盘和「文件管理」里，没人知道它们是谁的。
 *
 * ⚠️ 返回的是**字符串**。雪花 ID 约 2^61，`Number()` 会把
 * `2202097973238829056` 变成 `2202097973238829000`（CLAUDE.md 硬纪律 6）。
 */
export function richTextFileIds(html: string): string[] {
  if (!html) return []
  const ids = new Set<string>()
  for (const m of html.matchAll(/data-file-id="(\d+)"/g)) ids.add(m[1])
  return Array.from(ids)
}

export { PROSE } from "./prose"
export { RichTextToolbar } from "./toolbar"
export { DEFAULT_IMAGE_MIME, isOwnImageSrc } from "./images"
export type { RichTextImages, RichTextUploadResult } from "./images"
export type { Editor }
