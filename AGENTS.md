# MOSS-Colab-Studio AI Agent Setup & Operations Runbook

> 本文档面向 AI Coding / Setup Agent（Claude Code、Codex、Cursor、Windsurf、Antigravity、Cline、OpenCode 等）。
> 当用户把本项目仓库发给你并让你帮忙安装、启动并完成 Google Colab / Google Drive 联调时，请严格按下方确定性步骤执行。

---

## 0. 安全与隐私铁律（必须遵守）

1. **绝不索要敏感凭证到对话中**：不要让用户把 Civitai API Key、Hugging Face Token 或 Google OAuth JSON 粘贴到聊天框；所有凭证均由用户在本地浏览器 UI（`http://127.0.0.1:7860`）或 Google Colab Secrets 中自行填写。
2. **绝不提交个人运行数据**：`moss_studio/data/`（包含 `config.json`、`rclone.conf`、`history.json`）、`outputs/`、`.impeccable/` 均被 `.gitignore` 忽略，不得强制 `git add -f`。
3. **Windows 下不要从后台 shell 拉起桌面 Chrome**：在 Windows 的 Agent 非交互式后台进程中执行 `start chrome` 或 `webbrowser.open()` 可能导致浏览器隐藏窗口锁定用户默认 Profile。请在启动服务后直接输出 URL `http://127.0.0.1:7860`，请用户自行在浏览器中打开。

---

## 1. 环境预检（Step 1）

在仓库根目录运行标准库零依赖预检脚本：

```bash
python scripts/check_env.py --json
```

检查返回字段：
- `python.ok`：必须为 `true`（Python >= 3.10）。若低于 3.10，先创建兼容虚拟环境或提示升级 Python。
- `missing_packages`：若非空，立即执行依赖安装（见 Step 2）。
- `rclone.available`：用于本地免开 Colab 挂载 Google Drive、上传 LoRA 和一键同步 Notebook（强烈推荐）。
- `server.status`：`listening` 表示 `7860` 端口已在运行；`available` 表示需要启动服务。

---

## 2. 安装依赖与可选工具（Step 2）

若 `missing_packages` 非空：

```bash
pip install -r requirements.txt
```

若 `rclone.available` 为 `false`，使用当前系统对应的官方包管理器安装（安装前如策略要求请先征得用户同意）：
- **Windows**：`winget install -e --id Rclone.Rclone`
- **macOS**：`brew install rclone`
- **Linux**：`curl https://rclone.org/install.sh | sudo bash`

安装完成后重新运行一次确认：

```bash
python scripts/check_env.py --json
```

---

## 3. 启动本地 Web 工作台并验活（Step 3）

若 `7860` 端口尚未监听，以后台守护进程方式启动服务：

```bash
python moss_studio/server.py
```

等待 1–2 秒后验证健康状态（确认返回 HTTP `200`）：

```bash
python -c "import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:7860/api/config', timeout=5); print('HTTP', r.status)"
```

---

## 4. 用户浏览器交接清单（Step 4）

当本地服务返回 HTTP `200` 后，向用户展示以下 5 步浏览器操作指引即可：

1. **打开本地工作台**：在浏览器访问 `http://127.0.0.1:7860`。
2. **挂载 Google Drive**：点击顶部 **「Google Drive」→「一键浏览器授权挂载」** 完成 Google 账号授权（或切换为本地 Google Drive 桌面盘目录模式）。
3. **可选：配置 Civitai API Key**：点击顶部 **「Civitai 库」** 填入个人 Civitai API Key（同时自动作为云端桥接鉴权 Token，仅保存于本地 `moss_studio/data/config.json`）。
4. **一键同步并打开 Colab**：点击顶部 **「联动」→「同步本地最新版到云盘」**，再点击 **「直达 Colab ↗」** 在新标签页打开 `ComfyUI_Data` 绑定的 Notebook。
5. **在 Colab 中分两段运行**：
   - **首次准备模型（CPU 运行时，不消耗 GPU 计算单元）**：依次运行 **Cell 1（挂载云盘）→ Cell 3（并发下载 MOSS-Image-SFT-INT8 全套底模与官方工作流到云盘）**。
   - **出图阶段（切换 L4 / T4 / A100 GPU 运行时）**：依次运行 **Cell 1 → Cell 2（安装 ComfyUI + `moss_studio_bridge v3` + 同步热盘 SSD）→ Cell 4（启动 ComfyUI 与 Cloudflare 隧道）**（**跳过 Cell 3**），回到本地工作台点击顶部 **「自动连接」** 即可开始出图。

---

## 5. 常见问题速查与自检（Step 5）

- **网络代理环境下的 `rclone` / Civitai 请求**：`moss_studio/gdrive.py` 与 `server.py` 会自动读取环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 及本地常见代理端口。若 `rclone` 授权或读写超时，确认本地代理处于运行状态并在启动 `server.py` 的终端设置好环境变量。
- **在本地网页下载新 LoRA 到 Google Drive 后，Colab 提交报 `value_not_in_list`（`lora_name` 未找到）**：
  - 原因：通过 `rclone`/Drive API 写入的新文件不会更新 Colab FUSE 目录的 `st_mtime`，ComfyUI 缓存不会自动刷新。
  - 处理：在 Web 端「已有 LoRA」库或提示条直接点击 **「秒同步到 Colab」** / **「一键秒同步全部」**，通过 `/api/cloud/sync-drive` 将云盘新文件零重复下载拷贝至 Colab SSD 并清空 `folder_paths.filename_list_cache`。
- **验证 INT8 Bypass LoRA QKV 修复与桥接版本（v3）**：
  - 访问运行中 Colab 隧道的 `<comfy_url>/moss_studio/ping`，正常应包含 `"bridge_version": 3`、`"supports_sync_drive": true`、`"bypass_qkv_fix": true`。
  - Cell 4 启动日志应包含 `[MOSS-BypassFix] Patched comfy.sd.load_bypass_lora_for_models for sliced QKV & multi-LoRA stacking`，加载 `moss_image_sft_int8_convrot.safetensors` + Bypass LoRA 时不会刷屏 `proj.qkv.weight` `NOT LOADED` 警告。
- **防止 Colab 浏览器自动保存覆盖 Notebook 更新**：
  - 本地点击「同步最新 Notebook」时，会自动额外把最新插件代码写入云盘 `ComfyUI_Data/moss_studio_bridge.py`；Cell 4 每次启动前都会优先从该 `.py` 热更新插件，不受旧标签页 `.ipynb` 自动保存回写影响。如需同步 `.ipynb` 本体，先关闭旧 Colab 标签页再点同步，或指定新的 `remote_path`（如 `Colab Notebooks/MOSS_Studio_Colab_v3.ipynb`）。
