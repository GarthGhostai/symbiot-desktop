# Symbiot desktop

Symbiot in your **system tray**: it writes your week from your local git, pops a
native notification when it's ready, and gives you a window to read/copy it — no
terminal needed.

It's a thin shell around the [`symbiot`](https://www.npmjs.com/package/symbiot)
CLI (bundled in `cli/`), run with Electron's own Node. Both share
`~/.config/symbiot`, so your provider login is the same in the app and the CLI.

## What it does

- **Tray icon** with a menu: *Write my week now · Standup · What's on my plate ·
  Run every Friday 4pm ✓ · Start at login · Settings… · Quit*.
- **Weekly hook:** with "Run every Friday 4pm" on, it runs `week` at that time
  and shows a notification — click it to read the write-up.
- **Settings window:** pick the AI (Claude / OpenAI / Gemini / local Ollama),
  paste a key, save. Validation reuses the CLI's own `login`.

## Run it (development)

```bash
cd symbiot-desktop
npm install        # downloads Electron (~150 MB the first time)
npm start
```

The icon appears in your tray. First run → **Settings** → choose a provider and
paste a key (or point at a local Ollama). Then **Write my week now**.

## Build an installer

```bash
npm run dist:linux     # AppImage + .deb  (into dist/)
# npm run dist         # current OS: .dmg (mac) / .exe (win) / linux
```

Install the `.deb` (`sudo dpkg -i dist/Symbiot_*.deb`) or run the AppImage
directly. "Start at login" keeps it in your tray across reboots so the weekly
run actually fires.

## Notes / known caveats

- **Linux tray:** GNOME hides legacy tray icons — you may need the
  [AppIndicator](https://extensions.gnome.org/extension/615/appindicator-support/)
  extension for the icon to show. The window and notifications work regardless.
  (Pop!_OS with COSMIC generally shows AppIndicator icons.)
- **Scheduling** fires while the app is running; enable **Start at login** so it
  survives reboots. It runs at/after the set hour on the chosen day, once per day.
- **Config** lives in `~/.config/symbiot/config.json` (shared with the CLI);
  app-only prefs (schedule, autostart) live in `~/.config/symbiot/desktop.json`.
- **mac/win icons:** `assets/icon.png` (512²) is used for Linux; a proper
  `.icns`/`.ico` is recommended before shipping mac/win builds.

## Keeping the bundled CLI in sync

`cli/index.mjs` is a copy of the published CLI. To update it:

```bash
cp ../symbiot/index.mjs cli/index.mjs
```
