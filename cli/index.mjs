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
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline";

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
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 }); }
  catch { return ""; }
}
function me() {
  return { email: sh("git config --global user.email").trim(), name: sh("git config --global user.name").trim() };
}
function findRepos(base, sinceDays) {
  const out = sh(
    `find ${JSON.stringify(base)} -maxdepth 5 -name .git \\( -type d -o -type f \\) 2>/dev/null ` +
    `| grep -vE 'node_modules|/\\.cache/|/\\.local/|/venvs?/|/\\.npm' | head -400`,
  );
  const repos = [];
  for (const g of out.split("\n").filter(Boolean)) {
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
    // Filter to the identity you actually commit under IN THIS repo (people use
    // different emails per project); no filter with --all.
    const email = mineOnly ? sh(`git -C ${JSON.stringify(r.path)} config user.email`).trim() : "";
    const authorArg = email ? `--author=${JSON.stringify(email)}` : "";
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
    const dirty = sh(`git -C ${JSON.stringify(r.path)} status --porcelain 2>/dev/null`).split("\n").filter(Boolean);
    if (dirty.length) {
      const branch = sh(`git -C ${JSON.stringify(r.path)} rev-parse --abbrev-ref HEAD 2>/dev/null`).trim();
      items.push(`${r.name}: ${dirty.length} uncommitted file(s) on ${branch || "?"}`);
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

async function cmdWeek(days, label) {
  if (!resolveProvider()) { console.log(AUTH_HELP); return; }
  const who = me();
  const repos = findRepos(BASE, days);
  if (!repos.length) {
    console.log(c.y(`No git activity in the last ${days} days under ${BASE}.`));
    console.log(c.d("Try:  symbiot week --dir ~/projects   (point it at where your repos live)"));
    return;
  }
  let cs = commits(repos, `${days} days ago`, !has("all"));
  if (!cs.length) cs = commits(repos, `${days} days ago`, false); // fall back to all if none matched you
  const open = label === "week" ? openWork(repos) : [];

  if (!cs.length) { console.log(c.y("Found repos, but no commits in the window.")); return; }

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

  header(`${cs.length} commits across ${new Set(cs.map((x) => x.repo)).size} repos · ${label}`);
  const out = await write(system, prompt);
  if (out) console.log(out + "\n");
}

async function cmdTodo() {
  if (!resolveProvider()) { console.log(AUTH_HELP); return; }
  const repos = findRepos(BASE, 60);
  const open = openWork(repos);
  if (!open.length) { console.log(c.y("Nothing outstanding found (no TODOs or uncommitted work).")); return; }
  const system =
    `You summarise what's still on a developer's plate from their TODO markers and uncommitted work. ` +
    `Group by project, lead with what looks most in-flight (uncommitted work) then the to-dos. ` +
    `Be concise and concrete. No preamble.`;
  header(`${open.length} open items · todo`);
  const out = await write(system, `Open work:\n${open.map((o) => `- ${o}`).join("\n")}\n\nWhat's still on my plate?`);
  if (out) console.log(out + "\n");
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

const HELP = `${c.b("symbiot")} — your week, written from your real work.

${c.b("Usage")}
  symbiot ${c.d("(or)")} symbiot week      write up your last ${SINCE_WEEK} days
  symbiot standup                   yesterday + today, for standup
  symbiot todo                      what's still on your plate
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
(async () => {
  if (cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); return; }
  if (cmd === "login" || cmd === "auth") return cmdLogin();
  if (cmd === "logout") return cmdLogout();
  if (cmd === "whoami" || cmd === "status") return cmdWhoami();
  if (cmd === "week") return cmdWeek(SINCE_WEEK, "week");
  if (cmd === "standup") return cmdWeek(2, "standup");
  if (cmd === "todo") return cmdTodo();
  console.log(c.y(`Unknown command: ${cmd}`) + "\n"); console.log(HELP);
})();
