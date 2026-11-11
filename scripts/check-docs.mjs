#!/usr/bin/env node
/* global process, console */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INTERROGATIVES = /\b(what|where|when|how|which|why|who|whose|whom)\b/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LINK = /!?\[([^\]\n]*)\]\(([^)\n]+)\)/g;

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
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
        continue;
      }
      if (stripped.startsWith("<!--")) {
        if (!line.includes("-->")) {
          comment = true;
        }
        continue;
      }
      let match;
      const re = new RegExp(LINK.source, "g");
      while ((match = re.exec(line)) !== null) {
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
      if (marker[1][0] === "`" && line.slice(marker[0].length).includes("`")) {
        // inline prose
      } else {
        fence = marker[1];
        continue;
      }
    } else if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) {
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const text = headingMatch[1];
      if (INTERROGATIVES.test(text)) {
        errors.push(`${filePath}:${i + 1}: heading must not use interrogative words: "${text}"`);
      }
    }
    if (i + 1 < lines.length && line.startsWith("|") && line.endsWith("|")) {
      const nextLine = lines[i + 1].trim();
      if (/^\|(\s*:?-+:?\s*\|)+$/.test(nextLine)) {
        const cells = line.split("|").slice(1, -1);
        for (const cell of cells) {
          if (INTERROGATIVES.test(cell)) {
            errors.push(`${filePath}:${i + 1}: table header must not use interrogative words: "${cell.trim()}"`);
          }
        }
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

export function checkDocs(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);
  const docsDir = path.join(root, "docs");
  const indexFile = path.join(docsDir, "README.md");
  const errors = [];

  if (!fs.existsSync(indexFile)) {
    return { ok: false, errors: [`${indexFile} does not exist`] };
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

    if (allPagesEntries.length !== 21) {
      errors.push(`All pages expected 21 entries, found ${allPagesEntries.length}`);
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
    const relDoc = path.relative(root, docFile);
    const content = fs.readFileSync(docFile, "utf8");
    const lines = content.split("\n");

    checkProseHtml(content, relDoc, errors);

    if (docFile === indexFile) {
      continue;
    }

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
      for (let i = contentsIdx + 1; i < lines.length; i++) {
        const l = lines[i];
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

    // Page shape: **See also** footer
    if (!content.includes("**See also**")) {
      errors.push(`${relDoc}: missing "**See also**" footer`);
    }

    // Architecture specific check
    if (relDoc === "docs/getting-started/architecture.md") {
      if (lines.length > 200) {
        errors.push(`${relDoc}: line count exceeds 200 lines (${lines.length})`);
      }
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
  }

  // 5. Interrogatives in headings or table headers (README.md, docs/**/*.md)
  const interrogativeFiles = [path.join(root, "README.md"), ...docFiles];
  for (const f of interrogativeFiles) {
    if (fs.existsSync(f)) {
      checkInterrogatives(path.relative(root, f), fs.readFileSync(f, "utf8"), errors);
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
    const relFile = path.relative(root, file);
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
    errors,
    summary: `Checked ${docFiles.length} docs pages and ${linkCheckFiles.length} linked sources; ${errors.length} error(s).`
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkDocs(process.argv[2]);
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
