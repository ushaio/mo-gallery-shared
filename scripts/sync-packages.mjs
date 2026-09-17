#!/usr/bin/env node
/**
 * mo-gallery-shared/packages/* → 消费方仓库 packages/* 的单向同步器。
 *
 * 背景：共享包原先以 pnpm git 依赖（github:ushaio/mo-gallery-shared#vX&path:packages/x）
 * 被 mo-gallery-web / emulsion-desktop 引用，改一行共享代码要走
 * 「改代码 → 提交 → 打 tag → 两个仓库改引用 → 重装」。现在改成
 * 「shared 是唯一可编辑源头，两个消费方各自持有 packages/* 工作区副本」，
 * 由本脚本保证副本与源头一致，于是只需修改一次。
 *
 * 约束：
 * 1. 严格单向（shared → 消费方），不做反向合并。
 * 2. 只管理共享包自己的目录，消费方 packages/ 下的其他包不受影响（例如 desktop 专有的
 *    plugin-sdk、emulsion-mcp：它们只在消费方仓库里维护，不属于共享包）。sync.config.json
 *    的 consumerOnly 会在源头或清单里出现同名包时直接报错，避免共享包覆盖消费方自己的包。
 * 3. 防覆盖手工改动：镜像内容哈希记录在 <目标仓库>/.mo-gallery-shared-sync.json，
 *    实际内容与记录不符说明镜像被直接改过，默认报错退出，--force 才覆盖。
 * 4. 不镜像测试：任意层级的 tests/ / test/ / __tests__/ 目录、*.test.* / *.spec.*
 *    文件，以及 package.json 里指向 tests/ 的脚本都不进镜像——测试只在 shared 仓库里跑，
 *    进镜像只会污染消费方的类型检查范围。
 * 5. 幂等：内容一致时不写盘，同步后 git status 保持干净。
 *
 * 用法：
 *   pnpm sync                 同步到 sync.config.json 里的全部目标
 *   pnpm sync:check           只校验不写入，有差异或漂移则退出码 1
 *   pnpm sync:watch           开发时监听 packages/ 变动自动同步
 *   node scripts/sync-packages.mjs --target ../mo-gallery-web --force --verbose
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHARED_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGES_DIR = path.join(SHARED_ROOT, "packages");
const CONFIG_PATH = path.join(SHARED_ROOT, "sync.config.json");
const SOURCE_LABEL = "github.com/ushaio/mo-gallery-shared";

/** 不参与同步的目录名（任意层级）：依赖与构建产物，镜像里已装的就地保留、不删不覆盖。 */
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".turbo",
  ".next",
  ".cache",
  "coverage",
]);
/**
 * 任意层级的测试目录名（tests / test / __tests__）。测试只留在 mo-gallery-shared：
 * 消费方的 tsc / 打包范围会覆盖 packages/*，而测试（含 src/__tests__/helpers.ts
 * 这类不带 .test. 后缀的辅助文件）里指向旧仓库布局的相对 import 会直接把消费方的
 * 构建搞挂。
 */
const EXCLUDED_TEST_DIR_NAMES = new Set(["tests", "test", "__tests__"]);
/** 测试文件同样不镜像，理由同上；放宽到 *.test.* / *.spec.*（含 *.test.d.ts）。 */
const TEST_FILE_PATTERN = /\.(test|spec)\./;
/** package.json 里指向测试路径的脚本，镜像后是死链，生成镜像时删掉。 */
const TEST_SCRIPT_PATTERN = /\b(tests?|__tests__)\//;
const EXCLUDED_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "npm-debug.log",
  "pnpm-debug.log",
]);
const EXCLUDED_FILE_EXTENSIONS = new Set([".tsbuildinfo", ".log", ".swp", ".orig", ".rej"]);

/** packages/ 的每个键都必须是安全的单层目录名，不能是 "." / ".." / "a/b" 这类路径。 */
const SAFE_PACKAGE_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * 会被 git 做行尾转换的文本扩展名。这类文件在哈希前统一 \r\n → \n，避免
 * core.autocrlf=true 的 checkout/clone 把纯行尾差异误报成「镜像被手工修改」。
 */
