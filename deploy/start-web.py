# 在服务器上常驻启动 Web 服务（tmux 会话 novel-web），并做本机连通性检查
# 用法：DEPLOY_PASSWORD=... python deploy/start-web.py

import os
import secrets
import sys

import paramiko

HOST = "106.54.243.60"
USER = "ubuntu"
PORT = "3456"
NODE_PATH_EXPORT = 'export PATH="$HOME/opt/node-v22.14.0/bin:$PATH"'

RUN_SCRIPT = """#!/bin/bash
cd ~/ai-interactive-novel
""" + NODE_PATH_EXPORT + """
if [ ! -f .env ]; then echo "[run-web] 未找到 .env，使用 mock 模式"; fi
TOKEN=__TOKEN__ PORT=""" + PORT + """ \\
  $( [ -f .env ] && echo "npm run web" || echo "npm run web:mock" )
"""

START_CMD = f"""{NODE_PATH_EXPORT} && cd ~/ai-interactive-novel && \\
tmux kill-session -t novel-web 2>/dev/null; \\
TOKEN={{token}} tmux new-session -d -s novel-web 'bash run-web.sh' && sleep 2 && \\
echo "--- tmux ---" && tmux ls && \\
echo "--- 本机连通性 ---" && \\
curl -s -o /dev/null -w "HTTP %{{http_code}}\\n" http://127.0.0.1:{PORT}/ && \\
curl -s "http://127.0.0.1:{PORT}/api/state?token={{token}}" | head -c 200"""


def run(ssh: paramiko.SSHClient, cmd: str, timeout: int = 120) -> tuple[int, str]:
	print(f"\n$ {cmd[:160]}")
	_, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
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
		print("缺少 DEPLOY_PASSWORD")
		return 1

	ssh = paramiko.SSHClient()
	ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
	ssh.connect(HOST, username=USER, password=password, timeout=20)
	try:
		# 令牌持久化：首次生成后存到服务器，重启服务不变
		_, tok_out = run(ssh, f"cat ~/ai-interactive-novel/.web-token 2>/dev/null")
		token = tok_out.strip()
		if not token:
			token = secrets.token_urlsafe(12)
			run(ssh, f"echo '{token}' > ~/ai-interactive-novel/.web-token && chmod 600 ~/ai-interactive-novel/.web-token")
			print("(首次生成令牌，已持久化)")

		script = RUN_SCRIPT.replace("__TOKEN__", token)
		sftp = ssh.open_sftp()
		try:
			with sftp.open(f"/home/{USER}/ai-interactive-novel/run-web.sh", "w") as f:
				f.write(script)
		finally:
			sftp.close()
		run(ssh, f"chmod +x ~/ai-interactive-novel/run-web.sh")
		code, out = run(ssh, START_CMD.replace("{token}", token))
		if code != 0:
			print("启动失败")
			return 1
	finally:
		ssh.close()

	print(f"\n启动完成 ✓\n访问地址: http://{HOST}:{PORT}/\n访问令牌: {token}")
	return 0


if __name__ == "__main__":
	sys.exit(main())
