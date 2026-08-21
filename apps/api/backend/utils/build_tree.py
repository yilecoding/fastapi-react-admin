import operator

from collections.abc import Sequence
from typing import Any

from backend.common.enums import BuildTreeType, PrimaryKeyType
from backend.core.conf import settings
from backend.utils.serializers import RowData, select_list_serialize

# JavaScript 的 Number.MAX_SAFE_INTEGER
_JS_MAX_SAFE_INT = 9007199254740991

# 这些字段承载雪花 ID，必须以字符串下发
_ID_KEYS = ('id', 'parent_id')


def stringify_big_ids(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    把超出 JS 安全整数范围的 ID 转成字符串，就地递归处理。

    背景：雪花 ID 约 2^61，远超 JS 的 Number.MAX_SAFE_INTEGER (2^53-1)。
    浏览器 JSON.parse 会静默丢精度 —— 实测 2049629108245233664 会变成
    2049629108245233700，且连续的 6 个菜单 ID 会塌缩成同一个值。
    后果不只是 React key 冲突：把 ID 回传做更新/删除会命中错误记录，
    角色-菜单勾选也会整片错乱。

    FBA 的 Pydantic schema 已经用 `field_serializer('id')` 处理了
    （见 backend/common/schema.py），但树形接口返回的是**裸 dict**，
    绕过了 Pydantic 序列化，所以必须在这里补上。
    """
    if PrimaryKeyType.snowflake != settings.DATABASE_PK_MODE:
        return nodes

    def walk(items: list[dict[str, Any]]) -> None:
        for item in items:
            for key in _ID_KEYS:
                v = item.get(key)
                if isinstance(v, int) and not isinstance(v, bool) and abs(v) > _JS_MAX_SAFE_INT:
                    item[key] = str(v)
            children = item.get('children')
            if isinstance(children, list):
                walk(children)

    walk(nodes)
    return nodes


def get_tree_nodes(row: Sequence[RowData], *, is_sort: bool, sort_key: str) -> list[dict[str, Any]]:
    """
    获取所有树形结构节点

    :param row: 原始数据行序列
    :param is_sort: 是否启用结果排序
    :param sort_key: 基于此键对结果进行进行排序
    :return:
    """
    tree_nodes = select_list_serialize(row)
    if is_sort:
        tree_nodes.sort(key=operator.itemgetter(sort_key))
    return tree_nodes


def traversal_to_tree(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    通过遍历算法构造树形结构

    :param nodes: 树节点列表
    :return:
    """
    tree: list[dict[str, Any]] = []
    node_dict = {node['id']: node for node in nodes}

    for node in nodes:
        parent_id = node['parent_id']
        if parent_id is None:
            tree.append(node)
        else:
            parent_node = node_dict.get(parent_id)
            if parent_node is not None:
                if 'children' not in parent_node:
                    parent_node['children'] = []
                if node not in parent_node['children']:
                    parent_node['children'].append(node)
            else:
                if node not in tree:
                    tree.append(node)

    return tree


def recursive_to_tree(nodes: list[dict[str, Any]], *, parent_id: int | None = None) -> list[dict[str, Any]]:
    """
    通过递归算法构造树形结构（性能影响较大）

    :param nodes: 树节点列表
    :param parent_id: 父节点 ID，默认为 None 表示根节点
    :return:
    """
    tree: list[dict[str, Any]] = []
    for node in nodes:
        if node['parent_id'] == parent_id:
            child_nodes = recursive_to_tree(nodes, parent_id=node['id'])
            if child_nodes:
                node['children'] = child_nodes
            tree.append(node)
    return tree


def get_tree_data(
    row: Sequence[RowData],
    build_type: BuildTreeType = BuildTreeType.traversal,
    *,
    parent_id: int | None = None,
    is_sort: bool = True,
    sort_key: str = 'sort',
) -> list[dict[str, Any]]:
    """
    获取树形结构数据

    :param row: 原始数据行序列
    :param build_type: 构建树形结构的算法类型，默认为遍历算法
    :param parent_id: 父节点 ID，仅在递归算法中使用
    :param is_sort: 是否启用结果排序
    :param sort_key: 基于此键对结果进行进行排序
    :return:
    """
    nodes = get_tree_nodes(row, is_sort=is_sort, sort_key=sort_key)
    match build_type:
        case BuildTreeType.traversal:
            tree = traversal_to_tree(nodes)
        case BuildTreeType.recursive:
            tree = recursive_to_tree(nodes, parent_id=parent_id)
        case _:
            raise ValueError(f'无效的算法类型：{build_type}')
    return stringify_big_ids(tree)


def get_vben5_tree_data(
    row: Sequence[RowData],
    *,
    is_sort: bool = True,
    sort_key: str = 'sort',
) -> list[dict[str, Any]]:
    """
    获取 vben5 菜单树形结构数据

    :param row: 原始数据行序列
    :param is_sort: 是否启用结果排序
    :param sort_key: 基于此键对结果进行进行排序
    :return:
    """
    # 这些列会被搬进 meta（并从顶层剔除）。
    # 'cache' 仍然留在这里 —— 它不再进 meta，但要靠这个集合把它从顶层剔掉：
    # React 侧用 <Activity> 一律保活，keepAlive 这个键没人读，下发就是噪音。
    meta_keys = {'title', 'icon', 'link', 'cache', 'display', 'status'}

    vben5_nodes = [
        {
            **{k: v for k, v in node.items() if k not in meta_keys},
            'meta': {
                'title': node['title'],
                'icon': node['icon'],
                'iframeSrc': node['link'] if node['type'] == 3 else '',
                'link': node['link'] if node['type'] == 4 else '',
                'hideInMenu': not bool(node['display']),
                'menuVisibleWithForbidden': not bool(node['status']),
            },
        }
        for node in get_tree_nodes(row, is_sort=is_sort, sort_key=sort_key)
    ]

    return stringify_big_ids(traversal_to_tree(vben5_nodes))