const TEXT_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css", ".md", ".txt", ".yml", ".yaml", ".html", ".svg"]);

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
/** 旧的同仓库 git 子目录引用：github:...#<ref>&path:packages/<name> */
const SHARED_GIT_SPEC =
  /^(?:github:|git\+https?:\/\/github\.com\/)[^#]*#[^&]*[&?]path[:=]packages\/([^/&\s]+)/i;
const MANAGED_SCOPE = "@mo-gallery/";

// ---------------------------------------------------------------------------
// 输出与退出
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`[shared-sync] ${message}`);
}

function fail(message) {
  // 抛错而不是 process.exit：watch 的防抖回调必须能 catch 住（编辑共享包 package.json
  // 时出现瞬时非法 JSON 不能让 watch 进程静默退出）。退出码与文案由最底层入口统一处理。
  throw new Error(`[shared-sync] ✗ ${message}`);
}

/** 尽量用相对当前工作目录的路径，方便阅读。 */
function displayPath(absolute) {
  const relative = path.relative(process.cwd(), absolute);
  return relative && !relative.startsWith("..") ? relative : absolute;
}

function printHelp() {
  console.log(`用法：node scripts/sync-packages.mjs [选项]

  --target <路径>   只同步指定目标仓库（可重复，默认同步 sync.config.json 里的全部）
  --check           只校验不写盘；有差异或被手工改动则退出码 1
  --watch           持续监听 packages/ 变动并自动重新同步
  --force           跳过漂移检测，以 shared 为准强制覆盖镜像
  --verbose         打印每个文件的写入明细
  -h, --help        显示本帮助
`);
}

