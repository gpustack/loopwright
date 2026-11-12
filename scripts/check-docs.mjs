#!/usr/bin/env node
/* global process, console */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const INTERROGATIVES = /\b(what|where|when|how|which|why|who|whose|whom)\b/i;
const HEADING_ARTICLES = /\b(a|an|the)\b/i;
const TABLE_HEADER_BANNED_WORDS = /\b(a|an|the|this|that|these|those|what|where|when|how|which|why|who|whose|whom)\b/i;
const AI_FILLER_PHRASES = [
  "seamlessly",
  "delve",
  "tapestry",
  "leverage",
  "utilize",
  "cutting-edge",
  "empower",
  "it is worth noting",
  "in order to",
  "this page describes",
  "this document describes",
  "comprehensive guide"
];
const AI_FILLER_REGEXES = AI_FILLER_PHRASES.map(phrase => ({
  phrase,
  re: new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i")
}));

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LINK = /!?\[([^\]\n]*)\]\(([^)\n]+)\)/g;
export const PUBLIC_SITE_DOC_REL_PATHS = new Set([
  "docs/getting-started/architecture.md",
  "docs/getting-started/installation.md",
  "docs/operations/github-action.md",
  "docs/operations/github-app.md",
  "docs/operations/cli.md",
  "docs/walkthroughs/declarative-taskpack.md",
  "docs/walkthroughs/managed-controller.md",
  "docs/configuration/taskpack.md",
  "docs/configuration/task-contract.md",
  "docs/configuration/controller-and-registry.md",
  "docs/configuration/sandbox-backends.md",
  "docs/configuration/decision-routing.md"
]);
export const REPO_ONLY_DOC_REL_PATHS = new Set([
  "docs/development.md",
  "docs/contribute/internals.md",
  "docs/contribute/identity.md",
  "docs/contribute/evidence.md",
  "docs/contribute/state.md",
  "docs/contribute/pi-adapter.md",
  "docs/contribute/runner-taskpack.md",
  "docs/contribute/memory.md",
  "docs/contribute/github-app-internals.md",
  "docs/contribute/closure-matrix.md",
  "docs/contribute/adr/0001-local-state-authority.md",
  "docs/contribute/adr/0002-isolated-pi-sdk.md"
]);

const HEADING_MAX_WORDS = 4;
const HEADING_MAX_CHARS = 32;
const STEP_HEADING_MAX_CHARS = 38;
const MAX_H2_SECTIONS = 10;
const LINE_CAP_ARCHITECTURE = 200;
const LINE_CAP_ADR = 220;
const LINE_CAP_DEFAULT = 400;
const PARAGRAPH_MAX_LINES = 5;
const PARAGRAPH_MAX_CHARS = 500;
const TABLE_HEADER_MIN_WORDS = 1;
const TABLE_HEADER_MAX_WORDS = 3;
const TABLE_HEADER_MAX_CHARS = 24;
const TABLE_CELL_MAX_CHARS = 180;
const EXPECTED_ALL_PAGES_COUNT = PUBLIC_SITE_DOC_REL_PATHS.size + REPO_ONLY_DOC_REL_PATHS.size;

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function stripInlineFormatting(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|\*|_)/g, "")
    .trim();
}

function countWords(text) {
  const cleaned = stripInlineFormatting(text);
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

export function getAnchors(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const anchors = new Set();
  const counts = new Map();
  for (const line of content.split("\n")) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const rawText = headingMatch[1]
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .trim();
      let slug = slugify(rawText);
      if (counts.has(slug)) {
        const count = counts.get(slug) + 1;
        counts.set(slug, count);
        slug = `${slug}-${count}`;
      } else {
        counts.set(slug, 0);
      }
      anchors.add(slug);
    }
    const idMatch = line.match(/id=["\x27]([^"\x27]+)["\x27]/);
    if (idMatch) {
      anchors.add(idMatch[1]);
    }
  }
  return anchors;
}

export function proseLinks(text) {
  const links = [];
  let fence = "";
  let comment = false;
  for (const line of text.split("\n")) {
    const marker = line.match(FENCE);
    if (marker) {
      const m = marker[1];
      if (!fence) {
        if (m[0] === "`" && marker[2].includes("`")) {
          // inline code on line
        } else {
          fence = m;
          continue;
        }
      } else if (m[0] === fence[0] && m.length >= fence.length && !marker[2].trim()) {
        fence = "";
        continue;
      }
    }
    if (!fence) {
      const stripped = line.trimStart();
      if (comment) {
        if (line.includes("-->")) {
          comment = false;
        }
        continue;
      }
      if (stripped.startsWith("<!--")) {
        if (!line.includes("-->")) {
          comment = true;
        }
        continue;
      }
      let proseLine = line.replace(/`[^`]+`/g, " ");
      let match;
      const re = new RegExp(LINK.source, "g");
      while ((match = re.exec(proseLine)) !== null) {
        links.push({ label: match[1], target: match[2] });
      }
    }
  }
  return links;
}

export function checkProseHtml(text, source, errors) {
  let fence = "";
  let comment = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineno = i + 1;
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (marker[1][0] === "`" && marker[2].includes("`")) {
        // inline prose
      } else {
        fence = marker[1];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      continue;
    }

    const stripped = line.trim();
    if (comment) {
      if (stripped === "-->" || stripped.endsWith("-->")) {
        comment = false;
      } else if (stripped.includes("-->")) {
        errors.push(`${source}:${lineno}: HTML comment body must not contain '-->' (use '->' for flowgraph arrows)`);
      }
      continue;
    }

    if (stripped.startsWith("<!--")) {
      if (stripped.endsWith("-->") && stripped.length > 6) {
        const inner = stripped.slice(4, -3);
        if (inner.includes("-->")) {
          errors.push(`${source}:${lineno}: HTML comment body must not contain '-->' (use '->' for flowgraph arrows)`);
        }
      } else {
        if (stripped.slice(4).includes("-->")) {
          errors.push(`${source}:${lineno}: HTML comment body must not contain '-->' (use '->' for flowgraph arrows)`);
        }
        comment = true;
      }
      continue;
    }

    let proseLine = line.replace(/`[^`]+`/g, "");
    proseLine = proseLine.replace(/<(https?:\/\/[^\s>]+|[^\s>@]+@[^\s>@]+)>/g, "");
    const tagMatches = proseLine.matchAll(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^>]*)?\/?>/g);
    for (const match of tagMatches) {
      const tag = match[0];
      if (!/^<br\s*\/?>$/i.test(tag)) {
        errors.push(`${source}:${lineno}: raw HTML must be an attribute-free <br>: ${tag}`);
      }
    }
  }
}

