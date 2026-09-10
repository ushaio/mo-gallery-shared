# mo-gallery-shared — Web 与 Desktop 共用 TS 包仓库

pnpm workspace，纯 TypeScript 源码直发（`main` → `src/index.ts`，无构建产物）。根目录只有 `pnpm lint`（`pnpm -r --no-bail lint`）。

## 包

- `packages/api-client` — API client、DTO、端点契约
- `packages/ai-agent` — 编辑器 AI 领域协议 + Vercel AI SDK 运行时
- `packages/milkdown` / `packages/tiptap-editor` / `packages/mo-editor` — 共享编辑器组件

## 发布流程（改动必读）

1. 在本仓库修改并提交；
2. 更新包间互引的 git tag 引用到新 tag；
3. 给仓库打 tag（如 `v0.2.0`）；
4. 在 mo-gallery-web 与 emulsion-desktop 的 frontend 中更新 tag 引用并 `pnpm install`。

消费方（mo-gallery-web、emulsion-desktop/frontend）以 `github:ushaio/mo-gallery-shared#<tag>&path:packages/<name>` 引用，**禁止 `file:`/`link:`**。`pnpm-workspace.yaml` 的 `blockExoticSubdeps: false` 是因为包间互引，勿移除。共享编辑器/AI 逻辑只在本仓库改，不要复制进应用仓库。
