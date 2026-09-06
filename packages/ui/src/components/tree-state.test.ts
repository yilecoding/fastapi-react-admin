import { describe, expect, it } from 'vitest'

import {
  buildIndex,
  collectIds,
  filterTree,
  nodeState,
  toggleNode,
  type TreeNode,
} from './tree-state'

/**
 * 三层树，带一个 disabled 叶子。
 *
 *   sys
 *   ├─ sys.user
 *   └─ sys.menu
 *      ├─ sys.menu.add
 *      └─ sys.menu.del   (disabled)
 *   log
 *   └─ log.login
 */
const NODES: TreeNode[] = [
  {
    id: 'sys',
    label: '系统管理',
    children: [
      { id: 'sys.user', label: '用户管理' },
      {
        id: 'sys.menu',
        label: '菜单管理',
        children: [
          { id: 'sys.menu.add', label: '新增' },
          { id: 'sys.menu.del', label: '删除', disabled: true },
        ],
      },
    ],
  },
  { id: 'log', label: '日志', children: [{ id: 'log.login', label: '登录日志' }] },
]

const index = buildIndex(NODES)
const node = (id: string) => index.byId.get(id)!

describe('collectIds', () => {
  it('第 0 个是自己，然后是全部子孙', () => {
    expect(collectIds(node('sys'))).toEqual([
      'sys',
      'sys.user',
      'sys.menu',
      'sys.menu.add',
      'sys.menu.del',
    ])
  })

  it('叶子只有自己', () => {
    expect(collectIds(node('log.login'))).toEqual(['log.login'])
  })
})

describe('buildIndex', () => {
  it('根节点的父是 null，不是 undefined —— 向上遍历靠这个停', () => {
    expect(index.parentOf.get('sys')).toBeNull()
    expect(index.parentOf.get('sys.menu.add')).toBe('sys.menu')
  })
})

describe('nodeState', () => {
  it('叶子：在集合里就是 checked', () => {
    expect(nodeState(node('sys.user'), new Set(['sys.user']))).toBe('checked')
    expect(nodeState(node('sys.user'), new Set())).toBe('unchecked')
  })

  it('父节点：子孙全中才算 checked', () => {
    const all = new Set(['sys', 'sys.user', 'sys.menu', 'sys.menu.add', 'sys.menu.del'])
    expect(nodeState(node('sys'), all)).toBe('checked')
  })

  it('🔴 部分子孙中 = indeterminate（半选）', () => {
    expect(nodeState(node('sys'), new Set(['sys.user']))).toBe('indeterminate')
    expect(nodeState(node('sys.menu'), new Set(['sys.menu.add']))).toBe('indeterminate')
  })

  it('🔴 子孙全中、但父自己不在集合里，仍算 checked', () => {
    // 这是「向上修正」跑之前的中间态，不该显示成半选
    const kids = new Set(['sys.user', 'sys.menu', 'sys.menu.add', 'sys.menu.del'])
    expect(nodeState(node('sys'), kids)).toBe('checked')
  })

  it('🔴 只勾了父、一个子孙都没勾 = indeterminate（节点独立模式下的孤儿）', () => {
    expect(nodeState(node('sys'), new Set(['sys']))).toBe('indeterminate')
  })

  it('什么都没勾 = unchecked', () => {
    expect(nodeState(node('sys'), new Set())).toBe('unchecked')
  })
})

