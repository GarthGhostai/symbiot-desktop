#!/usr/bin/env node
// symbiot — your week, written from your real work.
//
// Reads your local git activity (no accounts, no OAuth, no integrations) and
// writes the update you'd actually send. It writes with an AI of your choice —
// Claude, OpenAI, Gemini, or a local model (Ollama) — set up once with
// `symbiot login`.
//
//   symbiot week      your week, written up          (default)
//   symbiot standup   yesterday + today, for standup
//   symbiot todo      what's still on your plate
//   symbiot login     connect it to an AI (once)
//   symbiot whoami    show how it's connected
//   symbiot help
//
// Flags:  --dir <path>  where to look (default: your home folder)
//         --since <n>   days back for `week` (default 7)
//         --plain       no colour, no spinner (for piping)

import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawn } from "node:child_process";
import { homedir, totalmem, cpus as oscpus } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
let VERSION = "0"; try { VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version; } catch {}

const MAX_REPOS = 14;
const MAX_COMMITS = 140;
const MAX_TOKENS = 1600;
const CONFIG_DIR = join(homedir(), ".config", "symbiot");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// The providers Symbiot can write with. Models are sensible defaults; override
// per provider at login, or globally with SYMBIOT_MODEL.
const PROVIDERS = {
  anthropic: { label: "Claude (Anthropic)", env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], keyUrl: "https://console.anthropic.com/settings/keys", keyName: "Anthropic API key (sk-ant-…)", model: "claude-opus-5-5" },
  openai:    { label: "OpenAI (GPT)",       env: ["OPENAI_API_KEY"],                            keyUrl: "https://platform.openai.com/api-keys",       keyName: "OpenAI API key (sk-…)",     model: "gpt-4o-mini" },
  gemini:    { label: "Gemini (Google)",    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],          keyUrl: "https://aistudio.google.com/apikey",         keyName: "Google AI API key",         model: "gemini-1.5-flash" },
  ollama:    { label: "Local model (Ollama)", local: true,                                       keyUrl: "https://ollama.com",                         keyName: null,                        model: "llama3.1" },
};

// ---- tiny arg parse --------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = (argv[0] && !argv[0].startsWith("-") ? argv[0] : "week").toLowerCase();
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);
const PLAIN = has("plain") || !process.stdout.isTTY;
let SERVING = false; // set while `symbiot app` runs — silences the CLI spinner
let LAST_MAP = null;  // cached graph so node clicks don't rescan

// ---- colour + spinner ------------------------------------------------------
const c = PLAIN
  ? { g: (s) => s, d: (s) => s, b: (s) => s, y: (s) => s }
  : {
      g: (s) => `\x1b[38;5;42m${s}\x1b[0m`,   // green
      d: (s) => `\x1b[38;5;66m${s}\x1b[0m`,    // faint
      b: (s) => `\x1b[1m${s}\x1b[0m`,          // bold
      y: (s) => `\x1b[38;5;179m${s}\x1b[0m`,   // amber
    };
function spinner(label) {
  if (SERVING) return () => {};
  if (PLAIN) { process.stderr.write(label + "\n"); return () => {}; }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => process.stderr.write(`\r${c.g(frames[i++ % frames.length])} ${c.d(label)} `), 80);
  return () => { clearInterval(t); process.stderr.write("\r\x1b[K"); };
}

// ---- config + provider resolution -----------------------------------------
function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}
function saveConfig(cfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
    try { chmodSync(CONFIG_PATH, 0o600); } catch {}
    return true;
  } catch { return false; }
}
function antProfileExists() {
  try { return existsSync(join(homedir(), ".config", "anthropic")); } catch { return false; }
}
// ---- tasks: a persistent checklist (~/.config/symbiot/tasks.json) ---------
const TASKS_PATH = join(CONFIG_DIR, "tasks.json");
function loadTasks() { try { return JSON.parse(readFileSync(TASKS_PATH, "utf8")); } catch { return []; } }
function saveTasks(t) { try { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(TASKS_PATH, JSON.stringify(t, null, 2)); return true; } catch { return false; } }
function addTask(text, repo) {
  text = String(text || "").trim().slice(0, 300);
  if (!text) return { error: "empty" };
  const t = loadTasks();
  const item = { id: randomBytes(6).toString("hex"), text, repo: repo || "", done: false, ts: Date.now() };
  t.unshift(item); saveTasks(t); return item;
}
function toggleTask(id) { const t = loadTasks(); const it = t.find((x) => x.id === id); if (it) { it.done = !it.done; saveTasks(t); } return it || { error: "not found" }; }
function removeTask(id) { saveTasks(loadTasks().filter((x) => x.id !== id)); return { ok: true }; }
function envKey(provider) {
  for (const e of (PROVIDERS[provider].env || [])) if (process.env[e]) return process.env[e];
  return null;
}
// Returns { provider, key?, baseUrl?, model, source } or null if nothing set up.
// Order: saved choice → legacy saved key → env keys → an `ant` profile.
function resolveProvider() {
  const cfg = loadConfig();
  const m = process.env.SYMBIOT_MODEL;
  if (cfg.provider && PROVIDERS[cfg.provider]) {
    const p = cfg.provider, pc = cfg[p] || {};
    if (p === "ollama") return { provider: p, baseUrl: pc.baseUrl || "http://localhost:11434", model: m || pc.model || PROVIDERS.ollama.model, source: "saved login" };
    const key = pc.apiKey || envKey(p);
    if (key || (p === "anthropic" && (process.env.ANTHROPIC_AUTH_TOKEN || antProfileExists())))
      return { provider: p, key, model: m || pc.model || PROVIDERS[p].model, source: pc.apiKey ? "saved login" : "environment" };
  }
  if (cfg.apiKey) return { provider: "anthropic", key: cfg.apiKey, model: m || PROVIDERS.anthropic.model, source: "saved login (~/.config/symbiot)" };
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return { provider: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: m || PROVIDERS.anthropic.model, source: "ANTHROPIC_* (environment)" };
  if (process.env.OPENAI_API_KEY) return { provider: "openai", key: process.env.OPENAI_API_KEY, model: m || PROVIDERS.openai.model, source: "OPENAI_API_KEY (environment)" };
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { provider: "gemini", key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, model: m || PROVIDERS.gemini.model, source: "GEMINI/GOOGLE_API_KEY (environment)" };
  if (antProfileExists()) return { provider: "anthropic", model: m || PROVIDERS.anthropic.model, source: "Anthropic CLI profile (ant auth login)" };
  return null;
}

// ---- prompt (with masked secret input) ------------------------------------
function ask(question, { secret = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret && !PLAIN) {
      rl._writeToOutput = (str) => {
        if (str.includes(question)) rl.output.write(question);
        else if (str.includes("\n")) rl.output.write("\n");
        else rl.output.write("*");
      };
    }
    rl.question(question, (ans) => {
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve((ans || "").trim());
    });
  });
}

// ---- git ------------------------------------------------------------------
function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024, timeout: 6000, killSignal: "SIGKILL" }); }
  catch { return ""; } // timeout or error -> empty, never hang the scan
}
// find .git dirs quickly by PRUNING heavy trees (node_modules etc.) instead of
// crawling into them — this is the big speedup for the map scan.
function findGitDirs(base, limit) {
  return sh(
    `find ${JSON.stringify(base)} -maxdepth 6 ` +
    `\\( -name node_modules -o -name .cache -o -name .local -o -name .npm -o -name venv -o -name .venv -o -name .git-crypt \\) -prune ` +
    `-o -name .git -print 2>/dev/null | head -${limit}`,
  ).split("\n").filter(Boolean);
}
function me() {
  return { email: sh("git config --global user.email").trim(), name: sh("git config --global user.name").trim() };
}

// ---- accurate repo signals (the field-report fixes) -----------------------
// All author identities in this repo that plausibly belong to the current user,
// with a fallback when the filter would keep almost nothing of an active repo.
function authorship(repoPath) {
  const gName = sh("git config --global user.name 2>/dev/null").trim();
  const gEmail = sh("git config --global user.email 2>/dev/null").trim();
  const rEmail = sh(`git -C ${JSON.stringify(repoPath)} config user.email 2>/dev/null`).trim();
  const rName = sh(`git -C ${JSON.stringify(repoPath)} config user.name 2>/dev/null`).trim();
  const total = Number(sh(`git -C ${JSON.stringify(repoPath)} rev-list --count HEAD 2>/dev/null`).trim()) || 0;
  const rows = sh(`git -C ${JSON.stringify(repoPath)} log --format='%ae|%an' 2>/dev/null | sort | uniq -c | sort -rn | head -60`)
    .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(\d+)\s+(.*)$/); if (!m) return null;
      const parts = m[2].split("|"); return { count: Number(m[1]), email: parts[0], name: parts.slice(1).join("|") };
    }).filter(Boolean);
  const myEmails = new Set([rEmail, gEmail].filter(Boolean));
  const myNames = new Set([gName, rName].filter(Boolean).map((n) => n.toLowerCase()));
  const nameKeys = new Set([...myNames].map((n) => n.replace(/\s+/g, "")));
  const mine = new Set();
  for (const r of rows) {
    const nore = r.email.match(/^\d+\+(.+)@users\.noreply\.github\.com$/i);
    const isMine = (r.email && myEmails.has(r.email))
      || (r.name && myNames.has(r.name.toLowerCase()))
      || (nore && nameKeys.has(nore[1].toLowerCase().replace(/\s+/g, "")));
    if (isMine) mine.add(r.email);
  }
  if (rEmail) mine.add(rEmail);
  let mineCount = rows.filter((r) => mine.has(r.email)).reduce((s, r) => s + r.count, 0);
  const filterDropped = total >= 20 && mineCount / Math.max(total, 1) < 0.10;
  const emails = filterDropped ? rows.map((r) => r.email) : [...mine];
  return { emails, mineCount, total, filterDropped, names: [...new Set(rows.filter((r) => mine.has(r.email)).map((r) => r.email))] };
}
function authorArgs(emails) { return (emails || []).filter(Boolean).map((e) => `--author=${JSON.stringify(e)}`).join(" "); }

