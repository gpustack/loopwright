#!/usr/bin/env node
/* global process, console */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL, URL } from "node:url";
import { checkDocs, proseLinks } from "./check-docs.mjs";

export function resolveHugo(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);

  if (process.env.HUGO_BIN && fs.existsSync(process.env.HUGO_BIN)) {
    return process.env.HUGO_BIN;
  }

  const localSbinHugo = path.join(root, ".sbin", "hugo");
  if (fs.existsSync(localSbinHugo)) {
    return localSbinHugo;
  }

  try {
    const whichResult = execSync("which hugo", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (whichResult && fs.existsSync(whichResult)) {
      return whichResult;
    }
  } catch {
    // ignore
  }

  return null;
}

function markdownPath(relPath) {
  const parsed = path.parse(relPath);
  if (parsed.base === "_index.md") {
    return path.join(parsed.dir, "index.md");
  }
  return path.join(parsed.dir, parsed.name, "index.md");
}

export function isSiteExcludedDoc(relFromDocs) {
  const normalized = relFromDocs.split(path.sep).join("/").replace(/^\.\//, "");
  return (
    normalized === "README.md" ||
    normalized === "development.md" ||
    normalized === "assets" ||
    normalized.startsWith("assets/") ||
    normalized === "contribute" ||
    normalized.startsWith("contribute/")
  );
}

function withoutLinkUrls(text) {
  const lines = [];
  let fence = "";
  let comment = false;
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      const m = marker[1];
      if (!fence) {
        fence = m;
      } else if (marker[0][0] === fence[0] && m.length >= fence.length) {
        fence = "";
      }
    } else if (!fence) {
      const stripped = line.trimStart();
      if (comment) {
        if (line.includes("-->")) {
          comment = false;
        }
      } else if (stripped.startsWith("<!--")) {
        if (!line.includes("-->")) {
          comment = true;
        }
      } else {
        const rewritten = line.replace(/!?\[([^\]\n]*)\]\(([^)\n]+)\)/g, (match, label) => `[${label}](URL)`);
        lines.push(rewritten);
        continue;
      }
    }
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function parseHtml(content) {
  const ids = new Set();
  const links = [];

  const idRegex = /\bid=["\x27]([^"\x27]+)["\x27]/gi;
  let match;
  while ((match = idRegex.exec(content)) !== null) {
    ids.add(match[1]);
  }

  const tagRegex = /<([a-zA-Z]+)\b([^>]*)>/gi;
  while ((match = tagRegex.exec(content)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrs = match[2];
    let attrMatch;
    if (tagName === "a" || tagName === "link") {
      if ((attrMatch = /\bhref=["\x27]([^"\x27]+)["\x27]/i.exec(attrs))) {
        links.push(attrMatch[1]);
      }
    } else if (tagName === "img" || tagName === "script") {
      if ((attrMatch = /\bsrc=["\x27]([^"\x27]+)["\x27]/i.exec(attrs))) {
        links.push(attrMatch[1]);
      }
    } else if (tagName === "form") {
      if ((attrMatch = /\baction=["\x27]([^"\x27]+)["\x27]/i.exec(attrs))) {
        links.push(attrMatch[1]);
      }
    }
  }

  return { ids, links };
}

export function verifySite(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const publicDir = path.resolve(options.publicDir || path.join(root, "site", "public"));
  const docsDir = path.join(root, "docs");
  const indexFile = path.join(docsDir, "README.md");
  const errors = [];

  const rawBaseUrl = String(options.baseURL || process.env.SITE_BASE_URL || "/").trim();
  let fullBaseUrl = "";
  let basePathname = "";
  if (/^https?:\/\//i.test(rawBaseUrl)) {
    fullBaseUrl = rawBaseUrl.replace(/\/+$/, "");
    try {
      basePathname = new URL(rawBaseUrl).pathname.replace(/\/+$/, "");
    } catch {
      basePathname = "";
    }
  } else if (rawBaseUrl.startsWith("/")) {
    basePathname = rawBaseUrl.replace(/\/+$/, "");
  }
  const baseOriginAndPath = { fullBaseUrl, basePathname };

  function stripBasePrefix(urlOrPath) {
    let rewritten = urlOrPath;
    if (baseOriginAndPath.fullBaseUrl && (rewritten === baseOriginAndPath.fullBaseUrl || rewritten.startsWith(`${baseOriginAndPath.fullBaseUrl}/`))) {
      const rest = rewritten.slice(baseOriginAndPath.fullBaseUrl.length).replace(/^\/+/, "");
      rewritten = `/${rest}`;
    }
    return rewritten;
  }

  function stripBasePathFromRawPath(rawPath) {
    if (!baseOriginAndPath.basePathname) {
      return rawPath;
    }
    if (rawPath === baseOriginAndPath.basePathname) {
      return "/";
    }
    if (rawPath.startsWith(`${baseOriginAndPath.basePathname}/`)) {
      return rawPath.slice(baseOriginAndPath.basePathname.length);
    }
    return rawPath;
  }

  if (!fs.existsSync(publicDir)) {
    return { ok: false, errors: [`Site public directory does not exist: ${publicDir}`] };
  }

  // 1. Verify llms.txt matches All pages
  const llmsFile = path.join(publicDir, "llms.txt");
  if (!fs.existsSync(llmsFile)) {
    errors.push("site: missing llms.txt");
  } else {
    const llmsContent = fs.readFileSync(llmsFile, "utf8");
    const indexContent = fs.readFileSync(indexFile, "utf8");
    const allPagesSection = indexContent.slice(indexContent.indexOf("## All pages\n") + "## All pages\n".length);

    const rowRegex = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+)\s*\|$/gm;
    const expected = new Map();
    let rowMatch;
    while ((rowMatch = rowRegex.exec(allPagesSection)) !== null) {
      const label = rowMatch[1].trim();
      const target = rowMatch[2].trim();
      const desc = rowMatch[3].trim();
      if (isSiteExcludedDoc(target)) {
        continue;
      }
      const expPath = "/" + markdownPath(path.join("docs", target));
      expected.set(label, { path: expPath, desc });
    }

    const actual = new Map();
    const llmsRegex = /^-\s+\[([^\]]+)\]\(([^)]+)\):\s+(.+)$/gm;
    let llmsMatch;
    while ((llmsMatch = llmsRegex.exec(llmsContent)) !== null) {
      const label = llmsMatch[1].trim();
      const rawTarget = llmsMatch[2].trim();
      const target = stripBasePathFromRawPath(stripBasePrefix(rawTarget));
      const desc = llmsMatch[3].trim();
      if (target.startsWith("/docs/")) {
        actual.set(label, { path: target, desc });
      }
    }

    if (expected.size !== 12) {
      errors.push(`Expected 12 published pages in docs/README.md All pages, found ${expected.size}`);
    }

    if (llmsContent.includes("/docs/development/")) {
      errors.push("llms.txt contains excluded path: /docs/development/");
    }
    if (llmsContent.includes("/docs/contribute/")) {
      errors.push("llms.txt contains excluded path: /docs/contribute/");
    }
    if (llmsContent.includes("/docs/adr/")) {
      errors.push("llms.txt contains excluded path: /docs/adr/");
    }

    for (const [label, exp] of expected.entries()) {
      const act = actual.get(label);
      if (!act) {
        errors.push(`llms.txt missing page: "${label}" (${exp.path})`);
      } else {
        if (act.path !== exp.path) {
          errors.push(`llms.txt path mismatch for "${label}": expected ${exp.path}, got ${act.path}`);
        }
        if (act.desc !== exp.desc) {
          errors.push(`llms.txt description mismatch for "${label}": expected "${exp.desc}", got "${act.desc}"`);
        }
      }
    }
  }

  // 2. Verify site-version.json and index.json
  const versionFile = path.join(publicDir, "site-version.json");
  if (!fs.existsSync(versionFile)) {
    errors.push("site: missing site-version.json");
  } else {
    try {
      const parsedVersion = JSON.parse(fs.readFileSync(versionFile, "utf8"));
      if (!parsedVersion.version || !parsedVersion.sourceRef) {
        errors.push("site-version.json missing required keys (version, sourceRef)");
      }
    } catch (e) {
      errors.push(`site-version.json invalid JSON: ${e.message}`);
    }
  }

  const indexJsonFile = path.join(publicDir, "index.json");
  if (!fs.existsSync(indexJsonFile)) {
    errors.push("site: missing index.json");
  } else {
    try {
      const parsedIndex = JSON.parse(fs.readFileSync(indexJsonFile, "utf8"));
      if (!Array.isArray(parsedIndex)) {
        errors.push("index.json is not an array");
      } else if (parsedIndex.length === 0) {
        errors.push("index.json contains zero pages");
      }
    } catch (e) {
      errors.push(`index.json invalid JSON: ${e.message}`);
    }
  }

  // 3. Verify all 12 Markdown exports exist and preserve prose and code blocks
  const docFiles = [];
  const excludedDocFiles = [];
  function scan(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const relFromDocs = path.relative(docsDir, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        scan(full);
      } else if (e.name.endsWith(".md")) {
        if (isSiteExcludedDoc(relFromDocs)) {
          if (relFromDocs !== "README.md") {
            excludedDocFiles.push(relFromDocs);
          }
        } else {
          docFiles.push(full);
        }
      }
    }
  }
  scan(docsDir);

  if (docFiles.length !== 12) {
    errors.push(`Expected 12 canonical docs files, found ${docFiles.length}`);
  }

  const excludedSiteTargets = [
    path.join(publicDir, "docs", "development"),
    path.join(publicDir, "docs", "contribute"),
    path.join(publicDir, "docs", "adr"),
    ...excludedDocFiles.flatMap(relFromDocs => {
      const slug = relFromDocs.replace(/\.md$/, "");
      return [
        path.join(publicDir, "docs", slug, "index.html"),
        path.join(publicDir, "docs", slug, "index.md")
      ];
    })
  ];
  for (const excludedPath of excludedSiteTargets) {
    if (fs.existsSync(excludedPath)) {
      errors.push(`Excluded contributor file exists in site/public: ${path.relative(publicDir, excludedPath)}`);
    }
  }

  for (const source of docFiles) {
    const relSource = path.relative(root, source);
    const relExported = markdownPath(relSource);
    const exported = path.join(publicDir, relExported);

    if (!fs.existsSync(exported)) {
      errors.push(`missing Markdown export: ${relExported}`);
      continue;
    }

    let content = fs.readFileSync(source, "utf8");
    content = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    const output = fs.readFileSync(exported, "utf8");

    if (withoutLinkUrls(content) !== withoutLinkUrls(output)) {
      errors.push(`Markdown export changed body or code blocks: ${relSource}`);
    }

    for (const link of proseLinks(output)) {
      const target = stripBasePrefix(link.target);
      if (/^(?:https?:\/\/|mailto:|javascript:)/i.test(target)) {
        continue;
      }
      let [rawPath] = target.split("#");
      try { rawPath = decodeURIComponent(rawPath); } catch { /* ignore */ }
      rawPath = stripBasePathFromRawPath(rawPath);
      let resolved;
      if (!rawPath) {
        resolved = exported;
      } else if (rawPath.startsWith("/")) {
        resolved = path.join(publicDir, rawPath.replace(/^\//, ""));
      } else {
        resolved = path.resolve(path.dirname(exported), rawPath);
      }
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        resolved = path.join(resolved, "index.md");
      }
      if (!resolved.startsWith(publicDir) || !fs.existsSync(resolved)) {
        errors.push(`${relExported}: missing markdown target ${link.target}`);
      }
    }
  }

  // 4. Verify all HTML files for internal links and anchors
  const htmlPages = new Map();
  function scanHtml(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanHtml(full);
      } else if (entry.name.endsWith(".html")) {
        htmlPages.set(full, parseHtml(fs.readFileSync(full, "utf8")));
      }
    }
  }
  scanHtml(publicDir);

  if (htmlPages.size === 0) {
    errors.push(`no HTML pages found under ${publicDir}`);
  }

  for (const [source, page] of htmlPages.entries()) {
    for (const rawHref of page.links) {
      const href = stripBasePrefix(rawHref);
      if (/^(?:https?:\/\/|mailto:|javascript:)/i.test(href)) {
        continue;
      }

      let [rawPath, fragment] = href.split("#");
      try { rawPath = decodeURIComponent(rawPath); } catch { /* ignore */ }
      try { if (fragment) fragment = decodeURIComponent(fragment); } catch { /* ignore */ }
      rawPath = stripBasePathFromRawPath(rawPath);

      let target;
      if (!rawPath) {
        target = source;
      } else if (rawPath.startsWith("/")) {
        target = path.join(publicDir, rawPath.replace(/^\//, ""));
      } else {
        target = path.resolve(path.dirname(source), rawPath);
      }

      if (rawPath && ((fs.existsSync(target) && fs.statSync(target).isDirectory()) || rawPath.endsWith("/"))) {
        target = path.join(target, "index.html");
      }

      if (!target.startsWith(publicDir) || !fs.existsSync(target)) {
        errors.push(`${path.relative(publicDir, source)} -> ${rawHref} (missing target: ${path.relative(publicDir, target)})`);
      } else if (fragment && target.endsWith(".html")) {
        const targetPage = htmlPages.get(target);
        if (!targetPage || !targetPage.ids.has(fragment)) {
          errors.push(`${path.relative(publicDir, source)} -> ${rawHref} (missing anchor #${fragment})`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: `Verified ${htmlPages.size} HTML pages and ${docFiles.length} Markdown exports; ${errors.length} broken link(s).`
  };
}

export function buildSite(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);

  console.log("Running docs lint check...");
  const docResult = checkDocs(root);
  if (!docResult.ok) {
    for (const err of docResult.errors) {
      console.error(err);
    }
    throw new Error(`docs check failed with ${docResult.errors.length} error(s)`);
  }
  console.log(docResult.summary);

  const hugoBin = resolveHugo(root);
  if (!hugoBin) {
    throw new Error("Hugo binary not found (checked HUGO_BIN, .sbin/hugo, PATH)");
  }

  const siteDir = path.join(root, "site");
  const destination = options.destination || path.join(siteDir, "public");
  const baseURL = options.baseURL || process.env.SITE_BASE_URL || "/";

  console.log(`Building Hugo site using ${hugoBin}...`);
  const buildArgs = [
    "--cleanDestinationDir",
    "--destination",
    destination,
    "--baseURL",
    baseURL
  ];

  const env = { ...process.env, ...(options.hugoEnv || {}) };
  const result = spawnSync(hugoBin, buildArgs, {
    cwd: siteDir,
    stdio: "inherit",
    env
  });

  if (result.status !== 0) {
    throw new Error(`Hugo build exited with code ${result.status}`);
  }

  console.log("Verifying built site assets, markdown exports, and links...");
  const verifyResult = verifySite(root, { baseURL, publicDir: destination });
  if (!verifyResult.ok) {
    for (const err of verifyResult.errors) {
      console.error(err);
    }
    throw new Error(`Site verification failed with ${verifyResult.errors.length} error(s)`);
  }
  console.log(verifyResult.summary);

  return { ok: true };
}

const MINOR_VERSION_DIR_RE = /^(\d+)\.(\d+)$/;

/**
 * Scan an existing gh-pages root directory and write gpustack/mike-compatible
 * versions.json, root redirect index.html, .nojekyll, and root llms.txt.
 */
export function syncGhPagesRoot(ghPagesDir) {
  const root = path.resolve(ghPagesDir);
  if (!fs.existsSync(root)) {
    throw new Error(`gh-pages directory does not exist: ${root}`);
  }

  const releaseDirs = [];
  let hasMain = false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === "main") {
      if (fs.existsSync(path.join(root, "main", "site-version.json"))) {
        hasMain = true;
      }
      continue;
    }
    const match = MINOR_VERSION_DIR_RE.exec(entry.name);
    if (!match) continue;
    if (!fs.existsSync(path.join(root, entry.name, "site-version.json"))) continue;
    releaseDirs.push({
      version: entry.name,
      major: Number(match[1]),
      minor: Number(match[2])
    });
  }

  releaseDirs.sort((a, b) => b.major - a.major || b.minor - a.minor);
  const latestRelease = releaseDirs[0]?.version ?? null;

  const versions = releaseDirs.map((item, index) => ({
    version: item.version,
    title: item.version,
    aliases: index === 0 ? ["latest"] : []
  }));

  if (hasMain) {
    versions.push({
      version: "main",
      title: "main",
      aliases: latestRelease === null ? ["latest"] : []
    });
  }

  fs.writeFileSync(path.join(root, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(root, ".nojekyll"), "", "utf8");

  const redirectTarget = latestRelease !== null || hasMain ? "latest/" : "./";
  const redirectHtml = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <title>Redirecting</title>",
    "  <noscript>",
    `    <meta http-equiv="refresh" content="1; url=${redirectTarget}" />`,
    "  </noscript>",
    "  <script>",
    "    window.location.replace(",
    `      ${JSON.stringify(redirectTarget)} + window.location.search + window.location.hash`,
    "    );",
    "  </script>",
    "</head>",
    "<body>",
    `  Redirecting to <a href="${redirectTarget}">${redirectTarget}</a>...`,
    "</body>",
    "</html>",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(root, "index.html"), redirectHtml, "utf8");

  const latestLlms = path.join(root, "latest", "llms.txt");
  const fallbackLlms = latestRelease ? path.join(root, latestRelease, "llms.txt") : path.join(root, "main", "llms.txt");
  const sourceLlms = fs.existsSync(latestLlms) ? latestLlms : fallbackLlms;
  if (fs.existsSync(sourceLlms)) {
    fs.copyFileSync(sourceLlms, path.join(root, "llms.txt"));
  }

  return { versions, latestVersion: latestRelease ?? (hasMain ? "main" : null) };
}

export function serveSite(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);
  const hugoBin = resolveHugo(root);
  if (!hugoBin) {
    throw new Error("Hugo binary not found (checked HUGO_BIN, .sbin/hugo, PATH)");
  }

  const siteDir = path.join(root, "site");
  console.log(`Starting Hugo development server using ${hugoBin}...`);
  const serveArgs = ["server", "--renderToMemory", "--disableFastRender"];
  const env = {
    ...process.env,
    HUGO_PARAMS_SITEROOT: process.env.HUGO_PARAMS_SITEROOT || "/",
    HUGO_PARAMS_VERSION: process.env.HUGO_PARAMS_VERSION || "main",
    HUGO_PARAMS_RELEASEKIND: process.env.HUGO_PARAMS_RELEASEKIND || "development"
  };
  spawnSync(hugoBin, serveArgs, {
    cwd: siteDir,
    stdio: "inherit",
    env
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] || "build";
  const repoRoot = process.cwd();

  try {
    if (action === "serve") {
      serveSite(repoRoot);
    } else if (action === "sync-gh-pages") {
      const targetDir = process.argv[3];
      if (!targetDir) {
        throw new Error("usage: node scripts/site.mjs sync-gh-pages <gh-pages-dir>");
      }
      const synced = syncGhPagesRoot(targetDir);
      console.log(`Synced gh-pages root (${synced.versions.length} version(s), latest: ${synced.latestVersion ?? "none"}).`);
    } else {
      buildSite(repoRoot);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