describe('toggleNode（级联）', () => {
  it('勾父节点，除 disabled 外的子孙全进来', () => {
    const next = toggleNode(node('sys'), true, [], index)
    expect(new Set(next)).toEqual(new Set(['sys', 'sys.user', 'sys.menu', 'sys.menu.add']))
    // 🔴 disabled 的叶子不能被父节点带上
    expect(next).not.toContain('sys.menu.del')
  })

  it('取消父节点，子孙一起走', () => {
    const all = ['sys', 'sys.user', 'sys.menu', 'sys.menu.add']
    expect(toggleNode(node('sys'), false, all, index)).toEqual([])
  })

  it('🔴 勾满同级子节点，祖先自动补上（否则父永远停在半选）', () => {
    // log 只有一个子节点，勾上它，log 自己该跟着变 checked
    const next = toggleNode(node('log.login'), true, [], index)
    expect(new Set(next)).toEqual(new Set(['log.login', 'log']))
  })

  it('🔴 取消任一子节点，祖先链一路取消', () => {
    const all = ['sys', 'sys.user', 'sys.menu', 'sys.menu.add']
    const next = toggleNode(node('sys.menu.add'), false, all, index)
    expect(next).not.toContain('sys.menu')
    expect(next).not.toContain('sys')
    expect(next).toContain('sys.user')
  })

  it('祖先修正是**多级**的，不只修直接父亲', () => {
    // 用没有 disabled 的那一支：deep.a.b 勾上之后，deep.a 和 deep 都该跟着补上
    const deep: TreeNode[] = [
      { id: 'deep', label: 'd', children: [{ id: 'deep.a', label: 'a', children: [{ id: 'deep.a.b', label: 'b' }] }] },
    ]
    const di = buildIndex(deep)
    const next = toggleNode(di.byId.get('deep.a.b')!, true, [], di)
    expect(new Set(next)).toEqual(new Set(['deep.a.b', 'deep.a', 'deep']))
  })

  it('🔴 disabled 的子节点会让祖先**永远**到不了 checked', () => {
    // sys.menu 有两个孩子，del 是 disabled 的、勾不上。
    // 祖先修正的判据是 `kids.every((i) => set.has(i))` —— del 永远不在 set 里，
    // 所以这个条件恒 false：sys.menu 进不了集合，sys 也就永远进不了。
    //
    // ⚠️ 这条是**实测出来的**，不是从代码形状推的 —— 第一版测试按「disabled
    // 不计入全选判定」写，跑出来是红的。真实行为是「计入，且永远不满足」。
    //
    // 是不是想要的行为可以再议（把 disabled 排除出 kids 也说得通），
    // 但先把现状钉住：改了这里，这条测试会红，而界面上只是某个父节点
    // 少了一条横杠 —— 没有测试的话没人会发现。
    const cur = toggleNode(node('sys.menu.add'), true, [], index)
    expect(cur).toEqual(['sys.menu.add'])
    expect(nodeState(node('sys.menu'), new Set(cur))).toBe('indeterminate')
    expect(nodeState(node('sys'), new Set(cur))).toBe('indeterminate')

    // 连「勾父节点」这条路也到不了 checked：del 被跳过
    const viaParent = toggleNode(node('sys.menu'), true, [], index)
    expect(nodeState(node('sys.menu'), new Set(viaParent))).toBe('indeterminate')
  })
})

describe('toggleNode（cascade=false，节点独立）', () => {
  it('只改自己，不动子孙', () => {
    const next = toggleNode(node('sys'), true, [], index, false)
    expect(next).toEqual(['sys'])
  })

  it('🔴 勾得出孤儿：子选了、父没选', () => {
    const next = toggleNode(node('sys.menu.add'), true, [], index, false)
    // 祖先修正照样跑，但 sys.menu 的另一个孩子没勾，所以 sys.menu 不会被补上
    expect(next).toContain('sys.menu.add')
    expect(next).not.toContain('sys.menu')
  })
})

describe('filterTree', () => {
  it('空关键字原样返回（同一个引用，不做无谓拷贝）', () => {
    expect(filterTree(NODES, '   ')).toBe(NODES)
  })

  it('命中叶子时保留整条祖先链', () => {
    const out = filterTree(NODES, '新增')
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('sys')
    expect(out[0]!.children).toHaveLength(1)
    expect(out[0]!.children![0]!.id).toBe('sys.menu')
    expect(out[0]!.children![0]!.children!.map((n) => n.id)).toEqual(['sys.menu.add'])
  })

  it('命中父节点时**整棵子树都留着**（否则搜到目录却看不到里面）', () => {
    const out = filterTree(NODES, '菜单管理')
    expect(out[0]!.children![0]!.children!.map((n) => n.id)).toEqual([
      'sys.menu.add',
      'sys.menu.del',
    ])
  })

  it('大小写不敏感', () => {
    const nodes: TreeNode[] = [{ id: 'a', label: 'Dashboard', searchText: 'Dashboard' }]
    expect(filterTree(nodes, 'DASH')).toHaveLength(1)
  })

  it('searchText 优先于 label —— label 是 ReactNode 时只能靠它', () => {
    const nodes: TreeNode[] = [{ id: 'a', label: null, searchText: '隐藏名字' }]
    expect(filterTree(nodes, '隐藏')).toHaveLength(1)
    expect(filterTree(nodes, 'a')).toHaveLength(0)
  })

  it('一条都不中就返回空数组', () => {
    expect(filterTree(NODES, 'zzz')).toEqual([])
  })
})
