import {dirname, join} from "node:path";
import {readdirSync, renameSync, statSync} from "node:fs";
import pLimit from "p-limit";
import {Camoufox} from "camoufox-js";
import type {Browser, Page} from "playwright-core";
import {ensureDir} from "../util.js";
import {consola} from "consola";
import type {DownloadContext, DownloadResult} from "./types.js";

interface UptodownVersionEntry {
    version: string;
    /** Download page URL: {data-url}/{data-extra-url}/{data-version-id} */
    downloadPageUrl: string;
    isXapk: boolean;
}

// Turnstile is slow or rejects concurrent challenges from one CI IP.
const downloadLimit = pLimit(1);

/**
 * Scrape Uptodown versions page.
 * Uses #versions-items-list container with data attributes.
 */
async function scrapeUptodownVersions(
    page: Page,
    versionsUrl: string
): Promise<UptodownVersionEntry[]> {
    consola.success(`Uptodown: fetching versions from ${versionsUrl}`);
    await page.goto(versionsUrl, {waitUntil: "domcontentloaded", timeout: 60000});
    await page.waitForTimeout(5000);

    const versions = await page.evaluate(() => {
        const list = document.querySelector("#versions-items-list");
        if (!list) return [];
        const items = Array.from(list.children).map((el) => {
            const ds = el as HTMLElement;
            const version = el.querySelector(".version")?.textContent?.trim() ?? "";
            const typeEl = el.querySelector(".type");
            const isXapk = /xapk/i.test(typeEl?.className ?? "") ||
                /xapk/i.test(typeEl?.getAttribute("title") ?? "");
            const url = ds.dataset.url ?? "";
            const versionId = ds.dataset.versionId ?? "";
            const extraUrl = ds.dataset.extraUrl ?? "download";
            // Construct download page URL
            const downloadPageUrl = `${url}/${extraUrl}/${versionId}`;
            return {version, downloadPageUrl, isXapk};
        });
        return items.filter((i) => i.version && i.downloadPageUrl);
    });

    return versions;
}

/**
 * Navigate to a version's download page, click download button, capture the
 * download URL via `<a>` href hook, then trigger browser saveAs via page.goto.
 * Same pattern as apkmirror.ts — browser handles Turnstile + AJAX, we handle
 * download via page.goto + file polling (Playwright Firefox doesn't fire
 * download events for programmatic `<a>.click()`).
 */
