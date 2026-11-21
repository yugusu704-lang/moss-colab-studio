# MOSS-Colab-Studio

**MOSS-Colab-Studio** 是一个面向 **MOSS-Image** 的本地 Web 工作台 + Google Colab 混合分层运行方案，将 **本地工作台交互**、**Google Drive 云盘持久化 / 免开 Colab 直传 LoRA**、以及 **Google Colab GPU 算力自动握手连接** 整合为一体。

> **English Summary:** MOSS-Colab-Studio is a local web studio and hybrid Google Colab runner for **MOSS-Image** ComfyUI workflows. It combines direct Google Drive mounting (`rclone` OAuth or local Drive folder), zero-GPU-cost Civitai/HuggingFace LoRA downloading to Drive, one-click Colab notebook launching with automatic tunnel discovery, a visual comic-panel layout editor, and full generation/history management.

---

## 核心特性

- **混合分层 Colab 架构（[ComfyUI_Colab_Hybrid.ipynb](ComfyUI_Colab_Hybrid.ipynb)）**
  - Colab 本地高速 SSD 运行 ComfyUI 本体与插件；大模型、LoRA、VAE、工作流、输入输出持久化在 Google Drive（`ComfyUI_Data/`）。
  - Cell 3 支持纯 CPU 环境下高速并发下载 `moss-image-sft-int8`、Qwen3.5 文本编码器、FLUX.2 VAE、ShinobiSat 加速包与 SeedVR2 超分模型，不消耗 GPU 点数。
- **Google Drive 挂载与免开 Colab 直传 LoRA**
  - 内置 `rclone` 一键浏览器 OAuth 授权挂载与本地 Drive 目录模式，Web 端直接查看云盘空间、管理目标目录（默认 `ComfyUI_Data/models/loras`）。
  - 在 **Civitai 库** 中浏览、检索或粘贴 Civitai / HuggingFace 直链，通过 `64M` 分片直传 Google Drive，支持实时进度条、取消任务与失败重试。
- **直达 Colab 与免复制公网地址自动连接**
  - 一键将本地最新版 Notebook 同步至云盘 `Colab Notebooks/MOSS_Studio_Colab.ipynb` 并绑定直达链接，顶栏点击 **「直达 Colab ↗」** 新标签页打开。
  - Colab Cell 4 启动后自动把隧道地址与 GPU 信息写入云盘 `.moss_studio_endpoint.json`，本地工作台点 **「自动连接」** 或返回页面即可自动探测并连上 ComfyUI。
- **LoRA 可视化库与完整生图工作台**
  - 合并展示 Colab 云端与 Google Drive 的全部已有 LoRA，支持快速下拉挂载、「已有 LoRA」可视化检索管理、触发词快捷追加以及 `-2.0 ~ +2.0` 权重调节（兼容 Slider LoRA）。
  - 支持 **ShinobiSat v2 / 高精度 / 4 步极速** 模式预设、二修放大与 **SeedVR2** 超分、胶片颗粒、A/B 对比滑块、图生图、PNG 参数反读、漫画分镜自由排版工作台、任务队列及局域网手机/平板访问。

---

## 快速开始

### 1. 环境准备

- **Python 3.10+**
- **[rclone](https://rclone.org/downloads/)**（可选但强烈推荐，用于本地挂载 Google Drive 与直传 LoRA）：
  - Windows：`winget install -e --id Rclone.Rclone`
  - macOS：`brew install rclone`
  - Linux：`curl https://rclone.org/install.sh | sudo bash`

### 2. 安装依赖并启动本地工作台

```bash
git clone https://github.com/yugusu704-lang/moss-colab-studio.git
cd moss-colab-studio
pip install -r requirements.txt
python moss_studio/server.py
```

Windows 用户也可直接双击根目录的 [启动MOSS本地Web端.bat](启动MOSS本地Web端.bat)，启动后访问：

- 本机访问：`http://127.0.0.1:7860`
- 局域网（手机/平板）：启动控制台会自动打印对应的局域网 IP 地址

### 3. 挂载 Google Drive 与绑定 Colab

1. 打开工作台顶部 **「Google Drive」**，点击 **「一键浏览器授权挂载」** 完成 Google 账号授权（默认目标目录 `ComfyUI_Data/models/loras`）。
2. 打开顶栏 **「联动」**，点击 **「同步本地最新版到云盘」**，将 Notebook 同步至 `Colab Notebooks/MOSS_Studio_Colab.ipynb` 并自动绑定直达链接。
3. 如需使用 **Civitai 库** 下载或桥接鉴权，请在「Civitai 库」顶部填写你自己的 Civitai API Key（本地保存在 `moss_studio/data/config.json`，不会纳入 Git 版本控制）。
4. 在 Colab 中建议通过左侧 **Secrets（钥匙图标）** 配置 `CIVITAI_TOKEN` 与 `HF_TOKEN`，或直接填入 Cell 3 / Cell 4 表单参数；依次运行 **Cell 1 → Cell 2 → Cell 4** 后，回到本地工作台点击 **「自动连接」** 即可开始生图。

---

## 目录结构

```text
moss-colab-studio/
├── ComfyUI_Colab_Hybrid.ipynb   # Colab 混合分层启动 Notebook（含云盘端点同步与桥接插件）
├── 启动MOSS本地Web端.bat          # Windows 一键启动脚本
├── requirements.txt             # Python 依赖（aiohttp, numpy, Pillow）
├── moss_studio/
│   ├── server.py                # 本地 aiohttp 服务与 ComfyUI API 代理
│   ├── gdrive.py                # Google Drive 挂载、LoRA 直传与 Colab 联动管理
│   ├── comic_layout.py          # 漫画分镜排版编译模块
│   ├── imgmeta.py               # 生成图片元数据读写与缩略图处理
│   └── static/                  # 前端工作台界面（HTML / CSS / JS）
└── workflows/                   # ComfyUI MOSS-Image 参考工作流模板
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
