# AWS Deployment Guide — Monou Landing

Stack en AWS prod (account `325907670798`, region `us-east-1`). Migración desde Render completada el 2026-05-09.

---

## Arquitectura

```
                                 ┌──────────────────┐
       monoulabs.ai              │   CloudFront     │
       www.monoulabs.ai  ───►    │  E1XWJ852NOX2OQ  │  ───►  S3: monoulabs-landing-prod (frontend)
                                 │   + WAF v2       │        (privado, OAC)
                                 └──────────────────┘
                                         │
                                         │ /api/*  (no, separated subdomain)
                                         │
       api.monoulabs.ai  ───►    ┌──────────────────┐
                                 │   ALB monou-alb  │  ───►  EC2 i-0dd84a9059f047b53
                                 │   HTTPS:443      │        AL2023 aarch64 (Graviton)
                                 │   HTTP:80→redir  │        gunicorn:8080
                                 └──────────────────┘        systemd: monou-backend.service
                                         │                            │
                                         │                            ▼
                                         │                   ┌─────────────────┐
                                         │                   │  RDS Postgres   │
                                         │                   │  18.3, db.t4g.μ │
                                         │                   │  10.20.12.244   │
                                         │                   │  monou_contacts │
                                         │                   └─────────────────┘
                                         │                            ▲
                                         │                            │ via instance role
                                         ▼                            │
                              ┌────────────────────────┐              │
                              │   Resend API           │  ◄───────────┤
                              │   (verified domain:    │              │
                              │    monoulabs.ai)       │              │
                              │   ⚠ transitorio →      │              │
                              │   migrar a SES (v3.1)  │              │
                              └────────────────────────┘              │
                                                                      │
                                       ┌──────────────────────────────┘
                                       │
                              ┌────────────────────────┐
                              │  Secrets Manager       │
                              │  monou/prod/database   │
                              │  monou/prod/app        │
                              │  + Parameter Store     │
                              │  /monou/prod/*         │
                              └────────────────────────┘
```

---

## Recursos principales

| Recurso | Identificador | Notas |
|---|---|---|
| VPC | `vpc-07ae219f9382a144a` | 10.20.0.0/16 |
| Public subnets | `subnet-073117b97708e2df2` (1a), `subnet-0104eb1bcd4ce3d56` (1b) | NAT Gateway, ALB |
| Private subnets | `subnet-0179d5d8c02262b22` (1a), `subnet-01c745b670c34eff6` (1b) | EC2, RDS |
| ALB | `monou-alb` | DNS: `monou-alb-1032172112.us-east-1.elb.amazonaws.com`, HZID: `Z35SXDOTRQ7X7K` |
| Target Group | `monou-backend-tg` | Port 8080 HTTP, health: `/api/health` |
| EC2 | `i-0dd84a9059f047b53` | t4g.micro, AL2023 aarch64, IP `10.20.12.168` |
| RDS | `monou-postgres-prod` | Postgres 18.3, db.t4g.micro, endpoint `monou-postgres-prod.cowccpt62qak.us-east-1.rds.amazonaws.com` |
| S3 frontend | `monoulabs-landing-prod` | Privado, OAC para CloudFront |
| S3 deploy | `monou-deploy-artifacts-prod` | Versionado, lifecycle 90d |
| S3 imágenes | `monou-landing-images-prod` | App-uploaded |
| CloudFront | `E1XWJ852NOX2OQ` | DNS: `d1fsmvccut9qvt.cloudfront.net` |
| WAF | `monou-waf-cloudfront` | Common Rule Set + IP Reputation |
| CloudFront Function | `monou-url-rewriter` | viewer-request, rewrites `/path/` → `/path/index.html` (S3 OAC needs explicit index resolution) |
| KMS key | `alias/monou-key-01` | `7db586b2-1622-401f-83d2-155e9bd2603c` |
| ACM cert | `arn:aws:acm:us-east-1:325907670798:certificate/82230df2-4bb4-4961-81c6-8b241e30c002` | `monoulabs.ai`, `*.monoulabs.ai` |
| EC2 IAM role | `monou-backend-ec2-role` | 4 inline policies |
| IAM user (deploy) | `monou-landing-deployer` | Profile CLI: `monou-prod` |
| Hosted zone | `monoulabs.ai.` | Route 53 |

---

## DNS records actuales en Route 53

