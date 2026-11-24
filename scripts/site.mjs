#!/usr/bin/env node
/* global process, console */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { checkDocs, PUBLIC_SITE_DOC_REL_PATHS, REPO_ONLY_DOC_REL_PATHS, slugify } from "./check-docs.mjs";

const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSiteHugoParams(rootDir) {
  const params = {
    repoSlug: "gpustack/loopwright",
    repoNavLabel: "Repository navigation",
    repoNavDescription: "Module relationships, design records, code entry points and applicable skills for contributors."
  };
  const hugoConfigPath = path.join(rootDir, "site", "hugo.toml");
  if (!fs.existsSync(hugoConfigPath)) {
    return params;
  }
  const text = fs.readFileSync(hugoConfigPath, "utf8");
  for (const key of Object.keys(params)) {
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
    if (match?.[1]) {
      params[key] = match[1];
    }
  }
  return params;
}

function repoBlobBaseForRoot(rootDir) {
  return `https://github.com/${readSiteHugoParams(rootDir).repoSlug}/blob`;
}

export const DEFAULT_DOCS_PREFIX = "../docs";
export const DEFAULT_SOURCE_REF = "main";
export const DEFAULT_REPO_BLOB_BASE = repoBlobBaseForRoot(MODULE_REPO_ROOT);
const FENCE_OPEN_LINE_RE = /^((?: {0,3}> ?)*) {0,3}(`{3,}|~{3,})([^\r\n]*?)(\r?\n|$)/;
const REF_DEF_START_RE = /^(?: {0,3}> ?)* {0,3}\[/;
const LIST_ITEM_RE = /^(?: {0,3}> ?)* {0,3}(?:[-*+]|\d+[.)])[ \t]/;
const FOOTNOTE_DEF_RE = /^(?: {0,3}> ?)* {0,3}\[\^[^\]]+\]:/;
const ATX_HEADING_RE = /^(?: {0,3}> ?)* {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/;
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const LLMS_BULLET_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\):\s+(.+)$/;
const LINE_ANCHOR_RE = /^L\d+(?:-L?\d+)?$/;

function isModernHugoBinary(binPath) {
  try {
    const res = spawnSync(binPath, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = /v(\d+)\.(\d+)/.exec(res.stdout || "");
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 0 || minor >= 153;
  } catch {
    return false;
  }
}

export function resolveHugo(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);

  if (process.env.HUGO_BIN && fs.existsSync(process.env.HUGO_BIN)) {
    return process.env.HUGO_BIN;
  }

  const candidates = [];
  const localSbinHugo = path.join(root, ".sbin", "hugo");
  if (fs.existsSync(localSbinHugo)) {
    candidates.push(localSbinHugo);
  }

  try {
    const whichResult = execSync("which hugo", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (whichResult && fs.existsSync(whichResult) && !candidates.includes(whichResult)) {
      candidates.push(whichResult);
    }
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    if (isModernHugoBinary(candidate)) {
      return candidate;
    }
  }

  if (candidates.length > 0) {
    throw new Error(`Hugo >= 0.153 is required; outdated binary detected: ${candidates[0]}`);
  }

  return null;
}

function markdownPath(relPath) {
  const normalized = relPath.split(path.sep).join("/");
  const parsed = path.posix.parse(normalized);
  if (parsed.base === "_index.md" || parsed.base === "index.md") {
    return path.posix.join(parsed.dir, "index.md");
  }
  return path.posix.join(parsed.dir, parsed.name, "index.md");
}

function htmlPath(relPath) {
  const normalized = relPath.split(path.sep).join("/");
  const parsed = path.posix.parse(normalized);
  if (parsed.base === "_index.md" || parsed.base === "index.md") {
    return path.posix.join(parsed.dir, "index.html");
  }
  return path.posix.join(parsed.dir, parsed.name, "index.html");
}

export function isSiteExcludedDoc(relFromDocs) {
  const normalized = relFromDocs.split(path.sep).join("/").replace(/^\.\//, "");
  return (
    normalized === "README.md" ||
    normalized === "development.md" ||
    normalized === "assets" ||
    normalized.startsWith("assets/") ||
    normalized === "references" ||
    normalized.startsWith("references/") ||
    normalized === "contribute" ||
    normalized.startsWith("contribute/")
  );
}

function isExcludedSiteRelPath(relPath) {
  const clean = path.posix
    .normalize("/" + String(relPath).replace(/^\/+/, ""))
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!clean || clean === ".") {
    return false;
  }
  return (
    clean === "development" ||
    clean === "development.md" ||
    clean.startsWith("development/") ||
    clean === "contribute" ||
    clean.startsWith("contribute/") ||
    clean === "references" ||
    clean.startsWith("references/") ||
    clean === "docs/development" ||
    clean === "docs/development.md" ||
    clean.startsWith("docs/development/") ||
    clean === "docs/contribute" ||
    clean.startsWith("docs/contribute/") ||
    clean === "docs/adr" ||
    clean.startsWith("docs/adr/") ||
    clean === "docs/references" ||
    clean.startsWith("docs/references/")
  );
}

function isSubpathOrEqual(parentDir, candidatePath) {
  const rel = path.relative(parentDir, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function validateNonEmpty(value, label, { stripSlash = false } = {}) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const cleaned = stripSlash ? value.replace(/\/+$/, "") : value;
  if (!cleaned) {
    throw new Error(`${label} must not be empty`);
  }
  return cleaned;
}

function splitSuffix(dest) {
  for (let i = 0; i < dest.length; i++) {
    const ch = dest[i];
    if (ch === "?" || ch === "#") {
      return [dest.slice(0, i), dest.slice(i)];
    }
  }
  return [dest, ""];
}

function hasExternalSchemeOrAuthority(dest) {
  return dest.startsWith("//") || URI_SCHEME_RE.test(dest);
}

export function rewriteReferenceDestination(
  dest,
  {
    docsPrefix = DEFAULT_DOCS_PREFIX,
    repoBlobBase = DEFAULT_REPO_BLOB_BASE,
    sourceRef = DEFAULT_SOURCE_REF
  } = {}
) {
  const prefix = validateNonEmpty(docsPrefix, "docsPrefix", { stripSlash: true });
  const blobBase = validateNonEmpty(repoBlobBase, "repoBlobBase", { stripSlash: true });
  const ref = validateNonEmpty(sourceRef, "sourceRef");

  if (!dest) {
    return dest;
  }
  if (hasExternalSchemeOrAuthority(dest)) {
    return dest;
  }

  const [pathPart, suffix] = splitSuffix(dest);
  if (!pathPart || pathPart.startsWith("/")) {
    return dest;
  }

  let norm = path.posix.normalize(path.posix.join("docs/references", pathPart));
  if (norm !== "." && norm.endsWith("/")) {
    norm = norm.replace(/\/+$/, "");
  }
  if (norm === ".." || norm.startsWith("../")) {
    throw new Error(`link escapes repository root: ${dest}`);
  }
  if (norm === ".") {
    return `${blobBase}/${ref}${suffix}`;
  }

  const effectiveNorm = norm.startsWith("docs/docs/") ? `docs/${norm.slice("docs/docs/".length)}` : norm;

  if (effectiveNorm === "docs/references") {
    return `.${suffix}`;
  }
  if (effectiveNorm.startsWith("docs/references/")) {
    return `${effectiveNorm.slice("docs/references/".length)}${suffix}`;
  }
  if (effectiveNorm.startsWith("docs/assets/")) {
    return `${prefix}/assets/${effectiveNorm.slice("docs/assets/".length)}${suffix}`;
  }
  if (
    effectiveNorm === "docs/README.md" ||
    effectiveNorm === "docs/development.md" ||
    effectiveNorm === "docs/contribute" ||
    effectiveNorm.startsWith("docs/contribute/")
  ) {
    return `${blobBase}/${ref}/${effectiveNorm}${suffix}`;
  }
  if (effectiveNorm.startsWith("docs/")) {
    if (effectiveNorm === "docs/_index.md" || effectiveNorm === "docs/index.md") {
      return `${prefix}/index.md${suffix}`;
    }
    if (effectiveNorm.endsWith("/_index.md")) {
      const relDir = effectiveNorm.slice("docs/".length, -"/_index.md".length);
      return `${prefix}/${relDir}/index.md${suffix}`;
    }
    if (effectiveNorm.endsWith("/index.md")) {
      const relDir = effectiveNorm.slice("docs/".length, -"/index.md".length);
      return `${prefix}/${relDir}/index.md${suffix}`;
    }
    if (effectiveNorm.endsWith(".md")) {
      const relNoExt = effectiveNorm.slice("docs/".length, -".md".length);
      return `${prefix}/${relNoExt}/index.md${suffix}`;
    }
    return `${blobBase}/${ref}/${effectiveNorm}${suffix}`;
  }

  return `${blobBase}/${ref}/${norm}${suffix}`;
}

export function rebaseReferenceDestination(
  dest,
  {
    fromPrefix = DEFAULT_DOCS_PREFIX,
    toPrefix
  } = {}
) {
  const srcPrefix = validateNonEmpty(fromPrefix, "fromPrefix", { stripSlash: true });
  const dstPrefix = validateNonEmpty(toPrefix, "toPrefix", { stripSlash: true });

  if (!dest || hasExternalSchemeOrAuthority(dest)) {
    return dest;
  }

  const [pathPart, suffix] = splitSuffix(dest);
  if (pathPart === srcPrefix) {
    return `${dstPrefix}${suffix}`;
  }
  if (pathPart.startsWith(`${srcPrefix}/`)) {
    return `${dstPrefix}${pathPart.slice(srcPrefix.length)}${suffix}`;
  }
  return dest;
}

function startsBlankLine(text, newlinePos) {
  let p = newlinePos + 1;
  const n = text.length;
  while (p < n && (text[p] === " " || text[p] === "\t")) {
    p += 1;
  }
  if (p < n && text[p] === "\r") {
    p += 1;
  }
  return p < n && text[p] === "\n";
}

function scanCodeSpan(text, start) {
  const n = text.length;
  let p = start;
  while (p < n && text[p] === "`") {
    p += 1;
  }
  const tickLen = p - start;
  while (p < n) {
    const ch = text[p];
    if (ch === "\n" && startsBlankLine(text, p)) {
      return null;
    }
    if (ch === "`") {
      const runStart = p;
      while (p < n && text[p] === "`") {
        p += 1;
      }
      if (p - runStart === tickLen) {
        return p;
      }
      continue;
    }
    p += 1;
  }
  return null;
}

