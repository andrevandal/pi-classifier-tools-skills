# Running the Laya HTTP server on WSL2 with an AMD GPU

How to keep `python/laya_http_server.py` running as a systemd user service on
WSL2, on CPU or on an AMD Radeon GPU through ROCm.

Reference machine: Ryzen 9 9900X3D, Radeon RX 9070 XT (gfx1201, RDNA4),
Ubuntu 26.04 on WSL2, `.wslconfig` with 6 GB RAM and `vmIdleTimeout=0`.

Status: the **CPU path was set up and the server started** on this machine. The
**GPU path is not tested here**. It needs `sudo` and a Windows driver update that
had to be done by hand. Ubuntu 26.04 is not on AMD's documented list (22.04 and
24.04 are), and the steps below follow AMD's WSL docs plus a community report of the
same GPU working on 26.04 (ROCm/librocdxg issue #74, which used the ROCm 7.13 pre-release).

## 1. CPU setup (works today)

```bash
uv venv .venv   # or: python3 -m venv .venv
export TMPDIR=~/.cache/tmp && mkdir -p "$TMPDIR"          # see "Space in /tmp"
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -r python/requirements.txt
```

Install the CPU `torch` wheel **before** `requirements.txt`. Otherwise pip
resolves the default Linux wheel, which pulls several GB of NVIDIA CUDA
libraries that an AMD machine cannot use.

## 2. Keep the server running (systemd user service)

`~/.config/systemd/user/laya-server.service`:

```ini
[Unit]
Description=Laya classifier HTTP server (pi-classifier-tools-skills)

[Service]
WorkingDirectory=%h/www/andrevandal/pi-classifier-tools-skills
ExecStart=%h/www/andrevandal/pi-classifier-tools-skills/.venv/bin/python python/laya_http_server.py --repo convaiinnovations/laya --router --port 8765
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now laya-server
systemctl --user status laya-server
journalctl --user -u laya-server -f      # wait for: laya_http_server: ready on http://127.0.0.1:8765
```

`/etc/wsl.conf` needs `systemd=true`. Use `loginctl enable-linger $USER` to start
the service without an open login session. The server starts in about 15 s here (it swapped
2.3 GB while loading), so omp calls made right after boot may fall back to the full
loadout.

Point the plugin at it in `~/.omp/loadout.json`:

```json
{"backend":"laya","laya":{"transport":"http","endpoint":"http://127.0.0.1:8765/","apiKeyEnvVar":"","timeoutMs":20000}}
```

## 3. Using the AMD GPU (ROCm on WSL2)

The GPU is exposed to WSL through `/dev/dxg`. There is no `/dev/kfd`, and you
never install the `amdgpu` kernel module in WSL. The stack is:
Windows Adrenalin driver, then ROCm userspace in WSL, then `librocdxg` (the bridge from
ROCm to `/dev/dxg`), then a ROCm build of PyTorch.

1. **Windows**: install an Adrenalin driver that supports WSL ROCm
   (26.1.1 or newer for ROCm 7.2) and reboot Windows.
2. **WSL, ROCm userspace**. This step needs sudo. ROCm 7.2.4 is the latest as of this
   writing; the `latest/` directory on `repo.radeon.com` shows the current file name.
   Ubuntu 26.04 has no directory there, so use `noble` (24.04):
   ```bash
   cd /tmp
   wget https://repo.radeon.com/amdgpu-install/latest/ubuntu/noble/amdgpu-install_7.2.4.70204-1_all.deb
   sudo apt install ./amdgpu-install_7.2.4.70204-1_all.deb
   sudo usermod -a -G render,video $LOGNAME
   sudo amdgpu-install -y --usecase=rocm --no-dkms
   ```
   The `wsl` usecase in older guides (`--usecase=wsl,rocm`) is gone from the 7.2.4
   installer and fails with `Usecase implementation 'wsl' is not supported or invalid`.
   Run the installer from `/tmp`, not from your home directory: apt runs downloads as
   the `_apt` user, and it prints a notice (not an error) when it cannot read the file.
3. **librocdxg**, after ROCm:
   ```bash
   wget https://github.com/ROCm/librocdxg/releases/download/v1.2.2/rocdxg-roct_1.2.2_amd64.deb
   sudo apt install ./rocdxg-roct_1.2.2_amd64.deb
   echo 'export HSA_ENABLE_DXG_DETECTION=1' >> ~/.bashrc && source ~/.bashrc
   ```
   `HSA_ENABLE_DXG_DETECTION=1` is required for ROCm older than 7.13. The package
   `hsa-runtime-rocr4wsl-amdgpu` is not needed on 7.2.x. Then run `wsl --shutdown` from
   PowerShell and reopen the distro.
4. **Check**: `rocminfo` (install the `rocminfo` package if the command is missing) must
   list `gfx1201` / `AMD Radeon RX 9070 XT`.
5. **PyTorch**: use AMD's wheels from `repo.radeon.com/rocm/manylinux/rocm-rel-7.2.4/`,
   matched to the ROCm version. That directory has wheels for Python 3.9 to 3.13 (3.12
   only for `torch` 2.11), none for 3.14, so this repo's 3.14 `.venv` cannot use them.
   Create a separate venv, for example `uv venv --python 3.12 .venv-rocm`, and install the
   `torch-2.9.1+rocm7.2.4...cp312` wheel (or a newer one in that directory) from that URL,
   then `-r python/requirements.txt`. `laya` requires `torch>=2.0.0`, so pip keeps the
   ROCm wheel. The comment in `requirements.txt` mentions `torch>=2.14` as upstream's
   floor; if the server fails to import with the ROCm wheel, that is the first thing to check.
6. **Verify**:
   ```bash
   .venv-rocm/bin/python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
   # True AMD Radeon RX 9070 XT
   ```
   ROCm answers through the `cuda` API.
7. **Run on GPU**: in the service file, change `ExecStart` to use `.venv-rocm/bin/python`
   with `--device cuda` (the server's `--device` flag; empty means auto-detect), and add
   `Environment=HSA_ENABLE_DXG_DETECTION=1` under `[Service]`. A systemd service does not read
   `~/.bashrc`. Then
   `systemctl --user daemon-reload && systemctl --user restart laya-server`.

Updates: after the installer `.deb` is installed, `sudo apt update && sudo apt upgrade`
updates ROCm within the 7.2.x release. A new ROCm release needs the new installer `.deb`
from `repo.radeon.com/amdgpu-install/<version>/`. The PyTorch wheel in the venv is not an apt
package; reinstall one built for the new ROCm version after upgrading.

Caveats:

- A warning about `libhsa-amd-aqlprofile64.so` has been reported with an RX 9070 XT
  and is harmless when `is_available()` is `True`.
- Windows 10 plus RDNA4 has a reported `rocminfo` failure
  (`HSA_STATUS_ERROR_OUT_OF_RESOURCES`, ROCm issue #6323).
- Games and the GPU: the model is small, but it keeps VRAM allocated while the server runs.
  Stop it with `systemctl --user stop laya-server` before gaming if VRAM is tight.
- GPU use is a latency gain only. On this CPU the model already loads in about 15 s and
  serves from a warm process.

## 4. Space in /tmp

WSL mounts `/tmp` as a tmpfs sized at half of the WSL memory (2.9 GB with
`memory=6GB`), so large files there use RAM. A pip install of torch and its
dependencies filled it with an unpack directory of 2.8 GB and failed with
`No space left on device`.

- Build and install large packages with `TMPDIR` on disk: `export TMPDIR=~/.cache/tmp`.
- Clean up after an interrupted install: `rm -rf /tmp/pip-unpack-* /tmp/pip-metadata-*`.
- Do not enlarge the tmpfs (`mount -o remount,size=...`) beyond a small amount;
  it competes with the 6 GB of RAM WSL has.