// Working-tree state, incl. detecting a stale/old checkout (not new work).
function repoState(repoPath) {
  const branch = sh(`git -C ${JSON.stringify(repoPath)} rev-parse --abbrev-ref HEAD 2>/dev/null`).trim();
  const porcelain = sh(`git -C ${JSON.stringify(repoPath)} status --porcelain 2>/dev/null`).split("\n").filter(Boolean);
  let del = 0, mod = 0, add = 0;
  for (const l of porcelain) { const x = l.slice(0, 2); if (/\?\?/.test(x)) add++; else if (x.includes("D")) del++; else if (x.includes("A")) add++; else mod++; }
  const dirty = porcelain.length;
  let stale = false, staleBy = 0;
  if (dirty) {
    for (const k of [3, 5, 10, 20, 40, 80, 160, 320]) {
      if (!sh(`git -C ${JSON.stringify(repoPath)} rev-parse HEAD~${k} 2>/dev/null`).trim()) break;
      if (sh(`git -C ${JSON.stringify(repoPath)} diff --quiet HEAD~${k} 2>/dev/null && echo EQ`).trim() === "EQ") { stale = true; staleBy = k; break; }
    }
    if (!stale && del >= 20 && del > mod && add === 0) stale = true; // mostly deletions = an old snapshot
  }
  const behind = Number(sh(`git -C ${JSON.stringify(repoPath)} rev-list --count HEAD..@{u} 2>/dev/null`).trim()) || 0;
  return { branch, dirty, del, mod, add, stale, staleBy, behind };
}
function readmeInfo(repoPath) {
  for (const f of ["README.md", "README.MD", "Readme.md", "readme.md", "README.txt", "README"]) {
    try {
      const p = join(repoPath, f);
      if (existsSync(p)) {
        const hash = sh(`git -C ${JSON.stringify(repoPath)} log -1 --format=%H -- ${JSON.stringify(f)} 2>/dev/null`).trim();
        return {
          file: f, excerpt: readFileSync(p, "utf8").slice(0, 2500),
          lastDate: sh(`git -C ${JSON.stringify(repoPath)} log -1 --format=%cd --date=short -- ${JSON.stringify(f)} 2>/dev/null`).trim(),
          commitsAgo: hash ? (Number(sh(`git -C ${JSON.stringify(repoPath)} rev-list --count ${hash}..HEAD 2>/dev/null`).trim()) || 0) : 0,
        };
      }
    } catch {}
  }
  return { file: null, excerpt: "", lastDate: "", commitsAgo: 0 };
}
function repoShape(repoPath) {
  const files = sh(`git -C ${JSON.stringify(repoPath)} ls-files 2>/dev/null | head -4000`).split("\n").filter(Boolean);
  const top = {}; const docs = []; const manifests = [];
  for (const f of files) {
    const seg = f.includes("/") ? f.split("/")[0] : "(root)";
    top[seg] = (top[seg] || 0) + 1;
    const base = f.split("/").pop();
    if (MANIFEST_TOOL[base]) manifests.push(f);
    if (/^(readme|contributing|claude|agents|changelog|architecture|design)/i.test(base) || /(^|\/)(docs|knowledge)\//i.test(f)) docs.push(f);
  }
  return {
    total: files.length,
    dirs: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([d, n]) => `${d}/ (${n})`),
    manifests: manifests.slice(0, 12), docs: [...new Set(docs)].slice(0, 16),
  };
}
// House rules the model must respect (e.g. "we commit .env on purpose").
function houseRules(repoPath) {
  const out = [];
  for (const [label, f] of [["Project rules", "CLAUDE.md"], ["Agent rules", "AGENTS.md"], ["Contributing", "CONTRIBUTING.md"]]) {
    try { const p = join(repoPath, f); if (existsSync(p)) out.push(`## ${label} (${f})\n` + readFileSync(p, "utf8").slice(0, 1500)); } catch {}
  }
  try { const g = join(homedir(), ".config", "symbiot", "rules.md"); if (existsSync(g)) out.push("## Your global rules\n" + readFileSync(g, "utf8").slice(0, 1500)); } catch {}
  return out.join("\n\n");
}
// "Show what was read" footer for every report.
function reportFooter(repoPath, auth, state, rd) {
  const b = [`symbiot ${VERSION}`, `path ${repoPath}`];
  if (state.branch) b.push(`branch ${state.branch}`);
  b.push(`${auth.mineCount} of ${auth.total} commits matched you${auth.filterDropped ? " — filter dropped, counting everyone" : ""}`);
  if (rd && rd.lastDate) b.push(`README changed ${rd.lastDate}${rd.commitsAgo ? ` (${rd.commitsAgo} commits ago)` : ""}`);
  if (state.stale) b.push(`⚠ STALE checkout: working tree ≈ ${state.staleBy ? "HEAD~" + state.staleBy : "an older commit"} — not new work`);
  else if (state.dirty) b.push(`${state.dirty} uncommitted (${state.mod} mod / ${state.del} del / ${state.add} new)`);
  if (state.behind) b.push(`${state.behind} behind upstream`);
  return b.join(" · ");
}
function findRepos(base, sinceDays) {
  const repos = [];
  for (const g of findGitDirs(base, 200)) {
    const repo = g.replace(/\/\.git$/, "");
    const n = Number(sh(`git -C ${JSON.stringify(repo)} log --since="${sinceDays} days ago" --oneline 2>/dev/null | wc -l`).trim());
    const last = Number(sh(`git -C ${JSON.stringify(repo)} log -1 --format=%ct 2>/dev/null`).trim()) || 0;
    if (n > 0) repos.push({ path: repo, name: repo.split("/").pop(), recency: last });
  }
  return repos.sort((a, b) => b.recency - a.recency).slice(0, MAX_REPOS);
}
function commits(repos, sinceExpr, mineOnly = true) {
  const all = [];
  const seen = new Set();
  for (const r of repos) {
    // Match ALL of your identities in this repo (per-repo email, global email,
    // GitHub noreply login, matching name), with a fallback when almost nothing
    // matches an active repo. No filter with --all.
    const authorArg = mineOnly ? authorArgs(authorship(r.path).emails) : "";
    const raw = sh(
      `git -C ${JSON.stringify(r.path)} log --since=${JSON.stringify(sinceExpr)} ${authorArg} ` +
      `--no-merges --date=short --name-only --pretty=format:'@@@%H|%ad|%s' -n 60`,
    );
    let cur = null;
    const flush = () => {
      if (cur && !seen.has(cur.h)) { seen.add(cur.h); all.push({ ...cur, repo: r.name }); }
    };
    for (const line of raw.split("\n")) {
      if (line.startsWith("@@@")) {
        flush();
        const [h, date, subject] = line.slice(3).split("|");
        cur = { h, date, subject: subject || "", files: [] };
      } else if (line.trim() && cur) cur.files.push(line.trim());
    }
    flush();
  }
  return all.slice(0, MAX_COMMITS);
}
function openWork(repos) {
  const items = [];
  for (const r of repos) {
    const todos = sh(
      `git -C ${JSON.stringify(r.path)} grep -nEI '(TODO|FIXME|HACK)[:( ]' -- ` +
      `'*.ts' '*.tsx' '*.js' '*.py' '*.go' '*.rs' '*.java' '*.sql' '*.vue' 2>/dev/null | head -8`,
    );
    for (const l of todos.split("\n").filter(Boolean)) {
      const m = l.match(/^([^:]+):(\d+):(.*)$/);
      if (m) items.push(`${r.name}: ${m[3].replace(/^[\s/*#-]+/, "").trim().slice(0, 120)} (${m[1]}:${m[2]})`);
    }
    const st = repoState(r.path);
    if (st.stale) {
      items.push(`${r.name}: STALE checkout — working tree ≈ ${st.staleBy ? "HEAD~" + st.staleBy : "an older commit"}, NOT new work; do not commit (would revert history)`);
    } else if (st.dirty) {
      items.push(`${r.name}: ${st.dirty} uncommitted (${st.mod} mod / ${st.del} del / ${st.add} new) on ${st.branch || "?"}`);
    }
  }
  return items;
}

// ---- model calls (one per provider, same in/out) --------------------------
async function callAnthropic(r, system, prompt) {
  const client = new Anthropic(r.key ? { apiKey: r.key } : {});
  const base = { model: r.model, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: prompt }] };
  let res;
  try { res = await client.messages.create({ ...base, output_config: { effort: "low" } }); }
  catch (e) {
    // effort/output_config isn't accepted on every model (e.g. Haiku) — retry plain
    if (/effort|output_config|thinking|budget|400/i.test(e?.message || "")) res = await client.messages.create(base);
    else throw e;
  }
  if (res.stop_reason === "refusal") return "(the model declined this one — odd for a work summary; try again)";
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}
async function callOpenAI(r, system, prompt) {
  const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
  // Newer models want max_completion_tokens instead of max_tokens; try both.
  for (const tokKey of ["max_tokens", "max_completion_tokens"]) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${r.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: r.model, [tokKey]: MAX_TOKENS, messages }),
    });
    const text = await res.text();
    if (res.ok) return (JSON.parse(text).choices?.[0]?.message?.content || "").trim();
    if (res.status === 400 && tokKey === "max_tokens" && /max_tokens|max_completion_tokens/i.test(text)) continue;
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
  }
  return "";
}
async function callGemini(r, system, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(r.model)}:generateContent?key=${encodeURIComponent(r.key)}`;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  const parts = JSON.parse(text).candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}
async function callOllama(r, system, prompt) {
  const res = await fetch(`${r.baseUrl}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: r.model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${text.slice(0, 200)}`);
  return (JSON.parse(text).message?.content || "").trim();
}

async function write(system, prompt) {
  const r = resolveProvider();
  if (!r) { console.log(AUTH_HELP); return null; }
  const stop = spinner("thinking…");
  try {
    if (r.provider === "anthropic") return await callAnthropic(r, system, prompt);
    if (r.provider === "openai") return await callOpenAI(r, system, prompt);
    if (r.provider === "gemini") return await callGemini(r, system, prompt);
    if (r.provider === "ollama") return await callOllama(r, system, prompt);
    return null;
  } catch (err) {
    if (/\b401\b|\b403\b|invalid|authentication|api key|unauthor/i.test(err?.message || "")) {
      console.log(c.y(`Your ${PROVIDERS[r.provider].label} credentials were rejected. `) + "Reconnect with:  " + c.b("symbiot login --force"));
      return null;
    }
    return `Couldn't reach the model: ${err?.message || err}`;
  } finally { stop(); }
}

