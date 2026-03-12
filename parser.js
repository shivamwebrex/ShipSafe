/**
 * ShipSafe Parser v0.2 - AI Enriched
 * 
 * Parses a TypeScript/JavaScript codebase, builds a semantic graph,
 * then enriches every node with AI summaries using Claude CLI.
 * 
 * Usage:
 *   node parser.js ./path/to/your/project
 *   node parser.js ./path/to/your/project --output ./my-graph.json
 *   node parser.js ./path/to/your/project --no-ai   (skip AI enrichment)
 */

const { Project, SyntaxKind } = require("ts-morph");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// ─── Config ────────────────────────────────────────────────────────────────
const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const outputArg = process.argv.indexOf("--output");
const outputPath = outputArg !== -1
  ? path.resolve(process.argv[outputArg + 1])
  : path.join(process.cwd(), "graph.json");
const skipAI = process.argv.includes("--no-ai");

console.log(`\nShipSafe Parser v0.2`);
console.log(`───────────────────────────────`);
console.log(`Target:  ${targetDir}`);
console.log(`Output:  ${outputPath}`);
console.log(`AI mode: ${skipAI ? "OFF (--no-ai)" : "ON (Claude CLI)"}`);
console.log(`───────────────────────────────\n`);

// ─── Setup ts-morph Project ────────────────────────────────────────────────
const project = new Project({
  compilerOptions: {
    allowJs: true,
    resolveJsonModule: true,
    esModuleInterop: true,
  },
  addFilesFromTsConfig: false,
});

function addFiles(dir) {
  const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next", "out"]);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) addFiles(path.join(dir, entry.name));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      project.addSourceFileAtPath(path.join(dir, entry.name));
    }
  }
}

addFiles(targetDir);
const sourceFiles = project.getSourceFiles();
console.log(`Found ${sourceFiles.length} source files\n`);

// ─── Graph Data Structures ─────────────────────────────────────────────────
const nodes = new Map();
const edges = [];

function addNode(id, label, type, filePath, extra = {}) {
  if (!nodes.has(id)) {
    nodes.set(id, {
      id, label, type,
      filePath: path.relative(targetDir, filePath),
      ...extra,
    });
  }
  return id;
}

function addEdge(from, to, type, confidence = 1.0) {
  const key = `${from}::${type}::${to}`;
  if (!edges.find(e => `${e.from}::${e.type}::${e.to}` === key)) {
    edges.push({ from, to, type, confidence });
  }
}

