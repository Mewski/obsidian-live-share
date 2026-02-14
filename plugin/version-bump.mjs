import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;

// Bump version in manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, "  ")}\n`);

// Update versions.json with target version and minAppVersion
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, "  ")}\n`);