| Record | Type | Target |
|---|---|---|
| `monoulabs.ai` | A (alias) | CloudFront `d1fsmvccut9qvt.cloudfront.net` |
| `www.monoulabs.ai` | A (alias) | CloudFront `d1fsmvccut9qvt.cloudfront.net` |
| `api.monoulabs.ai` | A (alias) | ALB `monou-alb-1032172112.us-east-1.elb.amazonaws.com` |
| `_dmarc.monoulabs.ai` | TXT | DMARC policy |
| `resend._domainkey.monoulabs.ai` | TXT | Resend DKIM |
| `_fe73...acm-validations.aws` | CNAME | ACM cert validation |
| `monoulabs.ai` | TXT | Google Search Console verification |
| `send.monoulabs.ai` | MX, TXT | SES feedback |

---

## Workflow de deploy

### Quick deploy (lo más usual)

```bash
cd ~/Documents/Claude/Projects/landing/Landing
./deploy.sh                    # despliega HEAD actual (git describe da el version label)
./deploy.sh v2.7.5             # despliega un tag específico (debe estar checked-out localmente)
```

El script:
1. Build artifact zip de `server/` + `deploy/`
2. Upload a `s3://monou-deploy-artifacts-prod/artifacts/`
3. Trigger SSM Run Command que: descarga, extract, install.sh
4. install.sh: stop service → atomic swap → venv install → systemd restart → local health check
5. Espera ALB target health → `healthy`

### Workflow git recomendado

```bash
# Desarrollar feature
git checkout -b feature/<x>
# ... cambios ...
git commit -am "feat: ..."
git push origin feature/<x>

# PR + merge a main (vía GitHub UI)
git checkout main
git pull
git tag v2.7.5  # bump apropiado de minor/patch
git push --tags

# Deploy
./deploy.sh v2.7.5
```

### Frontend deploy (S3 + CloudFront)

Cuando cambies HTML/CSS/JS del frontend (no `server/`):

```bash
cd ~/Documents/Claude/Projects/landing/Landing

# Sync al bucket de frontend
aws s3 sync . s3://monoulabs-landing-prod/ \
  --exclude '.git/*' \
  --exclude 'server/*' \
  --exclude 'deploy/*' \
  --exclude 'deploy.sh' \
  --exclude 'node_modules/*' \
  --exclude '*.md' \
  --exclude '.venv/*' \
  --exclude '*.pyc' \
  --exclude '__pycache__/*' \
  --exclude '.DS_Store' \
  --exclude '*.sh' \
  --cache-control 'public, max-age=3600' \
  --profile monou-prod

# Re-upload index.html con cache corto
aws s3 cp index.html s3://monoulabs-landing-prod/index.html \
  --cache-control 'public, max-age=60' \
  --content-type 'text/html' \
  --profile monou-prod

# Invalidar cache de CloudFront
aws cloudfront create-invalidation \
  --distribution-id E1XWJ852NOX2OQ \
  --paths '/*' \
  --profile monou-prod
```

---

## Acceso a los recursos

### SSM Session Manager (shell en EC2)

```bash
source ~/aws-monou-migration/monou-vars.sh
aws ssm start-session --target "$INSTANCE_ID"
```

Útiles desde adentro:

```bash
sudo journalctl -u monou-backend -f                  # logs en vivo
sudo systemctl restart monou-backend.service         # restart sin redeploy
sudo systemctl status monou-backend.service          # estado
ls -la /opt/monou-backend/                           # ver instalación
sudo cat /opt/monou-backend/deploy/start-monou.sh    # ver wrapper
```

### Acceso a RDS desde Mac (port forward via EC2)

```bash
source ~/aws-monou-migration/monou-vars.sh

aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$DB_ENDPOINT\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"55432\"]}" \
  > /tmp/ssm-tunnel.log 2>&1 &

TUNNEL_PID=$!
sleep 8
nc -vz -w 3 127.0.0.1 55432

# Connect (usa 127.0.0.1, NO localhost — IPv4 mismatch issue)
RDS_PASS=$(aws secretsmanager get-secret-value --secret-id monou/prod/database --query 'SecretString' --output text | jq -r .password)
PGPASSWORD="$RDS_PASS" psql -h 127.0.0.1 -p 55432 -U monou_admin -d monou_contacts

# Cleanup cuando termines
kill $TUNNEL_PID
pkill -f session-manager-plugin
unset RDS_PASS
```

