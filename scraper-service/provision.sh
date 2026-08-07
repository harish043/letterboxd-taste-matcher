#!/usr/bin/env bash
# Provision an e2-micro Debian instance to run the Letterboxd scraper service
# with egress routed through Cloudflare WARP (1.1.1.1), which bypasses
# Letterboxd's Cloudflare "Just a moment" challenge.
#
# Usage: sudo bash provision.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing system deps"
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release ufw

echo "==> Installing Node.js 20 (LTS)"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version

echo "==> Installing Cloudflare WARP (1.1.1.1)"
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
  | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" \
  | tee /etc/apt/sources.list.d/cloudflare-client.list
apt-get update -y
apt-get install -y cloudflare-warp

echo "==> Registering and connecting WARP (proxy mode on 127.0.0.1:40000)"
warp-cli --accept-tos registration new || true
warp-cli --accept-tos mode proxy || true
warp-cli --accept-tos proxy port 40000 || true
warp-cli --accept-tos connect || true
sleep 3
warp-cli --accept-tos status || true

echo "==> Cloning repo"
mkdir -p /opt/letterboxd-taste-matcher
if [ ! -d /opt/letterboxd-taste-matcher/.git ]; then
  git clone https://github.com/harish043/letterboxd-taste-matcher.git /opt/letterboxd-taste-matcher
fi
cd /opt/letterboxd-taste-matcher
git fetch origin
git checkout origin/main

echo "==> Installing npm deps"
npm ci --omit=dev

echo "==> Creating service env file"
cat > /opt/letterboxd-taste-matcher/scraper-service/.env <<'EOF'
PORT=8080
SCRAPER_TOKEN=CHANGE_ME_STRONG_TOKEN
SCRAPER_PROXY=http://127.0.0.1:40000
EOF
chmod 600 /opt/letterboxd-taste-matcher/scraper-service/.env

echo "==> Installing systemd unit"
cp /opt/letterboxd-taste-matcher/scraper-service/letterboxd-scraper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable letterboxd-scraper
systemctl start letterboxd-scraper
systemctl status letterboxd-scraper --no-pager || true

echo "==> Opening firewall port 8080 (scraper service)"
ufw allow 8080/tcp || true
ufw enable -y || true

echo "==> Done. Test locally:"
echo "    curl http://localhost:8080/health"
echo "    curl -X POST http://localhost:8080/match -H 'Content-Type: application/json' -H 'Authorization: Bearer CHANGE_ME_STRONG_TOKEN' -d '{\"username\":\"dave\",\"maxPagesPerFilm\":1,\"delayMs\":0}'"