export function checkInterrogatives(filePath, content, errors) {
  const lines = content.split("\n");
  let fence = "";
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      continue;
    }

    const stripped = line.trim();
    if (comment) {
      if (stripped.includes("-->")) comment = false;
      continue;
    }
    if (stripped.startsWith("<!--")) {
      if (!stripped.includes("-->")) comment = true;
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const text = headingMatch[1];
      if (INTERROGATIVES.test(text)) {
        errors.push(`${filePath}:${i + 1}: heading must not use interrogative words: "${text}"`);
      }
    }
    if (i + 1 < lines.length && stripped.startsWith("|") && stripped.endsWith("|")) {
      const nextLine = lines[i + 1].trim();
      if (/^\|(\s*:?-+:?\s*\|)+$/.test(nextLine)) {
        const cells = splitTableCells(stripped);
        for (const cell of cells) {
          if (INTERROGATIVES.test(cell)) {
            errors.push(`${filePath}:${i + 1}: table header must not use interrogative words: "${cell.trim()}"`);
          }
        }
      }
    }
  }
}

function splitTableCells(rowLine) {
  const trimmed = rowLine.trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const placeholder = "\u001C";
  return inner
    .replace(/\\\|/g, placeholder)
    .split("|")
    .map(c => c.replaceAll(placeholder, "|").trim());
}

export function checkHeadingCaps(relDoc, content, errors) {
  const lines = content.split("\n");
  let fence = "";
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      continue;
    }

    const stripped = line.trim();
    if (comment) {
      if (stripped.includes("-->")) comment = false;
      continue;
    }
    if (stripped.startsWith("<!--")) {
      if (!stripped.includes("-->")) comment = true;
      continue;
    }

    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (!headingMatch) continue;
    const rawHeading = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
    const visible = stripInlineFormatting(rawHeading);

    const stepMatch = visible.match(/^Step\s+[0-9]+:\s+(.+)$/);
    if (stepMatch) {
      const actionText = stepMatch[1].trim();
      const actionWords = countWords(actionText);
      const totalChars = visible.length;
      if (actionWords > HEADING_MAX_WORDS || totalChars > STEP_HEADING_MAX_CHARS) {
        errors.push(
          `${relDoc}:${i + 1}: Step heading exceeds cap (${actionWords} action words / ${totalChars} chars; max ${HEADING_MAX_WORDS} words after colon / ${STEP_HEADING_MAX_CHARS} chars total): "${visible}"`
        );
      }
    } else {
      const words = countWords(visible);
      const chars = visible.length;
      if (words > HEADING_MAX_WORDS || chars > HEADING_MAX_CHARS) {
        errors.push(
          `${relDoc}:${i + 1}: heading exceeds cap (${words} words / ${chars} chars; max ${HEADING_MAX_WORDS} words / ${HEADING_MAX_CHARS} chars): "${visible}"`
        );
      }
    }
    const articleMatch = visible.match(HEADING_ARTICLES);
    if (articleMatch) {
      errors.push(
        `${relDoc}:${i + 1}: section heading must omit articles ("${articleMatch[1]}"): "${visible}"`
      );
    }
  }
}

export function checkSectionAndLineCaps(relDoc, content, errors) {
  const normalizedRel = relDoc.split(path.sep).join("/");
  const rawLines = content.split("\n");
  const lineCount = rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.length - 1 : rawLines.length;

  let lineCap = LINE_CAP_DEFAULT;
  if (normalizedRel === "docs/getting-started/architecture.md") {
    lineCap = LINE_CAP_ARCHITECTURE;
  } else if (/^docs\/contribute\/adr\/[^/]+\.md$/.test(normalizedRel)) {
    lineCap = LINE_CAP_ADR;
  }

  if (lineCount > lineCap) {
    errors.push(`${relDoc}: line count exceeds ${lineCap} lines (${lineCount})`);
  }

  let fence = "";
  let comment = false;
  let h2Count = 0;
  for (const line of rawLines) {
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      continue;
    }

    const stripped = line.trim();
    if (comment) {
      if (stripped.includes("-->")) comment = false;
      continue;
    }
    if (stripped.startsWith("<!--")) {
      if (!stripped.includes("-->")) comment = true;
      continue;
    }

    if (line.startsWith("## ") && stripped !== "## Contents") {
      h2Count++;
    }
  }

  if (h2Count > MAX_H2_SECTIONS) {
    errors.push(`${relDoc}: H2 section count exceeds ${MAX_H2_SECTIONS} (${h2Count} ## sections excluding ## Contents)`);
  }
}

function stripTrailingReadingFooter(content) {
  const parts = content.split("\n---\n");
  if (parts.length > 1) {
    const footer = parts[parts.length - 1].trim();
    if (footer.startsWith("**See also**")) {
      return parts.slice(0, -1).join("\n---\n");
    }
  }
  return content;
}