// ---------------------------------------------------------------------------
// 参数与配置
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { check: false, force: false, watch: false, verbose: false, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--target") {
      const value = argv[++i];
      if (!value) fail("--target 需要一个仓库路径，例如 --target ../mo-gallery-web");
      options.targets.push(value);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      fail(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  if (options.check && options.watch) fail("--check 与 --watch 不能同时使用");
  return options;
}

/** JSON.parse 不接受 UTF-8 BOM，而 Windows 上的编辑器很容易给 JSON 文件加上它。 */
function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

/** 普通对象判断：清单必须是 { packages: { ... } } 这样的结构。 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 统一取错误文案：fail() 抛的是 Error，其他异常也要能读出来。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) fail(`缺少同步配置：${displayPath(CONFIG_PATH)}`);
  try {
    return JSON.parse(stripBom(readFileSync(CONFIG_PATH, "utf8")));
  } catch (error) {
    fail(`sync.config.json 解析失败：${error.message}`);
  }
}

function resolveTargets(config, options) {
  const configured = Array.isArray(config.targets) ? config.targets : [];
  if (configured.length === 0) fail("sync.config.json 里没有配置任何 targets");

  const manifestName = config.manifestName || ".mo-gallery-shared-sync.json";
  // 清单写在目标仓库根：取 "package.json" 之类的名字会覆盖消费方自己的文件。
  if (
    manifestName !== path.basename(manifestName) ||
    manifestName === "package.json" ||
    manifestName === "." ||
    manifestName === ".."
  ) {
    fail(
      `sync.config.json 的 manifestName 必须是单个文件名（当前：${JSON.stringify(manifestName)}），` +
        `且不能是 package.json。`,
    );
  }

  // consumerOnly：消费方专有包名。这些包只在消费方仓库里维护，不属于共享包，也不参与同步；
  // 一旦源头或清单里出现同名包，同步就会覆盖消费方自己的包，所以直接报错。
  const consumerOnly = config.consumerOnly ?? [];
  if (
    !Array.isArray(consumerOnly) ||
    consumerOnly.some((name) => typeof name !== "string" || !SAFE_PACKAGE_DIR_PATTERN.test(name))
  ) {
    fail(
      `sync.config.json 的 consumerOnly 必须是包目录名数组（如 ["plugin-sdk", "emulsion-mcp"]），` +
        `当前：${JSON.stringify(consumerOnly)}`,
    );
  }

  const consumerOnlySet = new Set(consumerOnly);
  const all = configured.map((entry) => {
    if (!entry || typeof entry.path !== "string") {
      fail("sync.config.json 的每个 target 都需要 { name, path }");
    }
    const root = path.resolve(SHARED_ROOT, entry.path);
    // 目标不能是 shared 自己：packagesRoot 会变成源头 PACKAGES_DIR，清理测试残留时
    // 会删掉 shared 自己的 tests/，--watch 下还会自写自触发。
    if (root === SHARED_ROOT || root === PACKAGES_DIR || root.startsWith(PACKAGES_DIR + path.sep)) {
      fail(
        `sync.config.json 里 ${entry.name || entry.path} 的 path 指向 mo-gallery-shared 自身：${displayPath(root)}。\n` +
          `同步目标必须是消费方仓库，请改成一个独立仓库的路径。`,
      );
    }
    return { name: entry.name || entry.path, root, manifestName, consumerOnly: consumerOnlySet };
  });

  if (options.targets.length === 0) return all;

  return options.targets.map((requested) => {
    const wanted = path.resolve(SHARED_ROOT, requested);
    const match = all.find((target) => target.root === wanted);
    if (!match) {
      fail(
        `--target ${requested} 不在 sync.config.json 中。已配置：${all
          .map((target) => displayPath(target.root))
          .join("、")}`,
      );
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// 目录遍历与哈希
// ---------------------------------------------------------------------------

function isExcludedDir(name) {
  return EXCLUDED_DIR_NAMES.has(name);
}

function isExcludedFile(name) {
  return EXCLUDED_FILE_NAMES.has(name) || EXCLUDED_FILE_EXTENSIONS.has(path.extname(name));
}

/**
 * 返回目录下所有应同步的文件（相对路径统一用 / 分隔），已排序。
 * includeTests=true 时连测试一起返回，只用于清理旧镜像里残留的测试文件。
 */
function walkFiles(root, { includeTests = false } = {}) {
  const files = [];
  if (!existsSync(root)) return files;
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop();
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        // 任意层级的 tests / test / __tests__ 目录都不镜像（src/__tests__/helpers.ts
        // 这类不带 .test. 后缀的辅助文件同样会污染消费方的类型检查范围）。
        if (!includeTests && EXCLUDED_TEST_DIR_NAMES.has(entry.name)) continue;
        stack.push(relativePath);
      } else if (entry.isFile()) {
        if (isExcludedFile(entry.name)) continue;
        if (!includeTests && TEST_FILE_PATTERN.test(entry.name)) continue;
        files.push(relativePath);
      }
      // 符号链接一律跳过，避免把 node_modules 之类的东西带进来。
    }
  }
  return files.sort();
}

/**
 * 文本类文件在哈希前做行尾归一化。清单记录的是脚本写入时的字节哈希，而消费方镜像会被
 * git 提交：core.autocrlf=true 的 checkout/clone 会把 LF 换成 CRLF，按原字节哈希就会把
 * 纯行尾差异误报成「镜像被手工修改」，把用户引向 --force 强制覆盖。source 与 target 都
 * 走同一个函数，所以两边一致。只有确实含 0x0d 的文本文件才解码重写，其他文件保持原字节。
 */
