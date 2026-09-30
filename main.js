// Symbiot desktop — a tray app that writes your week and pings you weekly.
// It is a thin shell around the `symbiot` CLI (bundled in ./cli), run with
// Electron's own Node. Both share ~/.config/symbiot, so login is identical.

const { app, Tray, Menu, BrowserWindow, Notification, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const CLI = () => path.join(app.getAppPath(), "cli", "index.mjs");
const NODE_MODULES = () => path.join(app.getAppPath(), "node_modules");
const PREFS_PATH = path.join(os.homedir(), ".config", "symbiot", "desktop.json");
const DEFAULT_PREFS = { schedule: { enabled: false, weekday: 5, hour: 16 }, lastRunDate: null, startAtLogin: false };

let tray = null;
let win = null;
let lastOutput = { cmd: "week", text: "", when: null };

// ---- prefs ----------------------------------------------------------------
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")) }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) {
  try { fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true }); fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2)); } catch {}
}
let prefs = loadPrefs();

// ---- run the bundled CLI --------------------------------------------------
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI(), ...args, "--plain"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: NODE_MODULES() },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.on("error", (e) => resolve({ code: -1, out: "", err: String(e) }));
  });
}

async function status() {
  const r = await runCli(["whoami"]);
  const connected = r.out.startsWith("✓") || /Connected:/.test(r.out);
  return { connected, line: r.out.replace(/^✓\s*/, "") };
}

// ---- window ---------------------------------------------------------------
function showWindow(tab) {
  if (!win) {
    win = new BrowserWindow({
      width: 620, height: 640, show: false, title: "Symbiot",
      backgroundColor: "#0E1A1F",
      icon: nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "icon.png")),
      webPreferences: { preload: path.join(app.getAppPath(), "preload.js"), contextIsolation: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(app.getAppPath(), "ui", "index.html"));
    win.on("close", (e) => { e.preventDefault(); win.hide(); }); // keep in tray
  }
  win.show(); win.focus();
  if (tab) win.webContents.send("open-tab", tab);
}

// ---- a run + notify -------------------------------------------------------
async function runAndShow(cmd, { notify = false } = {}) {
  const r = await runCli([cmd]);
  lastOutput = { cmd, text: r.out || r.err || "(no output)", when: new Date().toISOString() };
  if (win && win.isVisible()) win.webContents.send("result", { cmd, ...lastOutput });
  if (notify && Notification.isSupported()) {
    const n = new Notification({
      title: "Symbiot",
      body: cmd === "week" ? "Your week is ready." : `Your ${cmd} is ready.`,
      icon: path.join(app.getAppPath(), "assets", "icon.png"),
    });
    n.on("click", () => showWindow(cmd));
    n.show();
  }
  return lastOutput;
}

// ---- weekly scheduler (fires while the app is running) --------------------
function todayStr() { return new Date().toISOString().slice(0, 10); }
function tick() {
  const s = prefs.schedule;
  if (!s.enabled) return;
  const now = new Date();
  if (now.getDay() === s.weekday && now.getHours() >= s.hour && prefs.lastRunDate !== todayStr()) {
    prefs.lastRunDate = todayStr();
    savePrefs(prefs);
    runAndShow("week", { notify: true });
  }
}

// ---- autostart ------------------------------------------------------------
const LINUX_AUTOSTART = path.join(os.homedir(), ".config", "autostart", "symbiot-desktop.desktop");
function setAutostart(on) {
  prefs.startAtLogin = on; savePrefs(prefs);
  if (process.platform === "linux") {
    try {
      if (on) {
        fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
        const exec = app.isPackaged ? process.execPath : `${process.execPath} ${app.getAppPath()}`;
        fs.writeFileSync(LINUX_AUTOSTART,
          `[Desktop Entry]\nType=Application\nName=Symbiot\nExec=${exec}\nX-GNOME-Autostart-enabled=true\nComment=Weekly work update\n`);
      } else if (fs.existsSync(LINUX_AUTOSTART)) fs.unlinkSync(LINUX_AUTOSTART);
    } catch {}
  } else {
    app.setLoginItemSettings({ openAtLogin: on });
  }
}

// ---- tray menu ------------------------------------------------------------
async function buildMenu() {
  const st = await status();
  const s = prefs.schedule;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hh = (s.hour % 12 || 12) + (s.hour < 12 ? "am" : "pm");
  const menu = Menu.buildFromTemplate([
    { label: st.connected ? `● ${st.line}` : "○ Not connected — open Settings", enabled: false },
    { type: "separator" },
    { label: "Write my week now", click: () => runAndShow("week").then(() => showWindow("week")) },
    { label: "Standup", click: () => runAndShow("standup").then(() => showWindow("standup")) },
    { label: "What's on my plate", click: () => runAndShow("todo").then(() => showWindow("todo")) },
    { type: "separator" },
    { label: `Run every ${days[s.weekday]} ${hh}`, type: "checkbox", checked: s.enabled,
      click: (mi) => { prefs.schedule.enabled = mi.checked; savePrefs(prefs); refreshTray(); } },
    { label: "Start at login", type: "checkbox", checked: prefs.startAtLogin,
      click: (mi) => { setAutostart(mi.checked); } },
    { label: "Settings…", click: () => showWindow("settings") },
    { type: "separator" },
    { label: "Quit Symbiot", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(st.connected ? "Symbiot — " + st.line : "Symbiot");
}
function refreshTray() { buildMenu().catch(() => {}); }

// ---- IPC (from the window) ------------------------------------------------
ipcMain.handle("status", () => status());
ipcMain.handle("run", (_e, cmd) => runAndShow(["week", "standup", "todo"].includes(cmd) ? cmd : "week"));
ipcMain.handle("last", () => lastOutput);
ipcMain.handle("get-prefs", () => prefs);
ipcMain.handle("save-connection", async (_e, cfg) => {
  // cfg: { provider, key?, model?, baseUrl? } — reuse the CLI's own validation+save
  const args = ["login", "--provider", cfg.provider];
  if (cfg.key) args.push("--key", cfg.key);
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.baseUrl) args.push("--base-url", cfg.baseUrl);
  const r = await runCli(args);
  const ok = /✓|Connected/.test(r.out);
  refreshTray();
  return { ok, message: (r.out || r.err).split("\n").slice(-2).join(" ").replace(/✓\s*/, "") };
});
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));

// ---- lifecycle ------------------------------------------------------------
app.whenReady().then(() => {
  const img = nativeImage.createFromPath(path.join(app.getAppPath(), "assets",
    process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") img.setTemplateImage(true);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on("click", () => showWindow());   // left-click opens the window (esp. Windows/mac)
  refreshTray();
  setInterval(tick, 60 * 1000);
  tick();
  if (process.platform === "darwin") app.dock?.hide(); // menubar app, no dock icon
});
app.on("window-all-closed", (e) => { /* stay alive in tray */ });
app.on("before-quit", () => { app.isQuitting = true; });