function skipWsNoBlank(text, pos) {
  const n = text.length;
  let p = pos;
  while (p < n && (text[p] === " " || text[p] === "\t" || text[p] === "\r" || text[p] === "\n")) {
    if (text[p] === "\n" && startsBlankLine(text, p)) {
      return null;
    }
    p += 1;
  }
  return p;
}

function scanTitle(text, pos) {
  const n = text.length;
  if (pos >= n) {
    return null;
  }
  const opener = text[pos];
  let closer;
  if (opener === "\"") {
    closer = "\"";
  } else if (opener === "'") {
    closer = "'";
  } else if (opener === "(") {
    closer = ")";
  } else {
    return null;
  }

  let p = pos + 1;
  while (p < n) {
    const ch = text[p];
    if (ch === "\\" && p + 1 < n) {
      p += 2;
      continue;
    }
    if (ch === "\n" && startsBlankLine(text, p)) {
      return null;
    }
    if (opener === "(" && ch === "(") {
      return null;
    }
    if (ch === closer) {
      return p + 1;
    }
    p += 1;
  }
  return null;
}

function scanDestination(text, pos) {
  const n = text.length;
  if (pos >= n) {
    return null;
  }

  if (text[pos] === "<") {
    let p = pos + 1;
    while (p < n) {
      const ch = text[p];
      if (ch === "\\" && p + 1 < n) {
        p += 2;
        continue;
      }
      if (ch === "\n" || ch === "\r" || ch === "<") {
        return null;
      }
      if (ch === ">") {
        return [text.slice(pos + 1, p), p + 1, true];
      }
      p += 1;
    }
    return null;
  }

  let p = pos;
  let parenDepth = 0;
  while (p < n) {
    const ch = text[p];
    if (ch === "\\" && p + 1 < n) {
      p += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch.charCodeAt(0) < 32) {
      break;
    }
    if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      if (parenDepth === 0) {
        break;
      }
      parenDepth -= 1;
    }
    p += 1;
  }

  if (parenDepth !== 0 || p === pos) {
    return null;
  }
  return [text.slice(pos, p), p, false];
}

function consumeFencedBlock(text, start) {
  const slice = text.slice(start);
  const match = FENCE_OPEN_LINE_RE.exec(slice);
  if (!match) {
    return null;
  }
  const prefix = match[1];
  const marker = match[2];
  const info = match[3];
  const fenceChar = marker[0];
  const fenceLen = marker.length;
  if (fenceChar === "`" && info.includes("`")) {
    return null;
  }

  const bqDepth = (prefix.match(/>/g) || []).length;
  const escapedChar = fenceChar === "`" ? "`" : "~";
  const closeRe = new RegExp(`^ {0,3}${escapedChar}{${fenceLen},}[ \\t]*(?:\\r?\\n|$)`);
  const bqRe = bqDepth > 0 ? new RegExp(`^(?: {0,3}> ?){${bqDepth}}`) : null;

  const n = text.length;
  let pos = start + match[0].length;
  while (pos < n) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? n : nl + 1;
    const line = text.slice(pos, lineEnd);
    let rest = line;
    if (bqRe !== null) {
      const bqMatch = bqRe.exec(line);
      if (!bqMatch) {
        return pos;
      }
      rest = line.slice(bqMatch[0].length);
    }
    pos = lineEnd;
    if (closeRe.test(rest)) {
      return pos;
    }
  }
  return n;
}

function consumeIndentedCodeBlock(text, start) {
  const n = text.length;
  if (start >= n || !(text.startsWith("    ", start) || text[start] === "\t")) {
    return null;
  }
  let pos = start;
  let lastCodeEnd = start;
  while (pos < n) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? n : nl + 1;
    const line = text.slice(pos, lineEnd);
    if (line.startsWith("    ") || line.startsWith("\t")) {
      lastCodeEnd = lineEnd;
      pos = lineEnd;
      continue;
    }
    if (line.trim() === "") {
      pos = lineEnd;
      continue;
    }
    break;
  }
  return lastCodeEnd;
}

function tryRewriteRefDef(text, start, transform) {
  const slice = text.slice(start);
  const match = REF_DEF_START_RE.exec(slice);
  if (!match) {
    return null;
  }

  const n = text.length;
  let p = start + match[0].length;
  if (p < n && text[p] === "^") {
    return null;
  }

  let hasNonWs = false;
  while (p < n) {
    const ch = text[p];
    if (ch === "\\" && p + 1 < n) {
      hasNonWs = true;
      p += 2;
      continue;
    }
    if (ch === "\n" && startsBlankLine(text, p)) {
      return null;
    }
    if (ch === "[") {
      return null;
    }
    if (ch === "]") {
      break;
    }
    if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
      hasNonWs = true;
    }
    p += 1;
  }

  if (!hasNonWs || p + 1 >= n || text[p] !== "]" || text[p + 1] !== ":") {
    return null;
  }

  p += 2;
  while (p < n && (text[p] === " " || text[p] === "\t")) {
    p += 1;
  }
  if (p < n && (text[p] === "\r" || text[p] === "\n")) {
    p += text[p] === "\r" && p + 1 < n && text[p + 1] === "\n" ? 2 : 1;
    while (p < n && (text[p] === " " || text[p] === "\t")) {
      p += 1;
    }
  }

  const destStart = p;
  const scanned = scanDestination(text, destStart);
  if (!scanned) {
    return null;
  }
  const [dest, destEnd, isAngled] = scanned;

  let q = destEnd;
  while (q < n && (text[q] === " " || text[q] === "\t")) {
    q += 1;
  }
  let end;
  if (q === n || text[q] === "\r" || text[q] === "\n") {
    if (q < n) {
      q += text[q] === "\r" && q + 1 < n && text[q + 1] === "\n" ? 2 : 1;
    }
    end = q;
  } else if (q > destEnd && (text[q] === "\"" || text[q] === "'" || text[q] === "(")) {
    const titleEnd = scanTitle(text, q);
    if (titleEnd === null) {
      return null;
    }
    let r = titleEnd;
    while (r < n && (text[r] === " " || text[r] === "\t")) {
      r += 1;
    }
    if (r < n && text[r] !== "\r" && text[r] !== "\n") {
      return null;
    }
    if (r < n) {
      r += text[r] === "\r" && r + 1 < n && text[r + 1] === "\n" ? 2 : 1;
    }
    end = r;
  } else {
    return null;
  }

  const newDest = transform(dest);
  const formatted = isAngled ? `<${newDest}>` : newDest;
  const rebuilt = text.slice(start, destStart) + formatted + text.slice(destEnd, end);
  return [rebuilt, end];
}