export function checkProseParagraphCaps(relDoc, content, errors) {
  const body = stripTrailingReadingFooter(content);
  const lines = body.split("\n");
  let fence = "";
  let comment = false;
  let paraStart = 0;
  let paraLines = [];

  function flushParagraph() {
    if (paraLines.length === 0) return;
    const lineCount = paraLines.length;
    const renderedText = paraLines.map(l => stripInlineFormatting(l)).join(" ");
    const charCount = renderedText.length;
    if (lineCount > PARAGRAPH_MAX_LINES || charCount > PARAGRAPH_MAX_CHARS) {
      errors.push(
        `${relDoc}:${paraStart}: prose paragraph exceeds cap (${lineCount} lines / ${charCount} chars; max ${PARAGRAPH_MAX_LINES} lines / ${PARAGRAPH_MAX_CHARS} chars)`
      );
    }
    paraLines = [];
    paraStart = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        flushParagraph();
        fence = marker[1];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      continue;
    }

    const stripped = line.trim();
    if (comment) {
      if (stripped.includes("-->")) comment = false;
      continue;
    }
    if (stripped.startsWith("<!--")) {
      flushParagraph();
      if (!stripped.includes("-->")) comment = true;
      continue;
    }

    // Non-prose boundaries: blank lines, headings, tables, blockquotes, lists, horizontal rules, images, footers
    if (
      stripped === "" ||
      /^#{1,6}\s/.test(stripped) ||
      stripped.startsWith("|") ||
      stripped.startsWith(">") ||
      /^([-*+]|\d+[.)])\s/.test(stripped) ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(stripped) ||
      /^!\[[^\]]*\]\([^)]+\)$/.test(stripped) ||
      /^\*\*(See also|Next)\*\*/.test(stripped)
    ) {
      flushParagraph();
      continue;
    }

    if (paraLines.length === 0) {
      paraStart = i + 1;
    }
    paraLines.push(stripped);
  }

  flushParagraph();
}

export function checkTables(relDoc, content, errors) {
  const lines = content.split("\n");
  let fence = "";
  let comment = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        i++;
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      i++;
      continue;
    }

    const stripped = line.trim();
    if (comment) {
      if (stripped.includes("-->")) comment = false;
      i++;
      continue;
    }
    if (stripped.startsWith("<!--")) {
      if (!stripped.includes("-->")) comment = true;
      i++;
      continue;
    }

    if (
      i + 1 < lines.length &&
      stripped.startsWith("|") &&
      stripped.endsWith("|") &&
      /^\|(\s*:?-+:?\s*\|)+$/.test(lines[i + 1].trim())
    ) {
      const headerLineNo = i + 1;
      const sepLineNo = i + 2;
      const headerCells = splitTableCells(stripped);
      const sepCells = splitTableCells(lines[i + 1].trim());

      if (sepCells.length !== headerCells.length) {
        errors.push(
          `${relDoc}:${sepLineNo}: table separator column count (${sepCells.length}) does not match header column count (${headerCells.length})`
        );
      }

      for (const cell of headerCells) {
        const visible = stripInlineFormatting(cell);
        const words = countWords(visible);
        const chars = visible.length;
        if (words < TABLE_HEADER_MIN_WORDS || words > TABLE_HEADER_MAX_WORDS || chars > TABLE_HEADER_MAX_CHARS) {
          errors.push(
            `${relDoc}:${headerLineNo}: table header "${visible}" exceeds cap (${words} words / ${chars} chars; expected ${TABLE_HEADER_MIN_WORDS}-${TABLE_HEADER_MAX_WORDS} words and <= ${TABLE_HEADER_MAX_CHARS} chars)`
          );
        }
        const bannedMatch = visible.match(TABLE_HEADER_BANNED_WORDS);
        if (bannedMatch) {
          errors.push(
            `${relDoc}:${headerLineNo}: table header "${visible}" must not use banned word "${bannedMatch[1]}"`
          );
        }
        if (cell.length > TABLE_CELL_MAX_CHARS) {
          errors.push(
            `${relDoc}:${headerLineNo}: table cell length (${cell.length} chars) exceeds ${TABLE_CELL_MAX_CHARS} chars`
          );
        }
      }

      i += 2;
      while (i < lines.length) {
        const rowStripped = lines[i].trim();
        if (!rowStripped.startsWith("|") || !rowStripped.endsWith("|")) {
          break;
        }
        const rowLineNo = i + 1;
        const rowCells = splitTableCells(rowStripped);
        if (rowCells.length !== headerCells.length) {
          errors.push(
            `${relDoc}:${rowLineNo}: table row column count (${rowCells.length}) does not match header column count (${headerCells.length})`
          );
        }
        for (const cell of rowCells) {
          if (cell.length > TABLE_CELL_MAX_CHARS) {
            errors.push(
              `${relDoc}:${rowLineNo}: table cell length (${cell.length} chars) exceeds ${TABLE_CELL_MAX_CHARS} chars`
            );
          }
        }
        i++;
      }
      continue;
    }

    i++;
  }
}

