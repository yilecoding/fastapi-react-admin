"""给一个外部系统生成 MCP 凭据。

    uv run python -m backend.plugin.ai.mcp_gateway.gen_token pis-agent

明文只在这里打印一次，交给对方系统；库里 / 配置里只存 sha256。丢了就重新生成一个换掉。
"""

import json
import secrets
import sys

from pydantic import ValidationError

from backend.plugin.ai.mcp_gateway.auth import McpClient, hash_token


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit('用法：python -m backend.plugin.ai.mcp_gateway.gen_token <client-id>')
    token = f'fra_mcp_{secrets.token_urlsafe(32)}'
    # 先过一遍模型校验：client id 写错格式在这里就报，而不是上线后被 load_clients 静默跳过
    try:
        client = McpClient(id=sys.argv[1], token_sha256=hash_token(token), act_as=['<用户名>'])
    except ValidationError:
        sys.exit('client id 只能用小写字母、数字、- 和 _，且以字母或数字开头（例：pis-agent）')
    print(f'凭据（只显示这一次，交给 {client.id}）：\n  {token}\n')
    print('写进 .env 的 AI_MCP_CLIENTS（把 act_as 改成它能代表的用户名）：')
    print(f'  {json.dumps([client.model_dump(exclude_none=True)], ensure_ascii=False)}')


if __name__ == '__main__':
    main()
