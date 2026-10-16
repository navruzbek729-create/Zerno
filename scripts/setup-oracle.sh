#!/usr/bin/env bash
# ZERNO — Oracle Cloud (Ubuntu) serverga avtomatik o'rnatish skripti
#
# Ishlatish (serverda, ubuntu foydalanuvchisi sifatida):
#   bash ~/zerno/scripts/setup-oracle.sh                 # faqat IP orqali
#   bash ~/zerno/scripts/setup-oracle.sh zerno.uz        # domen + HTTPS bilan
#
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(whoami)"
PORT=3000

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

if [ ! -f "$APP_DIR/server.js" ]; then
  echo "Xato: server.js topilmadi ($APP_DIR). Skriptni zerno papkasi ichidan ishga tushiring." >&2
  exit 1
fi

# --- Admin parol ---
if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo
  read -rsp "Admin paroli (bo'sh qoldirsangiz: zerno2026): " ADMIN_TOKEN; echo
  ADMIN_TOKEN="${ADMIN_TOKEN:-zerno2026}"
fi
if [ "${#ADMIN_TOKEN}" -lt 8 ]; then echo "Parol juda qisqa (kamida 8 belgi)." >&2; exit 1; fi

say "1/6 Tizimni yangilash va kerakli dasturlarni o'rnatish"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl nginx unzip iptables-persistent

say "2/6 Node.js 20 o'rnatish"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
sudo npm install -g pm2

say "3/6 Loyiha kutubxonalarini o'rnatish"
cd "$APP_DIR"
npm install --omit=dev
mkdir -p data uploads

say "4/6 Saytni PM2 bilan ishga tushirish"
cat > "$APP_DIR/ecosystem.config.js" <<EOF
module.exports = { apps: [{ name: 'zerno', script: 'server.js', cwd: '$APP_DIR',
  env: { PORT: '$PORT', ADMIN_TOKEN: '$ADMIN_TOKEN', NODE_ENV: 'production' } }] };
EOF
chmod 600 "$APP_DIR/ecosystem.config.js"
pm2 delete zerno >/dev/null 2>&1 || true
pm2 start "$APP_DIR/ecosystem.config.js"
pm2 save
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$APP_USER" --hp "$HOME" >/dev/null
pm2 save

say "5/6 Nginx va Oracle ichki firewall (80/443 portlar)"
SERVER_NAME="${DOMAIN:-_}"
[ -n "$DOMAIN" ] && SERVER_NAME="$DOMAIN www.$DOMAIN"
sudo tee /etc/nginx/sites-available/zerno >/dev/null <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $SERVER_NAME;
    client_max_body_size 60M;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/zerno /etc/nginx/sites-enabled/zerno
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

# Oracle Ubuntu obrazlarida iptables 80/443 ni yopib qo'ygan bo'ladi
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT 1 -p tcp --dport "$p" -m state --state NEW -j ACCEPT
done
sudo netfilter-persistent save

say "6/6 HTTPS"
if [ -n "$DOMAIN" ]; then
  sudo apt-get install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --agree-tos --register-unsafely-without-email -n \
    || echo "⚠️  HTTPS o'rnatilmadi. Domen DNS'i shu server IP'siga yo'naltirilganini tekshiring va keyinroq qayta ishga tushiring: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
else
  echo "Domen berilmadi — HTTPS o'tkazib yuborildi. Domen olganingizda: bash $APP_DIR/scripts/setup-oracle.sh DOMEN"
fi

IP="$(curl -s -4 --max-time 5 https://ifconfig.me || echo SERVER_IP)"
URL="http://$IP"; [ -n "$DOMAIN" ] && URL="https://$DOMAIN"
cat <<EOF

✅ Tayyor! ZERNO ishlayapti.
   Sayt:        $URL
   Admin panel: $URL/admin

Foydali buyruqlar:
   pm2 status          — holatini ko'rish
   pm2 logs zerno      — loglarni ko'rish
   pm2 restart zerno   — qayta ishga tushirish
EOF