export function checkBannedAiFiller(relDoc, content, errors) {
  const lines = content.split("\n");
  let fence = "";
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      continue;
    }

    const stripped = line.trim();
    if (comment) {
      if (stripped.includes("-->")) comment = false;
      continue;
    }
    if (stripped.startsWith("<!--")) {
      if (!stripped.includes("-->")) comment = true;
      continue;
    }

    const proseLine = line.replace(/`[^`]+`/g, " ");
    for (const { phrase, re } of AI_FILLER_REGEXES) {
      if (re.test(proseLine)) {
        errors.push(`${relDoc}:${i + 1}: prose must not use banned AI filler phrase "${phrase}"`);
      }
    }
    if (/\b(?:no\s+`?metadata`?|without\s+`?metadata`?|`?metadata`?\s+is\s+(?:forbidden|not\s+used)|omits\s+`?metadata`?)\b/i.test(line)) {
      errors.push(`${relDoc}:${i + 1}: omit awkward "no metadata" / "without metadata" phrasing in docs`);
    }
  }
}

export function checkPrettyYamlBlocks(relDoc, content, errors) {
  const lines = content.split("\n");
  let fence = "";
  let isYamlFence = false;
  let yamlBlockStartLine = 0;
  let yamlLines = [];

  function inspectYamlBlock() {
    if (!isYamlFence || yamlLines.length === 0) return;
    const blockText = yamlLines.map(item => item.text).join("\n");

    for (const item of yamlLines) {
      if (item.text.includes("\t")) {
        errors.push(`${relDoc}:${item.lineNo}: Pretty YAML block must not contain tab characters`);
      }
    }

    if (/:\s*[|>][-+]?\s*\n\s*\{/.test(blockText)) {
      errors.push(
        `${relDoc}:${yamlBlockStartLine}: Pretty YAML block must not embed multi-line JSON block scalars`
      );
    }

    const topKeys = new Set();
    let topKind = "";
    for (const item of yamlLines) {
      const m = item.text.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) {
        topKeys.add(m[1]);
        if (m[1] === "kind") {
          const rawVal = m[2].replace(/#.*$/, "").trim();
          topKind = rawVal.replace(/^['"]|['"]$/g, "");
        }
      }
    }

    const NAMED_METADATA_KINDS = new Set(["Taskpack", "TrustedRegistry"]);
    const METADATA_FREE_KINDS = new Set([
      "ControllerConfig",
      "TaskContract",
      "GitHubAppConfig",
      "DecisionPolicy",
      "VerificationProfile",
      "AttemptReceipt"
    ]);

    for (const item of yamlLines) {
      const codeOnly = item.text.replace(/#.*$/, "");
      if (/\bhex:\s*['"]?[0-9a-fA-F]{64}['"]?\b/.test(codeOnly) || /\bimageDigest:\s*['"]?sha256:[0-9a-fA-F]{64}['"]?\b/.test(codeOnly)) {
        errors.push(
          `${relDoc}:${item.lineNo}: Use "hex: <hash>" (or "imageDigest: sha256:<hash>") instead of 64-character dummy hashes in YAML examples`
        );
      }
      const commentIdx = item.text.indexOf("#");
      if (commentIdx === -1) continue;
      const beforeComment = item.text.slice(0, commentIdx);
      const commentBody = item.text.slice(commentIdx);
      const quoteCount =
        (beforeComment.match(/'/g) || []).length +
        (beforeComment.match(/"/g) || []).length;
      if (quoteCount % 2 !== 0) continue;
      if (/#\s*(Required|Conditional)\b/i.test(commentBody)) {
        errors.push(
          `${relDoc}:${item.lineNo}: YAML comments must only annotate Optional items (omit "# Required" / "# Conditional" noise)`
        );
      }
      if (beforeComment.trim().length > 0 && /:\s/.test(commentBody)) {
        errors.push(
          `${relDoc}:${item.lineNo}: Inline YAML comment must not contain ": " (breaks Hugo Chroma comment syntax highlighting)`
        );
      }
      if (/\bno\s+metadata\b|\bmetadata\s+is\s+(?:forbidden|not\s+used)\b/i.test(commentBody)) {
        errors.push(
          `${relDoc}:${item.lineNo}: omit awkward "no metadata" phrasing in YAML comments`
        );
      }
    }

    const hasLoopwrightResourceEnvelope =
      topKeys.has("apiVersion") &&
      topKeys.has("kind") &&
      topKeys.has("spec");
    const hasWorkflowEnvelope =
      topKeys.has("name") &&
      topKeys.has("on") &&
      topKeys.has("jobs");
    const hasActionManifestEnvelope =
      topKeys.has("name") &&
      topKeys.has("inputs") &&
      topKeys.has("runs");

    if (!hasLoopwrightResourceEnvelope && !hasWorkflowEnvelope && !hasActionManifestEnvelope) {
      errors.push(
        `${relDoc}:${yamlBlockStartLine}: Pretty YAML block must include a complete top-level header envelope (apiVersion, kind, [metadata.name], spec for Loopwright resources, or name, on, jobs for GitHub Actions workflows)`
      );
    } else if (hasLoopwrightResourceEnvelope) {
      if (topKind === "TaskpackManifest") {
        errors.push(
          `${relDoc}:${yamlBlockStartLine}: Use "kind: Taskpack" instead of legacy "kind: TaskpackManifest"`
        );
      } else if (NAMED_METADATA_KINDS.has(topKind)) {
        if (!topKeys.has("metadata")) {
          errors.push(
            `${relDoc}:${yamlBlockStartLine}: Pretty YAML kind "${topKind}" must include top-level metadata.name`
          );
        } else {
          let inMetadata = false;
          const metadataSubkeys = new Set();
          for (const item of yamlLines) {
            if (/^metadata\s*:/.test(item.text)) {
              inMetadata = true;
              continue;
            }
            if (inMetadata) {
              if (/^[A-Za-z0-9_-]+\s*:/.test(item.text)) {
                inMetadata = false;
                continue;
              }
              const subMatch = item.text.match(/^ {2}([A-Za-z0-9_-]+)\s*:/);
              if (subMatch) {
                metadataSubkeys.add(subMatch[1]);
              }
            }
          }
          if (!metadataSubkeys.has("name")) {
            errors.push(
              `${relDoc}:${yamlBlockStartLine}: Pretty YAML kind "${topKind}" must declare metadata.name`
            );
          }
          if (metadataSubkeys.has("id") || metadataSubkeys.has("version")) {
            errors.push(
              `${relDoc}:${yamlBlockStartLine}: Pretty YAML kind "${topKind}" metadata must use name only (metadata.id and metadata.version are forbidden)`
            );
          }
        }
      } else if (METADATA_FREE_KINDS.has(topKind) && topKeys.has("metadata")) {
        errors.push(
          `${relDoc}:${yamlBlockStartLine}: Pretty YAML one-off kind "${topKind}" must omit top-level metadata (use apiVersion, kind, spec only)`
        );
      }
    }

    yamlLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        const info = marker[2].trim().split(/\s+/)[0]?.toLowerCase() || "";
        isYamlFence = info === "yaml" || info === "yml";
        yamlBlockStartLine = i + 1;
        yamlLines = [];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        inspectYamlBlock();
        fence = "";
        isYamlFence = false;
        continue;
      }
      if (isYamlFence) {
        yamlLines.push({ lineNo: i + 1, text: line });
      }
    }
  }
}

export function checkReadingFooter(relDoc, content, errors) {
  const parts = content.split("\n---\n");
  if (parts.length < 2) {
    errors.push(`${relDoc}: missing trailing "\\n---\\n" reading footer separator before "**See also**"`);
    return;
  }
  const footer = parts[parts.length - 1].trim();
  if (!footer.startsWith("**See also** — ")) {
    errors.push(`${relDoc}: trailing reading footer must start with "**See also** — "`);
    return;
  }

  const nextParts = footer.split("**Next**");
  const seeAlsoBody = nextParts[0].replace(/^\*\*See also\*\*\s*—\s*/, "").trim();
  const items = seeAlsoBody
    .split("·")
    .map(item => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    errors.push(`${relDoc}: "**See also** — " must list at least one linked page with description`);
  }

  for (const item of items) {
    if (!/^\[[^\]\n]+\]\([^)\n]+\)\s+\([^)\n]+\)$/.test(item)) {
      errors.push(
        `${relDoc}: "**See also**" item must match "[Title](target) (description)": ${item}`
      );
    }
  }

  const isPublic = PUBLIC_SITE_DOC_REL_PATHS.has(relDoc);
  if (isPublic && nextParts.length < 2) {
    errors.push(`${relDoc}: public site page must include "**Next** → [Title](target) — <description>" in reading footer`);
    return;
  }

  if (nextParts.length > 1) {
    const nextRaw = nextParts.slice(1).join("**Next**").trim();
    if (!/^→\s+\[[^\]\n]+\]\([^)\n]+\)\s+—\s+\S/.test(nextRaw)) {
      errors.push(
        `${relDoc}: "**Next**" footer must match "**Next** → [Title](target) — <description>": **Next** ${nextRaw}`
      );
    }
  }
}

export function checkExamplesControllerNoJson(relDoc, content, errors) {
  const lines = content.split("\n");
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(FENCE);
    if (marker && !fence) {
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        const info = marker[2].trim().split(/\s+/)[0]?.toLowerCase() || "";
        if (info === "json") {
          errors.push(`${relDoc}:${i + 1}: examples/controller.md must use Pretty YAML configuration blocks, not json`);
        }
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
    }
  }
}

function getSection(text, title) {
  const marker = `\n## ${title}\n`;
  const startIdx = text.startsWith(`## ${title}\n`) ? 0 : text.indexOf(marker);
  if (startIdx === -1) {
    throw new Error(`docs/README.md: missing "## ${title}" section`);
  }
  const bodyStart = startIdx === 0 ? `## ${title}\n`.length : startIdx + marker.length;
  const nextHeadingIdx = text.indexOf("\n## ", bodyStart);
  if (nextHeadingIdx === -1) {
    return text.slice(bodyStart);
  }
  return text.slice(bodyStart, nextHeadingIdx);
}

