import * as React from 'react'

/**
 * 服务端推送事件的订阅口。
 *
 * 为什么要这一层：socket 连接只有一条（`use-presence.ts` 建的，理由见那里），
 * 而想听事件的人在别的层 —— 铃铛在 `pages/notification/`。让 `shell` 去
 * import 一个具体业务页面，方向就反了（`shell` 是外壳，不该认识某一个页面；
 * 唯一那处反向 import 是 `use-sidebar → dev-sandbox`，那是没有更好办法的特例）。
 *
 * 所以连接方只管「收到什么就广播什么」，谁关心谁自己订阅。新增一种事件
 * **不用改这个文件，也不用改 `use-presence.ts`** —— 只在关心它的地方写一行
 * `useSocketEvent('xxx', fn)`。
 */
type Handler = (payload: unknown) => void

const handlers = new Map<string, Set<Handler>>()

/** 由 `use-presence.ts` 在收到任意事件时调用 */
export function dispatchSocketEvent(event: string, payload: unknown): void {
  for (const fn of handlers.get(event) ?? []) fn(payload)
}

/**
 * 订阅一种服务端事件。
 *
 * ⚠️ `handler` 存进 ref 再调用，所以**不需要**调用方自己 `useCallback` ——
 * 不这么写的话，每次渲染都会退订再订阅一遍，而 socket 事件恰恰会在渲染中途到达，
 * 那一瞬间没有任何订阅者，事件被静默丢掉。
 */
export function useSocketEvent(event: string, handler: Handler): void {
  const ref = React.useRef(handler)
  React.useEffect(() => {
    ref.current = handler
  })

  React.useEffect(() => {
    const wrapped: Handler = (payload) => ref.current(payload)
    let set = handlers.get(event)
    if (!set) {
      set = new Set()
      handlers.set(event, set)
    }
    set.add(wrapped)
    return () => {
      set.delete(wrapped)
      if (set.size === 0) handlers.delete(event)
    }
  }, [event])
}