function tryRewriteInlineLink(text, start, transform) {
  const n = text.length;
  let p = start + 1;
  let depth = 1;
  let closeBracket = -1;

  while (p < n) {
    const ch = text[p];
    if (ch === "\\" && p + 1 < n) {
      p += 2;
      continue;
    }
    if (text.startsWith("<!--", p)) {
      const endComment = text.indexOf("-->", p + 4);
      if (endComment === -1) {
        return null;
      }
      p = endComment + 3;
      continue;
    }
    if (ch === "`") {
      const endCode = scanCodeSpan(text, p);
      if (endCode !== null) {
        p = endCode;
        continue;
      }
      while (p < n && text[p] === "`") {
        p += 1;
      }
      continue;
    }
    if (ch === "\n" && startsBlankLine(text, p)) {
      return null;
    }
    if (ch === "[") {
      depth += 1;
      p += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        closeBracket = p;
        break;
      }
      p += 1;
      continue;
    }
    p += 1;
  }

  if (closeBracket === -1 || closeBracket + 1 >= n || text[closeBracket + 1] !== "(") {
    return null;
  }

  const destStart = skipWsNoBlank(text, closeBracket + 2);
  if (destStart === null) {
    return null;
  }

  if (destStart < n && text[destStart] === ")") {
    const inner = rewriteMarkdownText(text.slice(start + 1, closeBracket), transform, { blockLevel: false });
    return [`[${inner}](${text.slice(closeBracket + 2, destStart + 1)}`, destStart + 1];
  }

  const scanned = scanDestination(text, destStart);
  if (!scanned) {
    return null;
  }
  const [dest, destEnd, isAngled] = scanned;

  const afterWs = skipWsNoBlank(text, destEnd);
  if (afterWs === null) {
    return null;
  }

  let q = afterWs;
  if (q < n && q > destEnd && (text[q] === "\"" || text[q] === "'" || text[q] === "(")) {
    const titleEnd = scanTitle(text, q);
    if (titleEnd === null) {
      return null;
    }
    const afterTitle = skipWsNoBlank(text, titleEnd);
    if (afterTitle === null) {
      return null;
    }
    q = afterTitle;
  }

  if (q >= n || text[q] !== ")") {
    return null;
  }

  const inner = rewriteMarkdownText(text.slice(start + 1, closeBracket), transform, { blockLevel: false });
  const newDest = transform(dest);
  const formatted = isAngled ? `<${newDest}>` : newDest;
  const rebuilt = `[${inner}](${text.slice(closeBracket + 2, destStart)}${formatted}${text.slice(destEnd, q + 1)}`;
  return [rebuilt, q + 1];
}

function rewriteMarkdownText(text, transform, { blockLevel }) {
  const out = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    if (blockLevel && (i === 0 || text[i - 1] === "\n")) {
      const fenceEnd = consumeFencedBlock(text, i);
      if (fenceEnd !== null) {
        out.push(text.slice(i, fenceEnd));
        i = fenceEnd;
        continue;
      }

      const refResult = tryRewriteRefDef(text, i, transform);
      if (refResult !== null) {
        const [rebuilt, refEnd] = refResult;
        out.push(rebuilt);
        i = refEnd;
        continue;
      }
    }

    if (text.startsWith("<!--", i)) {
      const endComment = text.indexOf("-->", i + 4);
      if (endComment === -1) {
        out.push(text.slice(i));
        break;
      }
      out.push(text.slice(i, endComment + 3));
      i = endComment + 3;
      continue;
    }

    const ch = text[i];
    if (ch === "\\" && i + 1 < n) {
      out.push(text.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (ch === "`") {
      const codeEnd = scanCodeSpan(text, i);
      if (codeEnd !== null) {
        out.push(text.slice(i, codeEnd));
        i = codeEnd;
        continue;
      }
      const runStart = i;
      while (i < n && text[i] === "`") {
        i += 1;
      }
      out.push(text.slice(runStart, i));
      continue;
    }

    if (ch === "[") {
      const linkResult = tryRewriteInlineLink(text, i, transform);
      if (linkResult !== null) {
        const [rebuilt, linkEnd] = linkResult;
        out.push(rebuilt);
        i = linkEnd;
        continue;
      }
    }

    out.push(ch);
    i += 1;
  }

  return out.join("");
}

function rewriteMarkdownOutsideExemptBlocks(text, transform) {
  const pieces = [];
  const n = text.length;
  let pos = 0;
  let chunkStart = 0;
  let prevBlank = true;
  let container = "";

  while (pos < n) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? n : nl + 1;
    const line = text.slice(pos, lineEnd);

    if (line.trim() === "") {
      prevBlank = true;
      pos = lineEnd;
      continue;
    }

    const fenceEnd = consumeFencedBlock(text, pos);
    if (fenceEnd !== null) {
      prevBlank = false;
      pos = fenceEnd;
      continue;
    }

    const isIndented = line.startsWith("    ") || line.startsWith("\t");
    if (prevBlank && !container && isIndented) {
      const indentEnd = consumeIndentedCodeBlock(text, pos);
      if (indentEnd !== null) {
        if (pos > chunkStart) {
          pieces.push([true, text.slice(chunkStart, pos)]);
        }
        pieces.push([false, text.slice(pos, indentEnd)]);
        chunkStart = indentEnd;
        pos = indentEnd;
        prevBlank = false;
        continue;
      }
    }

    if (LIST_ITEM_RE.test(line)) {
      container = "list";
    } else if (FOOTNOTE_DEF_RE.test(line)) {
      container = "footnote";
    } else if (!isIndented) {
      container = "";
    }
    prevBlank = false;
    pos = lineEnd;
  }

  if (chunkStart < n) {
    pieces.push([true, text.slice(chunkStart, n)]);
  }

  return pieces
    .map(([shouldRewrite, chunk]) =>
      shouldRewrite ? rewriteMarkdownText(chunk, transform, { blockLevel: true }) : chunk
    )
    .join("");
}

export function rewriteReferenceMarkdown(
  content,
  {
    docsPrefix = DEFAULT_DOCS_PREFIX,
    repoBlobBase = DEFAULT_REPO_BLOB_BASE,
    sourceRef = DEFAULT_SOURCE_REF
  } = {}
) {
  validateNonEmpty(docsPrefix, "docsPrefix", { stripSlash: true });
  validateNonEmpty(repoBlobBase, "repoBlobBase", { stripSlash: true });
  validateNonEmpty(sourceRef, "sourceRef");
  return rewriteMarkdownOutsideExemptBlocks(content, dest =>
    rewriteReferenceDestination(dest, { docsPrefix, repoBlobBase, sourceRef })
  );
}

export function rebaseReferenceMarkdown(
  content,
  {
    fromPrefix = DEFAULT_DOCS_PREFIX,
    toPrefix
  } = {}
) {
  validateNonEmpty(fromPrefix, "fromPrefix", { stripSlash: true });
  validateNonEmpty(toPrefix, "toPrefix", { stripSlash: true });
  return rewriteMarkdownOutsideExemptBlocks(content, dest =>
    rebaseReferenceDestination(dest, { fromPrefix, toPrefix })
  );
}

export function rewriteReferenceDocLinks(text, docsPrefix = DEFAULT_DOCS_PREFIX, options = {}) {
  return rewriteReferenceMarkdown(text, { ...options, docsPrefix });
}

