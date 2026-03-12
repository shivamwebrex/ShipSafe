/**
 * ShipSafe Refine v2
 *
 * Takes your raw messy prompt, reads your codebase graph,
 * finds the relevant files, and produces a refined structured
 * prompt with full project context.
 *
 * Usage:
 *   node refine.js "fix my jobworker thing"
 *   node refine.js --graph ceo-graph.json "fix the payment flow"
 *   node refine.js --graph ./path/to/any-graph.json "your question"
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_FILE_CHARS = 1500;
const MAX_RELEVANT_FILES = 4;
const TMP_PROMPT = path.join(process.cwd(), "_shipsafe_tmp.txt");

// ─── Parse Arguments ───────────────────────────────────────────────────────
// Supports:
//   node refine.js "question"
//   node refine.js --graph ceo-graph.json "question"
const args = process.argv.slice(2);
let graphFlag = null;
const rawInputArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--graph" && args[i + 1]) {
    graphFlag = args[++i];
  } else {
    rawInputArgs.push(args[i]);
  }
}

const rawInput = rawInputArgs.join(" ").trim();

// Auto-detect graph file
const GRAPH_PATH = (() => {
  if (graphFlag) return path.resolve(graphFlag);
  const candidates = [
    path.join(process.cwd(), "graph.json"),
    path.join(process.cwd(), "server-graph.json"),
    path.join(process.cwd(), "codebase-graph.json"),
  ];
  return candidates.find(p => fs.existsSync(p)) || path.join(process.cwd(), "graph.json");
})();

// ─── Validate ──────────────────────────────────────────────────────────────
if (!rawInput) {
  console.log(`
ShipSafe Refine v2
──────────────────────────────────────────
Usage:
  node refine.js "your question here"
  node refine.js --graph ceo-graph.json "your question"

Examples:
  node refine.js "fix my jobworker it breaks with multiple jobs"
  node refine.js "add a download route"
  node refine.js "uploadFile is slow fix it"
  node refine.js --graph ceo-graph.json "fix the payment flow"
`);
  process.exit(0);
}

if (!fs.existsSync(GRAPH_PATH)) {
  console.error(`
Error: Graph file not found: ${GRAPH_PATH}

Run the parser first:
  node parser.js ./your-project --output graph.json

Or specify a graph file:
  node refine.js --graph path/to/graph.json "your question"
`);
  process.exit(1);
}

// ─── Load Graph ────────────────────────────────────────────────────────────
console.log(`\nShipSafe Refine`);
console.log(`──────────────────────────────────────────`);
console.log(`Question: "${rawInput}"`);
console.log(`Graph:    ${path.basename(GRAPH_PATH)}`);
console.log(`──────────────────────────────────────────`);

const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8"));
const { nodes, edges, meta } = graph;

// ─── Find Relevant Files ───────────────────────────────────────────────────
function findRelevantFiles(input) {
  const inputLower = input.toLowerCase();
  const words = inputLower.split(/\s+/).filter(w => w.length > 2);

  const fileNodes = nodes.filter(n => n.type === "file");
  const fnNodes = nodes.filter(n => ["function", "method"].includes(n.type));

  // Find files that contain relevant functions
  const relevantFnFiles = new Set();
  for (const fn of fnNodes) {
    const fnText = `${fn.label} ${fn.ai_summary || ""} ${fn.ai_purpose || ""}`.toLowerCase();
    for (const word of words) {
      if (fnText.includes(word)) {
        relevantFnFiles.add(fn.filePath);
        break;
      }
    }
  }

  const scored = fileNodes.map(n => {
    let score = 0;
    const fileLower = n.filePath.toLowerCase();
    const summaryLower = (n.ai_summary || "").toLowerCase();
    const purposeLower = (n.ai_purpose || "").toLowerCase();

    // Direct word match against file path and AI summary
    for (const word of words) {
      if (fileLower.includes(word)) score += 5;
      if (summaryLower.includes(word)) score += 3;
      if (purposeLower.includes(word)) score += 2;
    }

    // Boost if one of its functions matched
    if (relevantFnFiles.has(n.filePath)) score += 4;

    // Boost files connected via imports to already-relevant files
    const connected = edges
      .filter(e => e.type === "IMPORTS" && (e.from === n.id || e.to === n.id))
      .map(e => e.from === n.id ? e.to : e.from);

    for (const connId of connected) {
      const connNode = nodes.find(x => x.id === connId);
      if (connNode) {
        const connText = `${connNode.filePath} ${connNode.ai_summary || ""}`.toLowerCase();
        for (const word of words) {
          if (connText.includes(word)) { score += 1; break; }
        }
      }
    }

    return { node: n, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(s => s.score > 0)
    .slice(0, MAX_RELEVANT_FILES)
    .map(s => s.node);
}

// ─── Read Actual File Code ─────────────────────────────────────────────────
function readFileCode(node) {
  const candidates = [
    path.join(meta.targetDirectory, node.filePath),
    path.join(process.cwd(), "..", node.filePath),
    path.join(process.cwd(), node.filePath),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf8");
      return content.length > MAX_FILE_CHARS
        ? content.substring(0, MAX_FILE_CHARS) + "\n... (truncated)"
        : content;
    }
  }
  return null;
}

// ─── Build Context (focused on relevant files only) ───────────────────────
function buildContext(relevantFiles) {
  const relevantPaths = new Set(relevantFiles.map(f => f.filePath));

  // Also include files directly connected to relevant files
  const connectedPaths = new Set(relevantPaths);
  for (const e of edges.filter(e => e.type === "IMPORTS")) {
    const from = nodes.find(n => n.id === e.from);
    const to = nodes.find(n => n.id === e.to);
    if (from && to) {
      if (relevantPaths.has(from.filePath)) connectedPaths.add(to.filePath);
      if (relevantPaths.has(to.filePath)) connectedPaths.add(from.filePath);
    }
  }

  // Project overview - all files, mark relevant ones with *
  const overviewLines = nodes
    .filter(n => n.type === "file")
    .map(n => {
      const purpose = n.ai_purpose ? `[${n.ai_purpose}]` : "";
      const summary = n.ai_summary ? `→ ${n.ai_summary}` : "";
      const marker = relevantPaths.has(n.filePath) ? "* " : "  ";
      return `${marker}${n.filePath} ${purpose} ${summary}`;
    });

  // Functions only from relevant + connected files
  const fnLines = nodes
    .filter(n => ["function", "method"].includes(n.type) && connectedPaths.has(n.filePath))
    .map(n => {
      const c = n.ai_complexity ? `[${n.ai_complexity}]` : "";
      const r = n.ai_risk ? `[${n.ai_risk} risk]` : "";
      const s = n.ai_summary ? `→ ${n.ai_summary}` : "";
      return `  ${n.label} in ${n.filePath} ${c} ${r} ${s}`;
    });

  // Relationships between relevant + connected files only
  const relLines = edges
    .filter(e => e.type === "IMPORTS")
    .map(e => {
      const from = nodes.find(n => n.id === e.from);
      const to = nodes.find(n => n.id === e.to);
      if (!from || !to) return null;
      if (!connectedPaths.has(from.filePath) && !connectedPaths.has(to.filePath)) return null;
      return `  ${from.filePath} → ${to.filePath}`;
    })
    .filter(Boolean);

  return { overviewLines, fnLines, relLines };
}

// ─── Main ──────────────────────────────────────────────────────────────────
console.log(`Finding relevant files...`);
let relevantFiles = findRelevantFiles(rawInput);

if (relevantFiles.length === 0) {
  console.log(`No specific files matched. Using top files for context.`);
  relevantFiles = nodes.filter(n => n.type === "file").slice(0, 4);
}

console.log(`Found ${relevantFiles.length} relevant files:`);
relevantFiles.forEach(f => console.log(`  - ${f.filePath}`));
console.log(`Reading source code...`);

// Build code blocks for relevant files
const codeBlocks = relevantFiles
  .map(node => {
    const code = readFileCode(node);
    if (!code) return null;
    const header = [
      `--- ${node.filePath} ---`,
      node.ai_summary ? `// ${node.ai_summary}` : "",
    ].filter(Boolean).join("\n");
    return `${header}\n\n${code}`;
  })
  .filter(Boolean);

const { overviewLines, fnLines, relLines } = buildContext(relevantFiles);

// ─── Build Meta Prompt ─────────────────────────────────────────────────────
const metaPrompt = `You are an expert software engineering prompt engineer.

A developer gave you this raw request:
"${rawInput}"

Below is the full context of their codebase. Files marked with * are most relevant.

PROJECT OVERVIEW:
${overviewLines.join("\n")}

FUNCTIONS IN RELEVANT FILES:
${fnLines.length > 0 ? fnLines.join("\n") : "  (none detected)"}

FILE RELATIONSHIPS:
${relLines.length > 0 ? relLines.join("\n") : "  (none detected)"}

ACTUAL CODE FROM RELEVANT FILES:
${codeBlocks.length > 0 ? codeBlocks.join("\n\n") : "(source files not readable - use summaries above)"}

YOUR TASK:
Transform the developer's raw request into a refined, structured, expert-level prompt.

The refined prompt must:
1. Start with "You are a senior [language] engineer working on this specific codebase."
2. Include a CONTEXT section with the relevant files and how they connect
3. Include the ACTUAL CODE of the relevant files inline
4. Include a clear PROBLEM STATEMENT expanding on what the developer means
5. List the most likely causes or areas to investigate
6. End with a structured TASK with numbered steps
7. Include CONSTRAINTS matching the existing code style

Output ONLY the refined prompt. No explanation. No preamble. No markdown fences.
Start directly with "You are a senior..."`;

// ─── Call Claude via stdin ─────────────────────────────────────────────────
console.log(`Refining with Claude...\n`);

try {
  fs.writeFileSync(TMP_PROMPT, metaPrompt, "utf8");

  const result = spawnSync("claude", ["-p", "-"], {
    input: metaPrompt,
    timeout: 120000,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    shell: true,
  });

  if (result.error) throw result.error;

  const refined = (result.stdout || "").trim();

  if (!refined || refined.length < 50) {
    throw new Error("Claude returned empty or invalid response");
  }

  const outputFile = path.join(process.cwd(), "refined-prompt.txt");
  fs.writeFileSync(outputFile, refined, "utf8");

  console.log(`──────────────────────────────────────────`);
  console.log(`REFINED PROMPT:`);
  console.log(`──────────────────────────────────────────\n`);
  console.log(refined);
  console.log(`\n──────────────────────────────────────────`);
  console.log(`Saved to: refined-prompt.txt`);
  console.log(`Copy that file and paste into Claude.`);
  console.log(`──────────────────────────────────────────\n`);

} catch (err) {
  console.error(`Error: ${err.message}`);
  console.log(`\nMake sure Claude CLI is installed: claude -p "hello"`);
} finally {
  try { fs.unlinkSync(TMP_PROMPT); } catch {}
}