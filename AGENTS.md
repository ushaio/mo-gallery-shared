# mo-gallery-shared — Web 与 Desktop 共用 TS 包仓库

pnpm workspace，纯 TypeScript 源码直发（`main` → `src/index.ts`，无构建产物）。根目录脚本：`pnpm lint`（`pnpm -r --no-bail lint`）与同步用的 `pnpm sync` / `pnpm sync:check` / `pnpm sync:watch`（见下）。

## 包

- `packages/api-client` — API client、DTO、端点契约
- `packages/ai-agent` — 编辑器 AI 领域协议 + Vercel AI SDK 运行时
- `packages/milkdown` / `packages/tiptap-editor` / `packages/mo-editor` — 共享编辑器组件
消费方（desktop）专有的包**不在这里维护**：`plugin-sdk`（原 `desktop-plugin-sdk`，存储插件 TS SDK）与 `emulsion-mcp`（编辑器 MCP server）都只在 `../emulsion-desktop/packages/` 下，属于 desktop 专有包，不进本仓库、也不参与 `pnpm sync`。


## 同步到消费方（改动必读）

`packages/*` 是共享包**唯一可编辑源头**；mo-gallery-web 与 emulsion-desktop 各自在仓库根保留一份 `packages/*` 工作区副本（各自 pnpm workspace 的成员），以 `workspace:*` 引用，不再使用 git tag 依赖，也不需要 `file:`/`link:`。

在本仓库改完代码后：

1. `pnpm sync` — 按 `sync.config.json` 把 `packages/*` 单向同步到所有消费方仓库（底层脚本 `scripts/sync-packages.mjs`）；
2. `pnpm sync:check` — 只校验不写盘，有差异或被手工改动则退出码 1（提交前 / CI 用）；
3. `pnpm sync:watch` — 开发时监听 `packages/` 变动自动同步。

消费方仓库根的 `.mo-gallery-shared-sync.json` 记录镜像内容的 sha256：镜像被直接手工改过时 `pnpm sync` 默认报错退出、不覆盖，需 `--force` 才强制以本仓库为准。同步后，镜像变更仍需在 mo-gallery-web 与 emulsion-desktop 各自仓库分别提交；本仓库的 tag 不再影响生效，打 tag 只是可选的留档行为。共享编辑器/AI 逻辑只在本仓库改，不要改消费方的镜像文件，也不要复制进应用源码目录。

## 镜像约束（同步器会强制执行的规则）

- **测试不进镜像**：包根的 `tests/`（含 `test/`、`__tests__/`）目录、任意 `*.test.*` / `*.spec.*` 文件，以及 `package.json` 里指向 `tests/` 的脚本都不会同步到消费方。消费方的 tsc / 打包范围会覆盖 `packages/*`，测试里指向旧仓库布局的相对 import 会直接把消费方的构建搞挂。测试只在本仓库跑。
- **包内 `tsconfig.json` 必须自洽**：不能 `extends` 到包目录之外（典型错误是 `"extends": "../../tsconfig.json"`）。镜像会被放到消费方的 `packages/<name>/` 下，那边没有这个文件，desktop 的 Vite 会在 esbuild 转换阶段报 `failed to resolve extends` 并中断构建。需要继承什么，就把 `compilerOptions` 内联进来。
- **共享包之间只用 `workspace:*`**：写成 git / `file:` / `link:` 引用会被同步器直接拒绝。

- **消费方专有包不进 shared**：`sync.config.json` 的 `consumerOnly` 列出 `plugin-sdk`、`emulsion-mcp`。一旦它们出现在本仓库 `packages/` 或消费方的镜像清单里，同步会直接报错——否则共享包会覆盖消费方自己的同名包。
以上任一条被违反时 `pnpm sync` 会报错退出，不会生成坏镜像。