// ─── Parse Each File ───────────────────────────────────────────────────────
for (const sourceFile of sourceFiles) {
  const filePath = sourceFile.getFilePath();
  const relPath = path.relative(targetDir, filePath);
  const fileId = `file::${relPath}`;

  addNode(fileId, relPath.split("/").pop(), "file", filePath, { fullPath: relPath });

  // Classes
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() || "<anonymous>";
    const classId = `class::${relPath}::${className}`;

    addNode(classId, className, "class", filePath, {
      line: cls.getStartLineNumber(),
      rawCode: cls.getText().substring(0, 800),
    });
    addEdge(fileId, classId, "CONTAINS");

    const baseClass = cls.getBaseClass();
    if (baseClass) {
      const baseName = baseClass.getName?.() || "";
      if (baseName) {
        addNode(`class::${baseName}`, baseName, "class", filePath);
        addEdge(classId, `class::${baseName}`, "EXTENDS", 0.9);
      }
    }

    for (const impl of cls.getImplements()) {
      const implName = impl.getExpression().getText();
      addNode(`interface::${implName}`, implName, "interface", filePath);
      addEdge(classId, `interface::${implName}`, "IMPLEMENTS", 0.9);
    }

    for (const method of cls.getMethods()) {
      const methodName = method.getName();
      const methodId = `method::${relPath}::${className}::${methodName}`;

      addNode(methodId, `${className}.${methodName}()`, "method", filePath, {
        line: method.getStartLineNumber(),
        isAsync: method.isAsync(),
        returnType: method.getReturnType().getText().substring(0, 40),
        params: method.getParameters().map(p => ({
          name: p.getName(),
          type: p.getType().getText().substring(0, 30),
        })),
        rawCode: method.getText().substring(0, 600),
      });
      addEdge(classId, methodId, "HAS_METHOD");
    }
  }

  // Standalone Functions
  for (const fn of sourceFile.getFunctions()) {
    const fnName = fn.getName() || "<anonymous>";
    const fnId = `fn::${relPath}::${fnName}`;

    addNode(fnId, `${fnName}()`, "function", filePath, {
      line: fn.getStartLineNumber(),
      isAsync: fn.isAsync(),
      isExported: fn.isExported(),
      params: fn.getParameters().map(p => ({
        name: p.getName(),
        type: p.getType().getText().substring(0, 30),
      })),
      rawCode: fn.getText().substring(0, 600),
    });
    addEdge(fileId, fnId, "CONTAINS");
  }

  // Arrow functions
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const init = varDecl.getInitializer();
    if (init && (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression)) {
      const fnName = varDecl.getName();
      const fnId = `fn::${relPath}::${fnName}`;
      const isExported = varDecl.getVariableStatement()?.isExported?.() || false;

      addNode(fnId, `${fnName}()`, "function", filePath, {
        line: varDecl.getStartLineNumber(),
        isAsync: init.isAsync?.() || false,
        isExported,
        isArrow: true,
        rawCode: init.getText().substring(0, 600),
      });
      addEdge(fileId, fnId, "CONTAINS");
    }
  }

  // Interfaces
  for (const iface of sourceFile.getInterfaces()) {
    const ifaceName = iface.getName();
    const ifaceId = `interface::${relPath}::${ifaceName}`;

    addNode(ifaceId, ifaceName, "interface", filePath, {
      line: iface.getStartLineNumber(),
      isExported: iface.isExported(),
      rawCode: iface.getText().substring(0, 400),
    });
    addEdge(fileId, ifaceId, "CONTAINS");
  }

  // Imports
  for (const imp of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = imp.getModuleSpecifierValue();
    if (!moduleSpecifier.startsWith(".")) continue;
    const resolvedFile = imp.getModuleSpecifierSourceFile();
    if (resolvedFile) {
      const targetRel = path.relative(targetDir, resolvedFile.getFilePath());
      const targetFileId = `file::${targetRel}`;
      addNode(targetFileId, targetRel.split("/").pop(), "file", resolvedFile.getFilePath(), { fullPath: targetRel });
      addEdge(fileId, targetFileId, "IMPORTS", 1.0);
    }
  }
}

console.log(`Parse complete:`);
console.log(`  Nodes: ${nodes.size}`);
console.log(`  Edges: ${edges.length}`);

// ─── AI Enrichment via Claude CLI ──────────────────────────────────────────
function askClaude(code, type) {
  try {
    // Write prompt to a temp file to avoid Windows quote escaping issues
    const tmpFile = path.join(process.cwd(), "_tmp_prompt.txt");
    const prompt = `Analyze this JavaScript/TypeScript ${type} and respond with ONLY a JSON object, nothing else, no markdown, no explanation:
{
  "summary": "one clear sentence explaining what this does",
  "purpose": "one of: data-fetching, auth, routing, utility, config, queue, validation, transformation, database, other",
  "complexity": "one of: low, medium, high",
  "risk": "one of: low, medium, high"
}

Code:
${code}`;

    fs.writeFileSync(tmpFile, prompt, "utf8");
    const result = execSync(`claude -p "$(cat _tmp_prompt.txt)"`, {
      timeout: 30000,
      encoding: "utf8",
      windowsHide: true,
      cwd: process.cwd(),
    });
    fs.unlinkSync(tmpFile);
    return result.trim();
  } catch {
    try { fs.unlinkSync(path.join(process.cwd(), "_tmp_prompt.txt")); } catch {}
    return null;
  }
}