function normalizeLineEndings(file, buffer) {
  if (!TEXT_FILE_EXTENSIONS.has(path.extname(file)) || !buffer.includes(0x0d)) return buffer;
  return Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

/** 内容哈希：文件名 + 内容依次喂进 sha256，能同时感知新增/删除/修改。 */
function hashContents(files, contents) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(normalizeLineEndings(file, contents.get(file) ?? Buffer.alloc(0)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// 读取源头包
// ---------------------------------------------------------------------------

/**
 * 生成镜像用的 package.json：
 * 1. 同仓库 git 引用改写成 workspace:*（镜像必须自洽，否则消费方会解析到远程旧版本）；
 * 2. 删掉指向 tests/ 的脚本（测试不进镜像，留着就是死链）。
 * 没有任何改动时原样返回，避免无谓地重排 JSON。
 */
function normalizePackageJson(raw, packageDirName) {
  const text = raw.toString("utf8");
  let json;
  try {
    json = JSON.parse(stripBom(text));
  } catch (error) {
    fail(`packages/${packageDirName}/package.json 不是合法 JSON：${error.message}`);
  }

  let changed = false;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = json[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [dependency, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string" || !dependency.startsWith(MANAGED_SCOPE)) continue;
      if (spec.startsWith("workspace:")) continue;
      if (SHARED_GIT_SPEC.test(spec)) {
        dependencies[dependency] = "workspace:*";
        changed = true;
        continue;
      }
      fail(
        `packages/${packageDirName}/package.json 的 ${field}.${dependency} 使用了非 workspace 引用：\n` +
          `  ${spec}\n` +
          `共享包之间必须用 "workspace:*"，否则消费方仍会拉到远程旧版本。`,
      );
    }
  }

  // 测试不进镜像，指向 tests/ 的脚本会变成死链，一并删掉。
  if (json.scripts && typeof json.scripts === "object") {
    for (const [name, command] of Object.entries(json.scripts)) {
      if (typeof command === "string" && TEST_SCRIPT_PATTERN.test(command)) {
        delete json.scripts[name];
        changed = true;
      }
    }
    if (Object.keys(json.scripts).length === 0) {
      delete json.scripts;
      changed = true;
    }
  }

  if (!changed) return raw;
  return Buffer.from(`${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function discoverSourcePackageNames() {
  if (!existsSync(PACKAGES_DIR)) fail(`找不到共享包目录：${displayPath(PACKAGES_DIR)}`);
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(PACKAGES_DIR, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * 镜像里的 tsconfig*.json 必须自洽：它会被放到消费方的 packages/<name>/<relPath> 下，
 * extends 若指向包目录之外（"../../tsconfig.json" 这种），那边根本没有对应文件——
 * desktop 的 Vite 在 esbuild 转换阶段会直接报 "failed to resolve extends" 而中断构建。
 * 数组形式（TS 5 的 "extends": ["../../x.json", "./y.json"]）以及 tsconfig.build.json、
 * src/tsconfig.json 等同名文件都要一并检查。
 */
function validateTsconfig(raw, packageDirName, relPath) {
  const located = `packages/${packageDirName}/${relPath}`;
  let json;
  try {
    json = JSON.parse(stripBom(raw.toString("utf8")));
  } catch (error) {
    fail(`${located} 不是合法 JSON：${error.message}`);
  }

  const packageDir = path.resolve(PACKAGES_DIR, packageDirName);
  const extendsEntries = Array.isArray(json.extends) ? json.extends : [json.extends];
  for (const entry of extendsEntries) {
    // 包名形式的 extends（"@tsconfig/node22/tsconfig.json"）与仓库布局无关，跳过。
    if (typeof entry !== "string" || entry.startsWith("@")) continue;
    const resolved = path.resolve(
      path.dirname(path.join(PACKAGES_DIR, packageDirName, relPath)),
      entry,
    );
    if (resolved === packageDir || resolved.startsWith(packageDir + path.sep)) continue;
    fail(
      `${located} 的 extends 指向包目录之外：${entry}\n` +
        `镜像会被放到消费方的 packages/${packageDirName}/ 下，那里没有这个文件，desktop 的 Vite 会报 failed to resolve extends。\n` +
        `请把被继承的 compilerOptions 直接内联进这个 tsconfig。`,
    );
  }
}

function readSourcePackage(dirName) {
  const dir = path.join(PACKAGES_DIR, dirName);
  const files = walkFiles(dir);
  const contents = new Map();
  let packageName = null;

  for (const file of files) {
    const raw = readFileSync(path.join(dir, file));
    if (file === "package.json") {
      try {
        packageName = JSON.parse(stripBom(raw.toString("utf8"))).name ?? null;
      } catch (error) {
        fail(`packages/${dirName}/package.json 不是合法 JSON：${error.message}`);
      }
      contents.set(file, normalizePackageJson(raw, dirName));
    } else {
      // 相对路径可能含 "/"（如 src/tsconfig.json），按文件名匹配所有 tsconfig*.json。
      if (/^tsconfig.*\.json$/.test(path.basename(file))) validateTsconfig(raw, dirName, file);
      contents.set(file, raw);
    }
  }

  // 镜像路径直接沿用目录名，包名与目录名不一致会让消费方的 workspace:* 指错地方。
  const expectedSuffix = packageName?.startsWith(MANAGED_SCOPE)
    ? packageName.slice(MANAGED_SCOPE.length)
    : null;
  if (expectedSuffix !== dirName) {
    fail(
      `packages/${dirName}/package.json 的包名是 ${packageName ?? "(缺失)"}，与目录名不一致。\n` +
        `镜像目录按目录名生成，请让两者保持一致（应为 ${MANAGED_SCOPE}${dirName}）。`,
    );
  }

  return {
    dirName,
    packageName,
    files,
    contents,
    hash: hashContents(files, contents),
  };
}

// ---------------------------------------------------------------------------
// 读取 / 写入目标镜像
// ---------------------------------------------------------------------------

function readTargetPackage(packagesRoot, dirName) {
  const dir = path.join(packagesRoot, dirName);
  if (!existsSync(dir)) return null;
  const files = walkFiles(dir);
  const contents = new Map(files.map((file) => [file, readFileSync(path.join(dir, file))]));
  // 测试文件对 hash 不可见，但残留下来仍会污染消费方的类型检查，单独记一笔以触发清理。
  const leftoverFiles = walkFiles(dir, { includeTests: true }).filter(
    (file) => !files.includes(file),
  );
  return { dir, files, contents, leftoverFiles, hash: hashContents(files, contents) };
}

function readManifest(manifestPath) {
  // 文件不存在是合法的首次运行；文件损坏则必须报错，否则漂移检测整体失效，
  // 消费方被手工改过的镜像会被无声覆盖（--check 还会误报「全部一致」）。
  if (!existsSync(manifestPath)) return null;

  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFileSync(manifestPath, "utf8")));
  } catch (error) {
    fail(
      `清单 ${displayPath(manifestPath)} 不是合法 JSON：${error.message}\n` +
        `该文件记录镜像内容哈希，用于保护消费方的手工改动，不能当作「首次运行」忽略。\n` +
        `请修复它，或删除该文件后重新运行 pnpm sync（首次运行会重建清单）。`,
    );
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.packages)) {
    fail(
      `清单 ${displayPath(manifestPath)} 结构损坏：缺少 packages 对象。\n` +
        `该文件记录镜像内容哈希，用于保护消费方的手工改动，不能当作「首次运行」忽略。\n` +
        `请修复它，或删除该文件后重新运行 pnpm sync（首次运行会重建清单）。`,
    );
  }
  return parsed;
}

function pruneEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || isExcludedDir(entry.name)) continue;
    const child = path.join(dir, entry.name);
    pruneEmptyDirs(child);
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true });
  }
}

function writePackage(dir, source, verbose) {
  mkdirSync(dir, { recursive: true });

  const wanted = new Set(source.files);
  // includeTests：早期版本同步过测试文件，这里要一并清掉，否则会继续污染消费方的类型检查。
  for (const existing of walkFiles(dir, { includeTests: true })) {
    if (wanted.has(existing)) continue;
    if (verbose) log(`    删除 ${path.join(dir, existing)}`);
    rmSync(path.join(dir, existing), { force: true });
  }
  for (const file of source.files) {
    const absolute = path.join(dir, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source.contents.get(file));
  }
  pruneEmptyDirs(dir);
}

function gitInfo(repoDir) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", repoDir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: run(["rev-parse", "HEAD"]),
    dirty: (run(["status", "--porcelain", "--", "packages"]) ?? "") !== "",
  };
}

function writeManifestIfChanged(manifestPath, previous, packages, verbose) {
  // 只在镜像内容真正变化时重写清单，否则每次同步的时间戳都会产生无意义 diff。
  if (previous && JSON.stringify(previous.packages ?? {}) === JSON.stringify(packages)) {
    return false;
  }

  const manifest = {
    generator: "mo-gallery-shared/scripts/sync-packages.mjs",
    note:
      "本文件由 mo-gallery-shared 的 pnpm sync 生成，请勿手工编辑。" +
      "source.commit 是最近一次内容变更时执行同步的 shared HEAD；" +
      "source.dirty 为 true 表示当时该改动尚未提交。",
    source: { repo: SOURCE_LABEL, ...gitInfo(SHARED_ROOT) },
    syncedAt: new Date().toISOString(),
    packages,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (previous && readFileSync(manifestPath, "utf8") === serialized) return false;

  writeFileSync(manifestPath, serialized);
  if (verbose) log(`    更新 ${displayPath(manifestPath)}`);
  return true;
}

// ---------------------------------------------------------------------------
// 单个目标的同步
// ---------------------------------------------------------------------------

function syncTarget(sourcePackages, target, options) {
  if (!existsSync(target.root)) {
    fail(`目标仓库目录不存在：${displayPath(target.root)}（${target.name}）`);
  }

  const packagesRoot = path.join(target.root, "packages");
  const manifestPath = path.join(target.root, target.manifestName);
  const previous = readManifest(manifestPath);
  const previousPackages = previous?.packages ?? {};

  // 清单是消费方仓库里被提交的普通 JSON，它的键会被当成 packages/ 下的目录名使用：
  // "." / ".." / "../.." / "a/b" 这类键在删除阶段会越出 packages/（删掉消费方仓库根、
  // 整个工作区，或消费方自有包内部目录），所以整张清单直接拒绝。
  for (const name of Object.keys(previousPackages)) {
    if (SAFE_PACKAGE_DIR_PATTERN.test(name)) continue;
    fail(
      `${target.name} 的清单 ${target.manifestName} 里有非法包名：${JSON.stringify(name)}\n` +
        `清单可能已损坏或被手工编辑，请删除 ${displayPath(manifestPath)} 后重新运行 pnpm sync` +
        `（首次运行会重建清单）。`,
    );
  }
  // 清单里出现消费方专有包名，说明有人把专有包当共享包同步过；继续下去会覆盖消费方
  // 自己的包（如 desktop 的 plugin-sdk / emulsion-mcp），因此直接停手。
  const clashes = Object.keys(previousPackages).filter((name) => target.consumerOnly.has(name));
  if (clashes.length > 0) {
    fail(
      `${target.name} 的清单 ${target.manifestName} 里出现了消费方专有包：${clashes.join("、")}\n` +
        `这些包只在消费方仓库里维护，不参与共享包同步。` +
        `请删除 ${displayPath(manifestPath)} 后重新运行 pnpm sync。`,
    );
  }

  const knownNames = new Set([
    ...sourcePackages.map((source) => source.dirName),
    ...Object.keys(previousPackages),
  ]);
  const currentByName = new Map();
  for (const name of knownNames) currentByName.set(name, readTargetPackage(packagesRoot, name));

  // 1) 漂移检测：镜像被手工改过就停手，绝不静默覆盖别人的改动。
  if (!options.force) {
    const drift = [];
    for (const [name, recorded] of Object.entries(previousPackages)) {
      const current = currentByName.get(name);
      if (!current) {
        drift.push(`packages/${name}：清单里有记录，但镜像目录已消失`);
      } else if (current.hash !== recorded.hash) {
        drift.push(`packages/${name}：镜像内容与上次同步记录不一致`);
      }
    }
    if (drift.length > 0) {
      fail(
        `检测到 ${target.name} 的镜像被手工修改，已停止以免覆盖：\n  - ${drift.join("\n  - ")}\n` +
          `共享包只应在 mo-gallery-shared 里改。确认要以 shared 为准覆盖镜像时，请加 --force。`,
      );
    }
  }

  // 2) 计算差异
  const created = [];
  const updated = [];
  const unchanged = [];
  const removed = [];
  const manifestPackages = {};
  let needsInstall = false;

  for (const source of sourcePackages) {
    const current = currentByName.get(source.dirName);
    const isSame =
      current !== null && current.hash === source.hash && current.leftoverFiles.length === 0;
    if (!current) created.push(source.dirName);
    else if (!isSame) updated.push(source.dirName);
    else unchanged.push(source.dirName);

    manifestPackages[source.dirName] = { hash: source.hash, files: source.files.length };

    if (!isSame) {
      const before = current?.contents.get("package.json");
      const after = source.contents.get("package.json");
      if (!before || !before.equals(after)) needsInstall = true;
    }
  }
  for (const name of Object.keys(previousPackages)) {
    if (sourcePackages.some((source) => source.dirName === name)) continue;
    removed.push(name);
    needsInstall = true;
  }

  const changed = created.length + updated.length + removed.length > 0;

  // 3) 校验模式：只报告，不写盘
  if (options.check) {
    if (!changed) {
      log(`✓ ${target.name}：${unchanged.length} 个包均与 shared 一致`);
    } else {
      const parts = [];
      if (created.length) parts.push(`新增 ${created.join("、")}`);
      if (updated.length) parts.push(`待更新 ${updated.join("、")}`);
      if (removed.length) parts.push(`待删除 ${removed.join("、")}`);
      console.error(`[shared-sync] ✗ ${target.name}：${parts.join("；")}`);
    }
    return changed;
  }

  // 4) 写盘
  if (!changed) {
    log(`✓ ${target.name}：已是最新（${unchanged.length} 个包）`);
  } else {
    for (const source of sourcePackages) {
      if (unchanged.includes(source.dirName)) continue;
      writePackage(path.join(packagesRoot, source.dirName), source, options.verbose);
    }
    for (const name of removed) {
      // 双保险：即使清单键名校验被绕过，也只允许删除 packages/ 的直接子目录。
      const absolute = path.resolve(packagesRoot, name);
      if (path.dirname(absolute) !== path.resolve(packagesRoot)) {
        fail(
          `拒绝删除 ${absolute}：它不在 ${displayPath(packagesRoot)} 的直接子目录下` +
            `（${target.name} 的 ${target.manifestName} 可能已损坏）。`,
        );
      }
      if (options.verbose) log(`    删除 packages/${name}`);
      rmSync(absolute, { recursive: true, force: true });
    }

    const parts = [];
    if (created.length) parts.push(`新增 ${created.join("、")}`);
    if (updated.length) parts.push(`更新 ${updated.join("、")}`);
    if (removed.length) parts.push(`删除 ${removed.join("、")}`);
    log(`✓ ${target.name}：${parts.join("；")}`);
  }

  const manifestWritten = writeManifestIfChanged(
    manifestPath,
    previous,
    manifestPackages,
    options.verbose,
  );

  if (needsInstall && changed) {
    log(`  ↳ 依赖有变化，请在 ${displayPath(target.root)} 运行 pnpm install`);
  }
  if (manifestWritten && !changed) {
    log(`  ↳ 生成 ${target.manifestName}（记录镜像内容哈希，用于漂移检测）`);
  }

  return changed;
}

/**
 * 镜像里的 "workspace:*" 必须能在同一批源包里找到对应的包名：消费方 packages/ 的
 * workspace 范围只有这些包，指向不存在的包时 pnpm install 会直接失败。
 */
function validateWorkspaceReferences(sourcePackages) {
  const known = new Set(sourcePackages.map((source) => source.packageName));
  for (const source of sourcePackages) {
    const raw = source.contents.get("package.json");
    if (!raw) continue;
    let json;
    try {
      json = JSON.parse(stripBom(raw.toString("utf8")));
    } catch (error) {
      fail(`packages/${source.dirName}/package.json 不是合法 JSON：${error.message}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = json[field];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const [dependency, spec] of Object.entries(dependencies)) {
        if (spec !== "workspace:*" || known.has(dependency)) continue;
        fail(
          `packages/${source.dirName}/package.json 的 ${field}.${dependency} 用了 "workspace:*"，` +
            `但 packages/ 下没有名为 ${dependency} 的共享包。\n` +
            `消费方执行 pnpm install 时会因为找不到这个 workspace 包而失败。`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function runOnce(options, config) {
  const targets = resolveTargets(config, options);

  const sourcePackages = discoverSourcePackageNames().map(readSourcePackage);
  if (sourcePackages.length === 0) fail("packages/ 下没有找到任何可同步的包");
  validateWorkspaceReferences(sourcePackages);

  // 消费方专有包绝不能进 shared：放进 packages/ 就会被同步到消费方并覆盖同名包。
  const promoted = sourcePackages.filter((source) => targets[0].consumerOnly.has(source.dirName));
  if (promoted.length > 0) {
    fail(
      `packages/ 下出现了消费方专有包：${promoted.map((source) => source.dirName).join("、")}\n` +
        `它们（plugin-sdk、emulsion-mcp 等）只在消费方仓库里维护，不属于共享包。\n` +
        `放进 shared 会在同步时覆盖消费方自己的同名包；请移回消费方仓库，` +
        `或从 sync.config.json 的 consumerOnly 中移除。`,
    );
  }

  log(
    `源头 ${displayPath(PACKAGES_DIR)}：${sourcePackages
      .map((source) => source.packageName)
      .join("、")}`,
  );

  let driftedOrChanged = false;
  for (const target of targets) {
    if (syncTarget(sourcePackages, target, options)) driftedOrChanged = true;
  }

  if (options.check) {
    if (driftedOrChanged) {
      fail(`镜像与 shared 不一致。请在 ${displayPath(SHARED_ROOT)} 运行 pnpm sync 并提交消费方变更。`);
    }
    log("✓ 全部镜像与 shared 一致");
  }
}

function startWatch(options, config) {
  runOnce(options, config);
  log(`watch 模式：监听 ${displayPath(PACKAGES_DIR)} 的变动，Ctrl+C 退出`);

  let timer = null;
  // fail() 抛错后不能让 watch 进程退出：源头改回合法状态后会再次触发同步。
  const onSyncError = (error) => {
    console.error(`\n${errorMessage(error)}`);
    console.error("[shared-sync] 本次同步失败，watch 仍在运行，修好后会再次尝试\n");
  };

  let watcher;
  try {
    watcher = watch(PACKAGES_DIR, { recursive: true }, (_eventType, filename) => {
      const changedPath = typeof filename === "string" ? filename : "";
      if (changedPath.split(/[\\/]/).some(isExcludedDir)) return;
      if (isExcludedFile(path.basename(changedPath))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          runOnce(options, config);
        } catch (error) {
          onSyncError(error);
        }
      }, 200);
    });
  } catch (error) {
    fail(
      `无法监听 ${displayPath(PACKAGES_DIR)}：${errorMessage(error)}\n` +
        `本平台可能不支持 fs.watch 的递归监听，或 inotify 监听数已用满。\n` +
        `请改用 pnpm sync（每次手动跑一遍），或改完共享包后多次手动同步。`,
    );
  }
  // 运行期的监听错误（例如 inotify 限额耗尽）只提示，不能让进程崩掉。
  watcher.on("error", (error) => {
    console.error(`\n[shared-sync] ✗ watch 监听出错：${errorMessage(error)}`);
    console.error("[shared-sync] 监听可能已失效，建议改用 pnpm sync，或多次手动同步\n");
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (options.watch) startWatch(options, config);
  else runOnce(options, config);
}

// fail() 是抛错，退出码与错误文案统一在最底层入口处理（watch 的防抖回调里已自行 catch）。
try {
  main();
} catch (error) {
  console.error(`\n${errorMessage(error)}\n`);
  process.exit(1);
}
