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

本仓库是共享包**唯一可编辑源头**。mo-gallery-web 与 emulsion-desktop 各自在仓库根保留一份 `packages/*` 工作区副本（各自 pnpm workspace 的成员），并以 `workspace:*` 引用：

```json
{
  "dependencies": {
    "@mo-gallery/api-client": "workspace:*"
  }
}
```

不再使用 `github:ushaio/mo-gallery-shared#<tag>&path:packages/<name>` 这类 git 依赖，也不再需要 `file:`/`link:`。包间互引（api-client→ai-agent、tiptap-editor→ai-agent、milkdown→tiptap-editor）同样是 `workspace:*`。

消费方专有包不在此列：`plugin-sdk`（原 `desktop-plugin-sdk`）与 `emulsion-mcp` 都是 desktop 专有包，只在 `../emulsion-desktop/packages/` 下维护，不进本仓库、也不参与同步（`sync.config.json` 的 `consumerOnly` 会强制这一点）。

在本仓库运行 `pnpm sync` 即可把 `packages/*` 单向同步到所有消费方（目标列在 `sync.config.json`，底层脚本 `scripts/sync-packages.mjs`）：

```bash
pnpm sync          # 同步到所有消费方仓库
pnpm sync:check    # 只校验不写盘，有差异退出码 1（提交前 / CI）
pnpm sync:watch    # 监听 packages/ 变动自动同步
```

消费方仓库根的 `.mo-gallery-shared-sync.json` 记录镜像内容的 sha256 用于漂移检测：镜像被手工修改过时 `pnpm sync` 默认报错退出、不覆盖，需 `--force` 才强制以本仓库为准。
### 镜像会自动执行的规则

- **测试不进镜像**：包根的 `tests/`（含 `test/`、`__tests__/`）目录、任意 `*.test.*` / `*.spec.*` 文件，以及 `package.json` 里指向 `tests/` 的脚本都不会同步到消费方，只在本仓库跑。
- **包内 `tsconfig.json` 必须自洽**：不能 `extends` 到包目录之外（典型错误是 `"extends": "../../tsconfig.json"`）。镜像位于消费方的 `packages/<name>/`，那里没有该文件，desktop 的 Vite 会报 `failed to resolve extends` 并中断构建。需要继承什么就把 `compilerOptions` 内联进来。
- **共享包之间必须用 `workspace:*`**：git / `file:` / `link:` 引用会被同步器拒绝。

违反以上任一条时 `pnpm sync` 会报错退出，不会生成坏镜像。


## 发版流程（同步 + 两端提交）

1. 在本仓库修改包代码并提交；
2. 运行 `pnpm sync:check` 确认状态，再运行 `pnpm sync` 把 `packages/*` 同步到 mo-gallery-web 与 emulsion-desktop；
3. 进入 mo-gallery-web 与 emulsion-desktop 两个子仓库，分别提交镜像变更；
4. 打 tag（如 `v0.2.0`）已不是生效条件，仅为可选的版本留档；消费方不再依赖 tag，也无需为此重新 `pnpm install`。
