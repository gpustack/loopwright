#!/usr/bin/env node
/* global console, process, Buffer */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const diagramsDir = path.join(REPO_ROOT, "docs", "assets", "diagrams");
const siteImagesDir = path.join(REPO_ROOT, "site", "assets", "images");
const logoPngPath = path.join(REPO_ROOT, "docs", "assets", "logo.png");

function loadLogoDataUri() {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sips")) {
    const tmpOut = path.join(os.tmpdir(), `lw-diagram-logo-${process.pid}.png`);
    try {
      execFileSync("/usr/bin/sips", ["-Z", "88", logoPngPath, "--out", tmpOut], {
        stdio: "ignore"
      });
      const bytes = fs.readFileSync(tmpOut);
      return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    } finally {
      fs.rmSync(tmpOut, { force: true });
    }
  }
  const bytes = fs.readFileSync(logoPngPath);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

const LOGO_DATA_URI = loadLogoDataUri();

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countWords(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter(token => /[A-Za-z0-9]/.test(token)).length;
}

const ALLOWED_MIXED_CASE = new Set(["GitHub", "macOS", "Loopwright", "Taskpack"]);

function assertCleanSvgText(diagramName, context, text) {
  if (/[[{}\]]/.test(text)) {
    throw new Error(`${diagramName} (${context}): forbidden [] or {} in "${text}"`);
  }
  if (/\$|\||->|--[a-z]|[A-Za-z0-9]_[A-Za-z0-9]/.test(text)) {
    throw new Error(`${diagramName} (${context}): forbidden code syntax in "${text}"`);
  }
  if (/\bno\s+metadata\b|\bwithout\s+metadata\b/i.test(text)) {
    throw new Error(`${diagramName} (${context}): forbidden "no metadata" in "${text}"`);
  }
  for (const rawWord of String(text).split(/[^A-Za-z0-9]+/)) {
    if (!rawWord || ALLOWED_MIXED_CASE.has(rawWord)) continue;
    if (/[a-z][A-Z]/.test(rawWord)) {
      throw new Error(`${diagramName} (${context}): forbidden camelCase/PascalCase identifier "${rawWord}" in "${text}"`);
    }
  }
}

function assertCardWordLimit(diagramName, cardLabel, parts) {
  for (const part of parts) {
    assertCleanSvgText(diagramName, cardLabel, part);
  }
  const total = countWords(parts.join(" "));
  if (total > 10) {
    throw new Error(`${diagramName} (${cardLabel}): card has ${total} words (max 10): "${parts.join(" | ")}"`);
  }
}

function renderLogoBadge(x, y, size, rx) {
  const pad = Math.round(size * 0.08);
  const inner = size - pad * 2;
  return [
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}" fill="#ffffff" stroke="var(--line)" stroke-width="1.2"/>`,
    `<use href="#lw-logo" x="${x + pad}" y="${y + pad}" width="${inner}" height="${inner}"/>`
  ].join("");
}

function renderIcon(kind, x, y, colorVar) {
  switch (kind) {
    case "shield":
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M${x + 12} ${y}l9 3.5v6.2c0 5.3-3.8 9.4-9 11.3-5.2-1.9-9-6-9-11.3V${y + 3.5}z"/><path d="M${x + 8.5} ${y + 10.5}l2.5 2.5 5-5"/></g>`;
    case "chip":
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.6"><rect x="${x}" y="${y + 1}" width="24" height="19" rx="4"/><rect x="${x + 6}" y="${y + 5.5}" width="12" height="10" rx="2"/><path d="M${x - 3} ${y + 7}h3m-3 7h3m24-7h3m-3 7h3"/></g>`;
    case "lock":
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.7" stroke-linecap="round"><rect x="${x + 3}" y="${y + 9}" width="18" height="12" rx="3"/><path d="M${x + 7.5} ${y + 9}V${y + 5.5}a4.5 4.5 0 0 1 9 0V${y + 9}"/><circle cx="${x + 12}" cy="${y + 15}" r="1.5" fill="var(${colorVar})"/></g>`;
    case "check":
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="${x + 2}" y="${y + 1}" width="20" height="19" rx="4"/><path d="M${x + 7.5} ${y + 10.8}l3.2 3.2 6-6.4"/></g>`;
    case "git":
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.7" stroke-linecap="round"><circle cx="${x + 6}" cy="${y + 5}" r="2.6"/><circle cx="${x + 6}" cy="${y + 16.5}" r="2.6"/><circle cx="${x + 18}" cy="${y + 10.5}" r="2.6"/><path d="M${x + 6} ${y + 7.6}v6.3M${x + 8.6} ${y + 5.5}c4.5 0 5.5 5 6.8 5"/></g>`;
    case "layers":
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.6" stroke-linejoin="round"><path d="M${x + 12} ${y + 1}l10 5-10 5-10-5z"/><path d="M${x + 2} ${y + 11}l10 5 10-5"/><path d="M${x + 2} ${y + 16}l10 5 10-5"/></g>`;
    case "radar":
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.6" stroke-linecap="round"><circle cx="${x + 12}" cy="${y + 10.5}" r="9"/><circle cx="${x + 12}" cy="${y + 10.5}" r="4"/><path d="M${x + 12} ${y + 10.5}l6.2-6.2"/></g>`;
    default:
      return `<g fill="none" stroke="var(${colorVar})" stroke-width="1.6"><rect x="${x + 2}" y="${y + 1}" width="20" height="19" rx="4"/><path d="M${x + 7} ${y + 8}l3.5 3-3.5 3m5.5 0h4.5"/></g>`;
  }
}

