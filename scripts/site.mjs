#!/usr/bin/env node
/* global process, console */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

export function verifySite(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);
  const publicDir = path.join(root, "site", "public");
  const docsDir = path.join(root, "docs");
  const indexFile = path.join(docsDir, "README.md");
  const errors = [];

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
      const expPath = "/" + markdownPath(path.join("docs", target));
      expected.set(label, { path: expPath, desc });
    }

    const actual = new Map();
    const llmsRegex = /^-\s+\[([^\]]+)\]\(([^)]+)\):\s+(.+)$/gm;
    let llmsMatch;
    while ((llmsMatch = llmsRegex.exec(llmsContent)) !== null) {
      const label = llmsMatch[1].trim();
      const target = llmsMatch[2].trim();
      const desc = llmsMatch[3].trim();
      if (target.startsWith("/docs/")) {
        actual.set(label, { path: target, desc });
      }
    }

    if (expected.size !== 21) {
      errors.push(`Expected 21 pages in docs/README.md All pages, found ${expected.size}`);
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

  // 3. Verify all 21 Markdown exports exist and preserve prose and code blocks
  const docFiles = [];
  function scan(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "assets") scan(full);
      } else if (e.name.endsWith(".md") && e.name !== "README.md") {
        docFiles.push(full);
      }
    }
  }
  scan(docsDir);

  if (docFiles.length !== 21) {
    errors.push(`Expected 21 canonical docs files, found ${docFiles.length}`);
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
    if (content.startsWith("---\n")) {
      content = content.split("\n---\n")[1] || "";
    }
    const output = fs.readFileSync(exported, "utf8");

    if (withoutLinkUrls(content) !== withoutLinkUrls(output)) {
      errors.push(`Markdown export changed body or code blocks: ${relSource}`);
    }

    for (const link of proseLinks(output)) {
      const target = link.target;
      if (/^(?:https?:\/\/|mailto:|javascript:)/i.test(target)) {
        continue;
      }
      let [rawPath] = target.split("#");
      try { rawPath = decodeURIComponent(rawPath); } catch { /* ignore */ }
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
        errors.push(`${relExported}: missing markdown target ${target}`);
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
    for (const href of page.links) {
      if (/^(?:https?:\/\/|mailto:|javascript:)/i.test(href)) {
        continue;
      }

      let [rawPath, fragment] = href.split("#");
      try { rawPath = decodeURIComponent(rawPath); } catch { /* ignore */ }
      try { if (fragment) fragment = decodeURIComponent(fragment); } catch { /* ignore */ }

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
        errors.push(`${path.relative(publicDir, source)} -> ${href} (missing target: ${path.relative(publicDir, target)})`);
      } else if (fragment && target.endsWith(".html")) {
        const targetPage = htmlPages.get(target);
        if (!targetPage || !targetPage.ids.has(fragment)) {
          errors.push(`${path.relative(publicDir, source)} -> ${href} (missing anchor #${fragment})`);
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
  const baseURL = options.baseURL || "/";

  console.log(`Building Hugo site using ${hugoBin}...`);
  const buildArgs = [
    "--cleanDestinationDir",
    "--destination",
    destination,
    "--baseURL",
    baseURL
  ];

  const result = spawnSync(hugoBin, buildArgs, {
    cwd: siteDir,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`Hugo build exited with code ${result.status}`);
  }

  console.log("Verifying built site assets, markdown exports, and links...");
  const verifyResult = verifySite(root);
  if (!verifyResult.ok) {
    for (const err of verifyResult.errors) {
      console.error(err);
    }
    throw new Error(`Site verification failed with ${verifyResult.errors.length} error(s)`);
  }
  console.log(verifyResult.summary);

  return { ok: true };
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
  spawnSync(hugoBin, serveArgs, {
    cwd: siteDir,
    stdio: "inherit"
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] || "build";
  const repoRoot = process.cwd();

  try {
    if (action === "serve") {
      serveSite(repoRoot);
    } else {
      buildSite(repoRoot);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
