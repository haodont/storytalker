# 同步项目到远程服务器：上传 tarball 并在远端解压 + npm install + mock 自测
# 用法：python deploy/sync.py  （密码从环境变量 DEPLOY_PASSWORD 读取）

import os
import subprocess
import sys

import paramiko

HOST = "106.54.243.60"
USER = "ubuntu"
REMOTE_DIR = "ai-interactive-novel"
LOCAL_TARBALL = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "st-project.tar.gz"))
# 远端为用户级 Node（见 setup-node.py），非交互 shell 需显式加 PATH
NODE_PATH_EXPORT = 'export PATH="$HOME/opt/node-v22.14.0/bin:$PATH"'

TAR_EXCLUDES = ["node_modules", ".env", "test-workspace", "test-workspace-web", "novel-workspace", ".zcode", "__pycache__"]


def pack() -> str:
	"""打包项目（排除本地产物），返回 tarball 路径"""
	project = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
	cmd = ["tar", "-czf", LOCAL_TARBALL]
	for ex in TAR_EXCLUDES:
		cmd += [f"--exclude={ex}"]
	cmd += ["-C", project, "."]
	subprocess.run(cmd, check=True)
	print(f"已打包 {LOCAL_TARBALL}（{os.path.getsize(LOCAL_TARBALL) // 1024} KB）")
	return LOCAL_TARBALL


def run(ssh: paramiko.SSHClient, cmd: str, timeout: int = 300) -> tuple[int, str]:
	print(f"\n$ {cmd}")
	stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
	out = stdout.read().decode("utf-8", "replace")
	err = stderr.read().decode("utf-8", "replace")
	code = stdout.channel.recv_exit_status()
	if out.strip():
		print(out.rstrip())
	if err.strip():
		print("STDERR:", err.rstrip())
	return code, out


def main() -> int:
	password = os.environ.get("DEPLOY_PASSWORD")
	if not password:
		print("缺少 DEPLOY_PASSWORD 环境变量")
		return 1

	tarball = pack()
	print(f"上传 → {USER}@{HOST}:~/{REMOTE_DIR}/")

	ssh = paramiko.SSHClient()
	ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
	ssh.connect(HOST, username=USER, password=password, timeout=20)
	try:
		sftp = ssh.open_sftp()
		try:
			_, home_out = run(ssh, "echo $HOME")
			home = home_out.splitlines()[0].strip() if home_out.strip() else f"/home/{USER}"
			remote_tar = f"{home}/{REMOTE_DIR}.tar.gz"
			print("SFTP 上传中……")
			sftp.put(tarball, remote_tar)
			print("上传完成")

			run(ssh, f"mkdir -p ~/{REMOTE_DIR} && tar -xzf {remote_tar} -C ~/{REMOTE_DIR} && rm {remote_tar}")
			run(ssh, f"ls ~/{REMOTE_DIR}")

			# 远端环境检查 + 安装依赖 + mock 自测
			code, _ = run(ssh, f"{NODE_PATH_EXPORT} && node --version && npm --version", timeout=60)
			if code != 0:
				print("\n远端缺少 Node.js（先运行 deploy/setup-node.py），同步完成但跳过自测。")
				return 0
			run(ssh, f"{NODE_PATH_EXPORT} && cd ~/{REMOTE_DIR} && npm install --no-audit --no-fund 2>&1 | tail -3", timeout=900)
			run(ssh, f"{NODE_PATH_EXPORT} && cd ~/{REMOTE_DIR} && npx tsc --noEmit && npm run e2e 2>&1 | tail -20", timeout=900)
		finally:
			sftp.close()
	finally:
		ssh.close()
	print("\n同步完成 ✓")
	return 0


if __name__ == "__main__":
	sys.exit(main())