export function stageReferenceDocs({
  rootDir = process.cwd(),
  docsDir,
  sourceDir,
  stagingDir,
  docsPrefix = DEFAULT_DOCS_PREFIX,
  repoBlobBase,
  sourceRef = DEFAULT_SOURCE_REF,
  rebaseFrom = null
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedRepoBlobBase = repoBlobBase ?? repoBlobBaseForRoot(resolvedRoot);
  const resolvedDocsDir = path.resolve(docsDir ?? path.join(resolvedRoot, "docs"));
  const resolvedSiteDir = path.join(resolvedRoot, "site");
  let resolvedSourceDir = sourceDir ? path.resolve(sourceDir) : null;
  if (!resolvedSourceDir) {
    const defaultRefs = path.join(resolvedDocsDir, "references");
    if (!fs.existsSync(defaultRefs) && path.basename(resolvedDocsDir) === "references") {
      resolvedSourceDir = resolvedDocsDir;
    } else {
      resolvedSourceDir = defaultRefs;
    }
  }
  const resolvedStagingDir = path.resolve(stagingDir ?? path.join(resolvedSiteDir, "resources", "references"));

  if (!fs.existsSync(resolvedSourceDir) || !fs.statSync(resolvedSourceDir).isDirectory()) {
    throw new Error(`reference source directory does not exist: ${resolvedSourceDir}`);
  }
  if (
    resolvedSourceDir === resolvedStagingDir ||
    isSubpathOrEqual(resolvedSourceDir, resolvedStagingDir) ||
    isSubpathOrEqual(resolvedStagingDir, resolvedSourceDir)
  ) {
    throw new Error("reference source and staging directories must not overlap");
  }
  if (
    isSubpathOrEqual(resolvedStagingDir, resolvedRoot) ||
    isSubpathOrEqual(resolvedStagingDir, resolvedDocsDir) ||
    isSubpathOrEqual(resolvedStagingDir, resolvedSiteDir)
  ) {
    throw new Error(`staging directory must not contain the repository, docs, or site root: ${resolvedStagingDir}`);
  }
  if (fs.existsSync(resolvedStagingDir) && !fs.statSync(resolvedStagingDir).isDirectory()) {
    throw new Error(`staging path is not a directory: ${resolvedStagingDir}`);
  }

  if (rebaseFrom !== null && rebaseFrom !== undefined) {
    validateNonEmpty(rebaseFrom, "rebaseFrom", { stripSlash: true });
    validateNonEmpty(docsPrefix, "docsPrefix", { stripSlash: true });
  } else {
    validateNonEmpty(docsPrefix, "docsPrefix", { stripSlash: true });
    validateNonEmpty(resolvedRepoBlobBase, "repoBlobBase", { stripSlash: true });
    validateNonEmpty(sourceRef, "sourceRef");
  }

  const entries = fs
    .readdirSync(resolvedSourceDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const staged = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      throw new Error(`docs/references must be flat; found nested subdirectory: ${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`docs/references must not contain symlinks: ${entry.name}`);
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const raw = fs.readFileSync(path.join(resolvedSourceDir, entry.name), "utf8");
    const rewritten =
      rebaseFrom !== null && rebaseFrom !== undefined
        ? rebaseReferenceMarkdown(raw, { fromPrefix: rebaseFrom, toPrefix: docsPrefix })
        : rewriteReferenceMarkdown(raw, { docsPrefix, repoBlobBase: resolvedRepoBlobBase, sourceRef });
    staged.push([entry.name, rewritten]);
  }

  fs.mkdirSync(resolvedStagingDir, { recursive: true });
  const expectedNames = new Set(staged.map(([name]) => name));
  for (const existing of fs.readdirSync(resolvedStagingDir, { withFileTypes: true })) {
    const existingPath = path.join(resolvedStagingDir, existing.name);
    if (existing.isDirectory() || existing.isSymbolicLink() || !expectedNames.has(existing.name)) {
      fs.rmSync(existingPath, { recursive: true, force: true });
    }
  }

  for (const [name, payload] of staged) {
    fs.writeFileSync(path.join(resolvedStagingDir, name), payload, "utf8");
  }

  return staged.map(([name]) => name);
}

function stripFrontmatter(text) {
  if (text.startsWith("---\n")) {
    const match = text.match(/^---\n[\s\S]*?\n---\n/);
    if (match) {
      return text.slice(match[0].length);
    }
  }
  return text;
}

function walkMarkdownLinks(text) {
  const links = [];
  const normalized = rewriteMarkdownOutsideExemptBlocks(stripFrontmatter(text), dest => {
    if (dest) {
      links.push({ target: dest });
      return "URL";
    }
    return dest;
  });
  return { normalized: normalized.trim(), links };
}

export function withoutLinkUrls(text) {
  return walkMarkdownLinks(text).normalized;
}

function extractMarkdownLinks(text) {
  return walkMarkdownLinks(text).links;
}

function stripInlineHtmlComments(line) {
  const out = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < n) {
      out.push(line.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (ch === "`") {
      const codeEnd = scanCodeSpan(line, i);
      if (codeEnd !== null) {
        out.push(line.slice(i, codeEnd));
        i = codeEnd;
        continue;
      }
    }
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      if (end === -1) {
        break;
      }
      i = end + 3;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function stripHeadingLinks(headingText) {
  function dropLinks(s) {
    const out = [];
    const n = s.length;
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === "\\" && i + 1 < n) {
        out.push(s.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (ch === "`") {
        const codeEnd = scanCodeSpan(s, i);
        if (codeEnd !== null) {
          out.push(s.slice(i, codeEnd));
          i = codeEnd;
          continue;
        }
      }
      if (ch === "!" && i + 1 < n && s[i + 1] === "[") {
        const res = tryRewriteInlineLink(s, i + 1, d => d);
        if (res !== null) {
          const [rebuilt, end] = res;
          const closeB = rebuilt.lastIndexOf("](");
          out.push(dropLinks(rebuilt.slice(1, closeB)));
          i = end;
          continue;
        }
      }
      if (ch === "[") {
        const res = tryRewriteInlineLink(s, i, d => d);
        if (res !== null) {
          const [rebuilt, end] = res;
          const closeB = rebuilt.lastIndexOf("](");
          out.push(dropLinks(rebuilt.slice(1, closeB)));
          i = end;
          continue;
        }
      }
      out.push(ch);
      i += 1;
    }
    return out.join("");
  }
  return dropLinks(headingText);
}

export function extractMarkdownAnchors(content) {
  const body = stripFrontmatter(content);
  const used = new Set();
  const n = body.length;
  let i = 0;
  let prevBlank = true;
  let container = "";

  while (i < n) {
    const nl = body.indexOf("\n", i);
    const lineEnd = nl === -1 ? n : nl + 1;
    const line = body.slice(i, lineEnd);

    if (line.trim() === "") {
      i = lineEnd;
      prevBlank = true;
      continue;
    }

    const fenceEnd = consumeFencedBlock(body, i);
    if (fenceEnd !== null) {
      i = fenceEnd;
      prevBlank = false;
      continue;
    }

    const isIndented = line.startsWith("    ") || line.startsWith("\t");
    if (prevBlank && !container && isIndented) {
      const indentEnd = consumeIndentedCodeBlock(body, i);
      if (indentEnd !== null) {
        i = indentEnd;
        prevBlank = false;
        continue;
      }
    }

    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith("<!--")) {
      const commentStartOffset = line.indexOf("<!--");
      const endComment = body.indexOf("-->", i + commentStartOffset + 4);
      if (endComment === -1) {
        break;
      }
      const nextNl = body.indexOf("\n", endComment + 3);
      i = nextNl === -1 ? n : nextNl + 1;
      prevBlank = false;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      container = "list";
    } else if (FOOTNOTE_DEF_RE.test(line)) {
      container = "footnote";
    } else if (!isIndented) {
      container = "";
    }
    prevBlank = false;

    const uncommented = stripInlineHtmlComments(line.replace(/\r?\n$/, ""));
    const headingMatch = ATX_HEADING_RE.exec(uncommented);
    if (headingMatch) {
      const cleaned = stripHeadingLinks(headingMatch[2])
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(\*\*|__|\*)/g, "");
      const baseSlug = slugify(cleaned);
      if (baseSlug) {
        let candidate = baseSlug;
        let suffix = 1;
        while (used.has(candidate)) {
          candidate = `${baseSlug}-${suffix}`;
          suffix += 1;
        }
        used.add(candidate);
      }
    }

    const idRegex = /\bid=["\x27]([^"\x27]+)["\x27]/gi;
    let idMatch;
    while ((idMatch = idRegex.exec(uncommented)) !== null) {
      used.add(idMatch[1]);
    }

    i = lineEnd;
  }

  return used;
}

function readH1(filePath) {
  const body = stripFrontmatter(fs.readFileSync(filePath, "utf8"));
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim();
    }
  }
  return "";
}

