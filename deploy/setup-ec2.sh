#!/usr/bin/env bash
# ONE-TIME setup of a fresh Ubuntu 22.04 / 24.04 EC2 server for the abhicabs backend.
#
#   sudo bash setup-ec2.sh api.yourdomain.com https://github.com/<you>/<repo>.git
#
# Run it as a user that can sudo (the default "ubuntu" user is fine).
# Before you run it: the domain's DNS (A record) should already point to this server's public IP.
set -euo pipefail

DOMAIN="${1:?Usage: sudo bash setup-ec2.sh <domain> <git-repo-url>}"
REPO_URL="${2:?Usage: sudo bash setup-ec2.sh <domain> <git-repo-url>}"
APP_USER="${SUDO_USER:-ubuntu}"
APP_DIR="/home/${APP_USER}/abhicabs_backend"

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl git nginx ca-certificates certbot python3-certbot-nginx

echo "==> Installing Node.js 20"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Installing PM2"
npm install -g pm2

echo "==> Getting the code into ${APP_DIR}"
if [ ! -d "${APP_DIR}/.git" ]; then
  sudo -u "${APP_USER}" git clone "${REPO_URL}" "${APP_DIR}"   # a private repo asks for a token or needs a deploy key
else
  echo "    already cloned, skipping"
fi

echo "==> Configuring Nginx for ${DOMAIN}"
sed "s/YOUR_DOMAIN/${DOMAIN}/g" "${APP_DIR}/deploy/nginx-abhicabs.conf" > /etc/nginx/conf.d/abhicabs.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

echo "==> Making PM2 start on boot"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" >/dev/null || true

cat <<NEXT

Server is ready. Remaining steps, in this order:

  1. Create the settings file (never commit it):
       nano ${APP_DIR}/.env          # start from deploy/env.production.example
       chmod 600 ${APP_DIR}/.env

  2. Turn on HTTPS (the domain must already point to this server):
       sudo certbot --nginx -d ${DOMAIN}

  3. First deploy (installs packages, updates the database, starts the app):
       cd ${APP_DIR} && bash deploy/deploy.sh

  4. Check it:
       curl https://${DOMAIN}/health
       curl https://${DOMAIN}/webhook/whatsapp      # should say the WhatsApp webhook is up

NEXT
