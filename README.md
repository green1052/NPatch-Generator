# NPatch Generator

Automated APK patcher that downloads APKs from multiple sources and applies [NPatch](https://github.com/7723mod/NPatch) (an LSPatch fork) with Xposed module embedding support.

## Features

- **Multi-source download**: Vendetta tracker (Discord), APKMirror, Uptodown, direct URL
- **Split APK handling**: merges `.apkm`/`.xapk` via APKEditor before patching
- **BouncyCastle auto-setup**: resolves latest BC provider from Maven Central for BKS keystore
- **Parallel processing**: configurable concurrency via `p-limit`
- **Headful browser bypass**: Camoufox (Firefox anti-detect) for Cloudflare/Uptodown bot detection
- **Config-driven**: JSON config with global + per-app NPatch args merge

## Requirements

- Node.js 22+
- pnpm 11+
- JDK 17+ (tested on 25)

## Install

```bash
pnpm install
npx camoufox-js fetch
```

## Usage

```bash
pnpm start                # uses config.json
pnpm start custom.json    # custom config
```

## Config

```json
{
    "outputDir": "build",
    "jarCacheDir": "bin",
    "npatchVersion": "latest",
    "apkeditorVersion": "latest",
    "bcVersion": "latest",
    "concurrency": 3,
    "apps": [
        {
            "packageName": "com.discord",
            "arch": "arm64-v8a",
            "sources": [
                { "type": "vendetta", "url": "https://tracker.vendetta.rocks" }
            ]
        },
        {
            "packageName": "com.dcinside.app.android",
            "sources": [
                { "type": "uptodown", "url": "https://dcinside.kr.uptodown.com/android" }
            ]
        }
    ]
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `outputDir` | `"build"` | Patched APK output directory |
| `jarCacheDir` | `"bin"` | NPatch/APKEditor/BC jar cache |
| `npatchVersion` | `"latest"` | NPatch GitHub release tag |
| `apkeditorVersion` | `"latest"` | APKEditor GitHub release tag |
| `bcVersion` | `"latest"` | BouncyCastle Maven version |
| `concurrency` | `3` | Max parallel app processing |
| `npatchArgs` | — | Global NPatch args (see below) |

### App fields

| Field | Default | Description |
|-------|---------|-------------|
| `packageName` | required | Android package name |
| `arch` | `"all"` | `arm64-v8a` / `arm-v7a` / `x86` / `x86_64` / `all` |
| `version` | `"latest"` | `"latest"` / `"auto"` / version string |
| `dpi` | `"nodpi"` | APKMirror DPI filter |
| `includeBeta` | `false` | Include beta/alpha versions |
| `sources` | required | Array of download sources |
| `npatchArgs` | — | Per-app NPatch args (overrides global) |

### Source types

| Type | URL format | Notes |
|------|-----------|-------|
| `vendetta` | `https://tracker.vendetta.rocks` | Discord via Google Play proxy, downloads split APKs |
| `apkmirror` | `https://www.apkmirror.com/apk/{publisher}/{app}` | Headful browser scraping |
| `uptodown` | `https://{app}.en.uptodown.com/android` | Headful browser, AJAX intercept |
| `direct` | `https://example.com/app.apk` | Direct download URL |

### NPatch args

| Arg | Default | Description |
|-----|---------|-------------|
| `sigbypassLevel` | `2` | 0: None, 1: Basic, 2: High |
| `debuggable` | `false` | Make app debuggable |
| `keystore` | `null` | Custom keystore `[path, password, alias, aliasPassword]` |
| `useNpatchKeystore` | `true` | Use built-in NPatch keystore |
| `useFpaKeystore` | `false` | Use built-in FPA keystore |
| `modules` | `[]` | Xposed module APK paths to embed |
| `manager` | `false` | Manager mode (conflicts with modules) |
| `newPackageName` | `""` | Rename package |
| `useMicroG` | `false` | MicroG compatibility |
| `hideLibs` | `false` | Hide ART/system lib visibility |
| `allowDowngrade` | `false` | Override versionCode to 1 |
| `versionCode` | `1` | Custom versionCode (with allowDowngrade) |
| `verbose` | `false` | Verbose NPatch logging |
| `force` | `true` | Force overwrite output |

## CI

GitHub Actions workflow (`.github/workflows/build-release.yml`):
- Weekly cron (Mon 00:00 UTC) + manual dispatch
- Builds all apps, uploads patched APKs to Releases
- Keeps only latest release (via `Nats-ji/delete-old-releases`)

## How it works

```
config.json
  ↓
Download APK (vendetta / apkmirror / uptodown / direct)
  ↓
Merge splits if .apkm/.xapk (APKEditor)
  ↓
Patch with NPatch (BouncyCastle on classpath for BKS keystore)
  ↓
*-npatched.apk
```
