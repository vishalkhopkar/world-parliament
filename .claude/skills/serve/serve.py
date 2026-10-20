"""Start (or restart) the HUNG PARLIAMENT local servers: game server :8787 and web app :5173.
Run from anywhere:  python -I .claude/skills/serve/serve.py
Anything already listening on those two ports is stopped first (only that process tree, by PID), then both
servers are started detached, with logs in <repo>/.srv.log and <repo>/.vite.log, and the script waits until both answer."""
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
GAME = os.path.join(ROOT, 'game')
API_PORT, WEB_PORT = 8787, 5173
WIN = os.name == 'nt'


def listeners(port):
    """PIDs listening on a TCP port."""
    if WIN:
        out = subprocess.run(['netstat', '-ano', '-p', 'TCP'], capture_output=True, text=True).stdout
        pids = set()
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[3] == 'LISTENING' and re.search(r':%d$' % port, parts[1]):
                pids.add(int(parts[4]))
        return pids
    out = subprocess.run(['lsof', '-t', '-i', 'TCP:%d' % port, '-sTCP:LISTEN'], capture_output=True, text=True).stdout
    return {int(x) for x in out.split()}


def stop(port):
    for pid in listeners(port):
        if WIN:
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
        else:
            os.kill(pid, 15)
        print(f'stopped pid {pid} on :{port}')
    for _ in range(20):
        if not listeners(port):
            return
        time.sleep(0.25)
    sys.exit(f'port {port} is still in use')


def start(cmd, cwd, log):
    kw = {}
    if WIN:
        kw['creationflags'] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw['start_new_session'] = True
    with open(log, 'w') as f:
        subprocess.Popen(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kw)


def wait(url, ok_codes, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            code = urllib.request.urlopen(url, timeout=2).status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception:
            code = 0
        if code in ok_codes:
            return True
        time.sleep(0.5)
    return False


def main():
    npm = 'npm.cmd' if WIN else 'npm'
    npx = 'npx.cmd' if WIN else 'npx'
    if not os.path.isdir(os.path.join(GAME, 'node_modules')):
        sys.exit('game/node_modules is missing: run `npm install` in game/ first')
    running = bool(listeners(API_PORT) or listeners(WEB_PORT))
    stop(API_PORT)
    stop(WEB_PORT)
    start([npm, 'run', 'dev'], os.path.join(GAME, 'server'), os.path.join(ROOT, '.srv.log'))
    start([npx, 'vite', '--port', str(WEB_PORT), '--host'], os.path.join(GAME, 'web'), os.path.join(ROOT, '.vite.log'))
    api_ok = wait(f'http://localhost:{API_PORT}/games/x', {401})
    web_ok = wait(f'http://localhost:{WEB_PORT}/', {200})
    print(('restarted' if running else 'started') + f': game server :{API_PORT} {"OK" if api_ok else "FAILED (see .srv.log)"}, '
          f'web app :{WEB_PORT} {"OK" if web_ok else "FAILED (see .vite.log)"}')
    if api_ok and web_ok:
        print(f'play: http://localhost:{WEB_PORT}/?server=local   (several players in one browser: add &as=<name>)')
    sys.exit(0 if api_ok and web_ok else 1)


if __name__ == '__main__':
    main()