function askClaudeWindows(code, type) {
  try {
    // Windows-safe approach: write prompt to file, pass file path to claude
    const tmpFile = path.join(process.cwd(), "_tmp_prompt.txt");
    const prompt = `Analyze this JavaScript/TypeScript ${type} and respond with ONLY a JSON object, nothing else, no markdown:
{"summary":"one sentence what this does","purpose":"one of: data-fetching/auth/routing/utility/config/queue/validation/transformation/database/other","complexity":"low or medium or high","risk":"low or medium or high"}

Code:
${code.replace(/`/g, "'")}`;

    fs.writeFileSync(tmpFile, prompt, "utf8");

    const result = execSync(`type _tmp_prompt.txt | claude -p -`, {
      timeout: 30000,
      encoding: "utf8",
      windowsHide: true,
      cwd: process.cwd(),
      shell: "cmd.exe",
    });
    fs.unlinkSync(tmpFile);
    return result.trim();
  } catch {
    // Final fallback: direct prompt with minimal escaping
    try {
      fs.unlinkSync(path.join(process.cwd(), "_tmp_prompt.txt"));
    } catch {}
    try {
      const simple = `What does this ${type} do in one sentence? Just the sentence, nothing else. Code: ${code.substring(0, 200).replace(/[\n\r"]/g, " ")}`;
      const result = execSync(`claude -p "${simple.replace(/"/g, "'")}"`, {
        timeout: 20000,
        encoding: "utf8",
        windowsHide: true,
        shell: "cmd.exe",
      });
      return JSON.stringify({ summary: result.trim(), purpose: "other", complexity: "unknown", risk: "unknown" });
    } catch {
      return null;
    }
  }
}

function parseAIResponse(raw) {
  if (!raw) return null;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}
  return { summary: raw.substring(0, 150).replace(/\n/g, " "), purpose: "other", complexity: "unknown", risk: "unknown" };
}

function getFileContext(node) {
  try {
    const fullPath = path.join(targetDir, node.filePath);
    const content = fs.readFileSync(fullPath, "utf8");
    return content.substring(0, 800);
  } catch {
    return null;
  }
}

function enrichNodes() {
  const allNodes = Array.from(nodes.values());
  const fileNodes = allNodes.filter(n => n.type === "file");
  const codeNodes = allNodes.filter(n =>
    ["method", "function", "class", "interface"].includes(n.type) &&
    n.rawCode && n.rawCode.trim().length > 10
  );
  const toEnrich = [...codeNodes, ...fileNodes];

  if (toEnrich.length === 0) {
    console.log(`\nNo nodes to enrich.`);
    return;
  }

  console.log(`\nEnriching ${toEnrich.length} nodes with Claude AI...`);
  console.log(`  (${codeNodes.length} functions/methods + ${fileNodes.length} files)\n`);

  for (let i = 0; i < toEnrich.length; i++) {
    const node = toEnrich[i];
    const progress = `[${i + 1}/${toEnrich.length}]`;
    process.stdout.write(`  ${progress} ${node.label}... `);

    let code = null;
    let promptType = node.type;

    if (node.type === "file") {
      code = getFileContext(node);
      promptType = "file";
    } else {
      code = node.rawCode;
    }

    if (!code || code.trim().length < 5) {
      console.log(`skipped (empty)`);
      delete node.rawCode;
      continue;
    }

    const raw = askClaudeWindows(code, promptType);
    const ai = parseAIResponse(raw);

    if (ai) {
      node.ai_summary    = ai.summary    || null;
      node.ai_purpose    = ai.purpose    || null;
      node.ai_complexity = ai.complexity || null;
      node.ai_risk       = ai.risk       || null;
      console.log("done");
    } else {
      console.log("skipped");
    }

    delete node.rawCode;
  }

  for (const node of nodes.values()) delete node.rawCode;
}

// ─── Run ───────────────────────────────────────────────────────────────────
if (!skipAI) {
  enrichNodes();
} else {
  for (const node of nodes.values()) delete node.rawCode;
  console.log(`\nAI enrichment skipped (--no-ai flag).`);
}

const graph = {
  meta: {
    generatedAt: new Date().toISOString(),
    targetDirectory: targetDir,
    totalFiles: sourceFiles.length,
    totalNodes: nodes.size,
    totalEdges: edges.length,
    aiEnriched: !skipAI,
    parser: "ShipSafe v0.2 (AI enriched)",
  },
  nodes: Array.from(nodes.values()),
  edges,
};

fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2));

console.log(`\n───────────────────────────────`);
console.log(`Done. Graph saved to: ${outputPath}`);
console.log(`Nodes: ${nodes.size}  |  Edges: ${edges.length}  |  AI enriched: ${!skipAI}`);
console.log(`\nNext: open visualizer.html and load this graph.json\n`);