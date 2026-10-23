import { createSHA256 } from 'hash-wasm'

/**
 * 浏览器端分块算 sha256，给秒传预检用（后端 `/sys/files/check` 按它去重）。
 *
 * 不用 `crypto.subtle.digest`：它是一次性的，要把整个文件读进内存（99 MB 的 zip 就是 99 MB），
 * 而且 `crypto.subtle` 只在安全上下文里存在 —— 局域网里 `http://192.168.x.x:8888` 打开的页面
 * 上它是 `undefined`，报错看起来像「浏览器不支持」。`hash-wasm` 是增量的，哪里都能跑。
 *
 * @param chunkSize 每次读多少。4 MiB 一块，主线程上 100 MB 的文件约几百毫秒，能顺手报进度
 */
export async function sha256File(
  file: Blob,
  opts: { chunkSize?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const chunkSize = opts.chunkSize ?? 4 * 1024 * 1024
  const hasher = await createSHA256()
  hasher.init()
  const total = file.size
  // 空文件也要走一遍 digest，别在这里特判返回常量 —— 两边的 sha256 口径得一样
  for (let offset = 0; offset < total; offset += chunkSize) {
    if (opts.signal?.aborted) throw new DOMException('hashing aborted', 'AbortError')
    const buf = await file.slice(offset, Math.min(offset + chunkSize, total)).arrayBuffer()
    hasher.update(new Uint8Array(buf))
    opts.onProgress?.(Math.min(1, (offset + chunkSize) / total))
  }
  opts.onProgress?.(1)
  return hasher.digest('hex')
}