function resolveCheckOptions(arg) {
  if (!arg) {
    return { repoRoot: process.cwd(), mode: "strict" };
  }
  if (typeof arg === "string") {
    return { repoRoot: arg, mode: "strict" };
  }
  return {
    repoRoot: arg.repoRoot || arg.rootDir || process.cwd(),
    mode: arg.mode === "report" ? "report" : "strict"
  };
}

export function checkDocs(rootDirOrOptions = process.cwd()) {
  const { repoRoot, mode } = resolveCheckOptions(rootDirOrOptions);
  const root = path.resolve(repoRoot);
  const docsDir = path.join(root, "docs");
  const indexFile = path.join(docsDir, "README.md");
  const errors = [];

  if (!fs.existsSync(indexFile)) {
    return { ok: false, mode, errors: [`${indexFile} does not exist`], warnings: [] };
  }

  const indexContent = fs.readFileSync(indexFile, "utf8");

  // 1. docs/README.md sections
  let readingPaths;
  let moduleMap = "";
  let specsSection;
  let allPagesSection = "";

  try {
    readingPaths = getSection(indexContent, "Reading paths");
    if (!readingPaths.trim()) {
      errors.push('docs/README.md: "## Reading paths" section is empty');
    }
  } catch (err) {
    errors.push(err.message);
  }
  try {
    moduleMap = getSection(indexContent, "Module map");
  } catch (err) {
    errors.push(err.message);
  }
  try {
    specsSection = getSection(indexContent, "Specs");
    if (!specsSection.trim()) {
      errors.push('docs/README.md: "## Specs" section is empty');
    }
  } catch (err) {
    errors.push(err.message);
  }
  try {
    allPagesSection = getSection(indexContent, "All pages");
  } catch (err) {
    errors.push(err.message);
  }

  // 2. Module map validation
  const records = {};
  if (moduleMap) {
    const blocks = moduleMap.split(/^### /m).slice(1);
    const allowedFields = new Set(["ID", "Use for", "Aliases", "Guides", "Specs", "Code", "Related", "Skills"]);
    const requiredFields = ["ID", "Use for", "Aliases", "Guides", "Code", "Skills"];

    for (const block of blocks) {
      const newlineIdx = block.indexOf("\n");
      const title = newlineIdx !== -1 ? block.slice(0, newlineIdx).trim() : block.trim();
      const body = newlineIdx !== -1 ? block.slice(newlineIdx + 1) : "";

      const fieldMatches = Array.from(body.matchAll(/^- ([A-Za-z ]+): (.+)$/gm));
      const values = {};
      for (const m of fieldMatches) {
        const fieldName = m[1].trim();
        const fieldValue = m[2].trim();
        if (values[fieldName]) {
          errors.push(`${title}: duplicate field ${fieldName}`);
        }
        values[fieldName] = fieldValue;
      }

      for (const name of Object.keys(values)) {
        if (!allowedFields.has(name)) {
          errors.push(`${title}: unknown field ${name}`);
        }
      }
      for (const name of requiredFields) {
        if (!values[name]) {
          errors.push(`${title}: missing ${name}`);
        }
      }

      const id = (values.ID || "").replace(/^`|`$/g, "");
      if (!/^[a-z][a-z0-9-]*$/.test(id) || records[id]) {
        errors.push(`${title}: invalid or duplicate ID "${id}"`);
      }
      records[id] = values;

      for (const name of ["Guides", "Specs", "Code", "Skills"]) {
        const val = values[name] || "";
        const links = proseLinks(val);
        if (name in values && links.length === 0) {
          errors.push(`${title}: ${name} has no source links`);
        }
        for (const link of links) {
          const rawTarget = link.target.split("#")[0];
          const resolved = path.resolve(docsDir, rawTarget);
          if (!resolved.startsWith(root) || !fs.existsSync(resolved)) {
            errors.push(`${title}: ${name} target must exist in repository: ${link.target}`);
          } else if (name === "Guides" && !resolved.startsWith(docsDir)) {
            errors.push(`${title}: guide outside docs/: ${link.target}`);
          } else if (name === "Specs" && !resolved.startsWith(path.join(root, "specs"))) {
            errors.push(`${title}: spec outside specs/: ${link.target}`);
          } else if (name === "Skills" && (path.basename(resolved) !== "SKILL.md" || !resolved.startsWith(path.join(root, ".agents", "skills")))) {
            errors.push(`${title}: skill must use canonical SKILL.md: ${link.target}`);
          }
        }
      }
    }

    const expectedModuleIds = new Set([
      "contracts",
      "state",
      "pi-adapter",
      "controller",
      "taskpacks",
      "memory",
      "github-app",
      "decisions",
      "development"
    ]);

    const actualIds = new Set(Object.keys(records));
    if (actualIds.size !== expectedModuleIds.size || [...expectedModuleIds].some(id => !actualIds.has(id))) {
      errors.push(`module IDs mismatch: expected [${[...expectedModuleIds].sort().join(", ")}], got [${[...actualIds].sort().join(", ")}]`);
    }

    // Skill coverage check: skills referencing docs/ must be listed in Skills
    const skillsDir = path.join(root, ".agents", "skills");
    const consumers = new Set();
    if (fs.existsSync(skillsDir)) {
      for (const dirEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (dirEntry.isDirectory()) {
          const skillDir = path.join(skillsDir, dirEntry.name);
          const skillMd = path.join(skillDir, "SKILL.md");
          if (fs.existsSync(skillMd)) {
            let referencesDocs = false;
            const checkDir = d => {
              for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) {
                  checkDir(full);
                } else if (e.name.endsWith(".md") || e.name.endsWith(".sh")) {
                  const txt = fs.readFileSync(full, "utf8");
                  if (txt.includes("docs/")) {
                    referencesDocs = true;
                  }
                }
              }
            };
            checkDir(skillDir);
            if (referencesDocs) {
              consumers.add(dirEntry.name);
            }
          }
        }
      }
    }

    const routedSkills = new Set();
    for (const record of Object.values(records)) {
      for (const link of proseLinks(record.Skills || "")) {
        const rawTarget = link.target.split("#")[0];
        const resolved = path.resolve(docsDir, rawTarget);
        const parentDir = path.basename(path.dirname(resolved));
        routedSkills.add(parentDir);
      }
    }

    for (const consumer of consumers) {
      if (!routedSkills.has(consumer)) {
        errors.push(`documentation consumer skill missing from module map: ${consumer}`);
      }
    }
  }

  // 3. All pages table validation
  const allPagesEntries = [];
  if (allPagesSection) {
    const rowRegex = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+)\s*\|$/gm;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(allPagesSection)) !== null) {
      allPagesEntries.push({
        label: rowMatch[1].trim(),
        target: rowMatch[2].trim(),
        description: rowMatch[3].trim()
      });
    }

    if (allPagesEntries.length !== EXPECTED_ALL_PAGES_COUNT) {
      errors.push(`All pages expected ${EXPECTED_ALL_PAGES_COUNT} entries, found ${allPagesEntries.length}`);
    }

    for (const entry of allPagesEntries) {
      const targetPath = path.resolve(docsDir, entry.target);
      if (!fs.existsSync(targetPath)) {
        errors.push(`All pages target does not exist: ${entry.target}`);
        continue;
      }
      const pageContent = fs.readFileSync(targetPath, "utf8");
      const h1Match = pageContent.match(/^#\s+(.+)$/m);
      if (!h1Match) {
        errors.push(`${entry.target}: missing # H1 heading`);
      } else {
        const h1Title = h1Match[1].trim();
        if (h1Title !== entry.label) {
          errors.push(`${entry.target}: H1 title "${h1Title}" does not match All pages label "${entry.label}" character for character`);
        }
      }
    }
  }

  // 4. Validate all docs/**/*.md page contract
  const docFiles = [];
  function scanDocs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "assets") scanDocs(full);
      } else if (entry.name.endsWith(".md")) {
        docFiles.push(full);
      }
    }
  }
  scanDocs(docsDir);

  for (const docFile of docFiles) {
    const relDoc = path.relative(root, docFile).split(path.sep).join("/");
    const content = fs.readFileSync(docFile, "utf8");
    const lines = content.split("\n");

    checkProseHtml(content, relDoc, errors);
    checkProseParagraphCaps(relDoc, content, errors);
    checkBannedAiFiller(relDoc, content, errors);
    checkPrettyYamlBlocks(relDoc, content, errors);

    if (docFile === indexFile) {
      continue;
    }

    checkHeadingCaps(relDoc, content, errors);
    checkSectionAndLineCaps(relDoc, content, errors);
    checkTables(relDoc, content, errors);

    // Page shape: # Title
    const firstNonEmpty = lines.find(l => l.trim().length > 0);
    if (!firstNonEmpty || !firstNonEmpty.startsWith("# ")) {
      errors.push(`${relDoc}: missing H1 title at top of page`);
    }

    // Page shape: intro before ## Contents
    const contentsIdx = lines.findIndex(l => l.trim() === "## Contents");
    if (contentsIdx === -1) {
      errors.push(`${relDoc}: missing "## Contents" table of contents`);
    } else {
      const intro = lines.slice(1, contentsIdx).filter(l => l.trim().length > 0 && !l.startsWith("#"));
      if (intro.length === 0) {
        errors.push(`${relDoc}: missing introduction before "## Contents"`);
      }

      // ## Contents items match subsequent ## H2 headings in order
      const subsequentH2 = [];
      let inFence = "";
      for (let i = contentsIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        const marker = l.match(FENCE);
        if (marker && !inFence) {
          if (!(marker[1][0] === "`" && marker[2].includes("`"))) {
            inFence = marker[1];
            continue;
          }
        } else if (inFence) {
          if (marker && marker[1][0] === inFence[0] && marker[1].length >= inFence.length && !marker[2].trim()) {
            inFence = "";
          }
          continue;
        }
        if (l.startsWith("## ")) {
          subsequentH2.push(l.slice(3).trim());
        }
      }

      const tocItems = [];
      for (let i = contentsIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith("#")) break;
        const match = l.match(/^\s*-\s+\[([^\]]+)\]\((#[^)]+)\)/);
        if (match) {
          tocItems.push({ text: match[1], anchor: match[2] });
        }
      }

      if (tocItems.length !== subsequentH2.length) {
        errors.push(`${relDoc}: ## Contents count (${tocItems.length}) does not match subsequent ## headings (${subsequentH2.length})`);
      } else {
        for (let i = 0; i < tocItems.length; i++) {
          if (tocItems[i].text !== subsequentH2[i]) {
            errors.push(`${relDoc}: Contents item ${i + 1} "${tocItems[i].text}" does not match heading "${subsequentH2[i]}"`);
          }
          const expectedAnchor = "#" + slugify(subsequentH2[i]);
          if (tocItems[i].anchor !== expectedAnchor) {
            errors.push(`${relDoc}: Contents item ${i + 1} anchor "${tocItems[i].anchor}" does not match "${expectedAnchor}"`);
          }
        }
      }
    }

    // Page shape: gpustack-style **See also** / **Next** reading footer
    checkReadingFooter(relDoc, content, errors);

    // Architecture specific check
    if (relDoc === "docs/getting-started/architecture.md") {
      if (!content.includes("architecture-flow.svg")) {
        errors.push(`${relDoc}: must embed architecture-flow.svg`);
      }
      const commentMatch = content.match(/<!--([\s\S]*?)-->/);
      if (!commentMatch) {
        errors.push(`${relDoc}: missing hidden Mermaid flowgraph comment`);
      } else {
        const body = commentMatch[1];
        if (body.includes("-->")) {
          errors.push(`${relDoc}: Mermaid comment body must not contain '-->'`);
        }
        if (!body.includes("->") && !body.includes("..>")) {
          errors.push(`${relDoc}: Mermaid comment must use '->' or '..>' arrows`);
        }
      }
    }

    // Site publication link boundary & 1:1 filename-to-H1 slug rule on the 12 public docs pages
    if (PUBLIC_SITE_DOC_REL_PATHS.has(relDoc)) {
      if (firstNonEmpty && firstNonEmpty.startsWith("# ")) {
        const h1Title = firstNonEmpty.slice(2).trim();
        const expectedSlug = slugify(h1Title);
        const actualSlug = path.basename(relDoc, ".md");
        if (actualSlug !== expectedSlug) {
          errors.push(
            `${relDoc}: public page filename slug "${actualSlug}.md" must match # H1 title slug "${expectedSlug}.md" ("# ${h1Title}")`
          );
        }
      }

      const pageLinks = proseLinks(content);
      for (const link of pageLinks) {
        const raw = link.target.trim();
        if (/^(?:https?:\/\/|mailto:|javascript:)/i.test(raw)) {
          continue;
        }
        const [targetPath] = raw.split("#");
        if (!targetPath) continue;
        const resolved = path.resolve(path.dirname(docFile), targetPath);
        const relTarget = path.relative(root, resolved).split(path.sep).join("/");
        if (
          relTarget === "docs/development.md" ||
          relTarget.startsWith("docs/contribute/")
        ) {
          errors.push(
            `${relDoc}: public site page must not link to repository-only contributor page "${raw}" (${relTarget})`
          );
        }
      }
    }
  }

  // 4a. Validate 1:1:1 alignment with site/data/navigation.yaml when present
  const navYamlPath = path.join(root, "site", "data", "navigation.yaml");
  if (fs.existsSync(navYamlPath)) {
    const navDoc = parseDocument(fs.readFileSync(navYamlPath, "utf8"), {
      version: "1.2",
      schema: "core",
      uniqueKeys: true
    });
    if (navDoc.errors.length > 0) {
      errors.push(
        `site/data/navigation.yaml: invalid YAML (${navDoc.errors.map(e => e.message).join("; ")})`
      );
    } else {
      const navData = navDoc.toJS() || {};
      const groups = Array.isArray(navData.groups) ? navData.groups : [];
      const labels = navData.labels && typeof navData.labels === "object" ? navData.labels : {};
      const seenPublicPaths = new Set();

      for (const group of groups) {
        const groupName = String(group?.name || "").trim();
        const expectedGroupSlug = slugify(groupName);
        const pages = Array.isArray(group?.items) ? group.items : [];
        for (const route of pages) {
          const routeStr = String(route || "").trim();
          const m = routeStr.match(/^\/docs\/([a-z0-9-]+)\/([a-z0-9-]+)\/$/);
          if (!m) {
            errors.push(
              `site/data/navigation.yaml: route "${routeStr}" must match "/docs/<group-slug>/<page-slug>/"`
            );
            continue;
          }
          const [, routeGroupSlug, routePageSlug] = m;
          if (routeGroupSlug !== expectedGroupSlug) {
            errors.push(
              `site/data/navigation.yaml: route "${routeStr}" group directory "${routeGroupSlug}" must match group "${groupName}" ("${expectedGroupSlug}")`
            );
          }
          const relDoc = `docs/${routeGroupSlug}/${routePageSlug}.md`;
          seenPublicPaths.add(relDoc);
          const absDoc = path.join(root, relDoc);
          if (!fs.existsSync(absDoc)) {
            errors.push(`site/data/navigation.yaml: route "${routeStr}" missing file ${relDoc}`);
            continue;
          }
          const navLabel = String(labels[routeStr] || "").trim();
          if (!navLabel) {
            errors.push(`site/data/navigation.yaml: missing label for route "${routeStr}"`);
            continue;
          }
          const pageContent = fs.readFileSync(absDoc, "utf8");
          const h1Match = pageContent.match(/^#\s+(.+)$/m);
          const h1Title = h1Match ? h1Match[1].trim() : "";
          if (navLabel !== h1Title) {
            errors.push(
              `site/data/navigation.yaml: label "${navLabel}" for "${routeStr}" must match ${relDoc} # H1 title "${h1Title}" character for character`
            );
          }
          if (slugify(navLabel) !== routePageSlug) {
            errors.push(
              `site/data/navigation.yaml: route slug "${routePageSlug}" for "${routeStr}" must match slugified label "${slugify(navLabel)}"`
            );
          }
        }
      }

      for (const pubRel of PUBLIC_SITE_DOC_REL_PATHS) {
        if (!seenPublicPaths.has(pubRel)) {
          errors.push(`site/data/navigation.yaml: missing public doc page ${pubRel}`);
        }
      }
    }
  }

  // 4b. Validate README.md and examples/*.md YAML-first blocks
  const rootReadme = path.join(root, "README.md");
  if (fs.existsSync(rootReadme)) {
    checkPrettyYamlBlocks("README.md", fs.readFileSync(rootReadme, "utf8"), errors);
  }

  const examplesDir = path.join(root, "examples");
  if (fs.existsSync(examplesDir)) {
    for (const entry of fs.readdirSync(examplesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const exPath = path.join(examplesDir, entry.name);
        const relEx = path.relative(root, exPath).split(path.sep).join("/");
        const exContent = fs.readFileSync(exPath, "utf8");
        checkPrettyYamlBlocks(relEx, exContent, errors);
        if (entry.name === "controller.md") {
          checkExamplesControllerNoJson(relEx, exContent, errors);
        }
      }
    }
  }

  // 4c. Validate SVG diagram text hygiene under docs/assets/diagrams/*.svg
  const diagramsDir = path.join(docsDir, "assets", "diagrams");
  if (fs.existsSync(diagramsDir)) {
    for (const entry of fs.readdirSync(diagramsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".svg")) continue;
      const svgPath = path.join(diagramsDir, entry.name);
      const relSvg = path.relative(root, svgPath).split(path.sep).join("/");
      const svgContent = fs.readFileSync(svgPath, "utf8");
      const textMatches = svgContent.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g);
      for (const m of textMatches) {
        const inner = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (/[[\]{}]/.test(inner)) {
          errors.push(`${relSvg}: SVG <text> must not contain array/object brackets ([] or {}): "${inner}"`);
        }
        if (/\b(?:no\s+metadata|without\s+metadata)\b/i.test(inner)) {
          errors.push(`${relSvg}: SVG <text> must not contain "no metadata" / "without metadata": "${inner}"`);
        }
      }
    }
  }

  // 5. Interrogatives in headings or table headers (README.md, docs/**/*.md)
  const interrogativeFiles = [path.join(root, "README.md"), ...docFiles];
  for (const f of interrogativeFiles) {
    if (fs.existsSync(f)) {
      const rel = path.relative(root, f).split(path.sep).join("/");
      checkInterrogatives(rel, fs.readFileSync(f, "utf8"), errors);
    }
  }

  // 6. Relative links and anchors check across README.md, AGENTS.md, docs/**, .agents/skills/**
  const linkCheckFiles = [];
  for (const base of ["README.md", "AGENTS.md"]) {
    const f = path.join(root, base);
    if (fs.existsSync(f)) linkCheckFiles.push(f);
  }
  linkCheckFiles.push(...docFiles);

  const skillsRoot = path.join(root, ".agents", "skills");
  if (fs.existsSync(skillsRoot)) {
    const scanSkills = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) scanSkills(full);
        else if (e.name.endsWith(".md")) linkCheckFiles.push(full);
      }
    };
    scanSkills(skillsRoot);
  }

  const anchorCache = new Map();
  function getCachedAnchors(filePath) {
    if (!anchorCache.has(filePath)) {
      anchorCache.set(filePath, getAnchors(filePath));
    }
    return anchorCache.get(filePath);
  }

  for (const file of linkCheckFiles) {
    const relFile = path.relative(root, file).split(path.sep).join("/");
    const content = fs.readFileSync(file, "utf8");
    const links = proseLinks(content);
    for (const link of links) {
      const raw = link.target.trim();
      if (/^(?:https?:\/\/|mailto:|javascript:)/i.test(raw)) {
        continue;
      }
      const [targetPath, anchor] = raw.split("#");
      const resolved = targetPath ? path.resolve(path.dirname(file), targetPath) : file;
      if (!fs.existsSync(resolved)) {
        errors.push(`${relFile}: broken relative link -> ${raw}`);
        continue;
      }
      if (anchor && resolved.endsWith(".md")) {
        const anchors = getCachedAnchors(resolved);
        if (!anchors.has(anchor)) {
          errors.push(`${relFile}: broken anchor #${anchor} in ${targetPath || relFile}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    mode,
    errors,
    warnings: mode === "report" ? errors : [],
    summary: `Checked ${docFiles.length} docs pages and ${linkCheckFiles.length} linked sources; ${errors.length} error(s).`
  };
}

function formatReportOutput(result) {
  const byFile = new Map();
  for (const err of result.errors) {
    const colonIdx = err.indexOf(":");
    const key = colonIdx !== -1 ? err.slice(0, colonIdx) : "general";
    if (!byFile.has(key)) {
      byFile.set(key, []);
    }
    byFile.get(key).push(err);
  }

  const lines = [];
  lines.push(`=== check-docs report (${result.errors.length} finding(s) across ${byFile.size} source(s)) ===`);
  for (const [fileKey, fileErrors] of byFile.entries()) {
    lines.push(`\n[${fileKey}] (${fileErrors.length})`);
    for (const item of fileErrors) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push(`\n${result.summary}`);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let mode = "strict";
  let repoRoot = process.cwd();
  for (const arg of args) {
    if (arg === "--report") {
      mode = "report";
    } else if (arg === "--strict") {
      mode = "strict";
    } else if (arg.startsWith("-")) {
      console.error(`Unknown CLI flag: ${arg} (supported flags: --strict, --report)`);
      process.exit(2);
    } else {
      repoRoot = arg;
    }
  }

  const result = checkDocs({ repoRoot, mode });
  if (mode === "report") {
    console.log(formatReportOutput(result));
    process.exit(0);
  }
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(err);
    }
    console.error(result.summary);
    process.exit(1);
  }
  console.log(result.summary);
  process.exit(0);
}
