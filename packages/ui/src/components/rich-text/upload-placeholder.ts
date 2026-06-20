import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

/**
 * 上传中的占位。
 *
 * ## 为什么是 decoration，而不是往文档里插一个「上传中」节点
 *
 * 占位如果是真节点，它就会进 `editor.getHTML()`。而 `onUpdate` 一触发，
 * 父组件就 `form.setValue('content', html)` —— 用户在上传没结束时点「发布」，
 * 存进数据库的就是一个永远转圈的假节点。要堵这个洞得再加两套机制
 * （序列化时过滤 + 禁用提交按钮），而 widget decoration 天生就没有这个问题：
 * 它只活在视图层，`getHTML()` 看不见它，撤销栈也不碰它。
 *
 * ## `set.map(tr.mapping, tr.doc)` 是这个插件的全部意义
 *
 * 上传期间用户会照常打字。不映射位置的话，图会插到「当时的偏移量」上 ——
 * 在上面多打两行字，图就落到句子中间去了。
 */

type PlaceholderAction =
  | { type: "add"; id: object; pos: number; label: string }
  | { type: "remove"; id: object }

const KEY = new PluginKey<DecorationSet>("richTextUploadPlaceholder")

/** 占位的样子。纯 DOM —— 插件里拿不到 React，文案由调用方（有 `t`）传进来 */
function renderChip(label: string): HTMLElement {
  const el = document.createElement("span")
  el.className =
    "inline-flex items-center gap-1.5 rounded-md border border-dashed bg-muted/50 " +
    "px-2 py-1 align-middle text-xs text-muted-foreground select-none"
  el.setAttribute("data-testid", "rt-image-uploading")
  // `contenteditable=false` 是必须的：不加的话光标能走进占位里、还能往里打字
  el.contentEditable = "false"

  const spinner = document.createElement("span")
  spinner.className = "size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
  spinner.setAttribute("aria-hidden", "true")

  const text = document.createElement("span")
  text.textContent = label

  el.append(spinner, text)
  return el
}

export const UploadPlaceholder = Extension.create({
  name: "richTextUploadPlaceholder",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: KEY,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            // 见文件头：位置必须跟着后续编辑一起搬
            let next = set.map(tr.mapping, tr.doc)
            const action = tr.getMeta(KEY) as PlaceholderAction | undefined

            if (action?.type === "add") {
              const { id, label } = action
              next = next.add(tr.doc, [
                // `side: 1` 让占位排在插入点右侧，光标停在它左边 ——
                // 于是「上传中还能接着打字」时，字出现在图之前而不是之后
                Decoration.widget(action.pos, () => renderChip(label), { id, side: 1 }),
              ])
            }
            if (action?.type === "remove") {
              const { id } = action
              next = next.remove(next.find(undefined, undefined, (spec) => spec.id === id))
            }
            return next
          },
        },
        props: {
          decorations: (state) => KEY.getState(state),
        },
      }),
    ]
  },
})

/** 身份用**对象引用**而不是自增数：两次粘贴之间不用维护计数器，天然唯一 */
export function newPlaceholderId(): object {
  return {}
}

export function addPlaceholder(state: EditorState, id: object, pos: number, label: string) {
  return state.tr.setMeta(KEY, { type: "add", id, pos, label } satisfies PlaceholderAction)
}

export function removePlaceholder(state: EditorState, id: object) {
  return state.tr.setMeta(KEY, { type: "remove", id } satisfies PlaceholderAction)
}

/**
 * 占位现在在哪。
 *
 * 返回 `null` 表示它已经不在文档里了 —— 用户在上传期间按了 Ctrl+Z、
 * 或者把那一段选中删掉了。**这不是错误**：正确的处理是把上传结果丢掉，
 * 而不是硬插到某个「差不多」的位置。那张图会成为一个没有关联的文件，
 * 保存时的关联 diff 自然不会挂它。
 */
export function findPlaceholder(state: EditorState, id: object): number | null {
  const set = KEY.getState(state)
  const found = set?.find(undefined, undefined, (spec) => spec.id === id)
  return found && found.length > 0 ? found[0].from : null
}
