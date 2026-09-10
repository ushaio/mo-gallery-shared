# mo-gallery-shared

MO Gallery web 与 Emulsion desktop 共用的 TypeScript 包仓库。

## 包

| 包 | 说明 |
|---|---|
| `@mo-gallery/api-client` | API 客户端、DTO 与端点契约 |
| `@mo-gallery/ai-agent` | 编辑器 AI 领域协议与 Vercel AI SDK 运行时 |
| `@mo-gallery/milkdown` | Milkdown 富文本编辑器封装 |
| `@mo-gallery/tiptap-editor` | TipTap 富文本编辑器 |
| `@mo-gallery/mo-editor` | 编辑器共享组件 |

所有包均为 TS 源码直出（`main` 指向 `src/index.ts`），无构建产物。

## 消费方式

pnpm git 依赖（子目录引用）：

```json
{
  "dependencies": {
    "@mo-gallery/api-client": "github:ushaio/mo-gallery-shared#v0.1.0&path:packages/api-client"
  }
}
```

## 发版流程

1. 修改包代码，提交到 master。
2. 将包间互联依赖（api-client→ai-agent、tiptap-editor→ai-agent、milkdown→tiptap-editor）的 git 引用更新为新 tag。
3. 打仓库统一 tag（如 `v0.2.0`）并推送（包 `package.json` 的 `version` 与 tag 保持一致）。
4. 在 mo-gallery-web 与 emulsion-desktop 中更新引用 tag 并执行 `pnpm install`。

注意：包间互联依赖使用 `github:ushaio/mo-gallery-shared#<tag>&path:packages/<name>` 引用，每次发新 tag 时必须同步更新。
