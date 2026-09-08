#!/bin/zsh
set -eu
nerve_dir="${0:A:h}"
cd "$nerve_dir"
nerve_check_only=0
nerve_pid=''

nerve_fail() {
  print -u2 -- "$1"
  if [[ -t 0 && "$nerve_check_only" == 0 ]]; then read -r "?Press Return to close."; fi
  exit 1
}

if (( $# > 0 )); then
  if [[ "$1" == '--check' && $# == 1 ]]; then nerve_check_only=1
  else nerve_fail 'Usage: Launch Nerve.command [--check]'; fi
fi

if ! command -v node >/dev/null 2>&1; then
  nerve_fail 'Nerve needs Node.js 22.12 or newer. Install Node, then open this launcher again.'
fi

if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)'; then
  nerve_fail "Nerve needs Node.js 22.12 or newer. Found $(node --version). Upgrade Node, then reopen this launcher."
fi

nerve_is_running() {
  local nerve_health
  nerve_health="$(curl --silent --fail --max-time 2 "$1/api/health" 2>/dev/null || true)"
  node -e 'try{const h=JSON.parse(process.argv[1]);process.exit(h.ok===true&&h.model==="gpt-6-astra"&&h.isolation==="single-user localhost"&&h.webcamUpload===false?0:1)}catch{process.exit(1)}' "$nerve_health"
}

nerve_has_interface() {
  local nerve_markup
  nerve_markup="$(curl --silent --fail --max-time 2 "$1" 2>/dev/null || true)"
  node -e 'process.exit(/<title[^>]*>[^<]*Nerve/i.test(process.argv[1])&&/id=["\x27]root["\x27]/.test(process.argv[1])?0:1)' "$nerve_markup"
}

if nerve_is_running 'http://127.0.0.1:4318'; then
  for nerve_url in 'http://127.0.0.1:4318' 'http://127.0.0.1:4317'; do
    if nerve_is_running "$nerve_url" && nerve_has_interface "$nerve_url"; then
      print -- "Nerve is already running at $nerve_url. Its process and current session will be left untouched."
      if [[ "$nerve_check_only" == 0 ]]; then open "$nerve_url" || nerve_fail 'Could not open your browser. Open the address printed above manually.'; fi
      exit 0
    fi
  done
  nerve_fail 'The Nerve bridge is already running on port 4318, but no interface is available. Restore its development UI or stop that process yourself before relaunching. Nothing was stopped.'
fi

if node -e 'const net=require("node:net");const s=net.createConnection({host:"127.0.0.1",port:4318});s.setTimeout(750);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>{s.destroy();process.exit(1)})'; then
  nerve_fail 'Port 4318 is occupied by another process or a starting service. Nerve will not stop it. Close that service yourself, then try again.'
fi

if [[ "$nerve_check_only" == 1 ]]; then
  print -- "Node $(node --version) is supported. Port 4318 is available. Ready to launch Nerve from $nerve_dir."
  exit 0
fi

command -v npm >/dev/null 2>&1 || nerve_fail 'npm was not found. Reinstall a complete Node.js distribution, then try again.'
if [[ ! -d node_modules ]]; then npm ci || nerve_fail 'Dependency installation failed. Check your network and the error above.'; fi
npm run setup || nerve_fail 'Browser or camera-model setup failed. Check your network and the error above.'
npm run build || nerve_fail 'Nerve did not pass its production build. Review the error above; no server was started.'

nerve_cleanup() {
  if [[ -n "$nerve_pid" ]]; then
    kill -TERM "$nerve_pid" 2>/dev/null || true
    wait "$nerve_pid" 2>/dev/null || true
    nerve_pid=''
  fi
}
trap nerve_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

node scripts/start.mjs &
nerve_pid=$!
nerve_ready=0
for nerve_attempt in {1..45}; do
  if ! kill -0 "$nerve_pid" 2>/dev/null; then
    nerve_exit=0
    wait "$nerve_pid" || nerve_exit=$?
    nerve_pid=''
    nerve_fail "Nerve exited before its interface was ready (exit $nerve_exit). Review the startup error above."
  fi
  if nerve_is_running 'http://127.0.0.1:4318' && nerve_has_interface 'http://127.0.0.1:4318'; then
    nerve_ready=1
    break
  fi
  sleep 1
done
[[ "$nerve_ready" == 1 ]] || nerve_fail 'Nerve did not become ready within the startup window. Only the server started by this launcher will be stopped.'
open 'http://127.0.0.1:4318' || print -u2 'Could not open the browser automatically. Open http://127.0.0.1:4318 manually.'
print -- 'Nerve is running. Keep this window open. Press Control-C to stop this launcher’s server.'
nerve_exit=0
wait "$nerve_pid" || nerve_exit=$?
nerve_pid=''
[[ "$nerve_exit" == 0 ]] || nerve_fail "Nerve stopped with exit $nerve_exit. Review the error above."
