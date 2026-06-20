"use client"

import * as React from "react"
import { useEditorState, type Editor } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import {
  IconAlignCenter, IconAlignLeft, IconAlignRight, IconArrowBackUp, IconArrowForwardUp,
  IconBlockquote, IconBold, IconClearFormatting, IconCode, IconH1, IconH2, IconH3,
  IconItalic, IconLink, IconLinkOff, IconList, IconListNumbers, IconMinus, IconPhoto,
  IconSourceCode, IconStrikethrough, IconUnderline,
} from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Input } from "@admin/ui/components/input"
import { Popover, PopoverContent, PopoverTrigger } from "@admin/ui/components/popover"
import { Separator } from "@admin/ui/components/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@admin/ui/components/tooltip"
import { cn } from "@admin/ui/lib/utils"

/**
 * 编辑器工具栏。
 *
 * 按钮的「按下」态直接读编辑器状态，不自己存一份 —— 光标在加粗文字里
 * 和点了加粗按钮是同一个状态，存两份必然对不上。
 *
 * 🔴 但读法必须是 `useEditorState`，**不能**在渲染期裸调 `editor.isActive(...)`。
 * Tiptap v3 把 `useEditor` 的 `shouldRerenderOnTransaction` 默认改成了 `false`
 * （见 @tiptap/react 的 useEditor 实现），于是裸读只在**父组件**重渲染时才更新：
 * 打字时因为 `onUpdate → form.setValue → 父级 setState` 绕了一圈，凑巧能刷新；
 * 但**只移动光标**（方向键 / 鼠标点进一个 H2 或加粗词里）不产生 update，
 * 按钮就不亮 —— 一个只在「不打字」时出现、看起来像随机的 bug。
 *
 * `useEditorState` 的默认 equalityFn 是深比较，所以这里返回一个新对象没有代价：
 * 只有真的有值变了才重渲染。
 */
/** 对齐方式的文案。模块级常量翻不了 —— 在渲染处过 t() */
const ALIGN_LABEL = { left: "左对齐", center: "居中对齐", right: "右对齐" } as const