### Ver/editar secrets

```bash
# Database secret
aws secretsmanager get-secret-value --secret-id monou/prod/database --query 'SecretString' --output text | jq .

# App secret
aws secretsmanager get-secret-value --secret-id monou/prod/app --query 'SecretString' --output text | jq .

# Update específicamente un campo (ej. RESEND_API_KEY)
NEW_KEY="re_..."
CURRENT=$(aws secretsmanager get-secret-value --secret-id monou/prod/app --query 'SecretString' --output text)
NEW=$(echo "$CURRENT" | jq --arg k "$NEW_KEY" '.RESEND_API_KEY = $k')
aws secretsmanager update-secret --secret-id monou/prod/app --secret-string "$NEW"
# después: restart del service para que el wrapper relea
```

### Parameter Store

```bash
# Listar todos
aws ssm get-parameters-by-path --path /monou/prod/ --query 'Parameters[].[Name,Value]' --output table

# Update
aws ssm put-parameter --name /monou/prod/MAIL_FROM --value "noreply@monoulabs.ai" --type String --overwrite
# después: restart service
```

### Restart del backend sin redeploy

```bash
# Por SSM Run Command (rápido, no requiere abrir sesión interactiva)
aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo systemctl restart monou-backend.service"]'
```

---

## Troubleshooting

### `/api/health` da 502/504

1. ¿EC2 está running?
   ```bash
   aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name'
   ```
2. ¿gunicorn está corriendo?
   ```bash
   aws ssm start-session --target "$INSTANCE_ID"
   sudo systemctl status monou-backend
   ```
3. ¿ALB target healthy?
   ```bash
   TG_ARN=$(aws elbv2 describe-target-groups --names monou-backend-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
   aws elbv2 describe-target-health --target-group-arn "$TG_ARN"
   ```

### Sub-rutas estáticas (`/admin/`, etc.) sirven el HOME en vez del contenido

S3 con OAC no auto-resuelve `/admin/` → `/admin/index.html`. CloudFront Function `monou-url-rewriter` (asociada al default cache behavior viewer-request) hace el rewrite. Si agregas una nueva sub-ruta y no funciona, verifica:
```bash
aws cloudfront get-function --name monou-url-rewriter --stage LIVE | head -30
```

Para editar la lógica:
```bash
# Edit local file, then update + publish
aws cloudfront update-function --name monou-url-rewriter \
  --function-config "Comment=...,Runtime=cloudfront-js-2.0" \
  --function-code fileb://url-rewriter.js \
  --if-match $(aws cloudfront describe-function --name monou-url-rewriter --query 'ETag' --output text)

ETAG=$(aws cloudfront describe-function --name monou-url-rewriter --query 'ETag' --output text)
aws cloudfront publish-function --name monou-url-rewriter --if-match "$ETAG"
```

### Form retorna error pero `/health` OK

Suele ser DB o Resend. Ver logs:
```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo journalctl -u monou-backend -n 200 --no-pager | tail -100
```

### DB desincronizada o queries lentas

Conectarte via port forward y ver:
```bash
PGPASSWORD="..." psql -h 127.0.0.1 -p 55432 -U monou_admin -d monou_contacts -c "
SELECT * FROM pg_stat_activity WHERE datname='monou_contacts';
"
```

### Rollback del deploy

`install.sh` mantiene `/opt/monou-backend.old` después de cada deploy. Para rollback rápido:
```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo systemctl stop monou-backend
sudo mv /opt/monou-backend /opt/monou-backend.failed
sudo mv /opt/monou-backend.old /opt/monou-backend
sudo systemctl start monou-backend
```

O hacer rollback "proper" via deploy.sh con un tag anterior:
```bash
git checkout v2.7.0  # tag anterior
./deploy.sh
git checkout main
```

---

## Variables de entorno (cómo la app las recibe)

Todas vienen de `start-monou.sh` que las exporta antes de `exec gunicorn`:

