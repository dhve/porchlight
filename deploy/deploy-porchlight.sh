#!/usr/bin/env bash
# deploy-porchlight.sh  -  run on the droplet as root. Safe to re-run.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR=/opt/porchlight
APP_USER=porchlight
PW_BROWSERS=/opt/pw-browsers
PORT=3300

echo "== 1/7 system packages =="
apt-get update -y -qq >/dev/null
apt-get install -y -qq curl git ca-certificates openssl postgresql postgresql-contrib >/dev/null

echo "== 2/7 node =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v), npm $(npm -v)"

echo "== 3/7 app user + code =="
id -u $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin $APP_USER
if [ -d $APP_DIR/.git ]; then git -C $APP_DIR pull -q; else git clone -q https://github.com/dhve/porchlight.git $APP_DIR; fi
cd $APP_DIR
npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null

echo "== 4/7 chromium for the browser agent =="
mkdir -p $PW_BROWSERS
PLAYWRIGHT_BROWSERS_PATH=$PW_BROWSERS npx playwright install --with-deps chromium >/dev/null 2>&1
chmod -R a+rX $PW_BROWSERS

echo "== 5/7 postgres =="
systemctl enable --now postgresql >/dev/null 2>&1
if grep -q '^DATABASE_URL=' $APP_DIR/.env 2>/dev/null; then
  echo "database already configured; keeping the existing password"
  DBPW=unchanged
else
DBPW=$(openssl rand -hex 24)
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='porchlight') THEN
    CREATE ROLE porchlight LOGIN PASSWORD '$DBPW';
  ELSE
    ALTER ROLE porchlight WITH PASSWORD '$DBPW';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE porchlight OWNER porchlight' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='porchlight')\gexec
SQL
echo "database ready"
fi

echo "== 6/7 .env =="
touch $APP_DIR/.env
if [ -f /root/porchlight-openai.env ]; then
  # Merge uploaded settings into the existing .env without dropping anything already there.
  while IFS= read -r line; do
    k="${line%%=*}"; [ -n "$k" ] || continue
    if grep -q "^$k=" $APP_DIR/.env; then python3 - "$APP_DIR/.env" "$k" "$line" <<'PYX'
import sys,re; p,k,line=sys.argv[1:4]; s=open(p).read(); s=re.sub(r'^'+re.escape(k)+r'=.*$', line.replace('\\','\\\\'), s, flags=re.M); open(p,'w').write(s)
PYX
    else echo "$line" >> $APP_DIR/.env; fi
  done < <(grep -E '^[A-Z_]+=' /root/porchlight-openai.env)
  rm -f /root/porchlight-openai.env
fi
grep -q '^DATABASE_URL=' $APP_DIR/.env || echo "DATABASE_URL=postgres://porchlight:$DBPW@localhost:5432/porchlight" >> $APP_DIR/.env
grep -q '^PORT=' $APP_DIR/.env || echo "PORT=$PORT" >> $APP_DIR/.env
chown -R $APP_USER:$APP_USER $APP_DIR
chmod 600 $APP_DIR/.env
echo ".env preserved and updated (keys: $(grep -o '^[A-Z_]*=' $APP_DIR/.env | tr -d '=' | tr '\n' ' '))"
for k in SIGNING_PRIVATE_KEY SESSION_SECRET APP_URL; do grep -q "^$k=." $APP_DIR/.env || echo "WARNING: $k is not set in .env"; done

echo "== 7/7 systemd service =="
cat > /etc/systemd/system/porchlight.service <<UNIT
[Unit]
Description=Porchlight website checkup
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PLAYWRIGHT_BROWSERS_PATH=$PW_BROWSERS

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable porchlight >/dev/null 2>&1
systemctl restart porchlight
sleep 4
systemctl is-active porchlight && journalctl -u porchlight --no-pager -n 6 | sed 's/^/  /'

if ufw status 2>/dev/null | grep -q '^Status: active'; then ufw allow $PORT/tcp >/dev/null && echo "ufw: opened $PORT/tcp"; else echo "ufw: not active (no change)"; fi

echo "== health =="
curl -s http://127.0.0.1:$PORT/api/health; echo
echo "DEPLOY_DONE"
