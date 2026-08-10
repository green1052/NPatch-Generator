import {dirname, join} from "node:path";
import {readdirSync, renameSync, statSync} from "node:fs";
import {Camoufox} from "camoufox-js";
import type {Browser, Page} from "playwright-core";
import {compareVersions, ensureDir} from "../util.js";
import {consola} from "consola";
import type {DownloadContext, DownloadResult} from "./types.js";

const APKMIRROR_BASE = "https://www.apkmirror.com";

interface VersionEntry {
    version: string;
    url: string;
    isBeta: boolean;
}

/**
 * Scrape APKMirror app page for available versions.
 * Uses the app's direct URL (e.g. https://www.apkmirror.com/apk/google-inc/youtube).
 */
async function scrapeVersions(
    page: Page,
    appUrl: string,
    includeBeta: boolean
): Promise<VersionEntry[]> {
    consola.success(`APKMirror: fetching versions from ${appUrl}`);
    await page.goto(appUrl, {waitUntil: "networkidle", timeout: 60000});
    await page.waitForTimeout(2000);

    // Extract app path from URL (e.g. /apk/google-inc/youtube) to filter site-wide widgets
    const appPath = new URL(appUrl).pathname.replace(/\/$/, "");

    const entries = await page.evaluate((args: { baseUrl: string; appPath: string }) => {
        const rows = document.querySelectorAll(".appRow");
        const results: { version: string; url: string; isBeta: boolean }[] = [];
        for (const row of rows) {
            const links = Array.from(row.querySelectorAll("a"))
                .filter((a) => {
                    const href = a.getAttribute("href") ?? "";
                    // Only links within this app's own path (exclude site-wide widgets)
                    return href.includes("-release/") && href.includes(args.appPath);
                })
                .filter((a) => (a.textContent ?? "").trim().length > 0);

            const versionLink = links.find((a) => {
                const text = (a.textContent ?? "").trim();
                return text && !text.includes("variants") && !text.includes("disqus");
            });
            if (!versionLink) continue;

            const href = versionLink.getAttribute("href") ?? "";
            const text = (versionLink.textContent ?? "").trim();
            const isBeta = /beta|alpha/i.test(text);

            const match = href.match(/-([\d.]+(?:-\w+)?)-release\//);
            if (!match) continue;
            let version = match[1]!.replace(/-/g, ".");
            version = version.replace(/\.[A-Z]+$/, "");

            results.push({
                version,
                url: href.startsWith("http") ? href : `${args.baseUrl}${href}`,
                isBeta
            });
        }
        return results;
    }, {baseUrl: APKMIRROR_BASE, appPath});

    const seen = new Set<string>();
    const deduped = entries.filter((e) => {
        if (seen.has(e.version)) return false;
        seen.add(e.version);
        return true;
    });

    const filtered = includeBeta ? deduped : deduped.filter((e) => !e.isBeta);
    return filtered.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Find the download URL for a specific version on APKMirror.
 * Navigates version page → variant selection → download page → final APK URL.
 */
async function findApkDownloadUrl(
    page: Page,
    versionUrl: string,
    arch: string,
    dpi: string
): Promise<{ url: string; isBundle: boolean } | null> {
    consola.success(`APKMirror: resolving download URL from ${versionUrl}`);
    await page.goto(versionUrl, {waitUntil: "networkidle", timeout: 60000});
    await page.waitForTimeout(2000);

    const appArch = arch === "arm-v7a" ? "armeabi-v7a" : arch;
    const archOptions = ["universal", "noarch", "arm64-v8a + armeabi-v7a"];
    if (arch !== "all") archOptions.push(appArch);

    const dpiOptions = ["nodpi", "anydpi"];
    if (dpi) dpiOptions.push(...dpi.split(/\s+/));

    const downloadLink = await page.evaluate(
        (args: { archOptions: string[]; dpiOptions: string[] }) => {
            const rows = document.querySelectorAll("div.table-row.headerFont");
            for (let n = rows.length - 1; n >= 0; n--) {
                const row = rows[n]!;
                const link = row.querySelector("a");
                if (!link) continue;
                const href = link.getAttribute("href") ?? "";
                if (!href.includes("-release/") && !href.includes("/download/")) continue;

                const allText = row.textContent?.replace(/\s+/g, " ").trim() ?? "";

                const archMatch = args.archOptions.some((a) =>
                    allText.toLowerCase().includes(a.toLowerCase())
                );
                const dpiMatch = args.dpiOptions.some((d) =>
                    allText.toLowerCase().includes(d.toLowerCase())
                );

                if (archMatch && dpiMatch) {
                    const isBundle = /BUNDLE/i.test(allText);
                    return {
                        url: href.startsWith("http") ? href : `https://www.apkmirror.com${href}`,
                        isBundle
                    };
                }
            }
            return null;
        },
        {archOptions, dpiOptions}
    );

    if (!downloadLink) return null;

    // Navigate to the variant page
    await page.goto(downloadLink.url, {waitUntil: "networkidle", timeout: 60000});
    await page.waitForTimeout(2000);

    // Find the intermediate download button
    const intermediateUrl = await page.evaluate(() => {
        const btn = document.querySelector("a.btn.download-link") ||
            document.querySelector("a.btn");
        return btn?.getAttribute("href") ?? null;
    });

    if (!intermediateUrl) return null;
    const fullIntermediate = intermediateUrl.startsWith("http")
        ? intermediateUrl
        : `${APKMIRROR_BASE}${intermediateUrl}`;

    await page.goto(fullIntermediate, {waitUntil: "networkidle", timeout: 60000});
    await page.waitForTimeout(3000);

    // Get the final download URL from the page
    const finalUrl = await page.evaluate(() => {
        const link = document.querySelector("a[rel='nofollow']") ||
            document.querySelector("#download-link a") ||
            document.querySelector("span > a[rel='nofollow']");
        return link?.getAttribute("href") ?? null;
    });

    if (!finalUrl) return null;
    return {
        url: finalUrl.startsWith("http") ? finalUrl : `${APKMIRROR_BASE}${finalUrl}`,
        isBundle: downloadLink.isBundle
    };
}

/**
 * Download APK from APKMirror using Camoufox (bot-check bypass).
 * Uses browser saveAs for download to bypass 403 on direct fetch.
 * Must use headful mode - Cloudflare challenge blocks headless.
 */
export const downloadApkmirror: (ctx: DownloadContext) => Promise<DownloadResult> =
    async (ctx: DownloadContext): Promise<DownloadResult> => {
        const source = ctx.app.sources.find((s) => s.type === "apkmirror");
        if (!source) throw new Error("apkmirror: no apkmirror source configured");

        const arch = ctx.app.arch ?? "all";
        const dpi = ctx.app.dpi ?? "nodpi";
        const includeBeta = ctx.app.includeBeta ?? false;

        const browser: Browser = await Camoufox({
            headless: true,
            os: "windows",
            locale: "en-US",
            downloadsPath: ctx.workDir,
        });
        const page: Page = await browser.newPage();

        try {
            const versions = await scrapeVersions(page, source.url, includeBeta);
            if (versions.length === 0) {
                throw new Error(`apkmirror: no versions found for ${ctx.app.packageName}`);
            }

            // Select target version
            let target: VersionEntry;
            if (ctx.targetVersion === "latest" || ctx.targetVersion === "auto") {
                target = versions[0]!;
            } else {
                const found = versions.find(
                    (v) => v.version === ctx.targetVersion.replace(/^v/, "")
                );
                if (!found) {
                    consola.warn(`apkmirror: version ${ctx.targetVersion} not found, using ${versions[0]!.version}`);
                }
                target = found ?? versions[0]!;
            }

            consola.success(`APKMirror: selected version ${target.version} for ${ctx.app.packageName}`);

            const dlInfo = await findApkDownloadUrl(page, target.url, arch, dpi);
            if (!dlInfo) {
                throw new Error(
                    `apkmirror: no matching APK found for ${ctx.app.packageName} ${target.version} (arch=${arch}, dpi=${dpi})`
                );
            }

            const ext = dlInfo.isBundle ? ".apkm" : ".apk";
            const outPath = join(
                ctx.workDir,
                `${ctx.app.packageName}-${target.version}-${arch}${ext}`
            );

            // Download via browser auto-download (downloadsPath) + file polling.
            // fetch() fails CORS, got fails 403, waitForResponse fails on redirect body.
            ensureDir(dirname(outPath));

            // ponytail: poll-based download detection — patchright has no download events
            const filesBefore = new Set(readdirSync(ctx.workDir));
            consola.success(`APKMirror: downloading ${dlInfo.url}`);
            try {
                await page.goto(dlInfo.url, {waitUntil: "commit", timeout: 60000});
            } catch {
                // Navigation throws for download responses — expected
            }

            // Wait for new file to appear and stop growing
            const deadline = Date.now() + 120000;
            let downloadedFile: string | null = null;
            let lastSize = 0;
            let stableCount = 0;
            while (Date.now() < deadline) {
                await page.waitForTimeout(2000);
                const filesAfter = readdirSync(ctx.workDir);
                const newFiles = filesAfter.filter((f) => !filesBefore.has(f));
                if (newFiles.length > 0) {
                    const candidate = newFiles[0]!;
                    const fullCandidate = join(ctx.workDir, candidate);
                    const size = statSync(fullCandidate).size;
                    if (size === lastSize && size > 0) {
                        stableCount++;
                        if (stableCount >= 2) {
                            downloadedFile = fullCandidate;
                            break;
                        }
                    } else {
                        stableCount = 0;
                        lastSize = size;
                    }
                }
            }

            if (!downloadedFile) {
                throw new Error("APKMirror: download timed out or no file appeared");
            }
            renameSync(downloadedFile, outPath);

            return {
                apkPath: outPath,
                version: target.version,
                isSplit: dlInfo.isBundle,
                ...(dlInfo.isBundle ? {splitPath: outPath} : {})
            };
        } finally {
            await browser.close();
        }
    };