| Var | Origen |
|---|---|
| `DATABASE_URL` | Secrets Manager `monou/prod/database` campo `.url` |
| `RESEND_API_KEY` | Secrets Manager `monou/prod/app` campo `.RESEND_API_KEY` |
| `ADMIN_TOKEN` | Secrets Manager `monou/prod/app` campo `.ADMIN_TOKEN` |
| `FLASK_SECRET_KEY` | Secrets Manager `monou/prod/app` campo `.FLASK_SECRET_KEY` |
| `MAIL_FROM` | Parameter Store `/monou/prod/MAIL_FROM` |
| `MAIL_TO` | Parameter Store `/monou/prod/MAIL_TO` |
| `ALLOWED_ORIGIN` | Parameter Store `/monou/prod/ALLOWED_ORIGIN` |
| `S3_BUCKET` | Parameter Store `/monou/prod/S3_BUCKET` |
| `S3_REGION` | Parameter Store `/monou/prod/S3_REGION` |
| `PORT` | Hardcoded 8080 en wrapper |
| `HOME` | Hardcoded `/tmp` en wrapper (workaround systemd `ProtectHome=true`) |
| AWS credentials | NO env vars — boto3 las toma del instance role |

Para refrescar env vars después de cambiar Secrets/Parameter Store: **restart del service** (SSM Run Command).

---

## Costos aproximados (us-east-1, mensual)

| Recurso | ~Costo/mes |
|---|---|
| EC2 t4g.micro | ~$6 |
| RDS db.t4g.micro single-AZ | ~$13 |
| EBS gp3 20 GB | ~$2 |
| ALB | ~$16 + $0.008/LCU-hour |
| CloudFront | ~$0-5 (depende tráfico) |
| S3 frontend + deploy + images | ~$0.50 |
| Route 53 hosted zone | $0.50 + $0.40/M queries |
| Secrets Manager (2 secrets) | $0.80 |
| Parameter Store | $0 (Standard tier free) |
| KMS custom key | $1 |
| WAF v2 | $5 + $1/M requests |
| **Total estimado** | **~$45-55/mes** |

Comparado con Render ($0 free tier hasta dormido): mayor costo pero gana siempre-warm, performance, control, y stack unificado.

---

## Disaster Recovery

Si algo se rompe, ver [`docs/DISASTER-RECOVERY.md`](docs/DISASTER-RECOVERY.md). Cubre:
- Inventario crítico (qué existe, dónde, qué credentials viven dónde)
- Backups automáticos (RDS 7d, S3 versionado, etc.) y manuales recomendados
- 8 escenarios de recuperación con comandos exactos (Mac muere, EC2 caído,
  RDS corrupto, frontend roto, GitHub inaccesible, AWS comprometido, ADMIN_TOKEN
  perdido, migración a otro proveedor)
- Cómo regenerar `monou-vars.sh` desde cero usando solo APIs de AWS
- Checklist preventivo mensual

---

## Pendientes / Roadmap

### Completados después del cierre v3.0.0

- ✅ **Render shutdown** (2026-05-10): web service y Postgres suspended.
  Stack hosting + DB 100% en AWS.

### Próximas versiones

- **v3.1.0 — Email Resend → AWS SES** (próxima): completar la promesa "100% AWS-native".
  El email actual va por **Resend HTTP API** (transitorio). Migrar a `boto3.client('ses')`
  con dominio `monoulabs.ai` verificado en SES (Route 53 ya tiene MX/SPF de SES en
  `send.monoulabs.ai`, falta agregar DKIM del dominio principal y request prod access
  para sacar del sandbox).
- **v3.2.0 — Sistema multi-usuario** con roles, permisos e invitaciones por email.
  Replace ADMIN_TOKEN single-token por users + sessions.
- **v3.3.0 (Fase 8) — Monitoring/alerting**: CloudWatch alarms (5xx rate, ALB latency,
  RDS connections, EC2 CPU), SNS topic, dashboard.
- **v3.4.0 (Fase 9) — Hardening**: downgrade IAM user de AdministratorAccess a
  least-privilege custom policy basada en CloudTrail, tightening egress SGs,
  rotation policies para secrets.
- **Auto-renew domain**: activar auto-renew en Route53 para `monoulabs.ai`
  (expira 2028-04-28).
- **Backup strategy**: habilitar punto-en-tiempo-recovery (PITR) en RDS más allá
  de los 7d default.
- **CodeDeploy formal**: considerar si crece a multi-instance o necesitas blue-green.
- **Cleanup de `render.yaml`**: borrar del repo después de 30-60 días sin issues
  (cuando confidence de que no necesitas rollback a Render sea total).
