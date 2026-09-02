#!/usr/bin/env bash
# Local runner: copies the deploy script + the OpenAI lines from the local .env
# to the droplet over SSH (the key is never printed), then runs the deploy.
set -euo pipefail
HOST=root@67.205.176.71
SP=$(cd "$(dirname "$0")" && pwd)
scp -q -o StrictHostKeyChecking=accept-new "$SP/deploy-porchlight.sh" $HOST:/root/deploy-porchlight.sh
grep -E '^OPENAI_' "$SP/../.env" | ssh $HOST 'umask 077; cat > /root/porchlight-openai.env'
ssh $HOST 'bash /root/deploy-porchlight.sh'
