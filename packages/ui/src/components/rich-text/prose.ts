/**
 * 富文本的排版样式。
 *
 * 刻意**不引 `@tailwindcss/typography`**：那个插件带一整套自己的色板和间距体系，
 * 会和这里已有的语义色变量（`--foreground` / `--muted-foreground` / `--border`）打架，
 * 还得再写一层 `prose-invert` 之类去覆盖。编辑器要管的标签就这十几个，
 * 用任意变体直接点名更短，也保证亮/暗色跟着主题变量走。
 */
export const PROSE = [
  "[&_p]:my-2 [&_p]:leading-7",
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-semibold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:ps-6",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:ps-6",
  "[&_li]:my-1 [&_li>p]:my-0",
  "[&_blockquote]:my-3 [&_blockquote]:border-s-2 [&_blockquote]:border-border [&_blockquote]:ps-4 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-sm",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_strong]:font-semibold",
  // 图片。`max-w-full` 不是锦上添花 —— 缺了它，一张 3000px 宽的截图会把
  // 抽屉横向撑爆，而且是沿着 flex 链一路顶到 SidebarInset（`min-width:auto`
  // 那个坑的又一种面目，见 CLAUDE.md）。
  //
  // `h-auto` 必须跟着：resize 会把 width/height **同时**写成 HTML 属性，
  // 只钳宽度的话高度还是原始像素值，图会被压扁。
  //
  // `block` + `my-3`：默认 `inline` 的 img 会坐在文字基线上，
  // 单独成段时下面会多出一条说不清来源的缝。
  "[&_img]:my-3 [&_img]:block [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-md [&_img]:border",
  // 选中态。ProseMirror 给选中的原子节点加 `.ProseMirror-selectednode`，
  // 不画出来的话「点了一下图」和「没点」看起来一样，而缩放把手要靠选中才出现
  "[&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-ring",
  // 图片**没接对齐**，是刻意的。TextAlign 渲染出的是 `style="text-align: center"`
  // （注意冒号后有空格），而 img 是 block 节点 —— block 元素靠 text-align 推不动，
  // 得改成 `mx-auto`。要写成 Tailwind 任意变体就是
  // `[&_img[style*='text-align:_center']]:mx-auto`（`_` 是空格的转义），
  // 一条又长又脆的选择器。真要做对齐，正路是给 Image 加一个自己的 align 属性，
  // 别把 TextAlign 的 style 字符串当接口用。
  "[&_:first-child]:mt-0 [&_:last-child]:mb-0",
].join(" ")
