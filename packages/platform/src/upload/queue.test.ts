import { describe, expect, it } from 'vitest'

import { createUploadQueue } from './queue'
import type { UploadItem, UploadTransport } from './types'

type R = { id: string }

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name)

/** 等队列里没有进行中 / 排队中的项 */
function settled(q: ReturnType<typeof createUploadQueue<R>>): Promise<readonly UploadItem<R>[]> {
  return new Promise((resolve) => {
    const check = () => {
      const items = q.getItems()
      if (items.every((it) => it.status === 'done' || it.status === 'failed' || it.status === 'canceled')) {
        unsub()
        resolve(items)
      }
    }
    const unsub = q.subscribe(check)
    check()
  })
}

const immediate: UploadTransport<R> = {
  upload: async (f, ctx) => {
    ctx.onBytes(f.size, f.size)
    return { id: `up-${f.name}` }
  },
}

describe('createUploadQueue', () => {
  it('只给 upload：排队、串行、每个都 done，结果带回来', async () => {
    const order: string[] = []
    const q = createUploadQueue<R>({
      upload: async (f) => {
        order.push(`start ${f.name}`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`end ${f.name}`)
        return { id: f.name }
      },
    })
    q.add([file('a'), file('b')])
    const items = await settled(q)
    expect(items.map((it) => [it.status, it.result?.id, it.progress])).toEqual([
      ['done', 'a', 1],
      ['done', 'b', 1],
    ])
    // 串行：b 在 a 结束之后才开始
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('hash + check 命中 → 秒传：done、reused、一个字节都没传', async () => {
    let uploaded = 0
    const q = createUploadQueue<R>({
      hash: async () => 'deadbeef',
      check: async (f, sha) => (f.name === 'dup' && sha === 'deadbeef' ? { id: 'existing' } : null),
      upload: async (f) => {
        uploaded++
        return { id: `up-${f.name}` }
      },
    })
    q.add([file('dup'), file('fresh')])
    const [dup, fresh] = await settled(q)
    expect(dup).toMatchObject({ status: 'done', reused: true, result: { id: 'existing' } })
    expect(fresh).toMatchObject({ status: 'done', reused: false, result: { id: 'up-fresh' } })
    expect(uploaded).toBe(1)
  })

  it('一个失败不影响其余，失败的能重试', async () => {
    let attempts = 0
    const q = createUploadQueue<R>({
      upload: async (f) => {
        if (f.name === 'bad' && attempts++ === 0) throw new Error('boom')
        return { id: f.name }
      },
    })
    q.add([file('bad'), file('good')])
    let items = await settled(q)
    expect(items.map((it) => it.status)).toEqual(['failed', 'done'])
    expect(items[0]!.error).toBe('boom')

    q.retry(items[0]!.id)
    items = await settled(q)
    expect(items.map((it) => it.status)).toEqual(['done', 'done'])
  })

  it('取消：进行中的 abort → canceled；排队的直接 canceled；都不算失败', async () => {
    const q = createUploadQueue<R>({
      upload: (f, ctx) =>
        new Promise((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))
          setTimeout(() => resolve({ id: f.name }), 50)
        }),
    })
    const [a, b] = q.add([file('a'), file('b')])
    await new Promise((r) => setTimeout(r, 5))
    expect(q.getItems()[0]!.status).toBe('uploading')
    q.cancel(b!.id)
    q.cancel(a!.id)
    const items = await settled(q)
    expect(items.map((it) => it.status)).toEqual(['canceled', 'canceled'])
    expect(items.every((it) => it.error === null)).toBe(true)
  })

  it('进度与速度：onBytes 推进 progress，done 时 progress=1、speed 清掉', async () => {
    const seen: number[] = []
    const q = createUploadQueue<R>({
      upload: async (f, ctx) => {
        for (const loaded of [3, 6, 10]) ctx.onBytes(loaded, 10)
        return { id: f.name }
      },
    })
    q.subscribe(() => {
      const it = q.getItems()[0]
      if (it?.status === 'uploading') seen.push(it.progress)
    })
    q.add([file('p', 10)])
    const [item] = await settled(q)
    expect(seen).toEqual([0, 0.3, 0.6, 1])
    expect(item).toMatchObject({ status: 'done', progress: 1, speed: null })
  })

  it('clear 只清已结束的；onDone / onError 各自触发', async () => {
    const done: string[] = []
    const failed: string[] = []
    const q = createUploadQueue<R>(
      { upload: async (f) => (f.name === 'bad' ? Promise.reject(new Error('no')) : { id: f.name }) },
      { onDone: (it) => done.push(it.name), onError: (it) => failed.push(it.name) },
    )
    q.add([file('ok'), file('bad')])
    await settled(q)
    expect(done).toEqual(['ok'])
    expect(failed).toEqual(['bad'])
    q.clear()
    expect(q.getItems()).toEqual([])
  })

  it('immediate transport 也能走完整个状态机', async () => {
    const q = createUploadQueue<R>(immediate)
    q.add([file('z')])
    const [item] = await settled(q)
    expect(item?.status).toBe('done')
  })
})
