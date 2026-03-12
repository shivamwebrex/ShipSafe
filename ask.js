/**
 * ShipSafe Ask - Context-Aware Coding Assistant
 *
 * Uses your codebase graph + actual file code to answer questions
 * with full awareness of your specific project.
 *
 * Usage:
 *   node ask.js "how do i add a new route?"
 *   node ask.js "where is authentication handled?"
 *   node ask.js "how should i add error handling to uploadFile?"
 *
 * Requirements:
 *   - graph.json must exist in the same folder (run parser.js first)
 *   - Claude CLI must be installed (claude -p works in terminal)
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// ─── Config ────────────────────────────────────────────────────────────────
const GRAPH_PATH = path.join(process.cwd(), "server-graph.json");
const TMP_PROMPT = path.join(process.cwd(), "_ask_prompt.txt");
const MAX_FILE_SIZE = 1500;   // max chars to read per file
const MAX_FILES_FULL = 8;     // max files to include full code for

// ─── Validate ──────────────────────────────────────────────────────────────
const question = process.argv.slice(2).join(" ").trim();

if (!question) {
  console.log(`
ShipSafe Ask — Context-Aware Coding Assistant
─────────────────────────────────────────────
Usage:
  node ask.js "your question here"

Examples:
  node ask.js "how do i add a new route?"
  node ask.js "where is auth handled?"
  node ask.js "how should i structure a new service?"
  node ask.js "what does uploadFile do and how can i improve it?"
`);
  process.exit(0);
}

if (!fs.existsSync(GRAPH_PATH)) {
  console.error(`
Error: graph.json not found.
Run the parser first:
  node parser.js ../your-project --output graph.json
`);
  process.exit(1);
}

// ─── Load Graph ────────────────────────────────────────────────────────────
console.log(`\nShipSafe Ask`);
console.log(`─────────────────────────────────────────────`);
console.log(`Question: "${question}"`);
console.log(`─────────────────────────────────────────────`);
console.log(`Loading codebase context...`);

const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8"));
const { nodes, edges, meta } = graph;

// ─── Build Context ─────────────────────────────────────────────────────────

// 1. Architecture summary - all nodes with their AI summaries
function buildArchitectureSummary() {
  const lines = [];

  // Files
  const fileNodes = nodes.filter(n => n.type === "file");
  lines.push("FILES IN THIS PROJECT:");
  for (const n of fileNodes) {
    const summary = n.ai_summary ? ` → ${n.ai_summary}` : "";
    const purpose = n.ai_purpose ? ` [${n.ai_purpose}]` : "";
    lines.push(`  ${n.filePath}${purpose}${summary}`);
  }

  // Functions and methods
  const codeNodes = nodes.filter(n => ["function", "method", "class"].includes(n.type));
  if (codeNodes.length > 0) {
    lines.push("\nFUNCTIONS AND METHODS:");
    for (const n of codeNodes) {
      const summary = n.ai_summary ? ` → ${n.ai_summary}` : "";
      const complexity = n.ai_complexity ? ` [${n.ai_complexity} complexity]` : "";
      const risk = n.ai_risk ? ` [${n.ai_risk} risk]` : "";
      lines.push(`  ${n.label} in ${n.filePath}${complexity}${risk}${summary}`);
    }
  }

  return lines.join("\n");
}

// 2. Relationships - how files connect
function buildRelationships() {
  const lines = ["FILE RELATIONSHIPS (imports and dependencies):"];
  const importEdges = edges.filter(e => e.type === "IMPORTS");

  for (const e of importEdges) {
    const fromNode = nodes.find(n => n.id === e.from);
    const toNode = nodes.find(n => n.id === e.to);
    if (fromNode && toNode) {
      lines.push(`  ${fromNode.filePath} imports ${toNode.filePath}`);
    }
  }

  return lines.join("\n");
}

// 3. Actual file code - read real source files for deeper context
function buildActualCode() {
  const lines = ["ACTUAL CODE FROM KEY FILES:"];

  const fileNodes = nodes.filter(n => n.type === "file");

  // Prioritize files that seem most relevant based on question keywords
  const questionLower = question.toLowerCase();
  const scored = fileNodes.map(n => {
    let score = 0;
    const fileLower = n.filePath.toLowerCase();
    const summaryLower = (n.ai_summary || "").toLowerCase();
    const purposeLower = (n.ai_purpose || "").toLowerCase();

    // Score based on keyword match with question
    const questionWords = questionLower.split(/\s+/).filter(w => w.length > 3);
    for (const word of questionWords) {
      if (fileLower.includes(word)) score += 3;
      if (summaryLower.includes(word)) score += 2;
      if (purposeLower.includes(word)) score += 1;
    }

    // Always prioritize controllers, routes, services
    if (fileLower.includes("controller")) score += 2;
    if (fileLower.includes("route")) score += 2;
    if (fileLower.includes("service")) score += 2;
    if (fileLower.includes("middleware")) score += 1;

    return { node: n, score };
  });

  // Sort by relevance score, take top MAX_FILES_FULL
  scored.sort((a, b) => b.score - a.score);
  const topFiles = scored.slice(0, MAX_FILES_FULL);

  let filesRead = 0;
  for (const { node } of topFiles) {
    try {
      // Try to find the actual file
      const possiblePaths = [
        path.join(meta.targetDirectory, node.filePath),
        path.join(process.cwd(), "..", node.filePath),
        path.join(process.cwd(), node.filePath),
      ];

      let content = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          content = fs.readFileSync(p, "utf8").substring(0, MAX_FILE_SIZE);
          break;
        }
      }

      if (content) {
        lines.push(`\n--- ${node.filePath} ---`);
        lines.push(content);
        if (content.length >= MAX_FILE_SIZE) lines.push("... (truncated)");
        filesRead++;
      }
    } catch {
      // Skip unreadable files silently
    }
  }

  if (filesRead === 0) {
    lines.push("(Could not read source files directly - using summaries only)");
  }

  return lines.join("\n");
}

// ─── Assemble Full Prompt ──────────────────────────────────────────────────
console.log(`Reading source files...`);

const architectureSummary = buildArchitectureSummary();
const relationships = buildRelationships();
const actualCode = buildActualCode();

const fullPrompt = `You are a senior software engineer helping a developer understand and work on their codebase.

You have FULL context of this project. Here is everything you need to know:

=== PROJECT OVERVIEW ===
Total files: ${nodes.filter(n => n.type === "file").length}
Total functions: ${nodes.filter(n => n.type === "function").length}
Parser: ${meta.parser}

=== ${architectureSummary}

=== ${relationships}

=== ${actualCode}

=== DEVELOPER'S QUESTION ===
${question}

Instructions:
- Answer specifically for THIS codebase, not generically
- Reference actual file names, function names from this project
- If suggesting code, match the style and patterns already used in this project
- Be concise but complete
- If you see potential issues or improvements related to the question, mention them`;

// ─── Send to Claude ────────────────────────────────────────────────────────
console.log(`Asking Claude...\n`);
console.log(`─────────────────────────────────────────────`);

try {
  fs.writeFileSync(TMP_PROMPT, fullPrompt, "utf8");

  const result = execSync(`type _ask_prompt.txt | claude -p -`, {
    timeout: 60000,
    encoding: "utf8",
    windowsHide: true,
    cwd: process.cwd(),
    shell: "cmd.exe",
    maxBuffer: 10 * 1024 * 1024,
  });

  console.log(result.trim());
  console.log(`\n─────────────────────────────────────────────\n`);

} catch (err) {
  // Fallback if pipe doesn't work
  try {
    const escapedPath = TMP_PROMPT.replace(/\\/g, "\\\\");
    const result = execSync(`claude -p "Please read and answer the question from context provided" < "${escapedPath}"`, {
      timeout: 60000,
      encoding: "utf8",
      windowsHide: true,
      cwd: process.cwd(),
      shell: "cmd.exe",
      maxBuffer: 10 * 1024 * 1024,
    });
    console.log(result.trim());
    console.log(`\n─────────────────────────────────────────────\n`);
  } catch (err2) {
    console.error("Error calling Claude:", err2.message);
    console.log("\nTip: Make sure claude CLI is installed and you are logged in.");
    console.log("Test with: claude -p \"hello\"");
  }
} finally {
  try { fs.unlinkSync(TMP_PROMPT); } catch {}
}