## 改了什么、为什么

<!-- 一两句话。如果修的是一个踩过的坑，说清楚「症状 → 根因」，别只写「fix bug」。 -->

## 自查清单

- [ ] `pnpm typecheck --force` 过（普通 `typecheck` 会命中 turbo 缓存，结论不可信，见 CLAUDE.md 硬纪律 12）
- [ ] `pnpm lint` 过（eslint，web · ui · platform · mobile 四个包）
- [ ] `pnpm build` 过（web + mobile + desktop —— **别写 `--filter`**，见硬纪律 13）
- [ ] `pnpm i18n:check && pnpm i18n:jsx` 过（新增文案走 `t()`，没有裸中文）
- [ ] `pnpm ctx:check` 过（文档里没有死引用 / 死链接 / 死脚本）
- [ ] 改了后端：`pnpm test` 全绿（需要本地 `fba_test` 库，见 CONTRIBUTING.md）
- [ ] 改了前端交互/页面：`pnpm e2e` 全绿，或者补了对应的用例
- [ ] 改了模型：生成了 alembic 迁移（`pnpm db:revision`）并读过一遍；种子 SQL（`backend/sql/*/init_*.sql`）跟着同步了显式列名
- [ ] 这是一个曾经真的踩过的坑：结论已经追加进最近的那份 `CLAUDE.md` / `AGENTS.md`

## 关联 issue

<!-- Closes #xxx，没有就删掉这一节 -->
