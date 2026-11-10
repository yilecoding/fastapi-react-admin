import { expect, test } from "../fixtures/base"

/**
 * #281：带密钥的对象接进数据变更审计。界面上看得到「改过」，看不到密钥本身。
 *
 * 两种入口各一条：列表页的行操作菜单（开放应用）· 卡片页右上角的图标按钮（MCP 凭据，`ChangeHistoryButton`）。
 * 「密钥没进审计表」由后端各模块的 pytest 读库断言（明文、密文、哈希都搜一遍）；这里只验界面上的入口和展示
 */
test.describe("带密钥对象的变更记录", () => {
  test("开放应用：行操作「变更记录」—— 重置过的 Secret Key 只显示「已修改」", async ({ authedPage: page, api }) => {
    const code = `E2E_DCS_${Date.now().toString(36).toUpperCase()}`
    const issued = (await api.post("/api/v1/open-apps", { code, name: "E2E 审计应用", scopes: ["user:read"] })) as {
      id: string
      secret_key: string
    }
    try {
      const reset = (await api.post(`/api/v1/open-apps/${issued.id}/secret`, {})) as { secret_key: string }

      await page.goto("/open/app")
      await page.locator('[data-tab="/_auth/open/app"]').getByTestId(`row-actions-${code}`).click()
      await page.getByTestId(`history-${code}`).click()
      const sheet = page.getByTestId("data-change-sheet")
      const records = sheet.getByTestId("data-change-record")
      // 新的在前：重置密钥，再是新建
      await expect(records).toHaveCount(2)
      await expect(records.first().getByTestId("change-field-secret_cipher")).toContainText("已修改（不记录内容）")
      await expect(records.nth(1)).toContainText("E2E 审计应用")
      await expect(sheet).not.toContainText(issued.secret_key)
      await expect(sheet).not.toContainText(reset.secret_key)
    } finally {
      await api.del(`/api/v1/open-apps/${issued.id}`).catch(() => undefined)
    }
  })

  test("MCP 凭据：卡片右上角的「变更记录」—— 换过的令牌只显示「已修改」", async ({ authedPage: page, api }) => {
    const clientId = `e2e-dcs-${Date.now().toString(36)}`
    const issued = (await api.post("/api/v1/ai/mcp-clients", {
      client_id: clientId,
      name: "E2E 审计凭据",
      act_as: ["test"],
    })) as { id: string; mcp_token: string }
    try {
      const rotated = (await api.post(`/api/v1/ai/mcp-clients/${issued.id}/rotate`, {})) as { mcp_token: string }

      await page.goto("/ai/mcp-client")
      await page.locator('[data-tab="/_auth/ai/mcp-client"]').getByTestId(`mcp-client-history-${clientId}`).click()
      const sheet = page.getByTestId("data-change-sheet")
      const records = sheet.getByTestId("data-change-record")
      await expect(records).toHaveCount(2)
      await expect(records.first().getByTestId("change-field-token_sha256")).toContainText("已修改（不记录内容）")
      await expect(sheet).not.toContainText(issued.mcp_token)
      await expect(sheet).not.toContainText(rotated.mcp_token)
    } finally {
      await api.del(`/api/v1/ai/mcp-clients/${issued.id}`).catch(() => undefined)
    }
  })
})