async function validate(provider, { key, baseUrl } = {}) {
  try {
    if (provider === "anthropic") { await new Anthropic({ apiKey: key }).models.list(); return true; }
    if (provider === "openai") return (await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } })).ok;
    if (provider === "gemini") return (await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`)).ok;
    if (provider === "ollama") return (await fetch(`${baseUrl}/api/tags`)).ok;
  } catch { return false; }
  return false;
}

const AUTH_HELP =
  c.y("Symbiot needs an AI to write your updates. Connect one:\n") +
  "  " + c.b("symbiot login") + c.d("   pick Claude, OpenAI, Gemini, or a local model (Ollama)") + "\n" +
  c.d("  Or set a key in your environment: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.");

// ---- render ---------------------------------------------------------------
function renderCommits(list) {
  return list.map((x) => `- [${x.repo}] ${x.subject}${x.files.length ? ` (${x.files.length} files)` : ""}`).join("\n");
}
function header(sub) {
  if (PLAIN) { console.log(`Symbiot\n${sub}\n`); return; }
  console.log(`\n${c.g("●")} ${c.b("Symbiot")} ${c.d("· " + sub)}\n`);
}

// ---- commands -------------------------------------------------------------
const SINCE_WEEK = Number(flag("since", "7"));
const BASE = flag("dir", homedir());

// ---- hardware -> model recommendations ------------------------------------
function detectGpu() {
  const nv = sh("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null").trim();
  if (nv) { const p = nv.split("\n")[0].split(","); return { name: (p[0] || "NVIDIA GPU").trim(), vramGB: Math.round(Number(p[1]) / 1024) || null, kind: "nvidia" }; }
  if (process.platform === "linux") { const vga = sh("lspci 2>/dev/null | grep -iE 'vga|3d controller|display' | head -1").replace(/^.*?: /, "").trim(); if (vga) return { name: vga, vramGB: null, kind: "other" }; }
  if (process.platform === "darwin") { const chip = sh("sysctl -n machdep.cpu.brand_string 2>/dev/null").trim(); if (/apple/i.test(chip)) return { name: chip + " (unified memory)", vramGB: null, kind: "apple" }; }
  return null;
}
function detectHardware() {
  const cpus = oscpus() || [];
  return { platform: process.platform, arch: process.arch, ramGB: Math.round(totalmem() / 1073741824), cpuCount: cpus.length, cpuModel: ((cpus[0] && cpus[0].model) || "CPU").trim(), gpu: detectGpu() };
}
function recommendModels(hw) {
  const ram = hw.ramGB || 8;
  const local = [
    { tier: "min", model: "llama3.2:3b", needGB: 6, note: "fast & light — fine for summaries" },
    { tier: "med", model: "llama3.1:8b", needGB: 10, note: "solid all-rounder" },
    { tier: "max", model: "qwen2.5:14b", needGB: 18, note: "stronger reasoning" },
  ];
  if (ram >= 40) local.push({ tier: "max+", model: "llama3.1:70b", needGB: 48, note: "top local quality — big machine/GPU" });
  local.forEach((m) => { m.fits = ram >= m.needGB; });
  const paid = [
    { provider: "anthropic", tier: "cheap", model: "claude-haiku-4-5", note: "cheapest Claude" },
    { provider: "anthropic", tier: "top", model: "claude-opus-5-5", note: "best Claude (default)" },
    { provider: "openai", tier: "cheap", model: "gpt-4o-mini", note: "cheap OpenAI" },
    { provider: "openai", tier: "top", model: "gpt-4o", note: "stronger OpenAI" },
    { provider: "gemini", tier: "cheap", model: "gemini-1.5-flash", note: "cheap Google" },
    { provider: "gemini", tier: "top", model: "gemini-1.5-pro", note: "stronger Google" },
  ];
  const best = (local.slice().reverse().find((m) => m.fits) || local[0]).model;
  return { local, paid, best };
}
function cmdModels() {
  const hw = detectHardware(); const rec = recommendModels(hw);
  const pad = (s, n) => String(s).padEnd(n);
  console.log("\n" + c.b("Your machine"));
  console.log(`  ${c.b(hw.ramGB + " GB")} RAM · ${hw.cpuCount}-core ${hw.cpuModel} · ${hw.platform}/${hw.arch}`);
  if (hw.gpu) console.log(`  GPU: ${hw.gpu.name}${hw.gpu.vramGB ? ` (${hw.gpu.vramGB} GB VRAM)` : ""}`);
  console.log("\n" + c.b("Local models") + c.d("  (free & private via Ollama — install: ollama pull <model>)"));
  rec.local.forEach((m) => console.log(`  ${m.fits ? c.g("✓") : c.d("·")} ${pad(m.tier, 5)} ${pad(m.model, 16)} ${c.d("~" + m.needGB + "GB  " + m.note + (m.fits ? "" : "  (needs more RAM)"))}`));
  console.log(c.d(`  Best fit for you: `) + c.b(rec.best) + c.d(`   →  ollama pull ${rec.best}  then  symbiot login  (choose Ollama)`));
  console.log("\n" + c.b("Paid models") + c.d("  (bring an API key — symbiot login)"));
  rec.paid.forEach((p) => console.log(`  ${pad(p.provider, 10)} ${pad(p.tier, 6)} ${pad(p.model, 20)} ${c.d(p.note)}`));
  console.log("");
}

// ---- drift: what's out of sync / stuck / at risk (deterministic git facts) -
function gitDefaultBranch(repo) {
  const d = sh(`git -C ${JSON.stringify(repo)} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null`).trim();
  if (d) return d.replace(/^origin\//, "");
  for (const b of ["main", "master", "develop"]) if (sh(`git -C ${JSON.stringify(repo)} rev-parse --verify -q refs/remotes/origin/${b} 2>/dev/null`).trim()) return b;
  return sh(`git -C ${JSON.stringify(repo)} rev-parse --abbrev-ref HEAD 2>/dev/null`).trim() || "main";
}
function fetchAgeDays(repo) {
  const gd = sh(`git -C ${JSON.stringify(repo)} rev-parse --git-common-dir 2>/dev/null`).trim();
  if (!gd) return null;
  const p = gd.startsWith("/") ? join(gd, "FETCH_HEAD") : join(repo, gd, "FETCH_HEAD");
  try { return Math.floor((Date.now() - statSync(p).mtimeMs) / 86400000); } catch { return null; }
}
function worktreeCount(repo) { return sh(`git -C ${JSON.stringify(repo)} worktree list 2>/dev/null`).split("\n").filter(Boolean).length; }
// Deployed-sha commands are read ONLY from the user's own config (never from a
// repo file, which could be attacker-controlled): ~/.config/symbiot/deploys.json
function loadDeploys() { try { return JSON.parse(readFileSync(join(CONFIG_DIR, "deploys.json"), "utf8")); } catch { return {}; } }
function ciState(repo, def) {
  if (!sh("command -v gh 2>/dev/null").trim()) return null;
  if (!/github\.com/i.test(sh(`git -C ${JSON.stringify(repo)} remote get-url origin 2>/dev/null`))) return null;
  const j = sh(`cd ${JSON.stringify(repo)} && gh run list --branch ${def} --limit 1 --json databaseId,conclusion,status 2>/dev/null`).trim();
  if (!j) return null;
  try {
    const a = JSON.parse(j); if (!a.length) return null; const r = a[0];
    if (r.status && r.status !== "completed") return { level: "info", text: `CI on ${def}: ${r.status}` };
    if (r.conclusion === "success") return { level: "info", text: `CI on ${def}: passing` };
    if (r.conclusion === "failure") {
      // Deterministic "not running" signal: every job has 0 steps (never started).
      let notRun = false, reason = "";
      try {
        const jobs = (JSON.parse(sh(`cd ${JSON.stringify(repo)} && gh run view ${r.databaseId} --json jobs 2>/dev/null`)).jobs) || [];
        notRun = jobs.length > 0 && jobs.every((x) => ((x.steps || []).length === 0));
        if (notRun && jobs[0] && jobs[0].databaseId) {
          // Only on the not-running path: fetch the one job's annotation to quote
          // GitHub's exact reason (billing / spending limit / runner / disabled).
          const cru = sh(`cd ${JSON.stringify(repo)} && gh api repos/{owner}/{repo}/actions/jobs/${jobs[0].databaseId} --jq .check_run_url 2>/dev/null`).trim();
          const crid = (cru.match(/check-runs\/(\d+)/) || [])[1];
          if (crid) { const m = sh(`cd ${JSON.stringify(repo)} && gh api repos/{owner}/{repo}/check-runs/${crid}/annotations --jq '.[0].message' 2>/dev/null`).trim(); if (m) reason = m.slice(0, 240); }
        }
      } catch {}
      if (notRun) return { level: "warn", text: reason ? `CI is NOT running on ${def}: "${reason}"` : `CI is NOT running on ${def} — jobs never started (reason unavailable; usually a billing/spending-limit stop), not failing tests` };
      return { level: "warn", text: `CI's last run on ${def} failed (a real failure — jobs ran)` };
    }
    if (r.conclusion) return { level: "warn", text: `CI on ${def}: ${r.conclusion}` };
    return null;
  } catch { return null; }
}
// For merges that aren't on the default branch, tell "likely never landed"
// (added files missing from default) from "merged another way" (all present).
function mergedOffDefault(p, defRef) {
  const raw = sh(`git -C ${JSON.stringify(p)} log --merges --all --not ${defRef} --format='%H|%s' 2>/dev/null`)
    .split("\n").filter((l) => /merge pull request/i.test(l));
  if (!raw.length) return [];
  const defFiles = new Set(sh(`git -C ${JSON.stringify(p)} ls-tree -r --name-only ${defRef} 2>/dev/null`).split("\n").filter(Boolean));
  const hits = [];
  for (const line of raw.slice(0, 12)) {
    const [sha, subj] = line.split("|");
    const prNum = (subj.match(/#(\d+)/) || [])[1] || "?";
    const parents = sh(`git -C ${JSON.stringify(p)} rev-list --parents -n1 ${sha} 2>/dev/null`).trim().split(/\s+/);
    const head = parents[2]; // 2nd parent = the merged branch head
    let added = 0, missing = 0;
    if (head) {
      const mb = sh(`git -C ${JSON.stringify(p)} merge-base ${head} ${defRef} 2>/dev/null`).trim();
      const files = sh(`git -C ${JSON.stringify(p)} diff --name-status ${mb || defRef} ${head} 2>/dev/null`)
        .split("\n").map((l) => l.trim()).filter((l) => /^A\b|^A\t/.test(l)).map((l) => l.split(/\s+/).pop());
      added = files.length;
      for (const f of files) if (f && !defFiles.has(f)) missing++;
    }
    hits.push({ prNum, sha: sha.slice(0, 9), added, missing });
  }
  return hits;
}
// Drift facts for ONE repo. Compares against origin/<default> when a remote
// exists, else the local default branch (so it also works on local-only repos).
function driftRepo(p, opts = {}) {
  const name = p.split("/").pop();
  const def = gitDefaultBranch(p), st = repoState(p), flags = [];
  const originDef = sh(`git -C ${JSON.stringify(p)} rev-parse --verify -q refs/remotes/origin/${def} 2>/dev/null`).trim();
  const localDef = sh(`git -C ${JSON.stringify(p)} rev-parse --verify -q refs/heads/${def} 2>/dev/null`).trim();
  const defRef = originDef ? `origin/${def}` : (localDef ? def : "");
  const cmd = opts.deploys && (opts.deploys[p] || opts.deploys[name]);
  // Fetch only when asked, or for a deploy-configured repo (comparing a live
  // deployed sha against a stale origin gives a confidently wrong answer).
  if (originDef && (opts.fetch || cmd)) sh(`git -C ${JSON.stringify(p)} fetch -q origin 2>/dev/null`);
  const fa = fetchAgeDays(p);
  const stale = fa != null && fa > 1 ? ` (as of ${fa}d ago)` : "";

  if (st.stale) flags.push({ level: "warn", text: `checkout is stale — working tree ≈ ${st.staleBy ? "HEAD~" + st.staleBy : "an older commit"}, not new work` });
  else if (st.dirty) flags.push({ level: "info", text: `${st.dirty} uncommitted (${st.mod} mod / ${st.del} del / ${st.add} new)` });
  if (st.behind) flags.push({ level: "warn", text: `${st.behind} behind upstream on ${st.branch}${stale}` });
  const wc = worktreeCount(p); if (wc > 1) flags.push({ level: "info", text: `${wc} checkouts of this repo` });
  if (originDef) {
    const unmerged = sh(`git -C ${JSON.stringify(p)} branch -r --no-merged origin/${def} 2>/dev/null`).split("\n").map((s) => s.trim()).filter((b) => b && !b.startsWith("origin/HEAD"));
    if (unmerged.length) flags.push({ level: "info", text: `${unmerged.length} branch(es) with work not on ${def}` });
  }
  if (defRef) {
    const hits = mergedOffDefault(p, defRef);
    const gone = hits.filter((h) => h.added > 0 && h.missing > 0);
    const other = hits.length - gone.length;
    if (gone.length) flags.push({ level: "warn", text: `${gone.length} PR(s) merged off ${def} with added files MISSING from ${def} — likely never landed`, evidence: gone.slice(0, 5).map((h) => `#${h.prNum} (${h.missing}/${h.added} files missing)`).join(" | ") });
    if (other > 0) flags.push({ level: "info", text: `${other} other PR merge(s) off ${def} (files present — probably re-done/squashed)` });
  }
  if (cmd && defRef) {
    const sha = sh(cmd).trim().split(/\s+/)[0];
    if (sha) {
      const onDef = sh(`git -C ${JSON.stringify(p)} merge-base --is-ancestor ${sha} ${defRef} 2>/dev/null && echo Y`).trim() === "Y";
      const behind = Number(sh(`git -C ${JSON.stringify(p)} rev-list --count ${sha}..${defRef} 2>/dev/null`).trim()) || 0;
      const ahead = Number(sh(`git -C ${JSON.stringify(p)} rev-list --count ${defRef}..${sha} 2>/dev/null`).trim()) || 0;
      if (!onDef) flags.push({ level: "warn", text: `production runs code NOT on ${def}${ahead ? ` (${ahead} commits ahead of it)` : ""}`, evidence: sha.slice(0, 9) });
      else if (behind) flags.push({ level: "warn", text: `production is ${behind} behind ${def}`, evidence: sha.slice(0, 9) });
      else flags.push({ level: "info", text: `production in sync with ${def}`, evidence: sha.slice(0, 9) });
    }
  }
  if (opts.ci) { const ci = ciState(p, def); if (ci) flags.push(ci); }
  return { name, path: p, def, flags, fetchAgeDays: fa };
}
function computeDrift(opts = {}) {
  const deploys = loadDeploys();
  const repos = findAllRepos(BASE).slice(0, 20).map((r) => driftRepo(r.path, { deploys, ci: opts.ci, fetch: opts.fetch }));
  return { repos, ci: !!opts.ci };
}
function cmdDrift() {
  const d = computeDrift({ ci: has("ci"), fetch: has("fetch") });
  const warn = d.repos.filter((r) => r.flags.some((f) => f.level === "warn"));
  console.log(`\n${c.g("●")} ${c.b("Symbiot drift")} ${c.d("· " + d.repos.length + " repos · " + warn.length + " with risks")}\n`);
  for (const r of d.repos) {
    if (!r.flags.length) continue;
    const risky = r.flags.some((f) => f.level === "warn");
    console.log(`${risky ? c.y("●") : c.d("○")} ${c.b(r.name)} ${c.d(r.def + (r.fetchAgeDays != null && r.fetchAgeDays > 3 ? " · fetch " + r.fetchAgeDays + "d old" : ""))}`);
    for (const f of r.flags) console.log(`  ${f.level === "warn" ? c.y("⚠") : c.d("·")} ${f.text}${f.evidence ? c.d("  [" + f.evidence + "]") : ""}`);
    console.log("");
  }
  const clean = d.repos.filter((r) => !r.flags.length).map((r) => r.name);
  if (clean.length) console.log(c.d(`clean: ${clean.join(", ")}`));
  console.log(c.d(`\nsymbiot ${VERSION} · local git facts only${d.ci ? " + CI" : " (add --ci for CI status)"}${loadDeploys() && Object.keys(loadDeploys()).length ? "" : " · set ~/.config/symbiot/deploys.json for production-sha checks"}`));
}

// ---- work map: a node graph of your repos, languages, and tools -----------
const EXT_LANG = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", rb: "Ruby", php: "PHP",
  cs: "C#", cpp: "C++", cc: "C++", c: "C", swift: "Swift", vue: "Vue", svelte: "Svelte",
  sql: "SQL", sh: "Shell", css: "CSS", scss: "CSS", html: "HTML",
};
const MANIFEST_TOOL = {
  "package.json": "Node", "requirements.txt": "Python", "pyproject.toml": "Python",
  "go.mod": "Go", "Cargo.toml": "Rust", "pom.xml": "Maven", "build.gradle": "Gradle",
  "Gemfile": "Ruby", "composer.json": "PHP", "Dockerfile": "Docker", "docker-compose.yml": "Docker",
  "terraform.tf": "Terraform", "kubernetes.yml": "Kubernetes", ".github": "GitHub Actions",
};
function findAllRepos(base) {
  const repos = [];
  for (const g of findGitDirs(base, 120)) {
    const repo = g.replace(/\/\.git$/, "");
    const last = Number(sh(`git -C ${JSON.stringify(repo)} log -1 --format=%ct 2>/dev/null`).trim()) || 0;
    if (last) repos.push({ path: repo, name: repo.split("/").pop(), recency: last });
  }
  // Group worktrees by shared git dir; keep only the freshest checkout of each.
  const byCommon = {};
  for (const r of repos) {
    const cd = sh(`git -C ${JSON.stringify(r.path)} rev-parse --git-common-dir 2>/dev/null`).trim() || r.path;
    const key = cd.startsWith("/") ? cd : join(r.path, cd);
    if (!byCommon[key] || byCommon[key].recency < r.recency) byCommon[key] = r;
  }
  return Object.values(byCommon).sort((a, b) => b.recency - a.recency).slice(0, 30);
}
function detectRepo(r) {
  const files = sh(`git -C ${JSON.stringify(r.path)} ls-files 2>/dev/null | head -3000`).split("\n").filter(Boolean);
  const count = {}; const tools = new Set();
  for (const f of files) {
    const base = f.split("/").pop();
    if (MANIFEST_TOOL[base]) tools.add(MANIFEST_TOOL[base]);
    const ext = (base.includes(".") ? base.split(".").pop() : "").toLowerCase();
    if (EXT_LANG[ext]) count[EXT_LANG[ext]] = (count[EXT_LANG[ext]] || 0) + 1;
  }
  const langs = Object.entries(count).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const email = sh(`git -C ${JSON.stringify(r.path)} config user.email`).trim();
  const mine = Number(sh(`git -C ${JSON.stringify(r.path)} log ${email ? `--author=${JSON.stringify(email)}` : ""} --oneline 2>/dev/null | wc -l`).trim()) || 0;
  const branch = sh(`git -C ${JSON.stringify(r.path)} rev-parse --abbrev-ref HEAD 2>/dev/null`).trim();
  const last = sh(`git -C ${JSON.stringify(r.path)} log -1 --format=%cd --date=short 2>/dev/null`).trim();
  return { ...r, langs, tools: [...tools], mine, files: files.length, branch, last };
}
function buildMap() {
  const who = me();
  const repos = findAllRepos(BASE).map(detectRepo);
  const nodes = []; const edges = []; const have = new Set();
  const add = (n) => { if (!have.has(n.id)) { have.add(n.id); nodes.push(n); } };
  add({ id: "me", type: "person", label: who.name || "You", weight: 22 });
  for (const r of repos) {
    const rid = "repo:" + r.path;
    add({ id: rid, type: "repo", label: r.name, weight: Math.min(9 + Math.log2(1 + r.mine) * 3, 26),
      meta: { commits: r.mine, langs: r.langs.slice(0, 3), tools: r.tools, files: r.files, branch: r.branch, last: r.last, path: r.path } });
    edges.push({ source: "me", target: rid });
    for (const L of r.langs.slice(0, 3)) { const id = "lang:" + L; add({ id, type: "lang", label: L, weight: 15 }); edges.push({ source: rid, target: id }); }
    for (const T of r.tools) { const id = "tool:" + T; add({ id, type: "tool", label: T, weight: 12 }); edges.push({ source: rid, target: id }); }
  }
  const out = { nodes, edges, stats: {
    repos: repos.length,
    languages: nodes.filter((n) => n.type === "lang").length,
    tools: nodes.filter((n) => n.type === "tool").length,
    commits: repos.reduce((s, r) => s + r.mine, 0),
    files: repos.reduce((s, r) => s + (r.files || 0), 0),
    base: BASE,
  } };
  LAST_MAP = out;
  return out;
}
// Local detail for a clicked node (no AI).
function nodeDetail(id) {
  const map = LAST_MAP || buildMap();
  if (id === "me") { const n = map.nodes.find((x) => x.id === "me"); return { type: "person", label: (n && n.label) || "You", stats: map.stats }; }
  if (id.startsWith("repo:")) {
    const path = id.slice(5); const n = map.nodes.find((x) => x.id === id); const m = (n && n.meta) || {};
    return {
      type: "repo", label: n ? n.label : path.split("/").pop(), path,
      branch: sh(`git -C ${JSON.stringify(path)} rev-parse --abbrev-ref HEAD 2>/dev/null`).trim(),
      dirty: sh(`git -C ${JSON.stringify(path)} status --porcelain 2>/dev/null`).split("\n").filter(Boolean).length,
      last: sh(`git -C ${JSON.stringify(path)} log -1 --format=%cd --date=short 2>/dev/null`).trim(),
      commits: m.commits || 0, langs: m.langs || [], tools: m.tools || [],
    };
  }
  if (id.startsWith("lang:") || id.startsWith("tool:")) {
    const n = map.nodes.find((x) => x.id === id);
    const repos = map.edges.filter((e) => e.target === id).map((e) => { const r = map.nodes.find((x) => x.id === e.source); return r ? r.label : null; }).filter(Boolean);
    return { type: id.startsWith("lang:") ? "lang" : "tool", label: n ? n.label : id.split(":")[1], repos };
  }
  return { error: "unknown node" };
}
// AI review of one repo: what it does, what it's for, possible upgrades.
async function repoReview(path) {
  if (!resolveProvider()) return { error: "not-connected" };
  if (!path) return { error: "no repo" };
  const name = path.split("/").pop();
  const auth = authorship(path), state = repoState(path), rd = readmeInfo(path), shape = repoShape(path), rules = houseRules(path);
  const commits = sh(`git -C ${JSON.stringify(path)} log ${authorArgs(auth.emails)} --format='%ad %s' --date=short -50 2>/dev/null`).trim()
    || sh(`git -C ${JSON.stringify(path)} log --format='%ad %s' --date=short -50 2>/dev/null`).trim();
  const footer = reportFooter(path, auth, state, rd);
  const system =
    `You are reviewing one software project for its owner. Respond with ONLY a JSON object (no fences, no prose outside it): {"review": string, "ideas": string[]}. ` +
    `"review": 3-6 sentences on what it does and who it's for. "ideas": 3-6 short, concrete upgrade items, each a single actionable phrase. ` +
    `Ground every claim in the evidence below and tie it to real files/commits. Recent commits are MORE current than the README — when they disagree, trust the commits. ` +
    `Never propose building something that already appears in the structure. Never advise against anything the conventions call intentional. ` +
    (state.stale ? `CRITICAL: the working tree is a STALE/old checkout, not new work — never suggest committing it (it would revert history). ` : ``);
  const prompt =
    `Project: ${name}\nBranch ${state.branch} · ${auth.total} commits total (${auth.mineCount} yours${auth.filterDropped ? ", filter dropped so counting everyone" : ""})\n\n` +
    (rd.file ? `README (last changed ${rd.lastDate || "?"}, ${rd.commitsAgo} commits ago — may be out of date):\n${rd.excerpt}\n\n` : "(no README)\n\n") +
    `Structure (top folders · file counts): ${shape.dirs.join(", ")}\nManifests: ${shape.manifests.join(", ") || "none"}\nDocs present: ${shape.docs.join(", ") || "none"}\n\n` +
    `Recent commits (newest first):\n${commits || "(none)"}\n\n` +
    (rules ? `Conventions this team has chosen — do NOT advise against these:\n${rules}\n\n` : "") +
    (state.stale ? `Working tree: STALE (≈ ${state.staleBy ? "HEAD~" + state.staleBy : "older"}); its "changes" are the gap to an old snapshot, not new work.\n\n` : "") +
    `Return the JSON.`;
  const raw = await write(system, prompt);
  if (!raw) return { text: "(couldn't reach the model)", ideas: [], footer };
  const j = extractJson(raw);
  if (j && (j.review || j.ideas)) return { text: String(j.review || "").trim() || raw, ideas: Array.isArray(j.ideas) ? j.ideas.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [], footer };
  return { text: raw, ideas: [], footer };
}
function extractJson(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
// AI "value" suggestions for one repo, from its recent commits + open work.
async function repoSuggest(path) {
  if (!resolveProvider()) return { error: "not-connected" };
  if (!path) return { error: "no repo" };
  const name = path.split("/").pop();
  const auth = authorship(path), state = repoState(path), rd = readmeInfo(path), rules = houseRules(path);
  const recent = sh(`git -C ${JSON.stringify(path)} log ${authorArgs(auth.emails)} --format='%ad %s' --date=short -50 2>/dev/null`).trim()
    || sh(`git -C ${JSON.stringify(path)} log --format='%ad %s' --date=short -50 2>/dev/null`).trim();
  const open = openWork([{ path, name }]);
  const footer = reportFooter(path, auth, state, rd);
  const system =
    `You are a pragmatic senior engineer advising on one project. Write exactly three short sections with headings: ` +
    `"In flight" (what's clearly underway), "Next steps" (3-5 concrete actions), "Ideas" (2-3 that fit where this is heading). ` +
    `Ground each point in the evidence; recent commits beat the README. Do not advise against the stated conventions. ` +
    (state.stale ? `CRITICAL: the working tree is a STALE checkout — never suggest committing it (would revert history). ` : ``) +
    `No filler, no preamble.`;
  const prompt =
    `Project: ${name} (branch ${state.branch}, ${auth.total} commits, ${auth.mineCount} yours${auth.filterDropped ? " — filter dropped" : ""}).\n\n` +
    `Recent commits:\n${recent || "(none)"}\n\nOpen / unfinished:\n${open.length ? open.map((o) => "- " + o).join("\n") : "(none found)"}\n\n` +
    (rules ? `Conventions — do NOT advise against these:\n${rules}\n\n` : "") + `Give the advice.`;
  const text = await write(system, prompt);
  return { text: text || "(couldn't reach the model)", footer };
}

// Build a write-up for a command; returns { text, sub, error? } without printing.
// Shared by the CLI (cmdRun) and the web UI (symbiot app).
async function produce(cmd) {
  if (!resolveProvider()) return { error: "not-connected" };
  if (cmd === "todo") {
    const repos = findRepos(BASE, 60);
    const open = openWork(repos);
    if (!open.length) return { text: "Nothing outstanding found (no TODOs or uncommitted work).", sub: "0 open items · todo" };
    const system =
      `You summarise what's still on a developer's plate from their TODO markers and uncommitted work. ` +
      `Group by project, lead with what looks most in-flight (uncommitted work) then the to-dos. ` +
      `Be concise and concrete. No preamble.`;
    const text = await write(system, `Open work:\n${open.map((o) => `- ${o}`).join("\n")}\n\nWhat's still on my plate?`);
    return { text: text || "(couldn't reach the model)", sub: `${open.length} open items · todo`, footer: `symbiot ${VERSION} · ${repos.length} repos scanned · ${open.length} open items` };
  }
  const label = cmd === "standup" ? "standup" : "week";
  const days = cmd === "standup" ? 2 : SINCE_WEEK;
  const who = me();
  const repos = findRepos(BASE, days);
  if (!repos.length) return { text: `No git activity in the last ${days} days under ${BASE}.\nPoint it at your repos with --dir.`, sub: "no activity" };
  let cs = commits(repos, `${days} days ago`, !has("all"));
  if (!cs.length) cs = commits(repos, `${days} days ago`, false); // fall back to all if none matched you
  const open = label === "week" ? openWork(repos) : [];
  if (!cs.length) return { text: "Found repos, but no commits in the window.", sub: "no commits" };

  const system =
    `You write a short, first-person work update from a person's git commits. ` +
    `Write as them ("I"), plainly and specifically, grouped by theme or project, most important first. ` +
    `Turn commit messages into outcomes a manager or teammate would understand — not a raw commit list. ` +
    `${label === "standup" ? "Keep it to 3-5 bullets: done, and what's next." : "A short paragraph or a few grouped bullets; end with a one-line 'In progress / next' if there are open items."} ` +
    `No preamble, no sign-off, no invented work — only what the commits and open items show.`;
  const prompt =
    `Person: ${who.name || "me"}. Window: ${label === "standup" ? "since yesterday" : `last ${days} days`}.\n\n` +
    `Commits:\n${renderCommits(cs)}\n\n` +
    (open.length ? `Open / in progress:\n${open.map((o) => `- ${o}`).join("\n")}\n\n` : "") +
    `Write the ${label === "standup" ? "standup" : "update"}.`;

  const text = await write(system, prompt);
  return { text: text || "(couldn't reach the model)", sub: `${cs.length} commits across ${new Set(cs.map((x) => x.repo)).size} repos · ${label}`, footer: `symbiot ${VERSION} · ${repos.length} repos scanned · ${cs.length} commits (yours) in last ${days}d` };
}

async function cmdRun(cmd) {
  if (!resolveProvider()) { console.log(AUTH_HELP); return; }
  const r = await produce(cmd);
  header(r.sub || cmd);
  if (r.text) console.log(r.text + "\n");
  if (r.footer) console.log(c.d(r.footer) + "\n");
}

// Save a provider connection (used by the web Settings panel); mirrors cmdLogin.
async function connectProvider(b) {
  const provider = b && b.provider;
  if (!PROVIDERS[provider]) return { ok: false, message: "Unknown provider." };
  const cfg = loadConfig();
  if (provider === "ollama") {
    const baseUrl = (b.baseUrl || "http://localhost:11434").trim();
    const model = (b.model || "").trim() || PROVIDERS.ollama.model;
    if (!(await validate("ollama", { baseUrl }))) return { ok: false, message: `Couldn't reach Ollama at ${baseUrl}. Is it running?` };
    cfg.provider = "ollama"; cfg.ollama = { baseUrl, model }; delete cfg.apiKey;
    return saveConfig(cfg) ? { ok: true, message: `Connected: ${PROVIDERS.ollama.label} · ${model}` } : { ok: false, message: "Couldn't write the config file." };
  }
  const key = (b.key || "").trim();
  if (!key) return { ok: false, message: "No key entered." };
  const model = (b.model || "").trim() || PROVIDERS[provider].model;
  if (!(await validate(provider, { key }))) return { ok: false, message: `That key didn't work for ${PROVIDERS[provider].label}.` };
  cfg.provider = provider; cfg[provider] = { apiKey: key, model }; delete cfg.apiKey;
  return saveConfig(cfg) ? { ok: true, message: `Connected: ${PROVIDERS[provider].label} · ${model}` } : { ok: false, message: "Couldn't write the config file." };
}

function saveAndReport(cfg, what) {
  if (saveConfig(cfg)) {
    console.log(c.g("✓ ") + `Connected: ${what}. Try:  ` + c.b("symbiot week"));
    console.log(c.d(`  Saved in ${CONFIG_PATH} (readable only by you).`));
  } else console.log(c.y("Couldn't write the config file at " + CONFIG_PATH));
}

async function cmdLogin() {
  const flagProvider = flag("provider", null);
  const existing = resolveProvider();
  if (existing && !flagProvider && !flag("key", null) && !has("force")) {
    console.log(c.g("✓ ") + `Already connected — ${PROVIDERS[existing.provider].label} via ${existing.source}.`);
    console.log(c.d("  Switch or replace it with `symbiot login --force`."));
    return;
  }

  let provider = flagProvider;
  if (!provider) {
    console.log("\n" + c.b("Connect Symbiot") + "\n");
    console.log("Which AI should Symbiot write your updates with?\n");
    console.log("  1) " + PROVIDERS.anthropic.label + c.d("    — needs an Anthropic API key"));
    console.log("  2) " + PROVIDERS.openai.label + c.d("          — needs an OpenAI API key"));
    console.log("  3) " + PROVIDERS.gemini.label + c.d("       — needs a Google AI API key"));
    console.log("  4) " + PROVIDERS.ollama.label + c.d("  — runs on your machine, no key"));
    const pick = (await ask("\nChoose 1-4 [1]: ")) || "1";
    provider = { 1: "anthropic", 2: "openai", 3: "gemini", 4: "ollama" }[pick] || (PROVIDERS[pick] ? pick : "anthropic");
  }
  if (!PROVIDERS[provider]) { console.log(c.y("Unknown provider: " + provider)); return; }
  const meta = PROVIDERS[provider];
  const cfg = loadConfig();

  if (provider === "ollama") {
    const baseUrl = (flag("base-url", null) || (await ask("Ollama URL [http://localhost:11434]: ")) || "").trim() || "http://localhost:11434";
    const model = (flag("model", null) || (await ask(`Model name [${meta.model}]: `)) || "").trim() || meta.model;
    const stop = spinner("checking Ollama…");
    const ok = await validate("ollama", { baseUrl });
    stop();
    if (!ok) { console.log(c.y(`Couldn't reach Ollama at ${baseUrl}. `) + c.d("Is it running?  (try: ollama serve)")); process.exitCode = 1; return; }
    cfg.provider = "ollama"; cfg.ollama = { baseUrl, model }; delete cfg.apiKey;
    saveAndReport(cfg, `${meta.label} · ${model}`);
    return;
  }

  console.log("\n" + c.b(`Connect ${meta.label}`) + "\n" + c.d(`  Get a key at:  ${meta.keyUrl}`) + "\n");
  let key = flag("key", null);
  if (!key) key = await ask(`Paste your ${meta.keyName}: `, { secret: true });
  key = (key || "").trim();
  if (!key) { console.log(c.y("No key entered — nothing saved.")); return; }
  const model = (flag("model", null) || "").trim() || meta.model;

  const stop = spinner("checking the key…");
  const ok = await validate(provider, { key });
  stop();
  if (!ok) {
    console.log(c.y(`That key didn't work for ${meta.label}. `) + c.d("Double-check it and run `symbiot login` again."));
    process.exitCode = 1;
    return;
  }
  cfg.provider = provider; cfg[provider] = { apiKey: key, model }; delete cfg.apiKey;
  saveAndReport(cfg, `${meta.label} · ${model}`);
}

function cmdLogout() {
  const cfg = loadConfig();
  const had = cfg.provider || cfg.apiKey || Object.keys(PROVIDERS).some((p) => cfg[p]);
  delete cfg.provider; delete cfg.apiKey;
  for (const p of Object.keys(PROVIDERS)) delete cfg[p];
  saveConfig(cfg);
  console.log(had ? c.g("✓ ") + `Cleared saved credentials from ${CONFIG_PATH}.` : "No saved credentials to remove.");
  const envs = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"].filter((e) => process.env[e]);
  if (envs.length) console.log(c.d(`Note: still set in your environment: ${envs.join(", ")}.`));
}

function cmdWhoami() {
  const r = resolveProvider();
  if (r) console.log(c.g("✓ ") + `Connected: ${PROVIDERS[r.provider].label} · model ${r.model} · via ${r.source}.`);
  else { console.log(c.y("Not connected yet.\n")); console.log(AUTH_HELP); }
}

// ---- `symbiot app` : the same UI in a chrome-less browser window ----------
// Self-contained HTML served at / — no backticks or ${} inside (it lives in a
// template literal). Talks to the local API with the per-launch token.
const EMBEDDED_UI = `<!doctype html><html><head><meta charset="utf8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Symbiot</title>
<style>
:root{--ink:#0E1A1F;--ink2:#15262C;--ink3:#1D333A;--line:#24404A;--bone:#F4F1EA;--text:#B7C9C4;--faint:#7E9690;--green:#3DDC97;--amber:#F2A541;--green-dim:#16322D;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--ink);color:var(--text);font-family:var(--sans);font-size:14px;display:flex;flex-direction:column}
header{padding:16px 18px 10px;display:flex;align-items:center;gap:10px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}
.brand{font-weight:700;color:var(--bone);font-size:16px}
.status{margin-left:auto;font-size:12px;color:var(--faint);text-align:right;max-width:52%}
.tabs{display:flex;gap:6px;padding:0 14px;border-bottom:1px solid var(--line)}
.tab{padding:9px 14px;border:0;background:none;color:var(--faint);font:inherit;font-weight:600;cursor:pointer;border-bottom:2px solid transparent}
.tab.active{color:var(--bone);border-bottom-color:var(--green)}
main{flex:1;overflow:auto;padding:16px 18px}
.row{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
button.act{background:var(--green);color:var(--ink);border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}
button.act:hover{filter:brightness(1.08)}
button.ghost{background:var(--ink3);color:var(--bone);border:1px solid var(--line);border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer}
button.ghost:hover{border-color:var(--faint)}
.out{white-space:pre-wrap;background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:16px;min-height:180px;color:var(--bone);line-height:1.6}
.muted{color:var(--faint)}
label{display:block;font-size:12px;color:var(--faint);margin:14px 0 5px}
select,input{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:var(--bone);font:inherit}
select:focus,input:focus{outline:none;border-color:var(--green)}
a{color:var(--green);cursor:pointer}.hidden{display:none}
.note{font-size:12px;margin-top:10px}.ok{color:var(--green)}.err{color:var(--amber)}
footer{padding:10px 18px;border-top:1px solid var(--line);display:flex}
.profile{font-size:13px;margin-bottom:8px;line-height:1.5}
.profile b{color:var(--bone)}
.maprow{display:flex;gap:12px;align-items:stretch}
#graph{flex:1;width:100%;height:62vh;min-height:340px;background:var(--ink2);border:1px solid var(--line);border-radius:12px;touch-action:none;cursor:grab}
#graph:active{cursor:grabbing}
#graph text{font-family:var(--sans);fill:var(--text);font-size:11px;pointer-events:none}
#graph .lbl-me{fill:var(--bone);font-weight:700;font-size:13px}
.detail{width:290px;flex:none;background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto;max-height:62vh}
.detail h3{margin:0 0 4px;color:var(--bone);font-size:15px}
.detail .k{font-size:12px;color:var(--faint);margin-top:8px}
.detail ul{margin:6px 0 0;padding-left:18px}.detail li{margin:2px 0}
.detail .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.tag{display:inline-flex;font-size:11px;padding:4px 9px;border-radius:999px;background:var(--green-dim);border:1px solid #2a6b52;color:var(--green)}
.mapbar{margin-top:8px;font-size:12.5px;color:var(--text);background:var(--ink3);border:1px solid var(--line);border-radius:9px;padding:9px 12px;min-height:18px;font-family:ui-monospace,Menlo,Consolas,monospace}
.mapbar b{color:var(--bone)}
.review{margin-top:12px;background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:16px;min-height:120px}
.review h4{margin:0 0 8px;color:var(--green);font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700}
.review .body{color:var(--text);line-height:1.65;font-size:14px;white-space:pre-wrap}
.review .rname{color:var(--bone);font-weight:600}
.rfoot{margin-top:12px;font-size:11px;color:var(--faint);font-family:ui-monospace,Menlo,Consolas,monospace;border-top:1px solid var(--line);padding-top:8px;line-height:1.5}
.ideas{margin-top:14px}
.ideas h4{margin:0 0 6px;color:var(--amber);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
.idea{display:flex;align-items:flex-start;gap:9px;padding:5px 0;font-size:13.5px;color:var(--text)}
.idea input{margin-top:3px;flex:none;width:15px;height:15px;cursor:pointer}
.task{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;margin-top:8px;background:var(--ink2)}
.task input[type=checkbox]{width:16px;height:16px;flex:none;cursor:pointer}
.task .t{flex:1}.task.done .t{color:var(--faint);text-decoration:line-through}
.task .rp{font-size:11px;color:var(--faint);background:var(--ink3);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.task .rm{background:none;border:0;color:var(--faint);cursor:pointer;font-size:18px;line-height:1}
.task .rm:hover{color:var(--amber)}
.drift{border:1px solid var(--line);border-radius:10px;margin-top:10px;padding:12px 14px;background:var(--ink2)}
.drift .dh{display:flex;gap:8px;align-items:center}
.drift .dn{color:var(--bone);font-weight:600}
.drift .dd{color:var(--faint);font-size:12px}
.drift ul{margin:8px 0 0;padding:0;list-style:none}
.drift li{padding:3px 0;font-size:13.5px}
.drift li.warn{color:var(--amber)}
.drift .ev{color:var(--faint);font-family:ui-monospace,Menlo,monospace;font-size:11px}
.dot-w{width:9px;height:9px;border-radius:50%;background:var(--amber);display:inline-block}
.dot-c{width:9px;height:9px;border-radius:50%;background:var(--green);display:inline-block}
.out2{white-space:pre-wrap;background:var(--ink);border:1px solid var(--line);border-radius:9px;padding:10px;margin-top:10px;font-size:13px;line-height:1.55;color:var(--bone)}
.legend{display:flex;gap:14px;align-items:center;margin-top:10px;font-size:12px;color:var(--faint);flex-wrap:wrap}
.lg{display:inline-flex;gap:6px;align-items:center}
.lg i{width:10px;height:10px;border-radius:50%;display:inline-block}
@media(max-width:760px){.maprow{flex-direction:column}.detail{width:auto;max-height:none}}
</style></head><body>
<header><span class="dot"></span><span class="brand">Symbiot</span><span class="status" id="status">...</span></header>
<div class="tabs">
<button class="tab active" data-tab="map">Map</button>
<button class="tab" data-tab="drift">Drift</button>
<button class="tab" data-tab="week">Week</button>
<button class="tab" data-tab="standup">Standup</button>
<button class="tab" data-tab="todo">Todo</button>
<button class="tab" data-tab="tasks">Tasks</button>
<button class="tab" data-tab="settings">Settings</button>
</div>
<main>
<section id="panel-map">
<div class="profile muted" id="profile">Mapping your work&hellip;</div>
<div class="maprow">
<svg id="graph" viewBox="0 0 960 620" preserveAspectRatio="xMidYMid meet"></svg>
<aside id="detail" class="detail hidden"></aside>
</div>
<div id="mapbar" class="mapbar">Hover a node for a summary &middot; click for details &middot; drag to move</div>
<div class="legend">
<span class="lg"><i style="background:var(--green)"></i>you</span>
<span class="lg"><i style="background:var(--bone)"></i>repos</span>
<span class="lg"><i style="background:var(--amber)"></i>languages</span>
<span class="lg"><i style="background:#6bb3ff"></i>tools</span>
<span class="muted" style="margin-left:8px">scroll to zoom &middot; drag to pan &middot; click a node</span>
<button class="ghost" id="remap" style="margin-left:auto">Rescan</button>
</div>
<div id="review" class="review hidden"></div>
</section>
<section id="panel-run" class="hidden">
<div class="row"><button class="act" id="write">Write my <span id="what">week</span></button>
<button class="ghost hidden" id="copy">Copy</button>
<span class="muted">Reads your local git and writes it up.</span></div>
<div class="out muted" id="out">Nothing yet - hit the button.</div>
<div class="rfoot" id="outfoot" style="display:none"></div>
</section>
<section id="panel-tasks" class="hidden">
<div class="row"><input id="newtask" placeholder="Add a task..." style="flex:1"><button class="act" id="addtask">Add</button></div>
<div id="tasklist"></div>
</section>
<section id="panel-drift" class="hidden">
<div class="row"><span class="muted">What's out of sync, stuck or at risk across your repos — local git facts.</span>
<label class="muted" style="margin-left:auto"><input type="checkbox" id="driftfetch"> fetch latest</label>
<label class="muted"><input type="checkbox" id="driftci"> check CI (needs gh)</label>
<button class="ghost" id="driftrun">Rescan</button></div>
<div id="driftout"></div>
</section>
<section id="panel-settings" class="hidden">
<label>Which AI should Symbiot write with?</label>
<select id="provider">
<option value="anthropic">Claude (Anthropic)</option>
<option value="openai">OpenAI (GPT)</option>
<option value="gemini">Gemini (Google)</option>
<option value="ollama">Local model (Ollama) - free, no key</option>
</select>
<div class="note muted">The Map above needs no key. For the write-ups, a hosted model needs an API key - or run <b>Ollama</b> locally for a free, private option (nothing leaves your machine).</div>
<div id="keyWrap"><label>API key</label><input id="key" type="password" placeholder="paste your key">
<div class="note"><a id="getkey">Where do I get a key?</a></div></div>
<div id="baseWrap" class="hidden"><label>Ollama URL</label><input id="baseUrl" type="text" value="http://localhost:11434"></div>
<label>Model <span class="muted" id="modelHint"></span></label>
<input id="model" type="text" placeholder="(blank = default)">
<div class="row" style="margin-top:16px"><button class="act" id="save">Save &amp; connect</button>
<span class="note" id="saveMsg"></span></div>
<div style="margin-top:20px;border-top:1px solid var(--line);padding-top:16px">
<button class="ghost" id="recbtn">Recommend models for my machine</button>
<div id="recout" style="margin-top:12px"></div>
</div>
</section>
</main>
<footer><button class="ghost" id="quit" style="margin-left:auto">Quit</button></footer>
<script>
var T=new URLSearchParams(window.location.search).get('t')||'';
function api(path,body){return fetch(path,{method:body?'POST':'GET',headers:{'x-symbiot-token':T,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json();});}
var KEYURL={anthropic:'https://console.anthropic.com/settings/keys',openai:'https://platform.openai.com/api-keys',gemini:'https://aistudio.google.com/apikey',ollama:'https://ollama.com'};
var DEFMODEL={anthropic:'claude-opus-5-5',openai:'gpt-4o-mini',gemini:'gemini-1.5-flash',ollama:'llama3.1'};
function $(id){return document.getElementById(id);}
var current='map';var mapLoaded=false;var driftLoaded=false;
var COLORS={person:'#3DDC97',repo:'#F4F1EA',lang:'#F2A541',tool:'#6bb3ff'};
function tabs(){return document.querySelectorAll('.tab');}
function setTab(tab){current=tab;tabs().forEach(function(t){t.classList.toggle('active',t.dataset.tab===tab);});
var isMap=tab==='map',isSet=tab==='settings',isTasks=tab==='tasks',isDrift=tab==='drift',isRun=(tab==='week'||tab==='standup'||tab==='todo');
$('panel-map').classList.toggle('hidden',!isMap);
$('panel-run').classList.toggle('hidden',!isRun);
$('panel-settings').classList.toggle('hidden',!isSet);
$('panel-tasks').classList.toggle('hidden',!isTasks);
$('panel-drift').classList.toggle('hidden',!isDrift);
if(isRun){$('what').textContent=tab;$('out').textContent='Nothing yet - hit the button.';$('out').classList.add('muted');$('copy').classList.add('hidden');}
if(isMap&&!mapLoaded)loadMap();
if(isTasks)loadTasks();
if(isDrift&&!driftLoaded)loadDrift();}
tabs().forEach(function(t){t.addEventListener('click',function(){setTab(t.dataset.tab);});});
function refresh(){api('/api/status').then(function(s){$('status').textContent=s.connected?s.line:'Not connected - open Settings';});}
$('write').addEventListener('click',function(){$('out').textContent='Writing...';$('out').classList.add('muted');$('copy').classList.add('hidden');
api('/api/run',{cmd:current}).then(function(r){var f=$('outfoot');if(r.error==='not-connected'){$('out').textContent='Not connected yet - open Settings and pick an AI.';f.style.display='none';return;}
$('out').textContent=r.text||'(no output)';$('out').classList.remove('muted');$('copy').classList.remove('hidden');if(r.footer){f.textContent=r.footer;f.style.display='block';}else{f.style.display='none';}});});
$('copy').addEventListener('click',function(){navigator.clipboard.writeText($('out').textContent);$('copy').textContent='Copied';setTimeout(function(){$('copy').textContent='Copy';},1400);});
function syncP(){var p=$('provider').value;var local=p==='ollama';$('keyWrap').classList.toggle('hidden',local);$('baseWrap').classList.toggle('hidden',!local);
$('getkey').textContent=local?'About Ollama':'Where do I get a key?';$('modelHint').textContent='(default '+DEFMODEL[p]+')';$('model').placeholder='(blank = '+DEFMODEL[p]+')';}
$('provider').addEventListener('change',syncP);
$('getkey').addEventListener('click',function(){window.open(KEYURL[$('provider').value],'_blank');});
$('save').addEventListener('click',function(){var p=$('provider').value;$('saveMsg').textContent='checking...';$('saveMsg').className='note muted';
var cfg={provider:p,model:$('model').value.trim()};if(p==='ollama')cfg.baseUrl=$('baseUrl').value.trim();else cfg.key=$('key').value.trim();
api('/api/connect',cfg).then(function(r){$('saveMsg').textContent=r.message||(r.ok?'Connected.':'Could not connect.');$('saveMsg').className='note '+(r.ok?'ok':'err');if(r.ok){$('key').value='';refresh();}});});
$('quit').addEventListener('click',function(){api('/api/quit');document.body.innerHTML='<div style=\\'padding:40px;color:#7E9690;font-family:sans-serif\\'>Symbiot stopped. You can close this window.</div>';});
var GRAPH=null,sel=null,view={k:1,x:0,y:0},GW=960,GH=620;
function esc(s){return String(s).replace(/[&<>]/g,function(ch){return ch==='&'?'&amp;':ch==='<'?'&lt;':'&gt;';});}
function layout(nodes,edges){var idx={};nodes.forEach(function(n){n.x=GW/2+(Math.random()-0.5)*GW*0.8;n.y=GH/2+(Math.random()-0.5)*GH*0.8;n.vx=0;n.vy=0;idx[n.id]=n;});
for(var it=0;it<340;it++){for(var i=0;i<nodes.length;i++)for(var j=i+1;j<nodes.length;j++){var a=nodes[i],b=nodes[j];var dx=a.x-b.x,dy=a.y-b.y;var d2=dx*dx+dy*dy+0.01;var d=Math.sqrt(d2);var f=4600/d2;a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;}
edges.forEach(function(e){var a=idx[e.source],b=idx[e.target];if(!a||!b)return;var dx=b.x-a.x,dy=b.y-a.y;var d=Math.sqrt(dx*dx+dy*dy)+0.01;var f=(d-115)*0.03;a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;});
nodes.forEach(function(n){n.vx+=(GW/2-n.x)*0.002;n.vy+=(GH/2-n.y)*0.002;n.x+=Math.max(-9,Math.min(9,n.vx));n.y+=Math.max(-9,Math.min(9,n.vy));n.vx*=0.86;n.vy*=0.86;n.x=Math.max(30,Math.min(GW-30,n.x));n.y=Math.max(24,Math.min(GH-28,n.y));});}}
function nbrs(id){var s={};s[id]=1;GRAPH.edges.forEach(function(e){if(e.source===id)s[e.target]=1;if(e.target===id)s[e.source]=1;});return s;}
function render(){if(!GRAPH)return;var idx={};GRAPH.nodes.forEach(function(n){idx[n.id]=n;});var nb=sel?nbrs(sel):null;
var s="<g id='vp' transform='translate("+view.x.toFixed(1)+","+view.y.toFixed(1)+") scale("+view.k.toFixed(3)+")'>";
GRAPH.edges.forEach(function(e){var a=idx[e.source],b=idx[e.target];if(!a||!b)return;var op=nb?((nb[e.source]&&nb[e.target])?0.75:0.06):0.45;s+="<line x1='"+a.x.toFixed(1)+"' y1='"+a.y.toFixed(1)+"' x2='"+b.x.toFixed(1)+"' y2='"+b.y.toFixed(1)+"' stroke='#24404A' stroke-width='1' opacity='"+op+"'/>";});
GRAPH.nodes.forEach(function(n){var r=Math.max(5,Math.sqrt(n.weight)*2);var col=COLORS[n.type]||"#888";var op=nb?(nb[n.id]?1:0.14):0.95;var st=(n.id===sel)?" stroke='#F4F1EA' stroke-width='2'":"";var title=esc(n.label)+(n.meta?(" - "+(n.meta.commits||0)+" commits"):"");
s+="<g class='node' data-id='"+esc(n.id)+"' opacity='"+op+"'><circle cx='"+n.x.toFixed(1)+"' cy='"+n.y.toFixed(1)+"' r='"+r.toFixed(1)+"' fill='"+col+"'"+st+"><title>"+title+"</title></circle>";
var cls=n.type==="person"?"lbl-me":"";s+="<text x='"+n.x.toFixed(1)+"' y='"+(n.y+r+12).toFixed(1)+"' text-anchor='middle' class='"+cls+"'>"+esc(n.label)+"</text></g>";});
document.getElementById("graph").innerHTML=s+"</g>";}
function profileLine(g){var repos=g.nodes.filter(function(n){return n.type==="repo";});var base=g.stats.base||"your home folder";if(!repos.length)return "No git repositories found under "+esc(base)+" yet.";var langs=g.nodes.filter(function(n){return n.type==="lang";}).map(function(n){return n.label;});var top=repos.slice().sort(function(a,b){return (b.meta.commits||0)-(a.meta.commits||0);})[0];var s="Scanned <b>"+esc(base)+"</b> &middot; <b>"+g.stats.repos+"</b> repos &middot; <b>"+g.stats.commits+"</b> of your commits &middot; <b>"+(g.stats.files||0)+"</b> files &middot; ";s+=langs.length?("mostly <b>"+esc(langs.slice(0,3).join(", "))+"</b>"):"no languages detected";if(top)s+=" &middot; most active: <b>"+esc(top.label)+"</b>";return s;}
function nodeById(id){for(var i=0;i<GRAPH.nodes.length;i++)if(GRAPH.nodes[i].id===id)return GRAPH.nodes[i];return null;}
function summarize(n){if(!n)return "";if(n.type==='repo'){var m=n.meta||{};var bits=[m.commits+' commits'];if(m.branch)bits.push('branch '+m.branch);if(m.last)bits.push('last '+m.last);if(typeof m.files==='number')bits.push(m.files+' files');if(m.langs&&m.langs.length)bits.push(m.langs.join(', '));if(m.tools&&m.tools.length)bits.push(m.tools.join(', '));return "<b>"+esc(n.label)+"</b>  "+esc(m.path||'')+"  —  "+esc(bits.join('  ·  '));}if(n.type==='lang')return "<b>"+esc(n.label)+"</b>  —  language (click to see repos)";if(n.type==='tool')return "<b>"+esc(n.label)+"</b>  —  tool (click to see repos)";if(n.type==='person')return "<b>"+esc(n.label)+"</b>  —  you";return "<b>"+esc(n.label)+"</b>";}
function updateBar(id){var bar=document.getElementById('mapbar');if(!bar)return;var n=id?nodeById(id):(sel?nodeById(sel):null);bar.innerHTML=n?summarize(n):"Hover a node for a summary &middot; click for details &middot; drag to move";}
function hideDetail(){document.getElementById('detail').classList.add('hidden');}
function showDetail(d){var el=document.getElementById('detail');el.classList.remove('hidden');
if(d.error){el.innerHTML="<h3>&mdash;</h3><div class='k'>"+esc(d.error)+"</div>";return;}
if(d.type==='repo'){var chips="";['branch: '+(d.branch||'?'),d.commits+' commits',(d.dirty?d.dirty+' uncommitted':'clean'),(d.last?'last '+d.last:'')].concat(d.langs||[]).concat(d.tools||[]).forEach(function(x){if(x)chips+="<span class='tag'>"+esc(x)+"</span>";});
el.innerHTML="<h3>"+esc(d.label)+"</h3><div class='chips'>"+chips+"</div><button class='act' id='suggest' style='margin-top:12px'>Suggest next steps</button><div id='sugout'></div>";
document.getElementById('suggest').addEventListener('click',function(){var o=document.getElementById('sugout');o.innerHTML="<div class='out2'>Thinking...</div>";api('/api/suggest',{path:d.path}).then(function(r){if(r.error==='not-connected'){o.innerHTML="<div class='out2'>Connect a model in Settings to get suggestions - Ollama is free and runs locally.</div>";return;}o.innerHTML="<div class='out2'>"+esc(r.text||'(no output)')+"</div>"+(r.footer?"<div class='rfoot'>"+esc(r.footer)+"</div>":"");});});return;}
if(d.type==='lang'||d.type==='tool'){var lis=(d.repos||[]).map(function(r){return "<li>"+esc(r)+"</li>";}).join("");el.innerHTML="<h3>"+esc(d.label)+"</h3><div class='k'>Used in "+((d.repos||[]).length)+" repos</div><ul>"+lis+"</ul>";return;}
if(d.type==='person'){var st=d.stats||{};el.innerHTML="<h3>"+esc(d.label)+"</h3><div class='k'>"+st.repos+" repos &middot; "+st.commits+" commits &middot; "+st.languages+" languages &middot; "+st.tools+" tools</div>";return;}}
var reviewCache={};var IDEAS=[];var IREPO="";
function hideReview(){var el=document.getElementById('review');el.classList.add('hidden');el.innerHTML='';}
function reviewHtml(name,body,ideas,tasks,footer){IDEAS=ideas||[];IREPO=name;
var h="<h4>AI review &middot; <span class='rname'>"+esc(name)+"</span></h4><div class='body'>"+esc(body)+"</div>";
if(ideas&&ideas.length){h+="<div class='ideas'><h4>Upgrade ideas &middot; tick to add to Tasks</h4>";
ideas.forEach(function(idea,i){var t=(tasks||[]).filter(function(x){return x.text===idea&&x.repo===name;})[0];var tid=t?t.id:"";
h+="<label class='idea'><input type='checkbox' class='ideachk' data-idx='"+i+"' data-tid='"+esc(tid)+"'"+(t?" checked":"")+"><span>"+esc(idea)+"</span></label>";});
h+="</div>";}
if(footer)h+="<div class='rfoot'>"+esc(footer)+"</div>";
return h;}
function wireIdeas(){document.querySelectorAll('.ideachk').forEach(function(cb){cb.addEventListener('change',function(){
var idea=IDEAS[+cb.getAttribute('data-idx')];if(idea==null)return;
if(cb.checked){api('/api/tasks/add',{text:idea,repo:IREPO}).then(function(it){if(it&&it.id)cb.setAttribute('data-tid',it.id);});}
else{var id=cb.getAttribute('data-tid');if(id){api('/api/tasks/remove',{id:id}).then(function(){cb.setAttribute('data-tid','');});}}});});}
function loadReview(name,path){var el=document.getElementById('review');el.classList.remove('hidden');
if(reviewCache[path]){var c=reviewCache[path];api('/api/tasks').then(function(tasks){el.innerHTML=reviewHtml(name,c.text,c.ideas,tasks,c.footer);wireIdeas();});return;}
el.innerHTML="<h4>AI review &middot; <span class='rname'>"+esc(name)+"</span></h4><div class='body'>Reading the project&hellip;</div>";
Promise.all([api('/api/review',{path:path}),api('/api/tasks')]).then(function(res){var r=res[0]||{},tasks=res[1]||[];
if(r.error==='not-connected'){el.innerHTML="<h4>AI review &middot; <span class='rname'>"+esc(name)+"</span></h4><div class='body'>Connect a model in Settings to get a review - Ollama is free and runs locally.</div>"+(r.footer?"<div class='rfoot'>"+esc(r.footer)+"</div>":"");return;}
var body=r.text||'(no output)';reviewCache[path]={text:body,ideas:r.ideas||[],footer:r.footer};el.innerHTML=reviewHtml(name,body,r.ideas||[],tasks,r.footer);wireIdeas();});}
function renderTasks(list){var el=document.getElementById('tasklist');if(!list||!list.length){el.innerHTML="<div class='muted' style='margin-top:12px'>No tasks yet. Tick an idea in a repo's review, or add one above.</div>";return;}
var h="";list.forEach(function(t){h+="<div class='task"+(t.done?" done":"")+"' data-id='"+esc(t.id)+"'><input type='checkbox' class='taskchk'"+(t.done?" checked":"")+"><span class='t'>"+esc(t.text)+"</span>"+(t.repo?"<span class='rp'>"+esc(t.repo)+"</span>":"")+"<button class='rm' title='remove'>&times;</button></div>";});
el.innerHTML=h;
el.querySelectorAll('.task').forEach(function(row){var id=row.getAttribute('data-id');
row.querySelector('.taskchk').addEventListener('change',function(){api('/api/tasks/toggle',{id:id}).then(function(){row.classList.toggle('done');});});
row.querySelector('.rm').addEventListener('click',function(){api('/api/tasks/remove',{id:id}).then(function(){row.remove();if(!el.querySelector('.task'))renderTasks([]);});});});}
function loadTasks(){api('/api/tasks').then(renderTasks);}
function loadDrift(){var out=document.getElementById('driftout');out.innerHTML="<div class='muted' style='margin-top:12px'>Reading your repos&hellip;</div>";
var ci=document.getElementById('driftci').checked?'1':'0';var ft=document.getElementById('driftfetch').checked?'1':'0';
api('/api/drift?ci='+ci+'&fetch='+ft).then(function(d){driftLoaded=true;var repos=d.repos||[];var risky=repos.filter(function(r){return r.flags.some(function(f){return f.level==='warn';});});
var h="<div class='k' style='margin:10px 0'><b>"+repos.length+"</b> repos &middot; <b>"+risky.length+"</b> with risks</div>";
repos.forEach(function(r){if(!r.flags.length)return;var warn=r.flags.some(function(f){return f.level==='warn';});
h+="<div class='drift'><div class='dh'><span class='"+(warn?'dot-w':'dot-c')+"'></span><span class='dn'>"+esc(r.name)+"</span><span class='dd'>"+esc(r.def)+(r.fetchAgeDays!=null&&r.fetchAgeDays>3?" &middot; fetch "+r.fetchAgeDays+"d old":"")+"</span></div><ul>";
r.flags.forEach(function(f){h+="<li class='"+esc(f.level)+"'>"+(f.level==='warn'?'&#9888; ':'&middot; ')+esc(f.text)+(f.evidence?" <span class='ev'>["+esc(f.evidence)+"]</span>":"")+"</li>";});
h+="</ul></div>";});
var clean=repos.filter(function(r){return !r.flags.length;}).map(function(r){return r.name;});
if(clean.length)h+="<div class='muted' style='margin-top:10px'>clean: "+esc(clean.join(", "))+"</div>";
if(!repos.length)h+="<div class='muted'>No repos found under your home folder.</div>";
out.innerHTML=h;});}
function addTaskUI(){var i=document.getElementById('newtask');var v=(i.value||'').trim();if(!v)return;api('/api/tasks/add',{text:v,repo:''}).then(function(){i.value='';loadTasks();});}
function selectNode(id){sel=id;render();updateBar(id);var n=nodeById(id);api('/api/node?id='+encodeURIComponent(id)).then(showDetail);
if(n&&n.type==='repo'&&n.meta&&n.meta.path){loadReview(n.label,n.meta.path);}else{hideReview();}}
function screenToGraph(el,ev){var rc=el.getBoundingClientRect();var mx=(ev.clientX-rc.left)/rc.width*GW;var my=(ev.clientY-rc.top)/rc.height*GH;return {x:(mx-view.x)/view.k,y:(my-view.y)/view.k};}
function initGraphEvents(){var el=document.getElementById('graph');var mode=null,moved=0,sx=0,sy=0,ox=0,oy=0,downId=null,dnode=null;
function nodeAt(ev){var t=ev.target;var g=t&&t.closest?t.closest('.node'):null;return g?g.getAttribute('data-id'):null;}
el.addEventListener('wheel',function(ev){ev.preventDefault();if(!GRAPH)return;var rc=el.getBoundingClientRect();var mx=(ev.clientX-rc.left)/rc.width*GW;var my=(ev.clientY-rc.top)/rc.height*GH;var nk=Math.max(0.3,Math.min(4,view.k*(ev.deltaY<0?1.12:0.89)));view.x=mx-(mx-view.x)*(nk/view.k);view.y=my-(my-view.y)*(nk/view.k);view.k=nk;render();},{passive:false});
el.addEventListener('pointerdown',function(ev){if(!GRAPH)return;moved=0;sx=ev.clientX;sy=ev.clientY;ox=view.x;oy=view.y;downId=nodeAt(ev);if(downId){mode='node';dnode=nodeById(downId);}else{mode='pan';}try{el.setPointerCapture(ev.pointerId);}catch(e){}});
el.addEventListener('pointermove',function(ev){
if(!mode){updateBar(nodeAt(ev));return;}
var dx=ev.clientX-sx,dy=ev.clientY-sy;moved+=Math.abs(dx)+Math.abs(dy);if(moved<4)return;
if(mode==='node'&&dnode){var p=screenToGraph(el,ev);dnode.x=p.x;dnode.y=p.y;render();}
else if(mode==='pan'){var rc=el.getBoundingClientRect();view.x=ox+dx/rc.width*GW;view.y=oy+dy/rc.height*GH;render();}});
el.addEventListener('pointerup',function(ev){var id=downId,wasClick=moved<6;mode=null;dnode=null;downId=null;
if(id){selectNode(id);}else if(wasClick){sel=null;hideDetail();hideReview();render();updateBar(null);}});
el.addEventListener('mouseleave',function(){if(!mode)updateBar(null);}); }
function loadMap(){var p=document.getElementById("profile");p.textContent="Mapping your work...";document.getElementById("graph").innerHTML="";sel=null;hideDetail();hideReview();api("/api/map").then(function(g){mapLoaded=true;if(!g.nodes||!g.nodes.length){p.textContent="No git repositories found under your home folder.";return;}GRAPH=g;layout(g.nodes,g.edges);view={k:1,x:0,y:0};p.innerHTML=profileLine(g);render();});}
function fitBadge(m){return m.fits?"<span class='tag'>fits your RAM</span>":"<span class='tag' style='background:#3a2a12;border-color:#6b4a1f;color:#F2A541'>needs more RAM</span>";}
function loadRec(){var out=document.getElementById('recout');out.innerHTML="<div class='muted'>Reading your hardware...</div>";
api('/api/models').then(function(d){var hw=d.hardware,rec=d.rec;
var h="<div class='k'><b>"+hw.ramGB+" GB</b> RAM &middot; "+hw.cpuCount+"-core &middot; "+esc(hw.platform)+"/"+esc(hw.arch)+(hw.gpu?" &middot; GPU: "+esc(hw.gpu.name)+(hw.gpu.vramGB?" ("+hw.gpu.vramGB+"GB)":""):"")+"</div>";
h+="<div class='ideas'><h4>Local models &middot; free via Ollama</h4>";
rec.local.forEach(function(m){h+="<div class='idea' style='justify-content:space-between'><span><b>"+esc(m.tier)+"</b> &middot; <code>ollama pull "+esc(m.model)+"</code> <span class='muted'>~"+m.needGB+"GB &middot; "+esc(m.note)+"</span></span> "+fitBadge(m)+"</div>";});
h+="<div class='muted' style='margin-top:6px'>Best fit: <b>"+esc(rec.best)+"</b> &mdash; pull it, then pick <b>Local model (Ollama)</b> above.</div></div>";
h+="<div class='ideas'><h4>Paid models &middot; bring an API key</h4>";
rec.paid.forEach(function(p){h+="<div class='idea'><span><b>"+esc(p.provider)+"</b> &middot; "+esc(p.tier)+" &middot; <code>"+esc(p.model)+"</code> <span class='muted'>&middot; "+esc(p.note)+"</span></span></div>";});
h+="</div>";out.innerHTML=h;});}
document.getElementById('remap').addEventListener('click',loadMap);
document.getElementById('recbtn').addEventListener('click',loadRec);
document.getElementById('driftrun').addEventListener('click',function(){driftLoaded=false;loadDrift();});
document.getElementById('addtask').addEventListener('click',addTaskUI);
document.getElementById('newtask').addEventListener('keydown',function(e){if(e.key==='Enter')addTaskUI();});
initGraphEvents();syncP();refresh();loadMap();
</script></body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (ch) => (d += ch));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
function onPath(cands) { for (const cc of cands) { if (sh(`command -v ${cc} 2>/dev/null`).trim()) return cc; } return null; }
// Find a Chromium-family browser for the chrome-less --app window, per OS.
function chromeBinary() {
  const p = process.platform;
  const exists = (f) => { try { return existsSync(f) ? f : null; } catch { return null; } };
  if (p === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"].map(exists).find(Boolean) || null;
  }
  if (p === "win32") {
    const bases = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const rels = ["Google\\Chrome\\Application\\chrome.exe", "Chromium\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    for (const base of bases) for (const r of rels) { const f = exists(join(base, r)); if (f) return f; }
    const w = sh("where chrome 2>NUL").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return w || null;
  }
  return onPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"]);
}
function openApp(url) {
  try {
    const chrome = chromeBinary();
    if (chrome) { spawn(chrome, [`--app=${url}`, "--new-window"], { detached: true, stdio: "ignore" }).unref(); return "app window"; }
    // fall back to the OS default browser (a normal tab) — still fully functional
    if (process.platform === "win32") { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); return "browser tab"; }
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    return "browser tab";
  } catch { return null; }
}
async function cmdApp() {
  SERVING = true;
  const TOKEN = randomBytes(16).toString("hex");
  const json = (res, obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(EMBEDDED_UI); return; }
    if (u.pathname.startsWith("/api/")) {
      const tok = req.headers["x-symbiot-token"] || u.searchParams.get("t");
      if (tok !== TOKEN) { res.writeHead(403); res.end("forbidden"); return; }
    }
    try {
      if (u.pathname === "/api/status") { const r = resolveProvider(); return json(res, r ? { connected: true, line: `${PROVIDERS[r.provider].label} · ${r.model}` } : { connected: false }); }
      if (u.pathname === "/api/map") return json(res, buildMap()); // local git only — no AI key needed
      if (u.pathname === "/api/models") { const hw = detectHardware(); return json(res, { hardware: hw, rec: recommendModels(hw) }); }
      if (u.pathname === "/api/drift") return json(res, computeDrift({ ci: u.searchParams.get("ci") === "1", fetch: u.searchParams.get("fetch") === "1" }));
      if (u.pathname === "/api/node") return json(res, nodeDetail(u.searchParams.get("id") || "")); // local
      if (u.pathname === "/api/suggest" && req.method === "POST") { const b = await readBody(req); return json(res, await repoSuggest(String(b.path || ""))); }
      if (u.pathname === "/api/review" && req.method === "POST") { const b = await readBody(req); return json(res, await repoReview(String(b.path || ""))); }
      if (u.pathname === "/api/tasks" && req.method !== "POST") return json(res, loadTasks());
      if (u.pathname === "/api/tasks/add" && req.method === "POST") { const b = await readBody(req); return json(res, addTask(b.text, b.repo)); }
      if (u.pathname === "/api/tasks/toggle" && req.method === "POST") { const b = await readBody(req); return json(res, toggleTask(String(b.id || ""))); }
      if (u.pathname === "/api/tasks/remove" && req.method === "POST") { const b = await readBody(req); return json(res, removeTask(String(b.id || ""))); }
      if (u.pathname === "/api/run" && req.method === "POST") { const b = await readBody(req); const cmd = ["week", "standup", "todo"].includes(b.cmd) ? b.cmd : "week"; return json(res, await produce(cmd)); }
      if (u.pathname === "/api/connect" && req.method === "POST") { return json(res, await connectProvider(await readBody(req))); }
      if (u.pathname === "/api/quit") { res.writeHead(200); res.end("bye"); setTimeout(() => process.exit(0), 150); return; }
    } catch (e) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String((e && e.message) || e) })); return; }
    res.writeHead(404); res.end("not found");
  });
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
    const how = openApp(url);
    console.log(`\n${c.g("●")} ${c.b("Symbiot")} is running at ${c.b(url)}`);
    console.log(how ? c.d(`  Opened in a ${how}.`) : c.d("  Open that URL in your browser."));
    console.log(c.d("  Leave this running; press Ctrl+C to stop (or click Quit in the window)."));
  });
}

const HELP = `${c.b("symbiot")} — your week, written from your real work.

${c.b("Usage")}
  symbiot ${c.d("(or)")} symbiot week      write up your last ${SINCE_WEEK} days
  symbiot standup                   yesterday + today, for standup
  symbiot todo                      what's still on your plate
  symbiot app                       open the visual app in your browser
  symbiot drift                     what's out of sync / at risk across repos
  symbiot models                    recommend AI models for your hardware
  symbiot login                     connect it to an AI (once)
  symbiot whoami                    show how it's connected
  symbiot logout                    forget saved credentials
  symbiot help

${c.b("Options")}
  --dir <path>    where your repos are (default: ${homedir()})
  --since <days>  window for 'week' (default 7)
  --all           everyone's commits, not just yours
  --plain         no colour/spinner (good for piping)

${c.b("Setup")}  pick any AI to write with:
  symbiot login                       ${c.d("choose Claude / OpenAI / Gemini / Ollama")}
  symbiot login --provider openai --key sk-...   ${c.d("(non-interactive)")}
  ${c.d("Env keys also work: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY.")}
  ${c.d("Override the model per run with SYMBIOT_MODEL.")}

${c.d("Reads only your local git. No accounts, no OAuth, no data leaves except the")}
${c.d("commit summaries sent to the AI to write your update (nothing leaves at all")}
${c.d("with a local Ollama model).")}`;

// ---- main -----------------------------------------------------------------
async function main() {
  if (cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); return; }
  if (cmd === "login" || cmd === "auth") return cmdLogin();
  if (cmd === "logout") return cmdLogout();
  if (cmd === "whoami" || cmd === "status") return cmdWhoami();
  if (cmd === "app" || cmd === "ui") return cmdApp();
  if (cmd === "models" || cmd === "hardware") return cmdModels();
  if (cmd === "drift") return cmdDrift();
  if (cmd === "week") return cmdRun("week");
  if (cmd === "standup") return cmdRun("standup");
  if (cmd === "todo") return cmdRun("todo");
  console.log(c.y(`Unknown command: ${cmd}`) + "\n"); console.log(HELP);
}

// Run the CLI only when invoked directly; when imported (e.g. by tests) just
// expose the pure functions. Compare REAL paths so a global/npx bin symlink
// (argv[1] is the symlink, import.meta.url is the real file) still counts.
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) main();

export { authorship, repoState, readmeInfo, repoShape, houseRules, findAllRepos, buildMap, reportFooter, detectHardware, recommendModels, computeDrift, driftRepo, gitDefaultBranch, EMBEDDED_UI };
