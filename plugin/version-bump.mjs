import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;

// Bump version in manifest.json (plugin/ and repo root copies)
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
const manifestStr = `${JSON.stringify(manifest, null, "  ")}\n`;
writeFileSync("manifest.json", manifestStr);
writeFileSync("../manifest.json", manifestStr);

// Update versions.json with target version and minAppVersion
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, "  ")}\n`);
