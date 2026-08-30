# 远端环境初始化：用户级安装 Node.js（~/opt，不碰系统包）+ npm install + mock 自测
# 用法：DEPLOY_PASSWORD=... python deploy/setup-node.py

import os
import sys

import paramiko

HOST = "106.54.243.60"
USER = "ubuntu"
NODE_VERSION = "v22.14.0"
NODE_MIRROR = f"https://npmmirror.com/mirrors/node/{NODE_VERSION}/node-{NODE_VERSION}-linux-x64.tar.xz"
NPM_REGISTRY = "https://registry.npmmirror.com"
PROJECT_DIR = "ai-interactive-novel"
BASHRC_MARKER = "# >>> ai-novel node >>>"
BASHRC_END = "# <<< ai-novel node <<<"


def run(ssh: paramiko.SSHClient, cmd: str, timeout: int = 600) -> tuple[int, str]:
	print(f"\n$ {cmd}")
	_, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
	out = stdout.read().decode("utf-8", "replace")
	err = stderr.read().decode("utf-8", "replace")
	code = stdout.channel.recv_exit_status()
	if out.strip():
		print(out.rstrip()[-3000:])
	if err.strip():
		print("STDERR:", err.rstrip()[-1000:])
	return code, out


def main() -> int:
	password = os.environ.get("DEPLOY_PASSWORD")
	if not password:
		print("缺少 DEPLOY_PASSWORD")
		return 1

	ssh = paramiko.SSHClient()
	ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
	ssh.connect(HOST, username=USER, password=password, timeout=20)
	try:
		run(ssh, "uname -m && cat /etc/os-release | head -2")

		# 1) 用户级 Node：~/opt/node，已装则跳过
		code, out = run(ssh, f"ls ~/opt/node-{NODE_VERSION}/bin/node 2>/dev/null && echo INSTALLED")
		if "INSTALLED" not in out:
			run(ssh, f"mkdir -p ~/opt && cd ~/opt && curl -fsSL {NODE_MIRROR} -o node.tar.xz && tar -xf node.tar.xz && mv node-{NODE_VERSION}-linux-x64 node-{NODE_VERSION} && rm node.tar.xz", timeout=600)

		# 2) PATH 写入 .bashrc（带标记块，可整段删除）
		block = f"""{BASHRC_MARKER}
export PATH="$HOME/opt/node-{NODE_VERSION}/bin:$PATH"
{BASHRC_END}"""
		code, out = run(ssh, f"grep -q '{BASHRC_MARKER}' ~/.bashrc || printf '%s\\n' {shq(block)} >> ~/.bashrc; tail -4 ~/.bashrc")

		# 3) 依赖安装 + 自测（显式带 PATH，不依赖交互 shell 的 bashrc）
		export = f'export PATH="$HOME/opt/node-{NODE_VERSION}/bin:$PATH"'
		code, out = run(ssh, f'{export} && node --version && npm --version')
		if code != 0:
			print("Node 安装失败")
			return 1
		run(ssh, f'{export} && cd ~/{PROJECT_DIR} && npm config set registry {NPM_REGISTRY} && npm install --no-audit --no-fund 2>&1 | tail -3', timeout=900)
		run(ssh, f'{export} && cd ~/{PROJECT_DIR} && npx tsc --noEmit && npm run e2e 2>&1 | tail -24', timeout=900)

		# 4) 顺手清理误传上去的本地 .zcode 目录
		run(ssh, f"rm -rf ~/{PROJECT_DIR}/.zcode")
	finally:
		ssh.close()
	print("\n远端环境就绪 ✓")
	return 0


def shq(s: str) -> str:
	"""单引号安全转义"""
	return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
	sys.exit(main())
