import { describe, expect, it, vi } from 'vitest'

import { createUploadQueue } from './queue'
import type { UploadItem, UploadTransport } from './types'
import { deferred } from './test-utils'

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
  it.each(['hashing', 'checking'] as const)('换身份 reset 后，迟到的 %s 不能继续检查或上传旧文件', async (stage) => {
    const pending = deferred<string | R | null>()
    const transport: UploadTransport<R> = {
      hash: vi.fn(async () => (stage === 'hashing' ? (pending.promise as Promise<string>) : 'hash')),
      check: vi.fn(async () => pending.promise as Promise<R | null>),
      upload: vi.fn(immediate.upload),
    }
    const onDone = vi.fn()
    const q = createUploadQueue(transport, { onDone })
    q.add([file('private'), file('queued')])
    await vi.waitFor(() => expect(q.getItems()[0]?.status).toBe(stage))
    q.reset()
    pending.resolve(stage === 'hashing' ? 'late-hash' : { id: 'late-file' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(q.getItems()).toEqual([])
    expect(transport.upload).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(transport.check).toHaveBeenCalledTimes(stage === 'checking' ? 1 : 0)
  })

  it.each(['resolve', 'reject'] as const)(
    'reset 后新用户能立即上传，旧请求晚到的 %s 和进度不能污染新队列',
    async (result) => {
      const old = deferred<R>()
      let oldContext!: Parameters<UploadTransport<R>['upload']>[1]
      const onDone = vi.fn()
      const onError = vi.fn()
      const q = createUploadQueue<R>(
        {
          upload: (f, ctx) => {
            if (f.name === 'old') {
              oldContext = ctx
              return old.promise
            }
            return immediate.upload(f, ctx, {})
          },
        },
        { onDone, onError },
      )
      const notify = vi.fn()
      q.subscribe(notify)
      q.add([file('old'), file('old-queued')])
      q.reset()
      expect(oldContext.signal.aborted).toBe(true)
      expect(q.getItems()).toEqual([])
      q.add([file('new')])
      await settled(q)
      oldContext.onBytes(9, 10)
      oldContext.onFinalizing()
      if (result === 'resolve') old.resolve({ id: 'old' })
      else old.reject(new Error('late failure'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(q.getItems().map((item) => [item.name, item.status])).toEqual([['new', 'done']])
      expect(onDone).toHaveBeenCalledOnce()
      expect(onDone.mock.calls[0]?.[0].name).toBe('new')
      expect(onError).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalled()
    },
  )

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
