# CLAUDE.md

Follow the complete setup, safety, and troubleshooting runbook in [`AGENTS.md`](AGENTS.md).

Quick commands for this repository:

1. Preflight check:
   ```bash
   python scripts/check_env.py --json
   ```
2. Install Python dependencies (and install `rclone` if missing per `AGENTS.md`):
   ```bash
   pip install -r requirements.txt
   ```
3. Start the local workbench server (`http://127.0.0.1:7860`) in the background and verify HTTP `200`:
   ```bash
   python moss_studio/server.py
   ```

Privacy & safety reminders:
- Never ask users to paste Civitai API Keys or Google OAuth tokens into chat.
- Never commit `moss_studio/data/`, `outputs/`, `rclone.conf`, `config.json`, or screenshots.
- On Windows, print `http://127.0.0.1:7860` and let the user open it manually instead of spawning desktop Chrome from a background shell process.
