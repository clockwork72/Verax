from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SSH_COMMON = REPO_ROOT / "hpc" / "scraper" / "_ssh_common.sh"
ATTACH_TUNNEL = REPO_ROOT / "hpc" / "scraper" / "attach_tunnel.sh"


def _write_fake_ssh(path: Path) -> None:
    path.write_text(
        """#!/bin/bash
set -euo pipefail

control_path=""
host=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      if [[ "${2:-}" == ControlPath=* ]]; then
        control_path="${2#ControlPath=}"
      fi
      shift 2
      ;;
    -O)
      shift 2
      ;;
    *)
      host="$1"
      shift
      ;;
  esac
done

if [ -n "${SSH_LOG_PATH:-}" ]; then
  printf '%s|%s\\n' "${control_path}" "${host}" >> "${SSH_LOG_PATH}"
fi

if [ "${control_path}" = "${LIVE_SSH_SOCKET:-}" ] && [ "${host}" = "${EXPECTED_SSH_HOST:-}" ]; then
  exit 0
fi

exit 255
""",
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _source_ssh_common(env: dict[str, str]) -> tuple[str, str]:
    cmd = f"source {SSH_COMMON} && printf '%s\\n%s\\n' \"$SSH_HOST\" \"$SSH_SOCKET\""
    result = subprocess.run(
        ["bash", "-lc", cmd],
        check=True,
        text=True,
        capture_output=True,
        env=env,
    )
    host, socket = result.stdout.strip().splitlines()
    return host, socket


def _run_bash(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-lc", script],
        check=True,
        text=True,
        capture_output=True,
        env=env,
    )


def test_ssh_common_prefers_explicit_socket_override(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_ssh(fake_bin / "ssh")

    explicit_socket = "/tmp/scraper-ssh-explicit-pytest.sock"
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "SCRAPER_SSH_HOST": "soufiane.essahli@toubkal.hpc.um6p.ma",
        "SCRAPER_SSH_SOCKET": explicit_socket,
    }

    host, socket = _source_ssh_common(env)

    assert host == "soufiane.essahli@toubkal.hpc.um6p.ma"
    assert socket == explicit_socket


def test_ssh_common_reuses_any_live_matching_control_socket(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_ssh(fake_bin / "ssh")

    default_socket = "/tmp/scraper-ssh-pytest-missing.sock"
    fallback_socket = "/tmp/scraper-ssh-pytest-live.sock"
    Path(fallback_socket).write_text("", encoding="utf-8")
    log_path = tmp_path / "ssh.log"

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "USER": "pytest-missing",
        "SCRAPER_SSH_HOST": "soufiane.essahli@toubkal.hpc.um6p.ma",
        "LIVE_SSH_SOCKET": fallback_socket,
        "EXPECTED_SSH_HOST": "soufiane.essahli@toubkal.hpc.um6p.ma",
        "SSH_LOG_PATH": str(log_path),
    }

    try:
        host, socket = _source_ssh_common(env)
    finally:
        Path(fallback_socket).unlink(missing_ok=True)

    assert host == "soufiane.essahli@toubkal.hpc.um6p.ma"
    assert socket == fallback_socket
    assert default_socket in log_path.read_text(encoding="utf-8")
    assert fallback_socket in log_path.read_text(encoding="utf-8")


def test_submit_and_wait_keeps_node_on_stdout_and_progress_on_stderr(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    ssh_log = tmp_path / "ssh.log"
    fake_ssh = fake_bin / "ssh"
    fake_ssh.write_text(
        """#!/bin/bash
set -euo pipefail

command=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-O)
      shift 2
      ;;
    *)
      command="$1"
      shift
      ;;
  esac
done

printf '%s\\n' "${command}" >> "${SSH_LOG_PATH}"

case "${command}" in
  *"sbatch --parsable"*)
    printf '6683730\\n'
    ;;
  *"squeue -j 6683730 -h -o"*)
    printf 'RUNNING|slurm-compute-h22d5-u14-svn3\\n'
    ;;
  *"squeue -u \\\"\\$USER\\\" -h -o \\\"%i|%j\\\""*)
    printf ''
    ;;
  *)
    printf '' 
    ;;
esac
""",
        encoding="utf-8",
    )
    fake_ssh.chmod(fake_ssh.stat().st_mode | stat.S_IXUSR)

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "SCRAPER_SSH_HOST": "soufiane.essahli@toubkal.hpc.um6p.ma",
        "SCRAPER_SSH_SOCKET": "/tmp/scraper-ssh-explicit-pytest.sock",
        "SCRAPER_REMOTE_ROOT": "/srv/test-scraper",
        "SCRAPER_REPO_ROOT": "/srv/test-scraper/repo",
        "SSH_LOG_PATH": str(ssh_log),
    }

    result = _run_bash(
        f"""
source {REPO_ROOT / 'hpc' / 'scraper' / '_deploy_common.sh'}
submit_and_wait
""",
        env,
    )

    assert result.stdout.strip() == "slurm-compute-h22d5-u14-svn3"
    assert "Submitted orchestrator job 6683730" in result.stderr


def test_attach_tunnel_recycles_stale_master_forward(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    ssh_log = tmp_path / "ssh.log"
    ready_flag = tmp_path / "forward-ready"
    forward_state = tmp_path / "forward.target"

    fake_ssh = fake_bin / "ssh"
    fake_ssh.write_text(
        """#!/bin/bash
set -euo pipefail

args=("$@")
printf '%s\\n' "$*" >> "${SSH_LOG_PATH}"

joined="$*"
if [[ "${joined}" == *"-O check"* ]]; then
  exit 0
fi
if [[ "${joined}" == *"-O exit"* ]]; then
  exit 0
fi
if [[ "${joined}" == *"-MNf"* ]]; then
  exit 0
fi
if [[ "${joined}" == *"-O forward -L 8910:slurm-compute-h22d5-u14-svn3:8910"* ]]; then
  count_file="${FORWARD_COUNT_PATH}"
  count=0
  if [ -f "${count_file}" ]; then
    count="$(cat "${count_file}")"
  fi
  count="$((count + 1))"
  printf '%s' "${count}" > "${count_file}"
  if [ "${count}" -eq 1 ]; then
    printf 'mux_client_forward: forwarding request failed: Port forwarding failed\\n' >&2
    exit 255
  fi
  : > "${READY_FLAG_PATH}"
  exit 0
fi
exit 0
""",
        encoding="utf-8",
    )
    fake_ssh.chmod(fake_ssh.stat().st_mode | stat.S_IXUSR)

    fake_ss = fake_bin / "ss"
    fake_ss.write_text(
        """#!/bin/bash
printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\\n'
printf 'LISTEN 0 128 127.0.0.1:8910 0.0.0.0:*\\n'
""",
        encoding="utf-8",
    )
    fake_ss.chmod(fake_ss.stat().st_mode | stat.S_IXUSR)

    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        """#!/bin/bash
if [ -f "${READY_FLAG_PATH}" ]; then
  printf '{"ok": true}\\n'
  exit 0
fi
exit 1
""",
        encoding="utf-8",
    )
    fake_curl.chmod(fake_curl.stat().st_mode | stat.S_IXUSR)

    fake_sleep = fake_bin / "sleep"
    fake_sleep.write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
    fake_sleep.chmod(fake_sleep.stat().st_mode | stat.S_IXUSR)

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "SCRAPER_SSH_HOST": "soufiane.essahli@toubkal.hpc.um6p.ma",
        "SCRAPER_SSH_SOCKET": "/tmp/scraper-ssh-explicit-pytest.sock",
        "SCRAPER_SSH_FORWARD_STATE": str(forward_state),
        "SSH_LOG_PATH": str(ssh_log),
        "FORWARD_COUNT_PATH": str(tmp_path / "forward-count"),
        "READY_FLAG_PATH": str(ready_flag),
    }

    result = _run_bash(f"{ATTACH_TUNNEL} slurm-compute-h22d5-u14-svn3", env)

    assert "Resetting SSH master to clear stale port 8910 forward" in result.stdout
    assert forward_state.read_text(encoding="utf-8").strip() == "slurm-compute-h22d5-u14-svn3"
    ssh_calls = ssh_log.read_text(encoding="utf-8")
    assert "-O exit" in ssh_calls
    assert ssh_calls.count("-O forward -L 8910:slurm-compute-h22d5-u14-svn3:8910") == 2
