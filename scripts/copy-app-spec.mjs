import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceDir = path.join(repoRoot, "docs", "spec");
const appDir = path.join(repoRoot, "packages", "app");
const destinationDir = path.join(appDir, "dist", "spec");

fs.rmSync(destinationDir, { force: true, recursive: true });
fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
fs.cpSync(sourceDir, destinationDir, { recursive: true });

const bundledAgentFiles = ["prompt.md", "setup.md"];
for (const fileName of bundledAgentFiles) {
  const source = fs.readFileSync(path.join(appDir, "public", fileName), "utf8");
  const bundled = fs.readFileSync(path.join(appDir, "dist", fileName), "utf8");
  if (bundled !== source) {
    throw new Error(
      `packages/app/dist/${fileName} differs from packages/app/public/${fileName}; the served copy must equal the repo file`,
    );
  }
}