async function downloadViaBrowser(
    page: Page,
    downloadPageUrl: string,
    workDir: string,
    outName: string
): Promise<{ path: string; isXapk: boolean } | null> {
    consola.success(`Uptodown: resolving download from ${downloadPageUrl}`);
    await page.goto(downloadPageUrl, {waitUntil: "domcontentloaded", timeout: 60000});
    await page.waitForTimeout(3000);

    // Dismiss cookie consent overlay (blocks download button click).
    await page.evaluate(() => {
        document.querySelector("#cookiescript_injected_wrapper")?.remove();
        // Download button has `pointer-events: none` by default (CSS anti-bot delay).
        // Adding 'turbo' class to body removes this restriction.
        document.body.classList.add("turbo");
    });

    // Check button exists + read isXapk + detect "with Uptodown app store" variant
    const btnAttrs = await page.evaluate(() => {
        const el = document.querySelector("#detail-download-button");
        if (!el) return null;
        // If button says "with Uptodown app store", it downloads the store app, not the target app.
        // The real app variant URL is the download page URL + "-x".
        const isStoreApp = /uptodown app store/i.test(el.textContent ?? "");
        return {
            onlyXapk: el.getAttribute("data-only-xapk") === "1",
            exists: true,
            isStoreApp
        };
    });
    if (!btnAttrs?.exists) return null;

    // If the download button serves the Uptodown store app, navigate to the real variant page.
    // Variant URL = download page URL + "-x" (e.g. /download/1197234650 → /download/1197234650-x)
    if (btnAttrs.isStoreApp) {
        const variantUrl = `${downloadPageUrl}-x`;
        consola.success(`Uptodown: main button is store app, navigating to variant: ${variantUrl}`);
        await page.goto(variantUrl, {waitUntil: "domcontentloaded", timeout: 60000});
        await page.waitForTimeout(3000);
        await page.evaluate(() => {
            document.querySelector("#cookiescript_injected_wrapper")?.remove();
            document.body.classList.add("turbo");
        });
    }

    // Inject hook to capture the `<a>` href that download.js creates on click.
    // Both direct path (he) and AJAX path (ke) end by creating `<a>` with
    // href = "https://dw.uptodown.com/dwn/..." and calling .click().
    await page.evaluate(() => {
        (window as any).__capturedDownloadUrl = null;
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function() {
            if (this.href && this.href.includes("dw.uptodown.com/dwn/")) {
                (window as any).__capturedDownloadUrl = this.href;
            }
            return origClick.call(this);
        };
    });

    consola.success(`Uptodown: clicking download button...`);
    try {
        await page.locator("#detail-download-button").click({force: true, timeout: 10000});
    } catch {
        // Navigation throws for download responses — expected
    }

    // Wait for the href to be captured (Turnstile + AJAX can take time)
    const deadline = Date.now() + 120000;
    let downloadUrl: string | null = null;
    while (Date.now() < deadline) {
        await page.waitForTimeout(2000);
        downloadUrl = await page.evaluate(() => (window as any).__capturedDownloadUrl);
        if (downloadUrl) break;
    }

    if (!downloadUrl) {
        throw new Error("Uptodown: download URL not captured (Turnstile may not have solved)");
    }

    consola.success(`Uptodown: captured download URL, triggering browser download...`);

    // Trigger browser saveAs via page.goto (same as apkmirror.ts).
    // Firefox downloads the file to downloadsPath when navigating to a download URL.
    const filesBefore = new Set(readdirSync(workDir));
    try {
        await page.goto(downloadUrl, {waitUntil: "commit", timeout: 60000});
    } catch {
        // Navigation throws for download responses — expected
    }

    // Wait for new file to appear and stop growing
    const dlDeadline = Date.now() + 120000;
    let downloadedFile: string | null = null;
    let lastSize = 0;
    let stableCount = 0;
    while (Date.now() < dlDeadline) {
        await page.waitForTimeout(2000);
        const filesAfter = readdirSync(workDir);
        const newFiles = filesAfter.filter((f) => !filesBefore.has(f));
        if (newFiles.length > 0) {
            const candidate = newFiles[0]!;
            const fullCandidate = join(workDir, candidate);
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
        throw new Error("Uptodown: download timed out or no file appeared");
    }

    const outPath = join(workDir, outName);
    ensureDir(dirname(outPath));
    renameSync(downloadedFile, outPath);

    return {path: outPath, isXapk: btnAttrs.onlyXapk};
}

/**
 * Download APK from Uptodown using Camoufox (bot-check bypass).
 */
export const downloadUptodown: (ctx: DownloadContext) => Promise<DownloadResult> =
    (ctx: DownloadContext): Promise<DownloadResult> => downloadLimit(async (): Promise<DownloadResult> => {
        const source = ctx.app.sources.find((s) => s.type === "uptodown");
        if (!source) throw new Error("uptodown: no uptodown source configured");

        const arch = ctx.app.arch ?? "all";
        const versionsUrl = `${source.url}/versions`;

        const browser: Browser = await Camoufox({
            headless: true,
            os: "windows",
            locale: "en-US",
            downloadsPath: ctx.workDir,
        });
        const page: Page = await browser.newPage();

        try {
            const versions = await scrapeUptodownVersions(page, versionsUrl);
            if (versions.length === 0) {
                throw new Error(`uptodown: no versions found for ${ctx.app.packageName}`);
            }

            // Filter out SECONDARY/beta versions unless included
            const filtered = ctx.app.includeBeta
                ? versions
                : versions.filter((v) => !/SECONDARY|beta|alpha/i.test(v.version));

            // Select target version
            let target: UptodownVersionEntry;
            if (ctx.targetVersion === "latest" || ctx.targetVersion === "auto") {
                target = filtered[0] ?? versions[0]!;
            } else {
                const found = filtered.find(
                    (v) => v.version === ctx.targetVersion.replace(/^v/, "")
                );
                if (!found) {
                    consola.warn(`uptodown: version ${ctx.targetVersion} not found, using ${filtered[0]!.version}`);
                }
                target = found ?? filtered[0]!;
            }

            consola.success(`Uptodown: selected version ${target.version} for ${ctx.app.packageName}`);

            const ext = target.isXapk ? ".xapk" : ".apk";
            const dlInfo = await downloadViaBrowser(
                page,
                target.downloadPageUrl,
                ctx.workDir,
                `${ctx.app.packageName}-${target.version}-${arch}${ext}`
            );
            if (!dlInfo) {
                throw new Error(
                    `uptodown: no matching APK found for ${ctx.app.packageName} ${target.version} (arch=${arch})`
                );
            }

            return {
                apkPath: dlInfo.path,
                version: target.version,
                isSplit: dlInfo.isXapk,
                ...(dlInfo.isXapk ? {splitPath: dlInfo.path} : {})
            };
        } finally {
            await browser.close();
        }
    });