export function RichTextToolbar({
  editor,
  className,
  onPickImage,
  imageBusy,
}: {
  editor: Editor
  className?: string
  /** 传了才渲染插图按钮 —— 没有图片能力时不摆一个点了没反应的按钮 */
  onPickImage?: () => void
  imageBusy?: boolean
}) {
  const { t } = useTranslation()
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      alignLeft: e.isActive({ textAlign: "left" }),
      alignCenter: e.isActive({ textAlign: "center" }),
      alignRight: e.isActive({ textAlign: "right" }),
      link: e.isActive("link"),
    }),
  })
  const HEADING_ACTIVE = { 1: s.h1, 2: s.h2, 3: s.h3 } as const
  const ALIGN_ACTIVE = { left: s.alignLeft, center: s.alignCenter, right: s.alignRight } as const

  return (
    <div
      className={cn(
        // `sticky` 是刻意的：编辑区 min-h-64 放在会滚动的抽屉里，
        // 往下写两屏之后工具栏就滚出视口了。z 值要压过图片（图片是普通流内容）
        "sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b bg-muted/40 p-1",
        className
      )}
      data-testid="rt-toolbar"
    >
      <Group>
        <Item ed={editor} label={t("撤销")} testId="rt-undo"
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!s.canUndo}><IconArrowBackUp /></Item>
        <Item ed={editor} label={t("重做")} testId="rt-redo"
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!s.canRedo}><IconArrowForwardUp /></Item>
      </Group>
      <Div />

      <Group>
        {([1, 2, 3] as const).map((level) => (
          <Item
            key={level} ed={editor} label={t("标题 {{n}}", { n: level })} testId={`rt-h${level}`}
            active={HEADING_ACTIVE[level]}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
          >
            {level === 1 ? <IconH1 /> : level === 2 ? <IconH2 /> : <IconH3 />}
          </Item>
        ))}
      </Group>
      <Div />

      <Group>
        <Item ed={editor} label={t("加粗")} testId="rt-bold" active={s.bold}
              onClick={() => editor.chain().focus().toggleBold().run()}><IconBold /></Item>
        <Item ed={editor} label={t("斜体")} testId="rt-italic" active={s.italic}
              onClick={() => editor.chain().focus().toggleItalic().run()}><IconItalic /></Item>
        <Item ed={editor} label={t("下划线")} testId="rt-underline" active={s.underline}
              onClick={() => editor.chain().focus().toggleUnderline().run()}><IconUnderline /></Item>
        <Item ed={editor} label={t("删除线")} testId="rt-strike" active={s.strike}
              onClick={() => editor.chain().focus().toggleStrike().run()}><IconStrikethrough /></Item>
        <Item ed={editor} label={t("行内代码")} testId="rt-code" active={s.code}
              onClick={() => editor.chain().focus().toggleCode().run()}><IconCode /></Item>
      </Group>
      <Div />

      <Group>
        <Item ed={editor} label={t("无序列表")} testId="rt-ul" active={s.bulletList}
              onClick={() => editor.chain().focus().toggleBulletList().run()}><IconList /></Item>
        <Item ed={editor} label={t("有序列表")} testId="rt-ol" active={s.orderedList}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}><IconListNumbers /></Item>
        <Item ed={editor} label={t("引用块")} testId="rt-quote" active={s.blockquote}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}><IconBlockquote /></Item>
        <Item ed={editor} label={t("代码块")} testId="rt-codeblock" active={s.codeBlock}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}><IconSourceCode /></Item>
        <Item ed={editor} label={t("分割线")} testId="rt-hr"
              onClick={() => editor.chain().focus().setHorizontalRule().run()}><IconMinus /></Item>
      </Group>
      <Div />

      <Group>
        {(["left", "center", "right"] as const).map((a) => (
          <Item
            key={a} ed={editor} label={t(ALIGN_LABEL[a])}
            testId={`rt-align-${a}`} active={ALIGN_ACTIVE[a]}
            onClick={() => editor.chain().focus().setTextAlign(a).run()}
          >
            {a === "left" ? <IconAlignLeft /> : a === "center" ? <IconAlignCenter /> : <IconAlignRight />}
          </Item>
        ))}
      </Group>
      <Div />

      <Group>
        {onPickImage && (
          <Item
            ed={editor} label={imageBusy ? t("上传中…") : t("插入图片")} testId="rt-image"
            disabled={imageBusy} onClick={onPickImage}
          >
            <IconPhoto />
          </Item>
        )}
        <LinkButton editor={editor} />
        <Item ed={editor} label={t("去掉链接")} testId="rt-unlink" disabled={!s.link}
              onClick={() => editor.chain().focus().unsetLink().run()}><IconLinkOff /></Item>
        <Item ed={editor} label={t("清除格式")} testId="rt-clear"
              onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
          <IconClearFormatting />
        </Item>
      </Group>
    </div>
  )
}

const Group = ({ children }: { children: React.ReactNode }) => (
  <span className="flex items-center gap-0.5">{children}</span>
)
const Div = () => <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />

function Item({
  ed, label, testId, active, disabled, onClick, children,
}: {
  ed: Editor
  label: string
  testId: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  void ed
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button" variant="ghost" size="icon"
            className={cn("size-7", active && "bg-foreground/10 text-foreground")}
            aria-label={label} aria-pressed={active} disabled={disabled}
            // 点工具栏不能让编辑器失焦，否则「对选中文字加粗」会先丢选区
            onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
            onClick={onClick}
          />
        }
        data-testid={testId}
      >
        <span className="[&>svg]:size-4">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function LinkButton({ editor }: { editor: Editor }) {
  const { t } = useTranslation()
  const [url, setUrl] = React.useState("")
  const [open, setOpen] = React.useState(false)
  // 和上面同理：裸读 isActive 在「只移动光标」时不刷新
  const isActive = useEditorState({ editor, selector: ({ editor: e }) => e.isActive("link") })

  const apply = () => {
    const href = url.trim()
    if (!href) return
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run()
    setUrl("")
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={(o: boolean) => {
      setOpen(o)
      if (o) setUrl(editor.getAttributes("link").href ?? "")
    }}>
      <PopoverTrigger
        render={
          <Button
            type="button" variant="ghost" size="icon"
            className={cn("size-7", isActive && "bg-foreground/10")}
            aria-label={t("插入链接")}
            onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          />
        }
        data-testid="rt-link"
      >
        <IconLink className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="flex items-center gap-2">
          <Input
            autoFocus className="h-8" value={url} placeholder="https://…"
            data-testid="rt-link-input"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && apply()}
          />
          <Button size="sm" className="h-8 shrink-0" onClick={apply} data-testid="rt-link-apply">
            {t("确定")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
