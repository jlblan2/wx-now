#!/usr/bin/env bash
# Installs the Next Hour alert server on a fresh Ubuntu 22.04/24.04 VM (built for Oracle Cloud
# Always Free). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/jlblan2/next-hour/main/server/install.sh | sudo bash
# Safe to run again; it updates in place.
set -euo pipefail

REPO=https://github.com/jlblan2/next-hour.git
APP=/opt/next-hour
DATA=/var/lib/next-hour

echo "== Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates iptables-persistent debian-keyring debian-archive-keyring apt-transport-https gnupg \n  python3-eccodes python3-numpy python3-pil dpkg-dev

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "== Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "== Caddy (HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== App"
id nexthour >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin nexthour
mkdir -p "$DATA"
chown nexthour:nexthour "$DATA"
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q; else git clone -q "$REPO" "$APP"; fi
(cd "$APP/server" && npm install --omit=dev --no-audit --no-fund -q)

cat > /etc/systemd/system/next-hour.service <<EOF
[Unit]
Description=Next Hour rain alert server
After=network-online.target
Wants=network-online.target

[Service]
User=nexthour
WorkingDirectory=$APP/server
Environment=DATA_DIR=$DATA
Environment=PORT=8787
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Navy (FNMOC) forecasts: fetch each new NAVGEM / Navy wave run (checks hourly).
mkdir -p "$DATA/navy"
chown nexthour:nexthour "$DATA/navy"
cat > /etc/systemd/system/next-hour-navy.service <<EOF
[Unit]
Description=Fetch Navy NAVGEM and wave forecasts for Next Hour
After=network-online.target
[Service]
Type=oneshot
User=nexthour
Environment=NAVY_DIR=$DATA/navy
ExecStart=/usr/bin/python3 $APP/server/navy/fetch_navy.py
TimeoutStartSec=45min
Nice=10
EOF

cat > /etc/systemd/system/next-hour-navy.timer <<EOF
[Unit]
Description=Check NOMADS hourly for new Navy forecasts
[Timer]
OnBootSec=3min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
EOF

# Pick up new releases from GitHub automatically (checks every 30 minutes).
cat > /usr/local/bin/next-hour-update <<EOF
#!/usr/bin/env bash
set -e
cd $APP
before=\$(git rev-parse HEAD)
git pull -q
after=\$(git rev-parse HEAD)
if [ "\$before" != "\$after" ]; then
  (cd server && npm install --omit=dev --no-audit --no-fund -q)
  systemctl restart next-hour
  echo "Updated \$before -> \$after"
fi
EOF
chmod +x /usr/local/bin/next-hour-update

cat > /etc/systemd/system/next-hour-update.service <<EOF
[Unit]
Description=Update Next Hour alert server from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/next-hour-update
EOF

cat > /etc/systemd/system/next-hour-update.timer <<EOF
[Unit]
Description=Check GitHub for Next Hour updates
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
[Install]
WantedBy=timers.target
EOF

echo "== Firewall (Oracle images block 80/443 by default)"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport $port -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT -p tcp --dport $port -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true

echo "== HTTPS address"
IP=$(curl -fsS -4 https://api.ipify.org)
HOST="$(echo "$IP" | tr . -).sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  reverse_proxy 127.0.0.1:8787
}
EOF

systemctl daemon-reload
systemctl enable --now next-hour next-hour-update.timer next-hour-navy.timer
systemctl restart next-hour
systemctl reload caddy || systemctl restart caddy

echo
echo "Waiting for the HTTPS certificate..."
for i in $(seq 1 30); do
  if curl -fsS "https://$HOST/api/status" >/dev/null 2>&1; then
    echo
    echo "=============================================="
    echo " Alert server is running at: https://$HOST"
    echo "=============================================="
    exit 0
  fi
  sleep 5
done
echo
echo "The server is installed, but https://$HOST is not reachable yet."
echo "Most likely the Oracle network rules still block ports 80 and 443 (see the setup steps)."
echo "Logs: journalctl -u caddy -n 50 ; journalctl -u next-hour -n 50"
exit 1
