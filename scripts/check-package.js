#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/pi-profile.js",
  "extensions/auth-profile.ts",
];

for (const file of required) {
  const path = join(root, file);
  if (!existsSync(path)) {
    console.error(`Missing required package file: ${file}`);
    process.exit(1);
  }
}

accessSync(join(root, "bin/pi-profile.js"), constants.X_OK);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const key of ["name", "version", "description", "license", "bin", "files", "pi"]) {
  if (pkg[key] === undefined) {
    console.error(`package.json missing ${key}`);
    process.exit(1);
  }
}

console.log("package metadata looks good");
