import { fetchFile } from './client'

/**
 * 把一段字节存成文件（浏览器的下载）。
 *
 * ⚠️ `revokeObjectURL` 要晚一点：`a.click()` 只是把下载**交给**浏览器，立刻收回地址在 Firefox 上
 * 偶发「下载失败」。不收的话整个文件的字节留在内存里直到刷新页面，所以也不能不收
 */
export function saveFile(data: BlobPart, filename: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 带鉴权地下载一个文件并存下来，文件名用后端起的那个（读不到才用 `fallback`）。
 *
 * 🔴 **不能做成 `<a href>`**：这些地址都要 Authorization 头，裸链接带不上，
 * 存下来的是 401 的 JSON，而文件管理器只会说「文件已损坏」（同文件页的下载那条）
 */
export async function downloadFile(path: string, fallback: string): Promise<void> {
  const { buffer, filename, type } = await fetchFile(path)
  saveFile(buffer, filename ?? fallback, type ?? undefined)
}
