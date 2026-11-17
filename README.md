# PanUrgos Studio

A private, local-first AI code editor. Monaco editor, file explorer, terminal, and a coding agent that runs on **your** models: Unsloth Studio, Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server. You can also bring your own cloud keys (OpenAI, Anthropic, OpenRouter) if you choose.

## Run

```bash
npm install
npm start
```

## Install (Windows)

Run `PanUrgos-Studio-Setup-<version>.exe`. Like Claude Code, it's a one-click, per-user install with no admin prompt, into `%LOCALAPPDATA%\Programs\PanUrgos Studio`.

- **Bundled:** the editor, llama.cpp (Vulkan build, which runs on NVIDIA, AMD and Intel GPUs and falls back to CPU), and the Microsoft Visual C++ runtime (installed only if it's missing). No model files are included.
- **Registered with Windows:** Start menu and desktop shortcuts, an Add/Remove Programs entry, an `panurgos` command on PATH (`panurgos .`, `panurgos file.py`), and "Open with PanUrgos Studio" for files, folders and folder backgrounds. It's also registered for 50+ code file types, so you can pick it under **Settings › Apps › Default apps**.
- **Setup screen:** after installing, PanUrgos opens a setup window with optional extras: the NVIDIA CUDA build of llama.cpp, plus Git, Node.js LTS, Python 3.13, the .NET 8 SDK, Java 21 (Temurin), Rust, and the VC++ runtime, all installed through `winget` from their publishers. You can reopen it any time from **Help › Setup & Optional Components**.
- **Uninstall:** from Add/Remove Programs. It asks whether to also delete your settings, keys and models in `%APPDATA%\PanUrgos Studio`.

**Packages panel:** install toolchains, create a Python `.venv`, install a project's dependencies (npm, pnpm, yarn, pip, NuGet, Maven, Gradle, cargo, go), or add a library by name. Everything runs visibly in the integrated terminal, which picks up newly installed tools immediately, with no restart needed.

**Build the installer yourself:**

```bash
npm install
npm run assets
npm run dist
```

## Run models inside PanUrgos (built-in llama.cpp)

No LM Studio, Ollama or Unsloth needed:

1. Open the **Models** panel (cube icon, `Ctrl+Shift+M`).
2. Click **Install llama.cpp**. PanUrgos detects your hardware and downloads the matching official build from [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases): CUDA on NVIDIA (including the CUDA runtime libraries), otherwise Vulkan, otherwise CPU, or Metal on Apple Silicon. Downloads are checked against GitHub's published SHA-256 digests.
3. Search Hugging Face (for example `qwen coder`). Each quantization is shown with its size and a **Fits GPU / Partial GPU / Too large** estimate for your machine. Click **Download**, then **Use**.
4. Chat, use Agent mode or press Ctrl+K. The model runs in `llama-server` on `127.0.0.1` on a random port, and loads automatically on your first message.

**Updates:** under **Settings → Local Runtime** you can check for new llama.cpp builds, update with one click, turn on automatic updates, roll back to the previous build, pick a different GPU backend, and tune GPU layers, context size and threads.

**Your existing models:** GGUFs that LM Studio or the Hugging Face cache already downloaded are listed under **On this computer**, so you don't download them twice.

**Privacy:** Hugging Face and GitHub are contacted only after you allow them, either from the prompt or under **Settings → Privacy & Security → Internet access for models**. Every request is listed in the Network Ledger. Redirects are followed one hop at a time and only to allow-listed hosts, and your HF token is never sent to a CDN. Chats with local models never leave `127.0.0.1`.

## Connect Unsloth

1. Start your Unsloth server (default `http://127.0.0.1:8888/v1`).
2. Open **Settings → Models & API Keys → Unsloth Studio**, paste your `sk-unsloth-…` key and click **Save**.
3. Click **Fetch** to pick the loaded model, then **Test connection**.
4. Under **Settings → Unsloth Agents**, set thinking, `top_k`, `min_p`, `repetition_penalty`, and the server-side tools (`python`, `terminal`, `web_search`). The page shows the exact equivalent Python request.

## Privacy model

| Guarantee | How |
|---|---|
| No telemetry | There is no analytics code and no server to send to. Chromium background networking, component updates, and spellcheck downloads are disabled. |
| Sealed UI | The renderer has a strict CSP and every renderer web request is cancelled. Only the main process can reach model endpoints. |
| Encrypted keys | Keys are sealed with Electron `safeStorage` (DPAPI, Keychain, or libsecret) in `vault.bin.json`. The UI only ever sees `••••1234`. |
| Local-only mode (on by default) | Any model endpoint that isn't on loopback is hard-blocked. |
| Secret redaction | API keys, tokens, JWTs, private keys, and `password=` values are scrubbed from prompts sent to cloud providers. |
| Network Ledger | Every outbound request is listed with its host, size, purpose, and latency. |
| Agent sandbox | Agent tools can't leave the open folder. Writes and shell commands ask for approval by default. |
| Ephemeral chats | Chats are kept in memory only unless you turn on "Remember chats". |
| Panic wipe | One click destroys all keys and resets all settings. |

## Shortcuts

`Ctrl+P` go to file · `Ctrl+Shift+P` commands · `Ctrl+K` AI edit selection · `Ctrl+L` ask agent · `Ctrl+Shift+M` models · `Ctrl+B` sidebar · `Ctrl+J` panel · `Ctrl+Alt+B` agent panel · `Ctrl+,` settings

## Layout

```
src/main/main.js      window, sandboxing, network lockdown, fs + terminal IPC, ledger
src/main/llm.js       model gateway (OpenAI-compatible + Anthropic streaming), agent loop, tools, redaction
src/main/store.js     settings + encrypted key vault, provider presets
src/main/runtime.js   built-in llama.cpp: hardware detection, install/update/rollback, llama-server sidecar
src/main/hub.js       Hugging Face search, GGUF variants, resumable verified downloads, local model library
src/main/net.js       permission-gated, allow-listed, ledger-logged fetch + downloader
src/main/preload.js   narrow contextBridge API
src/renderer/         UI (index.html, styles.css, js/*)
```