function renderBlueprintSvg(spec) {
  for (const field of [
    spec.kicker,
    spec.title,
    spec.subtitle,
    spec.topSectionLabel,
    spec.topContainerTitle,
    spec.hubTitle,
    spec.hubSubtitle,
    spec.hubDetail,
    spec.bottomSectionLabel,
    spec.footnote,
    ...spec.pills
  ]) {
    assertCleanSvgText(spec.filename, "header/hub", field);
  }

  const width = 1200;
  const height = 870;
  const wireXs = spec.cards.length === 5 ? [138, 369, 600, 831, 1062] : [180, 456, 744, 1020];

  const topDomainsHtml = spec.domains
    .map((dom, dIdx) => {
      assertCleanSvgText(spec.filename, `domain-${dIdx}`, dom.title);
      const dx = dIdx === 0 ? 50 : 602;
      const cardsHtml = dom.items
        .map((it, iIdx) => {
          assertCardWordLimit(spec.filename, `domain-${dIdx}-card-${iIdx}`, [
            it.kicker,
            it.head,
            it.note
          ]);
          const ix = dx + 16 + iIdx * 266;
          return [
            `<rect class="box" x="${ix}" y="220" width="250" height="90" rx="8"/>`,
            `<text class="detail" x="${ix + 14}" y="243">${esc(it.kicker)}</text>`,
            `<text class="cardhead" x="${ix + 14}" y="268">${esc(it.head)}</text>`,
            `<text class="small" x="${ix + 14}" y="293">${esc(it.note)}</text>`
          ].join("");
        })
        .join("");
      return [
        `<rect class="tint" x="${dx}" y="183" width="548" height="143" rx="10"/>`,
        `<text class="ct" x="${dx + 16}" y="207">${esc(dom.title)}</text>`,
        cardsHtml
      ].join("");
    })
    .join("");

  const wiresHtml = wireXs
    .map((wx, idx) => {
      const b1 = (-idx * 0.37).toFixed(2);
      const b2 = (-(idx * 0.37 + 0.74)).toFixed(2);
      return [
        `<path class="wire" d="M ${wx} 326 L ${wx} 416"/>`,
        `<circle class="dot" r="3.5"><animateMotion path="M ${wx} 326 L ${wx} 416" dur="2.6s" begin="${b1}s" repeatCount="indefinite"/></circle>`,
        `<path class="wire" d="M ${wx} 540 L ${wx} 614"/>`,
        `<circle class="dot" r="3.5"><animateMotion path="M ${wx} 540 L ${wx} 614" dur="2.6s" begin="${b2}s" repeatCount="indefinite"/></circle>`
      ].join("");
    })
    .join("");

  const cardCount = spec.cards.length;
  const cardGap = cardCount === 5 ? 19 : 16;
  const cardWidth = cardCount === 5 ? 212 : 272;

  const bottomCardsHtml = spec.cards
    .map((card, idx) => {
      assertCardWordLimit(spec.filename, `stage-card-${idx}`, [
        card.title,
        card.line1,
        card.line2
      ]);
      const cx = 32 + idx * (cardWidth + cardGap);
      return [
        `<rect class="box" x="${cx}" y="614" width="${cardWidth}" height="136" rx="12"/>`,
        `<rect x="${cx}" y="626" width="4" height="112" rx="2" fill="var(${card.accent})"/>`,
        renderIcon(card.icon, cx + 16, 632, card.accent),
        `<text class="ct" x="${cx + 48}" y="648">${esc(card.title)}</text>`,
        `<text class="detail" x="${cx + 18}" y="684">${esc(card.line1)}</text>`,
        `<text class="detail" x="${cx + 18}" y="707">${esc(card.line2)}</text>`
      ].join("");
    })
    .join("");

  const pillsHtml = spec.pills
    .map((pill, idx) => {
      const px = 32 + idx * 384;
      return [
        `<rect class="box" x="${px}" y="802" width="368" height="42" rx="10"/>`,
        `<circle cx="${px + 20}" cy="823" r="5.5" fill="none" stroke="var(--emerald)" stroke-width="1.6"/>`,
        `<circle cx="${px + 20}" cy="823" r="2.5" fill="var(--emerald)"/>`,
        `<text class="pill" x="${px + 36}" y="827.5">${esc(pill)}</text>`
      ].join("");
    })
    .join("");

  const topBannerLabelWidth = Math.max(240, spec.topSectionLabel.length * 8.2 + 22);
  const bottomBannerLabelWidth = Math.max(240, spec.bottomSectionLabel.length * 8.2 + 22);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${esc(spec.title)}</title>
<desc id="desc">${esc(spec.subtitle)} — ${esc(spec.footnote)}</desc>
<style>
:root{color-scheme:light dark;--bg:#f8fbff;--card:#fff;--ink:#12233d;--muted:#52677f;--line:#c9d9e7;--indigo:#5B4B9E;--blue:#2563eb;--purple:#7c3aed;--teal:#3B8EA5;--amber:#D89B48;--emerald:#059669;--soft:#edf5fc;--grid:#dfeaf3}
@media(prefers-color-scheme:dark){:root{--bg:#101d30;--card:#1a2c43;--ink:#f1f6ff;--muted:#bdcde0;--line:#526b83;--indigo:#b5a6f5;--blue:#80adff;--purple:#c4a4ff;--teal:#6cd0e8;--amber:#ffc273;--emerald:#5ce2af;--soft:#213b55;--grid:#29425b}}
text{font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;fill:var(--ink)}
.title{font-size:29px;font-weight:750;letter-spacing:-.4px}
.sub{font-size:14px;fill:var(--muted)}
.label{font-size:12px;font-weight:700;letter-spacing:1.2px;fill:var(--muted)}
.ct{font-size:15px;font-weight:700}
.cardhead{font-size:13.5px;font-weight:650}
.detail{font-size:12.5px;fill:var(--muted)}
.small{font-size:11.5px;fill:var(--muted)}
.box{fill:var(--card);stroke:var(--line);stroke-width:1.2}
.tint{fill:var(--soft);stroke:var(--line);stroke-width:1.1}
.wire{fill:none;stroke:var(--teal);stroke-width:2;stroke-dasharray:5 5;opacity:.85}
.dot{fill:var(--teal)}
.headline{font-size:16px;font-weight:750;letter-spacing:.35px}
.pill{font-size:12px;font-weight:650}
@media(prefers-reduced-motion:reduce){.dot{display:none}}
</style>
<defs>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M40 0H0V40" fill="none" stroke="var(--grid)" stroke-width="1"/>
  </pattern>
  <symbol id="lw-logo" viewBox="0 0 88 88">
    <image width="88" height="88" href="${LOGO_DATA_URI}"/>
  </symbol>
</defs>
<rect width="${width}" height="${height}" rx="16" fill="var(--bg)"/>
<rect width="${width}" height="${height}" rx="16" fill="url(#grid)" opacity=".65"/>
<text class="label" x="32" y="34">${esc(spec.kicker)}</text>
<text class="title" x="32" y="70">${esc(spec.title)}</text>
<text class="sub" x="32" y="94">${esc(spec.subtitle)}</text>
${renderLogoBadge(1126, 30, 42, 10)}
<rect x="28" y="114" width="${topBannerLabelWidth.toFixed(0)}" height="20" rx="3" fill="var(--bg)"/>
<text class="label" x="34" y="128">${esc(spec.topSectionLabel)}</text>
<rect class="box" x="32" y="144" width="1136" height="198" rx="15" style="stroke:var(${spec.topContainerAccent})"/>
<text class="ct" x="50" y="169">${esc(spec.topContainerTitle)}</text>
${topDomainsHtml}
${wiresHtml}
<rect class="box" x="32" y="416" width="1136" height="124" rx="16" style="stroke:var(${spec.hubAccent});stroke-width:1.8"/>
${renderLogoBadge(52, 434, 48, 11)}
<text class="headline" x="118" y="452">${esc(spec.hubTitle)}</text>
<text class="sub" x="118" y="478">${esc(spec.hubSubtitle)}</text>
<text class="detail" x="118" y="505">${esc(spec.hubDetail)}</text>
<rect x="28" y="580" width="${bottomBannerLabelWidth.toFixed(0)}" height="20" rx="3" fill="var(--bg)"/>
<text class="label" x="34" y="594">${esc(spec.bottomSectionLabel)}</text>
${bottomCardsHtml}
<text class="small" x="33" y="780">${esc(spec.footnote)}</text>
${pillsHtml}
</svg>
`;
}

const DIAGRAMS = [
  {
    filename: "architecture-flow.svg",
    copyToSiteAssets: true,
    kicker: "LOOPWRIGHT  /  ARCHITECTURE OVERVIEW",
    title: "Bounded, Verified Work",
    subtitle: "Two operating modes share fenced state, sandbox isolation, and independent verification",
    topSectionLabel: "OPERATING MODES  ·  TASKPACK  AND  MANAGED CONTROLLER",
    topContainerAccent: "--indigo",
    topContainerTitle: "AUTHORING AND INTAKE SURFACES",
    domains: [
      {
        title: "DECLARATIVE TASKPACK  ·  Simple Mode",
        items: [
          { kicker: "TASKPACK", head: "taskpack.yaml", note: "Defines scope and checks" },
          { kicker: "ENTRY POINT", head: "GitHub Action or App", note: "Compiles execution plan" }
        ]
      },
      {
        title: "MANAGED CONTROLLER  ·  Governance Mode",
        items: [
          { kicker: "TRUSTED REGISTRY", head: "registry.yaml", note: "Pins approved handlers" },
          { kicker: "RUN CONFIG", head: "controller.yaml", note: "Binds task and registry" }
        ]
      }
    ],
    hubAccent: "--teal",
    hubTitle: "FENCED CONTROL PLANE & ISOLATED RUNTIME",
    hubSubtitle: "SQLite Lease Fence  ·  Monotonic Clock Guard  ·  Isolated Pi Session  ·  Advisory Router",
    hubDetail: "Reserves hard budgets before dispatch and scrubs credentials from outputs",
    bottomSectionLabel: "EXECUTION CHAIN  ·  01 ADMIT  →  02 EXECUTE  →  03 VERIFY  →  04 PUBLISH",
    cards: [
      {
        accent: "--indigo",
        icon: "lock",
        title: "01 · Admit",
        line1: "Validate contract scope",
        line2: "Acquire fenced lease"
      },
      {
        accent: "--teal",
        icon: "chip",
        title: "02 · Execute",
        line1: "Run sandboxed session",
        line2: "Route optional advice"
      },
      {
        accent: "--amber",
        icon: "check",
        title: "03 · Verify",
        line1: "Evaluate clean checkout",
        line2: "Collect signed receipts"
      },
      {
        accent: "--emerald",
        icon: "git",
        title: "04 · Publish",
        line1: "Open verified pull request",
        line2: "Propose memory separately"
      }
    ],
    footnote: "Protected repository paths remain read-only across every execution stage.",
    pills: [
      "Independent gate receipts",
      "Fenced state and clock guards",
      "Zero blind retry on unknown effects"
    ]
  },
  {
    filename: "taskpack-sync-flow.svg",
    kicker: "LOOPWRIGHT  /  DECLARATIVE TASKPACK",
    title: "Repository Taskpack Pipeline",
    subtitle: "Author one Taskpack file while the host compiles contracts, digests, and secret bindings",
    topSectionLabel: "DECLARATIVE INPUTS  ·  UPSTREAMS  +  TASKPACK  →  COMPILER",
    topContainerAccent: "--indigo",
    topContainerTitle: "REPOSITORY INTENT  ·  taskpack.yaml",
    domains: [
      {
        title: "UPSTREAM WATCH  ·  Drift Discovery",
        items: [
          { kicker: "RELEASES & TAGS", head: "GitHub releases and tags", note: "Tracks upstream versions" },
          { kicker: "COMMITS & FEEDS", head: "Commits and JSON feeds", note: "Monitors watched paths" }
        ]
      },
      {
        title: "SCOPE & MODELS  ·  Safety Bounds",
        items: [
          { kicker: "PATH SCOPE", head: "Writable and protected", note: "Masks policy files" },
          { kicker: "MODEL POOL", head: "Ordered model list", note: "Rotates on quota limits" }
        ]
      }
    ],
    hubAccent: "--blue",
    hubTitle: "DECLARATIVE TASKPACK COMPILER",
    hubSubtitle: "Task Contract  ·  Trusted Registry Digests  ·  Controller Config  ·  Secret Scrubber",
    hubDetail: "Generates owner-only files outside the checkout with unexpanded secret templates",
    bottomSectionLabel: "EXECUTION & SETTLEMENT  ·  DISCOVER  →  AUTHOR  →  VERIFY  →  SETTLE",
    cards: [
      {
        accent: "--indigo",
        icon: "radar",
        title: "01 · Discover",
        line1: "Check trigger rules",
        line2: "Skip unchanged work"
      },
      {
        accent: "--teal",
        icon: "chip",
        title: "02 · Author",
        line1: "Edit writable paths",
        line2: "Write proposal file"
      },
      {
        accent: "--amber",
        icon: "check",
        title: "03 · Verify",
        line1: "Check schema and scope",
        line2: "Verify gate verdicts"
      },
      {
        accent: "--emerald",
        icon: "git",
        title: "04 · Settle",
        line1: "Open pinned pull request",
        line2: "Propose memory updates"
      }
    ],
    footnote: "Run in dry-run mode on pull requests to validate compilation before live dispatch.",
    pills: [
      "Single Taskpack configuration file",
      "Automatic handler digest pinning",
      "Ordered model quota fallback"
    ]
  },
  {
    filename: "managed-controller-flow.svg",
    kicker: "LOOPWRIGHT  /  MANAGED CONTROLLER",
    title: "Managed Controller Lifecycle",
    subtitle: "Separate operator-owned registry digests from task contracts and manage runs via the CLI",
    topSectionLabel: "SEPARATION OF DUTIES  ·  TRUST DIRECTORY  ↔  OPERATOR WORKSPACE",
    topContainerAccent: "--purple",
    topContainerTitle: "OPERATOR CONFIGURATION  ·  OUTSIDE TARGET REPOSITORY",
    domains: [
      {
        title: "TRUST STORE  ·  Operator Authority",
        items: [
          { kicker: "TRUSTED REGISTRY", head: "registry.yaml", note: "Pins handlers and runtimes" },
          { kicker: "DIGEST LOCK", head: "SHA-256 hash pin", note: "Verifies registry bytes" }
        ]
      },
      {
        title: "RUN WORKSPACE  ·  Execution Plan",
        items: [
          { kicker: "CONTROLLER", head: "controller.yaml", note: "Binds task and registry" },
          { kicker: "TASK CONTRACT", head: "Embedded task spec", note: "Defines steps and budgets" }
        ]
      }
    ],
    hubAccent: "--indigo",
    hubTitle: "BOUNDED CONTROLLER & LOCAL RUN STATE",
    hubSubtitle: "Trusted Config Loader  ·  Plan Compiler  ·  Credential Vault  ·  SQLite Run Store",
    hubDetail: "Resolves credentials strictly in memory and checkpoints every attempt and receipt",
    bottomSectionLabel: "OPERATOR WORKFLOW  ·  INIT  →  PIN  →  BIND  →  RUN  →  RECONCILE",
    cards: [
      {
        accent: "--indigo",
        icon: "layers",
        title: "01 · Init",
        line1: "Generate draft files",
        line2: "Outside target checkout"
      },
      {
        accent: "--teal",
        icon: "lock",
        title: "02 · Pin",
        line1: "Pin handler digests",
        line2: "Hash approved registry"
      },
      {
        accent: "--blue",
        icon: "chip",
        title: "03 · Bind",
        line1: "Bind task and profiles",
        line2: "Validate static plan"
      },
      {
        accent: "--amber",
        icon: "check",
        title: "04 · Run",
        line1: "Execute fenced steps",
        line2: "Reserve drain window"
      },
      {
        accent: "--emerald",
        icon: "git",
        title: "05 · Settle",
        line1: "Export evidence bundle",
        line2: "Reconcile pending receipts"
      }
    ],
    footnote: "Static plan checks perform zero network calls and zero run-state mutations.",
    pills: [
      "Registry stored outside repository",
      "Custom agent and check steps",
      "Crash resume and reconciliation"
    ]
  },
  {
    filename: "slash-command-flow.svg",
    kicker: "LOOPWRIGHT  /  GITHUB APP",
    title: "Authenticated GitHub Intake",
    subtitle: "Verify webhook signatures, authorize collaborators, fence tenant queues, and broker scoped tokens",
    topSectionLabel: "INBOUND EVENTS  ·  SLASH COMMANDS  &  REPOSITORY TRIGGERS",
    topContainerAccent: "--blue",
    topContainerTitle: "EVENT SOURCES  ·  COLLABORATORS & REPOSITORY AUTOMATION",
    domains: [
      {
        title: "SLASH COMMANDS  ·  Issue & PR Comments",
        items: [
          { kicker: "RETRY & STATUS", head: "Queue control", note: "Inspect or rerun tasks" },
          { kicker: "REVISION", head: "Guided revision", note: "Passes bounded feedback" }
        ]
      },
      {
        title: "AUTOMATED EVENTS  ·  Schedules & Releases",
        items: [
          { kicker: "RELEASE & CRON", head: "Scheduled triggers", note: "Checks upstream drift" },
          { kicker: "MANUAL RUN", head: "Workflow dispatch", note: "Supports dry-run checks" }
        ]
      }
    ],
    hubAccent: "--indigo",
    hubTitle: "GITHUB APP CONTROL PLANE",
    hubSubtitle: "HMAC Webhook Verifier  ·  Delivery Store  ·  Tenant Queue  ·  Token Broker",
    hubDetail: "Deduplicates deliveries, verifies write access, and mints single-repo tokens",
    bottomSectionLabel: "INTAKE PIPELINE  ·  SIGNATURE  →  AUTHORIZE  →  ENQUEUE  →  BROKER",
    cards: [
      {
        accent: "--indigo",
        icon: "shield",
        title: "01 · Signature",
        line1: "Verify webhook HMAC",
        line2: "Reject tampered payloads"
      },
      {
        accent: "--teal",
        icon: "check",
        title: "02 · Authorize",
        line1: "Verify write permission",
        line2: "Enforce trigger policy"
      },
      {
        accent: "--amber",
        icon: "layers",
        title: "03 · Enqueue",
        line1: "Isolate tenant queue",
        line2: "Fence stale workers"
      },
      {
        accent: "--emerald",
        icon: "lock",
        title: "04 · Broker",
        line1: "Scope repo token",
        line2: "Scrub token bytes"
      }
    ],
    footnote: "GitHub Action mode needs no server; the GitHub App daemon is optional.",
    pills: [
      "Constant-time signature verification",
      "Lease-fenced tenant queues",
      "Single-repository token scope"
    ]
  },
  {
    filename: "sandbox-backends-flow.svg",
    kicker: "LOOPWRIGHT  /  SANDBOX BACKENDS",
    title: "Fail-Closed Sandbox Negotiation",
    subtitle: "Match isolation requirements against verified host backends before launching any agent subprocess",
    topSectionLabel: "SANDBOX POLICY  ·  FILESYSTEM, NETWORK & PROCESS ISOLATION",
    topContainerAccent: "--teal",
    topContainerTitle: "ISOLATION REQUIREMENTS  ·  TASKPACK SANDBOX POLICY",
    domains: [
      {
        title: "FILESYSTEM  ·  Read & Write Masks",
        items: [
          { kicker: "PATH ACCESS", head: "Writable and denied", note: "Blocks host credentials" },
          { kicker: "READ-ONLY MASKS", head: "Protected overrides", note: "Shields workflow files" }
        ]
      },
      {
        title: "NETWORK & EXEC  ·  Socket & Process Rules",
        items: [
          { kicker: "SOCKET POLICY", head: "Network disabled default", note: "Optional loopback or outbound" },
          { kicker: "PROCESS HYGIENE", head: "Process tree cleanup", note: "Reaps child processes" }
        ]
      }
    ],
    hubAccent: "--teal",
    hubTitle: "SANDBOX CAPABILITY NEGOTIATOR",
    hubSubtitle: "Backend Priority Order  ·  Binary Verification  ·  Capability Proof  ·  Fail-Closed Guard",
    hubDetail: "Refuses execution immediately when no available backend satisfies every required capability",
    bottomSectionLabel: "EXECUTION BACKENDS  ·  PRIORITY PROBE ORDER",
    cards: [
      {
        accent: "--indigo",
        icon: "shield",
        title: "macOS Seatbelt",
        line1: "Kernel sandbox profiles",
        line2: "Path and network masks"
      },
      {
        accent: "--teal",
        icon: "layers",
        title: "Linux Bubblewrap",
        line1: "Mount and net namespaces",
        line2: "Seccomp syscall filter"
      },
      {
        accent: "--blue",
        icon: "lock",
        title: "Linux Landlock",
        line1: "Unprivileged filesystem rules",
        line2: "No-new-privileges guard"
      },
      {
        accent: "--amber",
        icon: "chip",
        title: "Docker & Dedicated",
        line1: "Verified container digest",
        line2: "Explicit dedicated opt-in"
      }
    ],
    footnote: "Local tests verify profile generation; production hosts require live OS qualification.",
    pills: [
      "Network disabled by default",
      "Kernel protected path masks",
      "Zero silent unsandboxed fallback"
    ]
  },
  {
    filename: "decision-routing-flow.svg",
    kicker: "LOOPWRIGHT  /  DECISION ROUTING",
    title: "Advisory Decision Routing",
    subtitle: "Route bounded non-authority triage across three confidence zones with strict outbound redaction",
    topSectionLabel: "POLICY & DISCLOSURE  ·  OPT-IN, REDACTION & AUTHORITY GUARD",
    topContainerAccent: "--amber",
    topContainerTitle: "DECISION POLICY  ·  decisions.yaml",
    domains: [
      {
        title: "DISCLOSURE BOUNDARY  ·  Payload Scrubbing",
        items: [
          { kicker: "SAFE DEFAULT", head: "Public metadata tier", note: "Excludes raw source code" },
          { kicker: "REDACTED TIER", head: "Approved evidence", note: "Scrubs secret tokens" }
        ]
      },
      {
        title: "AUTHORITY GUARD  ·  Non-Delegable Rules",
        items: [
          { kicker: "RESERVED GATES", head: "Gates, scope, leases", note: "Never delegated outward" },
          { kicker: "BOUNDED CALLS", head: "Deadline and attempts", note: "Caps latency and retries" }
        ]
      }
    ],
    hubAccent: "--amber",
    hubTitle: "CALIBRATED DECISION ROUTER",
    hubSubtitle: "Payload Sanitizer  ·  Multi-Provider Adapters  ·  Confidence Thresholds  ·  Fallback Policy",
    hubDetail: "Evaluates calibrated confidence against policy thresholds without granting gate authority",
    bottomSectionLabel: "CONFIDENCE ZONES  ·  ACT  ·  CONFIRM  ·  ESCALATE  ·  FALLBACK",
    cards: [
      {
        accent: "--emerald",
        icon: "check",
        title: "Act Zone",
        line1: "High calibrated confidence",
        line2: "Accepts bounded advice"
      },
      {
        accent: "--teal",
        icon: "radar",
        title: "Confirm Zone",
        line1: "Moderate confidence score",
        line2: "Requests conservative check"
      },
      {
        accent: "--amber",
        icon: "shield",
        title: "Escalate Zone",
        line1: "Low confidence score",
        line2: "Uses deterministic rules"
      },
      {
        accent: "--indigo",
        icon: "lock",
        title: "Timeout Fallback",
        line1: "Enforces hard deadline",
        line2: "Retains unknown usage"
      }
    ],
    footnote: "Advisory models never approve verification gates, expand writable scope, or override leases.",
    pills: [
      "Advisory triage without gate power",
      "Three calibrated confidence zones",
      "Deterministic offline fallback"
    ]
  },
  {
    filename: "reconcile-closure-flow.svg",
    kicker: "LOOPWRIGHT  /  RECOVERY & CLOSURE",
    title: "Recovery and Capability Closure",
    subtitle: "Preserve uncertain external effects without blind retries and audit the capability ledger",
    topSectionLabel: "RUN EVIDENCE  ·  CHECKPOINTS & UNCERTAIN EXTERNAL EFFECTS",
    topContainerAccent: "--purple",
    topContainerTitle: "LOCAL RUN STATE  ·  FENCED SQLITE STORE",
    domains: [
      {
        title: "FENCED CHECKPOINTS  ·  Local State",
        items: [
          { kicker: "INSPECTION", head: "Redacted run bundles", note: "Shows leases and usage" },
          { kicker: "CONTINUATION", head: "Crash-safe resume", note: "Verifies matching digests" }
        ]
      },
      {
        title: "UNCERTAIN EFFECTS  ·  External Settlement",
        items: [
          { kicker: "UNKNOWN STATE", head: "Halts blind retry", note: "Awaits operator check" },
          { kicker: "SIGNED PROOF", head: "Publication receipt", note: "Proves remote outcome" }
        ]
      }
    ],
    hubAccent: "--emerald",
    hubTitle: "RECONCILIATION & CLOSURE AUDITOR",
    hubSubtitle: "Bundle Inspector  ·  Signed Receipt Verifier  ·  Capability Ledger  ·  Failure Matrix",
    hubDetail: "Settles external receipts idempotently and verifies local failure-injection scenarios",
    bottomSectionLabel: "SETTLEMENT & AUDIT  ·  INSPECT  →  RECONCILE  →  VERIFY  →  QUALIFY",
    cards: [
      {
        accent: "--indigo",
        icon: "layers",
        title: "01 · Inspect",
        line1: "Export redacted checkpoints",
        line2: "Preserve active leases"
      },
      {
        accent: "--teal",
        icon: "lock",
        title: "02 · Reconcile",
        line1: "Verify receipt signature",
        line2: "Settle outcome once"
      },
      {
        accent: "--emerald",
        icon: "check",
        title: "03 · Local Audit",
        line1: "Verify capability ledger",
        line2: "Run failure matrix"
      },
      {
        accent: "--amber",
        icon: "shield",
        title: "04 · Live Gaps",
        line1: "Report external blockers",
        line2: "Separate host qualification"
      }
    ],
    footnote: "Conflicting receipts are refused and never overwrite an already settled outcome.",
    pills: [
      "Idempotent receipt reconciliation",
      "Deterministic failure matrix",
      "Honest local vs live evidence"
    ]
  }
];

function renderControllerRelationsSvg() {
  const diagramName = "managed-controller-relations.svg";
  const width = 1200;
  const height = 910;

  const taskCards = [
    { x: 66, y: 224, kicker: "ROLES", head: "Agent persona", note: "Model and tool list" },
    { x: 336, y: 224, kicker: "WORKFLOW", head: "Step graph", note: "Author then verify" },
    { x: 66, y: 326, kicker: "BOUNDS", head: "Scope and budgets", note: "Paths, time, and calls" },
    { x: 336, y: 326, kicker: "CONTEXT", head: "Pinned files", note: "Read-only file digests" }
  ];

  const bridgeCards = [
    { x: 626, y: 224, kicker: "REGISTRY PIN", head: "Name and SHA-256", note: "Locks approved registry" },
    { x: 892, y: 224, kicker: "ROLE MAP", head: "Role to profile", note: "Selects runtime profile" },
    { x: 626, y: 326, kicker: "STEP MAP", head: "Step to handler", note: "Selects handler code" },
    { x: 892, y: 326, kicker: "CREDENTIALS", head: "Secrets and endpoints", note: "Binds vault and PRs" }
  ];

  for (const [idx, c] of [...taskCards, ...bridgeCards].entries()) {
    assertCardWordLimit(diagramName, `inner-card-${idx}`, [c.kicker, c.head, c.note]);
  }

  const renderInnerCard = (c, w) =>
    [
      `<rect class="box" x="${c.x}" y="${c.y}" width="${w}" height="88" rx="8"/>`,
      `<text class="detail" x="${c.x + 14}" y="${c.y + 23}">${esc(c.kicker)}</text>`,
      `<text class="cardhead" x="${c.x + 14}" y="${c.y + 48}">${esc(c.head)}</text>`,
      `<text class="small" x="${c.x + 14}" y="${c.y + 72}">${esc(c.note)}</text>`
    ].join("");

  const wires = [
    { x: 180, label: "Context digests", begin: "0s" },
    { x: 468, label: "Step handlers", begin: "-0.45s" },
    { x: 748, label: "Registry SHA-256", begin: "-0.9s" },
    { x: 1020, label: "Role credentials", begin: "-1.35s" }
  ];

  for (const w of wires) {
    assertCleanSvgText(diagramName, "wire-label", w.label);
  }

  const wiresHtml = wires
    .map(w =>
      [
        `<path class="wire" d="M ${w.x} 444 L ${w.x} 562"/>`,
        `<circle class="dot" r="3.5"><animateMotion path="M ${w.x} 444 L ${w.x} 562" dur="2.6s" begin="${w.begin}" repeatCount="indefinite"/></circle>`,
        `<rect x="${w.x - 72}" y="491" width="144" height="22" rx="6" class="box"/>`,
        `<text class="small" x="${w.x}" y="506" text-anchor="middle">${esc(w.label)}</text>`
      ].join("")
    )
    .join("");

  const regCards = [
    {
      accent: "--indigo",
      icon: "chip",
      title: "Role Profiles",
      line1: "Pins provider and limits",
      line2: "Binds container runtime"
    },
    {
      accent: "--teal",
      icon: "check",
      title: "Handlers",
      line1: "Pins code digests",
      line2: "Binds checks and gates"
    },
    {
      accent: "--amber",
      icon: "lock",
      title: "Credentials",
      line1: "Approves target paths",
      line2: "Resolves secrets in memory"
    },
    {
      accent: "--emerald",
      icon: "git",
      title: "Resources & Endpoints",
      line1: "Verifies context digests",
      line2: "Pins gate and PR URLs"
    }
  ];

  const regCardsHtml = regCards
    .map((card, idx) => {
      assertCardWordLimit(diagramName, `registry-card-${idx}`, [
        card.title,
        card.line1,
        card.line2
      ]);
      const cx = 50 + idx * 278;
      return [
        `<rect class="box" x="${cx}" y="618" width="266" height="140" rx="12"/>`,
        `<rect x="${cx}" y="630" width="4" height="116" rx="2" fill="var(${card.accent})"/>`,
        renderIcon(card.icon, cx + 16, 636, card.accent),
        `<text class="ct" x="${cx + 48}" y="652">${esc(card.title)}</text>`,
        `<text class="detail" x="${cx + 18}" y="688">${esc(card.line1)}</text>`,
        `<text class="detail" x="${cx + 18}" y="711">${esc(card.line2)}</text>`
      ].join("");
    })
    .join("");

  const pills = [
    "Containment: Controller embeds Task Contract",
    "Association: Refs bind Trusted Registry",
    "Isolation: Registry stays outside repository"
  ];
  for (const pill of pills) {
    assertCleanSvgText(diagramName, "pill", pill);
  }

  const pillsHtml = pills
    .map((pill, idx) => {
      const px = 32 + idx * 384;
      return [
        `<rect class="box" x="${px}" y="846" width="368" height="42" rx="10"/>`,
        `<circle cx="${px + 20}" cy="867" r="5.5" fill="none" stroke="var(--emerald)" stroke-width="1.6"/>`,
        `<circle cx="${px + 20}" cy="867" r="2.5" fill="var(--emerald)"/>`,
        `<text class="pill" x="${px + 36}" y="871.5">${esc(pill)}</text>`
      ].join("");
    })
    .join("");

  const headerTexts = [
    "LOOPWRIGHT  /  CONFIGURATION TOPOLOGY",
    "Managed Controller Configuration Relationships",
    "Controller Config embeds a Task Contract and binds an out-of-repo Trusted Registry by name and SHA-256",
    "CONTAINMENT & COMPOSITION  ·  OPERATOR WORKSPACE",
    "Controller Config  ·  controller.yaml",
    "EMBEDDED TASK CONTRACT  ·  Contained Child Spec",
    "REFERENCE & POLICY BRIDGE  ·  Registry & Profile Bindings",
    "ASSOCIATED AUTHORITY STORE  ·  SEPARATE TRUST DIRECTORY",
    "Trusted Registry  ·  registry.yaml",
    "Optional Decision Policy (decisions.yaml) adds advisory triage; SQLite state stays in the local run root."
  ];
  for (const t of headerTexts) {
    assertCleanSvgText(diagramName, "header", t);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Managed Controller Configuration Relationships</title>
<desc id="desc">Containment, composition, and cross-reference bindings across Controller Config, embedded Task Contract, and out-of-repo Trusted Registry.</desc>
<style>
:root{color-scheme:light dark;--bg:#f8fbff;--card:#fff;--ink:#12233d;--muted:#52677f;--line:#c9d9e7;--indigo:#5B4B9E;--blue:#2563eb;--purple:#7c3aed;--teal:#3B8EA5;--amber:#D89B48;--emerald:#059669;--soft:#edf5fc;--grid:#dfeaf3}
@media(prefers-color-scheme:dark){:root{--bg:#101d30;--card:#1a2c43;--ink:#f1f6ff;--muted:#bdcde0;--line:#526b83;--indigo:#b5a6f5;--blue:#80adff;--purple:#c4a4ff;--teal:#6cd0e8;--amber:#ffc273;--emerald:#5ce2af;--soft:#213b55;--grid:#29425b}}
text{font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;fill:var(--ink)}
.title{font-size:29px;font-weight:750;letter-spacing:-.4px}
.sub{font-size:14px;fill:var(--muted)}
.label{font-size:12px;font-weight:700;letter-spacing:1.2px;fill:var(--muted)}
.ct{font-size:15px;font-weight:700}
.cardhead{font-size:13.5px;font-weight:650}
.detail{font-size:12.5px;fill:var(--muted)}
.small{font-size:11.5px;fill:var(--muted)}
.box{fill:var(--card);stroke:var(--line);stroke-width:1.2}
.tint{fill:var(--soft);stroke:var(--line);stroke-width:1.1}
.wire{fill:none;stroke:var(--teal);stroke-width:2;stroke-dasharray:5 5;opacity:.85}
.dot{fill:var(--teal)}
.headline{font-size:16px;font-weight:750;letter-spacing:.35px}
.pill{font-size:12px;font-weight:650}
@media(prefers-reduced-motion:reduce){.dot{display:none}}
</style>
<defs>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M40 0H0V40" fill="none" stroke="var(--grid)" stroke-width="1"/>
  </pattern>
  <symbol id="lw-logo" viewBox="0 0 88 88">
    <image width="88" height="88" href="${LOGO_DATA_URI}"/>
  </symbol>
</defs>
<rect width="${width}" height="${height}" rx="16" fill="var(--bg)"/>
<rect width="${width}" height="${height}" rx="16" fill="url(#grid)" opacity=".65"/>
<text class="label" x="32" y="34">LOOPWRIGHT  /  CONFIGURATION TOPOLOGY</text>
<text class="title" x="32" y="70">Managed Controller Configuration Relationships</text>
<text class="sub" x="32" y="94">Controller Config embeds a Task Contract and binds an out-of-repo Trusted Registry by name and SHA-256</text>
${renderLogoBadge(1126, 30, 42, 10)}

<rect x="28" y="114" width="465" height="20" rx="3" fill="var(--bg)"/>
<text class="label" x="34" y="128">CONTAINMENT &amp; COMPOSITION  ·  OPERATOR WORKSPACE</text>
<rect class="box" x="32" y="144" width="1136" height="300" rx="15" style="stroke:var(--indigo);stroke-width:1.6"/>
<text class="ct" x="50" y="170">Controller Config  ·  controller.yaml</text>

<rect class="tint" x="50" y="186" width="552" height="242" rx="10"/>
<text class="ct" x="66" y="210">EMBEDDED TASK CONTRACT  ·  Contained Child Spec</text>
${taskCards.map(c => renderInnerCard(c, 252)).join("")}

<rect class="tint" x="612" y="186" width="538" height="242" rx="10"/>
<text class="ct" x="628" y="210">REFERENCE &amp; POLICY BRIDGE  ·  Registry &amp; Profile Bindings</text>
${bridgeCards.map(c => renderInnerCard(c, 244)).join("")}

${wiresHtml}

<rect x="28" y="534" width="540" height="20" rx="3" fill="var(--bg)"/>
<text class="label" x="34" y="548">ASSOCIATED AUTHORITY STORE  ·  SEPARATE TRUST DIRECTORY</text>
<rect class="box" x="32" y="562" width="1136" height="216" rx="16" style="stroke:var(--teal);stroke-width:1.8"/>
<text class="ct" x="50" y="592">Trusted Registry  ·  registry.yaml</text>
${regCardsHtml}

<text class="small" x="33" y="820">Optional Decision Policy (decisions.yaml) adds advisory triage; SQLite state stays in the local run root.</text>
${pillsHtml}
</svg>
`;
}

function renderHardwareRelayFlowSvg() {
  const diagramName = "hardware-relay-flow.svg";
  const width = 1200;
  const height = 1036;

  const headerTexts = [
    "LOOPWRIGHT  /  HARDWARE RUNNER",
    "Hardware Relay and Network Boundaries",
    "Three isolated network zones separate control plane credentials, relay DMZ routing, and private GPU clusters",
    "ZONE 1  ·  CONTROL PLANE ZONE  ·  OUTBOUND HTTPS ONLY",
    "SIGNED BENCHMARK SUBMISSION  ·  LOCAL CLI OR GITHUB ACTIONS",
    "OUTBOUND HTTPS ONLY  ·  HMAC JOB SUBMIT  ·  NO WORKER TOKENS",
    "ZONE 2  ·  RELAY DMZ BOUNDARY  ·  HTTPS & CREDENTIAL ISOLATION",
    "HARDWARE RELAY & CAS HUB  ·  RELAY DMZ",
    "HTTPS Endpoint  ·  HMAC Auth  ·  Monotonic Lease Fence  ·  1 MB CAS Store",
    "Separates controller signing secrets from worker bearer tokens across distinct endpoints",
    "CLUSTER FIREWALL  ·  ZERO INBOUND PORTS  ·  WORKER PULLS OVER HTTPS",
    "ZONE 3  ·  PRIVATE GPU CLUSTER ZONE  ·  OUTBOUND PULL & OFFLINE SANDBOX",
    "OFFLINE DOCKER SANDBOX  ·  ZERO NETWORK",
    "GPU hosts open zero inbound ports and hold no signing secrets; controllers never read held-out suites."
  ];
  for (const t of headerTexts) {
    assertCleanSvgText(diagramName, "header/boundary", t);
  }

  const domains = [
    {
      title: "CAMPAIGN CLIENTS  ·  Job Producers",
      items: [
        { kicker: "LOCAL CLI", head: "Evolution campaigns", note: "Dispatches candidate jobs" },
        { kicker: "CI WORKFLOW", head: "GitHub Actions", note: "Runs with read scope" }
      ]
    },
    {
      title: "SIGNED PAYLOAD  ·  Controller Secret",
      items: [
        { kicker: "BENCHMARK JOB", head: "Target pool routing", note: "Matches GPU capabilities" },
        { kicker: "HMAC SECRET", head: "Controller signing key", note: "Authenticates verdict receipts" }
      ]
    }
  ];

  const topDomainsHtml = domains
    .map((dom, dIdx) => {
      assertCleanSvgText(diagramName, `domain-${dIdx}`, dom.title);
      const dx = dIdx === 0 ? 50 : 602;
      const cardsHtml = dom.items
        .map((it, iIdx) => {
          assertCardWordLimit(diagramName, `domain-${dIdx}-card-${iIdx}`, [
            it.kicker,
            it.head,
            it.note
          ]);
          const ix = dx + 16 + iIdx * 266;
          return [
            `<rect class="box" x="${ix}" y="214" width="250" height="86" rx="8"/>`,
            `<text class="detail" x="${ix + 14}" y="236">${esc(it.kicker)}</text>`,
            `<text class="cardhead" x="${ix + 14}" y="261">${esc(it.head)}</text>`,
            `<text class="small" x="${ix + 14}" y="285">${esc(it.note)}</text>`
          ].join("");
        })
        .join("");
      return [
        `<rect class="tint" x="${dx}" y="178" width="548" height="138" rx="10"/>`,
        `<text class="ct" x="${dx + 16}" y="201">${esc(dom.title)}</text>`,
        cardsHtml
      ].join("");
    })
    .join("");

  const wireXs = [179, 453, 727, 1001];
  const topWiresHtml = wireXs
    .map((wx, idx) => {
      const b1 = (-idx * 0.37).toFixed(2);
      return [
        `<path class="wire" d="M ${wx} 330 L ${wx} 442"/>`,
        `<circle class="dot" r="3.5"><animateMotion path="M ${wx} 330 L ${wx} 442" dur="2.6s" begin="${b1}s" repeatCount="indefinite"/></circle>`
      ].join("");
    })
    .join("");

  const bottomWiresHtml = wireXs
    .map((wx, idx) => {
      const b2 = (-(idx * 0.37 + 0.74)).toFixed(2);
      return [
        `<path class="wire" d="M ${wx} 560 L ${wx} 676"/>`,
        `<circle class="dot" r="3.5"><animateMotion path="M ${wx} 560 L ${wx} 676" dur="2.6s" begin="${b2}s" repeatCount="indefinite"/></circle>`
      ].join("");
    })
    .join("");

  const stageCards = [
    {
      accent: "--indigo",
      icon: "radar",
      title: "01 · Worker Pull",
      line1: "Zero inbound GPU ports",
      line2: "Polls leases outbound"
    },
    {
      accent: "--teal",
      icon: "layers",
      title: "02 · Build Audit",
      line1: "Offline zero-network compile",
      line2: "Checks forbidden symbols"
    },
    {
      accent: "--amber",
      icon: "chip",
      title: "03 · GPU Bench",
      line1: "Zero-network Docker sandbox",
      line2: "Mounts holdout read-only"
    },
    {
      accent: "--emerald",
      icon: "shield",
      title: "04 · Verdict Receipt",
      line1: "Returns signed HMAC",
      line2: "Backs archive export"
    }
  ];

  const stageCardsHtml = stageCards
    .map((card, idx) => {
      assertCardWordLimit(diagramName, `stage-card-${idx}`, [
        card.title,
        card.line1,
        card.line2
      ]);
      const cx = 50 + idx * 274;
      return [
        `<rect class="box" x="${cx}" y="732" width="258" height="148" rx="12"/>`,
        `<rect x="${cx}" y="744" width="4" height="124" rx="2" fill="var(${card.accent})"/>`,
        renderIcon(card.icon, cx + 16, 750, card.accent),
        `<text class="ct" x="${cx + 48}" y="766">${esc(card.title)}</text>`,
        `<text class="detail" x="${cx + 18}" y="804">${esc(card.line1)}</text>`,
        `<text class="detail" x="${cx + 18}" y="828">${esc(card.line2)}</text>`
      ].join("");
    })
    .join("");

  const pills = [
    "Zone 1 to DMZ: outbound HTTPS job submit",
    "Cluster firewall: zero inbound GPU ports",
    "Stage A and B: offline zero-network Docker"
  ];
  for (const pill of pills) {
    assertCleanSvgText(diagramName, "pill", pill);
  }

  const pillsHtml = pills
    .map((pill, idx) => {
      const px = 32 + idx * 384;
      return [
        `<rect class="box" x="${px}" y="968" width="368" height="42" rx="10"/>`,
        `<circle cx="${px + 20}" cy="989" r="5.5" fill="none" stroke="var(--emerald)" stroke-width="1.6"/>`,
        `<circle cx="${px + 20}" cy="989" r="2.5" fill="var(--emerald)"/>`,
        `<text class="pill" x="${px + 36}" y="993.5">${esc(pill)}</text>`
      ].join("");
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Hardware Relay and Network Boundaries</title>
<desc id="desc">Three isolated network zones: Control Plane outbound HTTPS submit, Relay DMZ hub, and Private GPU Cluster behind a zero-inbound-ports firewall with offline zero-network Docker sandboxes.</desc>
<style>
:root{color-scheme:light dark;--bg:#f8fbff;--card:#fff;--ink:#12233d;--muted:#52677f;--line:#c9d9e7;--indigo:#5B4B9E;--blue:#2563eb;--purple:#7c3aed;--teal:#3B8EA5;--amber:#D89B48;--emerald:#059669;--soft:#edf5fc;--grid:#dfeaf3}
@media(prefers-color-scheme:dark){:root{--bg:#101d30;--card:#1a2c43;--ink:#f1f6ff;--muted:#bdcde0;--line:#526b83;--indigo:#b5a6f5;--blue:#80adff;--purple:#c4a4ff;--teal:#6cd0e8;--amber:#ffc273;--emerald:#5ce2af;--soft:#213b55;--grid:#29425b}}
text{font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;fill:var(--ink)}
.title{font-size:29px;font-weight:750;letter-spacing:-.4px}
.sub{font-size:14px;fill:var(--muted)}
.label{font-size:12px;font-weight:700;letter-spacing:1.2px;fill:var(--muted)}
.ct{font-size:15px;font-weight:700}
.cardhead{font-size:13.5px;font-weight:650}
.detail{font-size:12.5px;fill:var(--muted)}
.small{font-size:11.5px;fill:var(--muted)}
.box{fill:var(--card);stroke:var(--line);stroke-width:1.2}
.tint{fill:var(--soft);stroke:var(--line);stroke-width:1.1}
.wire{fill:none;stroke:var(--teal);stroke-width:2;stroke-dasharray:5 5;opacity:.85}
.barrier{fill:none;stroke:var(--blue);stroke-width:1.8;stroke-dasharray:7 5;opacity:.85}
.firewall{fill:none;stroke:var(--amber);stroke-width:2.2;stroke-dasharray:8 5;opacity:.95}
.sandbox{fill:var(--soft);stroke:var(--amber);stroke-width:1.5;stroke-dasharray:6 4}
.badge{font-size:11.5px;font-weight:700;letter-spacing:.7px;fill:var(--ink)}
.dot{fill:var(--teal)}
.headline{font-size:16px;font-weight:750;letter-spacing:.35px}
.pill{font-size:12px;font-weight:650}
@media(prefers-reduced-motion:reduce){.dot{display:none}}
</style>
<defs>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M40 0H0V40" fill="none" stroke="var(--grid)" stroke-width="1"/>
  </pattern>
  <symbol id="lw-logo" viewBox="0 0 88 88">
    <image width="88" height="88" href="${LOGO_DATA_URI}"/>
  </symbol>
</defs>
<rect width="${width}" height="${height}" rx="16" fill="var(--bg)"/>
<rect width="${width}" height="${height}" rx="16" fill="url(#grid)" opacity=".65"/>
<text class="label" x="32" y="34">LOOPWRIGHT  /  HARDWARE RUNNER</text>
<text class="title" x="32" y="70">Hardware Relay and Network Boundaries</text>
<text class="sub" x="32" y="94">Three isolated network zones separate control plane credentials, relay DMZ routing, and private GPU clusters</text>
${renderLogoBadge(1126, 30, 42, 10)}

<rect x="28" y="114" width="465" height="20" rx="3" fill="var(--bg)"/>
<text class="label" x="34" y="128">ZONE 1  ·  CONTROL PLANE ZONE  ·  OUTBOUND HTTPS ONLY</text>
<rect class="box" x="32" y="142" width="1136" height="188" rx="15" style="stroke:var(--indigo);stroke-width:1.6"/>
<text class="ct" x="50" y="166">SIGNED BENCHMARK SUBMISSION  ·  LOCAL CLI OR GITHUB ACTIONS</text>
${topDomainsHtml}

${topWiresHtml}
<line class="barrier" x1="32" y1="376" x2="1168" y2="376"/>
<rect class="box" x="330" y="362" width="540" height="28" rx="8" style="stroke:var(--blue);stroke-width:1.5"/>
<text class="badge" x="600" y="380" text-anchor="middle">OUTBOUND HTTPS ONLY  ·  HMAC JOB SUBMIT  ·  NO WORKER TOKENS</text>

<rect x="28" y="414" width="525" height="20" rx="3" fill="var(--bg)"/>
<text class="label" x="34" y="428">ZONE 2  ·  RELAY DMZ BOUNDARY  ·  HTTPS &amp; CREDENTIAL ISOLATION</text>
<rect class="box" x="32" y="442" width="1136" height="118" rx="16" style="stroke:var(--teal);stroke-width:1.8"/>
${renderLogoBadge(52, 460, 48, 11)}
<text class="headline" x="118" y="478">HARDWARE RELAY &amp; CAS HUB  ·  RELAY DMZ</text>
<text class="sub" x="118" y="504">HTTPS Endpoint  ·  HMAC Auth  ·  Monotonic Lease Fence  ·  1 MB CAS Store</text>
<text class="detail" x="118" y="530">Separates controller signing secrets from worker bearer tokens across distinct endpoints</text>

${bottomWiresHtml}
<line class="firewall" x1="32" y1="616" x2="1168" y2="616"/>
<rect class="box" x="295" y="601" width="610" height="30" rx="8" style="stroke:var(--amber);stroke-width:1.8"/>
<text class="badge" x="600" y="620" text-anchor="middle">CLUSTER FIREWALL  ·  ZERO INBOUND PORTS  ·  WORKER PULLS OVER HTTPS</text>

<rect x="28" y="648" width="615" height="20" rx="3" fill="var(--bg)"/>
<text class="label" x="34" y="662">ZONE 3  ·  PRIVATE GPU CLUSTER ZONE  ·  OUTBOUND PULL &amp; OFFLINE SANDBOX</text>
<rect class="box" x="32" y="676" width="1136" height="238" rx="16" style="stroke:var(--emerald);stroke-width:1.7"/>
<rect class="sandbox" x="312" y="694" width="556" height="202" rx="12"/>
<text class="badge" x="590" y="716" text-anchor="middle">OFFLINE DOCKER SANDBOX  ·  ZERO NETWORK</text>
${stageCardsHtml}

<text class="small" x="33" y="944">GPU hosts open zero inbound ports and hold no signing secrets; controllers never read held-out suites.</text>
${pillsHtml}
</svg>
`;
}

for (const spec of DIAGRAMS) {
  const svg = renderBlueprintSvg(spec);
  const outPath = path.join(diagramsDir, spec.filename);
  fs.writeFileSync(outPath, svg, "utf8");
  if (spec.copyToSiteAssets) {
    fs.writeFileSync(path.join(siteImagesDir, spec.filename), svg, "utf8");
  }
}

fs.writeFileSync(
  path.join(diagramsDir, "managed-controller-relations.svg"),
  renderControllerRelationsSvg(),
  "utf8"
);

fs.writeFileSync(
  path.join(diagramsDir, "hardware-relay-flow.svg"),
  renderHardwareRelayFlowSvg(),
  "utf8"
);

console.log(`Generated ${DIAGRAMS.length + 2} gpustack-style blueprint SVG diagrams.`);