function parseReadmeZoneRows(indexContent, heading, errors) {
  const normalized = indexContent.replace(/\r\n/g, "\n");
  const headingPrefix = `## ${heading}\n`;
  let section;
  if (normalized.startsWith(headingPrefix)) {
    section = normalized.slice(headingPrefix.length).split("\n## ")[0];
  } else {
    const marker = `\n${headingPrefix}`;
    const idx = normalized.indexOf(marker);
    if (idx === -1) {
      errors.push(`docs/README.md: missing "## ${heading}" section`);
      return [];
    }
    section = normalized.slice(idx + marker.length).split("\n## ")[0];
  }

  const rows = [];
  const rowRegex = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|$/gm;
  let match;
  while ((match = rowRegex.exec(section)) !== null) {
    rows.push({
      label: match[1].trim(),
      target: match[2].trim(),
      desc: match[3].trim()
    });
  }
  return rows;
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

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

export function verifySite(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const publicDir = path.resolve(options.publicDir || path.join(root, "site", "public"));
  const docsDir = path.resolve(options.docsDir || path.join(root, "docs"));
  const indexFile = path.join(docsDir, "README.md");
  const hugoParams = readSiteHugoParams(root);
  const repoBlobBase = validateNonEmpty(options.repoBlobBase || repoBlobBaseForRoot(root), "repoBlobBase", { stripSlash: true });
  const errors = [];

  const rawBaseUrl = String(options.baseURL || process.env.SITE_BASE_URL || "/").trim();
  let baseOrigin = "";
  let basePathname = "";
  if (/^https?:\/\//i.test(rawBaseUrl)) {
    try {
      const parsedBase = new URL(rawBaseUrl);
      baseOrigin = parsedBase.origin;
      basePathname = parsedBase.pathname.replace(/\/+$/, "");
    } catch {
      baseOrigin = rawBaseUrl.replace(/\/+$/, "");
      basePathname = "";
    }
  } else {
    const withSlash = rawBaseUrl.startsWith("/") ? rawBaseUrl : `/${rawBaseUrl}`;
    basePathname = withSlash.replace(/\/+$/, "");
  }
  const sitePathPrefix = `${basePathname}/`;
  const expectedPublicUrlPrefix = `${baseOrigin}${sitePathPrefix}`;

  function stripBasePrefix(urlOrPath) {
    if (!baseOrigin) {
      return urlOrPath;
    }
    if (/^https?:\/\//i.test(urlOrPath)) {
      try {
        const parsed = new URL(urlOrPath);
        if (parsed.origin === baseOrigin) {
          return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        }
      } catch {
        // ignore
      }
    }
    return urlOrPath;
  }

  function stripBasePathFromRawPath(rawPath) {
    if (!basePathname) {
      return rawPath;
    }
    if (rawPath === basePathname) {
      return "/";
    }
    if (rawPath.startsWith(`${basePathname}/`)) {
      return rawPath.slice(basePathname.length);
    }
    return rawPath;
  }

  function extractSiteRelativePath(rawUrl) {
    let candidate = rawUrl.trim();
    if (/^https?:\/\//i.test(candidate)) {
      try {
        const parsed = new URL(candidate);
        if (baseOrigin && parsed.origin !== baseOrigin) {
          return { rel: null, reason: `foreign origin against base URL ${rawBaseUrl}` };
        }
        candidate = parsed.pathname;
      } catch {
        return { rel: null, reason: `invalid URL ${rawUrl}` };
      }
    } else {
      [candidate] = splitSuffix(candidate);
    }
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // ignore
    }
    if (!candidate.startsWith(sitePathPrefix)) {
      return { rel: null, reason: `outside site base URL ${rawBaseUrl}` };
    }
    return { rel: candidate.slice(sitePathPrefix.length), reason: null };
  }

  if (!fs.existsSync(publicDir)) {
    return { ok: false, errors: [`Site public directory does not exist: ${publicDir}`] };
  }

  // 1. Verify site-version.json and resolve sourceRef
  let effectiveSourceRef = options.sourceRef || process.env.HUGO_PARAMS_SOURCEREF || DEFAULT_SOURCE_REF;
  const versionFile = path.join(publicDir, "site-version.json");
  if (!fs.existsSync(versionFile)) {
    errors.push("site: missing site-version.json");
  } else {
    try {
      const parsedVersion = JSON.parse(fs.readFileSync(versionFile, "utf8"));
      if (!parsedVersion.version || !parsedVersion.sourceRef) {
        errors.push("site-version.json missing required keys (version, sourceRef)");
      } else if (!options.sourceRef) {
        effectiveSourceRef = parsedVersion.sourceRef;
      }
    } catch (e) {
      errors.push(`site-version.json invalid JSON: ${e.message}`);
    }
  }

  // 2. Scan docs/ filesystem across all three zones
  const docFiles = [];
  const excludedDocFiles = [];
  const contributeDocRelPaths = [];
  function scanDocs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relFromDocs = path.relative(docsDir, full).split(path.sep).join("/");
      if (relFromDocs === "references" || relFromDocs.startsWith("references/")) {
        continue;
      }
      if (entry.isDirectory()) {
        scanDocs(full);
      } else if (entry.name.endsWith(".md")) {
        if (isSiteExcludedDoc(relFromDocs)) {
          if (relFromDocs !== "README.md") {
            excludedDocFiles.push(relFromDocs);
            if (relFromDocs === "development.md" || relFromDocs.startsWith("contribute/")) {
              contributeDocRelPaths.push(relFromDocs);
            }
          }
        } else {
          docFiles.push(full);
        }
      }
    }
  }
  scanDocs(docsDir);
  docFiles.sort();
  contributeDocRelPaths.sort();

  const refSrcDir = path.join(docsDir, "references");
  const srcRefNames = [];
  if (!fs.existsSync(refSrcDir) || !fs.statSync(refSrcDir).isDirectory()) {
    errors.push("docs/references directory does not exist");
  } else {
    for (const entry of fs.readdirSync(refSrcDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.isDirectory()) {
        errors.push(`docs/references/${entry.name}: nested subdirectory forbidden under flat docs/references/`);
        continue;
      }
      if (entry.isSymbolicLink()) {
        errors.push(`docs/references/${entry.name}: symlink forbidden under docs/references/`);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        srcRefNames.push(entry.name);
        excludedDocFiles.push(`references/${entry.name}`);
      }
    }
  }

  const isCanonicalRepo = root === MODULE_REPO_ROOT && options.strictRepoCounts !== false;
  if (isCanonicalRepo) {
    if (docFiles.length !== PUBLIC_SITE_DOC_REL_PATHS.size) {
      errors.push(`Expected ${PUBLIC_SITE_DOC_REL_PATHS.size} canonical public docs files, found ${docFiles.length}`);
    }
    if (contributeDocRelPaths.length !== REPO_ONLY_DOC_REL_PATHS.size) {
      errors.push(`Expected ${REPO_ONLY_DOC_REL_PATHS.size} contributor docs files, found ${contributeDocRelPaths.length}`);
    }
  }

  // 3. Parse docs/README.md three-zone tables and verify llms.txt
  let allPagesRows = [];
  let referenceRows = [];
  let contributeRows = [];
  if (!fs.existsSync(indexFile)) {
    errors.push("docs/README.md does not exist");
  } else {
    const indexContent = fs.readFileSync(indexFile, "utf8");
    allPagesRows = parseReadmeZoneRows(indexContent, "All pages", errors);
    referenceRows = parseReadmeZoneRows(indexContent, "Reference", errors);
    contributeRows = parseReadmeZoneRows(indexContent, "Contribute", errors);
  }

  if (isCanonicalRepo && allPagesRows.length !== PUBLIC_SITE_DOC_REL_PATHS.size) {
    errors.push(`Expected ${PUBLIC_SITE_DOC_REL_PATHS.size} published pages in docs/README.md All pages, found ${allPagesRows.length}`);
  }
  if (isCanonicalRepo && contributeRows.length !== REPO_ONLY_DOC_REL_PATHS.size) {
    errors.push(`Expected ${REPO_ONLY_DOC_REL_PATHS.size} contributor pages in docs/README.md Contribute, found ${contributeRows.length}`);
  }

  const expectedPublicMap = new Map();
  const indexedPublicTargets = new Set();
  for (const row of allPagesRows) {
    if (isSiteExcludedDoc(row.target)) {
      errors.push(`docs/README.md All pages must not contain excluded doc: ${row.target}`);
      continue;
    }
    if (indexedPublicTargets.has(row.target)) {
      errors.push(`docs/README.md All pages duplicate entry: ${row.target}`);
    }
    indexedPublicTargets.add(row.target);
    const srcFile = path.join(docsDir, row.target);
    if (!fs.existsSync(srcFile)) {
      errors.push(`docs/README.md All pages missing source file: docs/${row.target}`);
    } else {
      const h1 = readH1(srcFile);
      if (h1 && h1 !== row.label) {
        errors.push(`docs/README.md All pages label "${row.label}" != H1 "${h1}" for ${row.target}`);
      }
    }
    const expUrl = `${expectedPublicUrlPrefix}${markdownPath(path.posix.join("docs", row.target))}`;
    expectedPublicMap.set(expUrl, { label: row.label, url: expUrl, desc: row.desc });
  }

  for (const docFull of docFiles) {
    const relFromDocs = path.relative(docsDir, docFull).split(path.sep).join("/");
    if (!indexedPublicTargets.has(relFromDocs)) {
      errors.push(`docs/${relFromDocs}: missing from docs/README.md All pages table`);
    }
  }

  const expectedRefMap = new Map();
  const indexedRefNames = new Set();
  for (const row of referenceRows) {
    if (path.posix.dirname(row.target) !== "references" || !row.target.endsWith(".md")) {
      errors.push(`docs/README.md Reference entry must be flat references/*.md: ${row.target}`);
      continue;
    }
    const refName = path.posix.basename(row.target);
    if (indexedRefNames.has(refName)) {
      errors.push(`docs/README.md Reference duplicate entry: ${row.target}`);
    }
    indexedRefNames.add(refName);
    const srcFile = path.join(refSrcDir, refName);
    if (!fs.existsSync(srcFile)) {
      errors.push(`docs/README.md Reference indexed source file missing: docs/${row.target}`);
    } else {
      const h1 = readH1(srcFile);
      if (h1 && h1 !== row.label) {
        errors.push(`docs/README.md Reference label "${row.label}" != H1 "${h1}" for ${row.target}`);
      }
    }
    const expUrl = `${expectedPublicUrlPrefix}references/${refName}`;
    expectedRefMap.set(expUrl, { label: row.label, url: expUrl, desc: row.desc });
  }

  for (const refName of srcRefNames) {
    if (!indexedRefNames.has(refName)) {
      errors.push(`docs/references/${refName}: missing from docs/README.md Reference table`);
    }
  }

  const expectedOptionalMap = new Map();
  const repoNavUrl = `${repoBlobBase}/${effectiveSourceRef}/docs/README.md`;
  expectedOptionalMap.set(repoNavUrl, {
    label: hugoParams.repoNavLabel,
    url: repoNavUrl,
    desc: hugoParams.repoNavDescription
  });

  const indexedContributeTargets = new Set();
  for (const row of contributeRows) {
    if ((row.target !== "development.md" && !row.target.startsWith("contribute/")) || !row.target.endsWith(".md")) {
      errors.push(`docs/README.md Contribute entry must be development.md or contribute/**/*.md: ${row.target}`);
      continue;
    }
    if (indexedContributeTargets.has(row.target)) {
      errors.push(`docs/README.md Contribute duplicate entry: ${row.target}`);
    }
    indexedContributeTargets.add(row.target);
    const srcFile = path.join(docsDir, row.target);
    if (!fs.existsSync(srcFile)) {
      errors.push(`docs/README.md Contribute indexed source file missing: docs/${row.target}`);
    } else {
      const h1 = readH1(srcFile);
      if (h1 && h1 !== row.label) {
        errors.push(`docs/README.md Contribute label "${row.label}" != H1 "${h1}" for ${row.target}`);
      }
    }
    const expUrl = `${repoBlobBase}/${effectiveSourceRef}/docs/${row.target}`;
    expectedOptionalMap.set(expUrl, { label: row.label, url: expUrl, desc: row.desc });
  }

  for (const contribRel of contributeDocRelPaths) {
    if (!indexedContributeTargets.has(contribRel)) {
      errors.push(`docs/${contribRel}: missing from docs/README.md Contribute table`);
    }
  }

  const llmsFile = path.join(publicDir, "llms.txt");
  if (!fs.existsSync(llmsFile)) {
    errors.push("site: missing llms.txt");
  } else {
    const llmsContent = fs.readFileSync(llmsFile, "utf8");
    const repoBlobUrlPrefix = `${repoBlobBase}/`;

    let currentSection = "";
    const seenUrls = new Set();
    const actualPublicMap = new Map();
    const actualRefMap = new Map();
    const actualOptionalMap = new Map();

    const llmsLines = llmsContent.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < llmsLines.length; i++) {
      const line = llmsLines[i];
      if (line.startsWith("## ")) {
        currentSection = line.slice(3).trim();
        continue;
      }
      if (!line.startsWith("- ")) {
        continue;
      }
      const match = LLMS_BULLET_RE.exec(line);
      if (!match) {
        errors.push(`llms.txt:${i + 1}: malformed bullet: ${line}`);
        continue;
      }
      const label = match[1].trim();
      const url = match[2].trim();
      const desc = match[3].trim();
      if (!url.startsWith(repoBlobUrlPrefix)) {
        for (const forbidden of ["/docs/development", "/docs/contribute/", "/docs/adr/", "/docs/references/"]) {
          if (url.includes(forbidden)) {
            errors.push(`llms.txt:${i + 1}: contains excluded site path ${forbidden}: ${url}`);
          }
        }
      }
      if (seenUrls.has(url)) {
        errors.push(`llms.txt:${i + 1}: duplicate URL: ${url}`);
      }
      seenUrls.add(url);

      if (!currentSection) {
        errors.push(`llms.txt:${i + 1}: bullet outside ## section: ${url}`);
      } else if (currentSection === "Reference") {
        actualRefMap.set(url, { label, url, desc });
      } else if (currentSection === "Optional") {
        actualOptionalMap.set(url, { label, url, desc });
      } else {
        actualPublicMap.set(url, { label, url, desc });
      }
    }

    function compareLlmsZone(zoneLabel, expectedMap, actualMap) {
      for (const [expUrl, exp] of expectedMap.entries()) {
        const act = actualMap.get(expUrl);
        if (!act) {
          errors.push(`llms.txt ${zoneLabel} missing "${exp.label}" (${expUrl})`);
        } else {
          if (act.label !== exp.label) {
            errors.push(`llms.txt ${zoneLabel} label mismatch for ${expUrl}: expected "${exp.label}", got "${act.label}"`);
          }
          if (act.desc !== exp.desc) {
            errors.push(`llms.txt ${zoneLabel} description mismatch for "${exp.label}": expected "${exp.desc}", got "${act.desc}"`);
          }
        }
      }
      for (const [actUrl, act] of actualMap.entries()) {
        if (!expectedMap.has(actUrl)) {
          errors.push(`llms.txt ${zoneLabel} unexpected entry "${act.label}" (${actUrl})`);
        }
      }
    }

    compareLlmsZone("Public", expectedPublicMap, actualPublicMap);
    compareLlmsZone("Reference", expectedRefMap, actualRefMap);
    compareLlmsZone("Optional", expectedOptionalMap, actualOptionalMap);
  }

  // 4. Audit index.json and sitemap.xml for leaked excluded zones
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
      } else {
        const seenIndexUrls = new Set();
        for (const entry of parsedIndex) {
          const rawUrl = String(entry?.url ?? "");
          if (seenIndexUrls.has(rawUrl)) {
            errors.push(`index.json: duplicate search entry URL ${rawUrl}`);
          }
          seenIndexUrls.add(rawUrl);
          const { rel, reason } = extractSiteRelativePath(rawUrl);
          if (rel === null) {
            errors.push(`index.json: entry ${reason}: ${rawUrl}`);
          } else if (isExcludedSiteRelPath(rel)) {
            errors.push(`index.json: leaked excluded documentation zone entry ${rawUrl}`);
          }
        }
      }
    } catch (e) {
      errors.push(`index.json invalid JSON: ${e.message}`);
    }
  }

  const sitemapFile = path.join(publicDir, "sitemap.xml");
  if (!fs.existsSync(sitemapFile)) {
    errors.push("site: missing sitemap.xml");
  } else {
    const sitemapXml = fs.readFileSync(sitemapFile, "utf8");
    const locMatches = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gi)];
    if (locMatches.length === 0) {
      errors.push("sitemap.xml contains zero <loc> entries");
    }
    for (const locMatch of locMatches) {
      const loc = decodeXmlEntities(locMatch[1].trim());
      const { rel, reason } = extractSiteRelativePath(loc);
      if (rel === null) {
        errors.push(`sitemap.xml: loc ${reason}: ${loc}`);
      } else if (isExcludedSiteRelPath(rel)) {
        errors.push(`sitemap.xml: leaked excluded documentation zone URL ${loc}`);
      }
    }
  }

  // 5. Verify excluded files never exist under site/public/docs/
  const excludedSiteTargets = [
    path.join(publicDir, "docs", "development"),
    path.join(publicDir, "docs", "contribute"),
    path.join(publicDir, "docs", "adr"),
    path.join(publicDir, "docs", "references"),
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
      errors.push(`Excluded file exists in site/public: ${path.relative(publicDir, excludedPath)}`);
    }
  }

  // 6. Scan HTML files early so Markdown/HTML cross-checks can resolve HTML ids too
  const htmlPages = new Map();
  function scanHtml(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanHtml(full);
      } else if (entry.name.endsWith(".html")) {
        const relHtml = path.relative(publicDir, full).split(path.sep).join("/");
        if (isExcludedSiteRelPath(relHtml)) {
          errors.push(`Excluded HTML output in site/public: ${relHtml}`);
        }
        htmlPages.set(full, parseHtml(fs.readFileSync(full, "utf8")));
      }
    }
  }
  scanHtml(publicDir);

  if (htmlPages.size === 0) {
    errors.push(`no HTML pages found under ${publicDir}`);
  }

  // 7. Helper to validate links & #anchor fragments in exported public and reference .md files
  const markdownAnchorCache = new Map();
  function getAnchorsForMarkdownFile(mdFilePath) {
    const resolved = path.resolve(mdFilePath);
    if (!markdownAnchorCache.has(resolved)) {
      markdownAnchorCache.set(resolved, extractMarkdownAnchors(fs.readFileSync(resolved, "utf8")));
    }
    return markdownAnchorCache.get(resolved);
  }

  const repoBlobPrefix = `${repoBlobBase}/`;
  function validateExportedMarkdownLinks(exportedFilePath, content, { forbidExcludedSiteZones }) {
    const relExported = path.relative(publicDir, exportedFilePath).split(path.sep).join("/");
    for (const link of extractMarkdownLinks(content)) {
      const rawTarget = link.target;

      if (rawTarget.startsWith(repoBlobPrefix)) {
        const rest = rawTarget.slice(repoBlobPrefix.length);
        const [pathPart, suffix] = splitSuffix(rest);
        const slashIdx = pathPart.indexOf("/");
        const refInUrl = slashIdx === -1 ? pathPart : pathPart.slice(0, slashIdx);
        let repoRel = slashIdx === -1 ? "" : pathPart.slice(slashIdx + 1);
        try {
          repoRel = decodeURIComponent(repoRel);
        } catch {
          // ignore
        }
        if (refInUrl !== effectiveSourceRef) {
          errors.push(`${relExported}: GitHub link ref "${refInUrl}" differs from site sourceRef "${effectiveSourceRef}": ${rawTarget}`);
          continue;
        }
        if (forbidExcludedSiteZones && /^docs\/(?:references|contribute|adr|development(?:\.md)?)(?:\/|$)/.test(repoRel)) {
          errors.push(`${relExported}: public page links to excluded documentation zone on GitHub: ${rawTarget}`);
          continue;
        }
        const repoTarget = repoRel ? path.resolve(root, repoRel) : root;
        if (!isSubpathOrEqual(root, repoTarget) || !fs.existsSync(repoTarget)) {
          errors.push(`${relExported}: missing repository target ${rawTarget}`);
          continue;
        }
        if (suffix.startsWith("#")) {
          let fragment = suffix.slice(1);
          try {
            fragment = decodeURIComponent(fragment);
          } catch {
            // ignore
          }
          if (
            fragment &&
            !LINE_ANCHOR_RE.test(fragment) &&
            fs.statSync(repoTarget).isFile() &&
            repoTarget.endsWith(".md") &&
            !getAnchorsForMarkdownFile(repoTarget).has(fragment)
          ) {
            errors.push(`${relExported}: missing markdown anchor #${fragment} in ${rawTarget}`);
          }
        }
        continue;
      }

      const target = stripBasePrefix(rawTarget);
      if (/^(?:https?:\/\/|\/\/|mailto:|javascript:)/i.test(target) || URI_SCHEME_RE.test(target)) {
        continue;
      }

      const hashIdx = target.indexOf("#");
      const rawBeforeHash = hashIdx === -1 ? target : target.slice(0, hashIdx);
      let fragment = hashIdx === -1 ? "" : target.slice(hashIdx + 1);
      let [rawPath] = rawBeforeHash.split("?");
      try {
        rawPath = decodeURIComponent(rawPath);
      } catch {
        // ignore
      }
      try {
        if (fragment) fragment = decodeURIComponent(fragment);
      } catch {
        // ignore
      }

      if (rawPath.startsWith("/") && basePathname && rawPath !== basePathname && !rawPath.startsWith(`${basePathname}/`)) {
        errors.push(`${relExported}: target outside site base URL ${rawTarget}`);
        continue;
      }
      rawPath = stripBasePathFromRawPath(rawPath);

      let resolved;
      if (!rawPath) {
        resolved = exportedFilePath;
      } else if (rawPath.startsWith("/")) {
        resolved = path.join(publicDir, rawPath.replace(/^\/+/, ""));
      } else {
        resolved = path.resolve(path.dirname(exportedFilePath), rawPath);
      }
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        resolved = path.join(resolved, "index.md");
      }

      if (!isSubpathOrEqual(publicDir, resolved) || !fs.existsSync(resolved)) {
        errors.push(`${relExported}: missing markdown target ${rawTarget}`);
        continue;
      }

      if (forbidExcludedSiteZones) {
        const relResolved = path.relative(publicDir, resolved).split(path.sep).join("/");
        if (isExcludedSiteRelPath(relResolved)) {
          errors.push(`${relExported}: public page links to excluded documentation zone: ${rawTarget}`);
          continue;
        }
      }

      if (fragment) {
        if (resolved.endsWith(".md") && fs.statSync(resolved).isFile()) {
          if (!getAnchorsForMarkdownFile(resolved).has(fragment)) {
            errors.push(`${relExported}: missing markdown anchor #${fragment} in ${rawTarget}`);
          }
        } else if (resolved.endsWith(".html") && htmlPages.has(resolved)) {
          if (!htmlPages.get(resolved).ids.has(fragment)) {
            errors.push(`${relExported}: missing HTML anchor #${fragment} in ${rawTarget}`);
          }
        }
      }
    }
  }

  // 8. Verify all public Markdown & HTML exports exist, preserve body/code, and have valid links/anchors
  for (const source of docFiles) {
    const relFromDocs = path.relative(docsDir, source).split(path.sep).join("/");
    const relDoc = path.posix.join("docs", relFromDocs);
    const relExported = markdownPath(relDoc);
    const relHtmlExported = htmlPath(relDoc);
    const exported = path.join(publicDir, relExported);
    const exportedHtml = path.join(publicDir, relHtmlExported);

    if (!fs.existsSync(exportedHtml)) {
      errors.push(`missing HTML export: ${relHtmlExported}`);
    }
    if (!fs.existsSync(exported)) {
      errors.push(`missing Markdown export: ${relExported}`);
      continue;
    }

    const content = stripFrontmatter(fs.readFileSync(source, "utf8"));
    const output = fs.readFileSync(exported, "utf8");

    if (withoutLinkUrls(content) !== withoutLinkUrls(output)) {
      errors.push(`Markdown export changed body or code blocks: ${relDoc}`);
    }

    validateExportedMarkdownLinks(exported, output, { forbidExcludedSiteZones: true });
  }

  // Also check wrapper Markdown exports under site/content/docs/ (e.g. docs/index.md) for valid links/anchors
  const docsIndexMd = path.join(publicDir, "docs", "index.md");
  if (fs.existsSync(docsIndexMd)) {
    validateExportedMarkdownLinks(docsIndexMd, fs.readFileSync(docsIndexMd, "utf8"), { forbidExcludedSiteZones: true });
  }

  // 9. Dynamically verify ALL flat docs/references/*.md files in site/public/references/
  const refPubDir = path.join(publicDir, "references");
  if (srcRefNames.length > 0) {
    if (!fs.existsSync(refPubDir) || !fs.statSync(refPubDir).isDirectory()) {
      errors.push("site: missing static references/ directory");
    } else {
      const expectedRefSet = new Set(srcRefNames);
      for (const pubEntry of fs.readdirSync(refPubDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (pubEntry.isDirectory()) {
          errors.push(`references/${pubEntry.name}: subdirectory forbidden in published references/`);
        } else if (!pubEntry.name.endsWith(".md") || !expectedRefSet.has(pubEntry.name)) {
          errors.push(`references/${pubEntry.name}: unexpected or stale file in published references/`);
        }
      }

      for (const refName of srcRefNames) {
        const srcFile = path.join(refSrcDir, refName);
        const pubFile = path.join(refPubDir, refName);
        if (!fs.existsSync(pubFile)) {
          errors.push(`site: missing references/${refName}`);
          continue;
        }
        const srcContent = fs.readFileSync(srcFile, "utf8");
        const pubContent = fs.readFileSync(pubFile, "utf8");
        const expectedRewritten = rewriteReferenceMarkdown(srcContent, {
          docsPrefix: DEFAULT_DOCS_PREFIX,
          repoBlobBase,
          sourceRef: effectiveSourceRef
        });
        if (withoutLinkUrls(srcContent) !== withoutLinkUrls(pubContent)) {
          errors.push(`site: references/${refName} changed body or code blocks`);
        } else if (pubContent !== expectedRewritten) {
          errors.push(`site: references/${refName} differs byte-for-byte from rewriteReferenceMarkdown() output`);
        }
        validateExportedMarkdownLinks(pubFile, pubContent, { forbidExcludedSiteZones: false });
      }
    }
  }

  // 10. Verify all HTML files for internal links, anchors, and docs/ zone isolation
  const docsPublicDir = path.join(publicDir, "docs");
  for (const [source, page] of htmlPages.entries()) {
    const isDocsHtml = isSubpathOrEqual(docsPublicDir, source);
    for (const rawHref of page.links) {
      const href = stripBasePrefix(rawHref);
      if (/^(?:https?:\/\/|\/\/|mailto:|javascript:)/i.test(href) || URI_SCHEME_RE.test(href)) {
        continue;
      }

      const hashIdx = href.indexOf("#");
      const beforeHash = hashIdx === -1 ? href : href.slice(0, hashIdx);
      let fragment = hashIdx === -1 ? "" : href.slice(hashIdx + 1);
      let [rawPath] = beforeHash.split("?");
      try {
        rawPath = decodeURIComponent(rawPath);
      } catch {
        // ignore
      }
      try {
        if (fragment) fragment = decodeURIComponent(fragment);
      } catch {
        // ignore
      }

      if (rawPath.startsWith("/") && basePathname && rawPath !== basePathname && !rawPath.startsWith(`${basePathname}/`)) {
        errors.push(`${path.relative(publicDir, source)} -> ${rawHref} (outside site base URL)`);
        continue;
      }
      rawPath = stripBasePathFromRawPath(rawPath);

      let target;
      if (!rawPath) {
        target = source;
      } else if (rawPath.startsWith("/")) {
        target = path.join(publicDir, rawPath.replace(/^\/+/, ""));
      } else {
        target = path.resolve(path.dirname(source), rawPath);
      }

      if (isDocsHtml && isSubpathOrEqual(publicDir, target)) {
        const relTarget = path.relative(publicDir, target).split(path.sep).join("/");
        if (isExcludedSiteRelPath(relTarget)) {
          errors.push(`${path.relative(publicDir, source)} -> ${rawHref} (links to excluded documentation zone)`);
          continue;
        }
      }

      if (rawPath && ((fs.existsSync(target) && fs.statSync(target).isDirectory()) || rawPath.endsWith("/"))) {
        target = path.join(target, "index.html");
      }

      if (!isSubpathOrEqual(publicDir, target) || !fs.existsSync(target)) {
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
    summary: `Verified ${htmlPages.size} HTML pages and ${docFiles.length} Markdown exports; ${errors.length} broken link(s) (${srcRefNames.length} reference file(s)).`
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
  const env = { ...process.env, ...(options.hugoEnv || {}) };
  const sourceRef = options.sourceRef || env.HUGO_PARAMS_SOURCEREF || DEFAULT_SOURCE_REF;
  const repoBlobBase = options.repoBlobBase || repoBlobBaseForRoot(root);

  stageReferenceDocs({
    rootDir: root,
    docsDir: path.join(root, "docs"),
    stagingDir: path.join(siteDir, "resources", "references"),
    docsPrefix: DEFAULT_DOCS_PREFIX,
    repoBlobBase,
    sourceRef
  });

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
    stdio: "inherit",
    env
  });

  if (result.status !== 0) {
    throw new Error(`Hugo build exited with code ${result.status}`);
  }

  console.log("Verifying built site assets, markdown exports, and links...");
  const verifyResult = verifySite(root, { baseURL, publicDir: destination, sourceRef, repoBlobBase });
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
 * versions.json, root redirect index.html, .nojekyll, root llms.txt, and
 * fresh-mirrored root references/*.md.
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
  const fallbackVersionDir = latestRelease ?? (hasMain ? "main" : null);
  const fallbackLlms = fallbackVersionDir ? path.join(root, fallbackVersionDir, "llms.txt") : null;
  const sourceLlms = fs.existsSync(latestLlms)
    ? latestLlms
    : (fallbackLlms && fs.existsSync(fallbackLlms) ? fallbackLlms : null);
  if (sourceLlms) {
    fs.copyFileSync(sourceLlms, path.join(root, "llms.txt"));
  }

  const latestRefsDir = path.join(root, "latest", "references");
  const fallbackRefsDir = fallbackVersionDir ? path.join(root, fallbackVersionDir, "references") : null;
  const hasLatestRefs = fs.existsSync(latestRefsDir) && fs.statSync(latestRefsDir).isDirectory();
  const sourceRefsDir = hasLatestRefs
    ? latestRefsDir
    : (fallbackRefsDir && fs.existsSync(fallbackRefsDir) && fs.statSync(fallbackRefsDir).isDirectory()
        ? fallbackRefsDir
        : null);

  const rootRefsDir = path.join(root, "references");
  if (sourceRefsDir) {
    const targetPrefix = hasLatestRefs ? "../latest/docs" : `../${fallbackVersionDir}/docs`;
    stageReferenceDocs({
      sourceDir: sourceRefsDir,
      stagingDir: rootRefsDir,
      docsPrefix: targetPrefix,
      rebaseFrom: DEFAULT_DOCS_PREFIX
    });
  } else if (fs.existsSync(rootRefsDir)) {
    fs.rmSync(rootRefsDir, { recursive: true, force: true });
  }

  return { versions, latestVersion: fallbackVersionDir };
}

export function serveSite(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const hugoBin = resolveHugo(root);
  if (!hugoBin) {
    throw new Error("Hugo binary not found (checked HUGO_BIN, .sbin/hugo, PATH)");
  }

  const siteDir = path.join(root, "site");
  const env = {
    ...process.env,
    HUGO_PARAMS_SITEROOT: process.env.HUGO_PARAMS_SITEROOT || "/",
    HUGO_PARAMS_VERSION: process.env.HUGO_PARAMS_VERSION || "main",
    HUGO_PARAMS_RELEASEKIND: process.env.HUGO_PARAMS_RELEASEKIND || "development"
  };
  const sourceRef = options.sourceRef || env.HUGO_PARAMS_SOURCEREF || DEFAULT_SOURCE_REF;
  const repoBlobBase = options.repoBlobBase || repoBlobBaseForRoot(root);

  stageReferenceDocs({
    rootDir: root,
    docsDir: path.join(root, "docs"),
    stagingDir: path.join(siteDir, "resources", "references"),
    docsPrefix: DEFAULT_DOCS_PREFIX,
    repoBlobBase,
    sourceRef
  });

  console.log(`Starting Hugo development server using ${hugoBin}...`);
  const serveArgs = ["server", "--renderToMemory", "--disableFastRender"];
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
