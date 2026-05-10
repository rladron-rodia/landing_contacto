# Disaster Recovery Runbook — Monou Landing AWS Stack

Guía operativa para retomar el proyecto rápidamente si algo se rompe.
Asume que el stack productivo está 100% en AWS post-v3.0.0.

**Última actualización:** 2026-05-10

---

## 1. Inventario crítico — qué existe y dónde

### 1.1 Código fuente

| Ubicación | Propósito | Notas |
|---|---|---|
| `~/Documents/Claude/Projects/landing/Landing/` (Mac) | Working copy local | Es la fuente diaria de cambios |
| `https://github.com/rladron-rodia/landing_contacto` | Remote canónico | Backup gratuito + tags |
| `s3://monou-deploy-artifacts-prod/artifacts/` | Builds históricos (zips) | 90 días lifecycle, cada `./deploy.sh` deja artifact |

### 1.2 Variables de estado (paths, IDs, vars)

| Archivo | Contenido | Backup recomendado |
|---|---|---|
| `~/aws-monou-migration/monou-vars.sh` | Todos los IDs de recursos AWS y endpoints | Copia en password manager (nota encriptada) |
| `~/aws-monou-migration/.gitignore` | Lista de archivos a no versionar (incluyendo `.tmp-*`) | — |

### 1.3 Infraestructura AWS

| Recurso | Identificador |
|---|---|
| Account ID | `325907670798` |
| Region | `us-east-1` |
| IAM user (deploy) | `monou-landing-deployer` |
| CLI profile | `monou-prod` (en `~/.aws/credentials`) |
| EC2 instance | `i-0dd84a9059f047b53` |
| RDS instance | `monou-postgres-prod` |
| ALB | `monou-alb` |
| CloudFront distribution | `E1XWJ852NOX2OQ` |
| Route 53 hosted zone | `monoulabs.ai.` |

### 1.4 Credenciales y secretos

| Credential | Dónde vive | Criticidad |
|---|---|---|
| AWS root account | Password manager (1Password/Bitwarden) con MFA | **EXTREMO** — recuperación última |
| AWS IAM Access Keys (`monou-landing-deployer`) | Password manager + `~/.aws/credentials` | **EXTREMO** — acceso CLI diario |
| AWS MFA backup codes (root) | Password manager (separado del MFA app) | **EXTREMO** — sin esto, root account inaccesible |
| GitHub SSH key | `~/.ssh/id_ed25519` (Mac) + público en GitHub | ALTO |
| Resend API key | Secrets Manager `monou/prod/app` (rotable desde dashboard) | MEDIO |
| `ADMIN_TOKEN` | Secrets Manager `monou/prod/app` (recuperable via magic link) | MEDIO |
| `FLASK_SECRET_KEY` | Secrets Manager `monou/prod/app` (rotación invalida sesiones admin) | MEDIO |
| RDS master password | Secrets Manager `monou/prod/database` (rotable via `aws rds modify-db-instance`) | ALTO |
| KMS key `alias/monou-key-01` | Customer-managed en AWS, irrecuperable si se borra | **EXTREMO** — encripta secretos y SSM sessions |

> ⚠️ **NUNCA borres el KMS key `alias/monou-key-01`**. Si lo haces, todos los secretos quedan inutilizables y hay que regenerarlos uno por uno. AWS impone un mínimo de 7 días para schedule deletion, pero es mejor ni intentarlo.

---

## 2. Backups automáticos (qué se respalda solo)

| Recurso | Mecanismo | Retención | Acción manual? |
|---|---|---|---|
| RDS Postgres | Automated backups (snapshots) | **7 días** | Considerar extender a 30d |
| RDS Postgres | Manual snapshots | indefinida | **Tomar 1 mensual antes de cambios mayores** |
| S3 `monoulabs-landing-prod` | Versionado activo | indefinido | — |
| S3 `monou-deploy-artifacts-prod` | Versionado + lifecycle | 90 días | — |
| S3 `monou-landing-images-prod` | (verificar versionado) | — | — |
| Secrets Manager | Versionado interno | últimas versiones | — |
| Parameter Store | Versionado | hasta 100 versiones | — |
| Route 53 | (sin backup automático) | — | **Export manual mensual** |
| KMS key | Sin "borrado real" inmediato | 7-30 días schedule | — |
| CloudTrail logs | Default 90 días | 90 días | Considerar archivar a S3 long-term |

---

## 3. Backups manuales recomendados (mensuales)

### 3.1 Git bundle a S3 (defensa en profundidad por si GitHub falla)

```bash
cd ~/Documents/Claude/Projects/landing/Landing
git bundle create /tmp/landing-$(date +%Y%m%d).bundle --all
aws s3 cp /tmp/landing-$(date +%Y%m%d).bundle \
  s3://monou-deploy-artifacts-prod/git-bundles/ \
  --profile monou-prod
rm /tmp/landing-$(date +%Y%m%d).bundle
```

Para restaurar desde un bundle:
```bash
aws s3 cp s3://monou-deploy-artifacts-prod/git-bundles/landing-YYYYMMDD.bundle .
git clone landing-YYYYMMDD.bundle landing-restored
```

### 3.2 Export de Route 53 hosted zone

```bash
HZ_ID=$(aws route53 list-hosted-zones --query "HostedZones[?Name=='monoulabs.ai.'].Id" --output text | sed 's|/hostedzone/||')
aws route53 list-resource-record-sets --hosted-zone-id "$HZ_ID" \
  --output json > "/tmp/route53-monoulabs-$(date +%Y%m%d).json"
aws s3 cp /tmp/route53-monoulabs-*.json \
  s3://monou-deploy-artifacts-prod/route53-snapshots/ \
  --profile monou-prod
```

### 3.3 Snapshot manual de RDS antes de cambios mayores

```bash
aws rds create-db-snapshot \
  --db-snapshot-identifier "monou-postgres-prod-pre-v3X-$(date +%Y%m%d)" \
  --db-instance-identifier monou-postgres-prod
```

### 3.4 Export de Secrets Manager + Parameter Store

```bash
# Secrets (cuidado: los outputs tienen valores en plaintext)
aws secretsmanager list-secrets --query 'SecretList[].[Name,ARN]' --output json > /tmp/secrets-list.json

# Parameter Store
aws ssm get-parameters-by-path --path /monou/prod/ --with-decryption \
  --query 'Parameters[].[Name,Value,Version]' --output json > /tmp/params.json
```

> ⚠️ **No subas estos exports a S3 sin encriptación adicional**. Mejor: copia a un USB encriptado físico, o nota encriptada del password manager.

---

## 4. Escenarios de recuperación

### 4.1 Mi Mac muere

1. Compra Mac nueva
2. Recupera `~/.aws/credentials` con las Access Keys del password manager
3. `aws configure --profile monou-prod` con las keys
4. `git clone https://github.com/rladron-rodia/landing_contacto.git ~/Documents/Claude/Projects/landing/Landing`
5. Recupera `~/aws-monou-migration/monou-vars.sh` del password manager (o regenéralo: ver §6)
6. `brew install awscli libpq jq` y `brew install --cask session-manager-plugin`
7. Ya estás de vuelta. Para deploys: `cd Landing && ./deploy.sh`

### 4.2 Backend AWS no responde (EC2/ALB caídos)

```bash
source ~/aws-monou-migration/monou-vars.sh

# Diagnóstico
aws elbv2 describe-target-health --target-group-arn \
  $(aws elbv2 describe-target-groups --names monou-backend-tg --query 'TargetGroups[0].TargetGroupArn' --output text)

# Conectarse al EC2 y ver logs
aws ssm start-session --target $INSTANCE_ID
# adentro:
sudo systemctl status monou-backend
sudo journalctl -u monou-backend -n 200 --no-pager

# Si la EC2 está rota, terminarla y dejar que ASG lance reemplazo
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
# Esperar ~3 min a que ASG cree una nueva (mismo identifier en el target group)

# Una vez la EC2 nueva esté SSM-Online:
cd ~/Documents/Claude/Projects/landing/Landing
./deploy.sh
```

### 4.3 RDS corrupto o datos perdidos

```bash
# Listar snapshots disponibles
aws rds describe-db-snapshots \
  --db-instance-identifier monou-postgres-prod \
  --query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotCreateTime,Status]' \
  --output table

# Restaurar desde snapshot a una nueva instance
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier monou-postgres-prod-restored \
  --db-snapshot-identifier <snapshot-id> \
  --db-subnet-group-name monou-db-subnet-group \
  --vpc-security-group-ids $DB_SG \
  --no-publicly-accessible

# Esperar available, luego update el secret con el nuevo endpoint
NEW_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier monou-postgres-prod-restored \
  --query 'DBInstances[0].Endpoint.Address' --output text)

# Actualizar Secrets Manager con el nuevo endpoint (ver script en monou-vars.sh historico)
```

### 4.4 Frontend roto (S3 con build malo)

```bash
# Ver versiones disponibles del index.html
aws s3api list-object-versions --bucket monoulabs-landing-prod --prefix index.html \
  --query 'Versions[].[VersionId,LastModified,IsLatest]' --output table

# Restaurar a versión anterior
aws s3api copy-object \
  --copy-source "monoulabs-landing-prod/index.html?versionId=<previous-version-id>" \
  --bucket monoulabs-landing-prod \
  --key index.html

# Invalidar CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id E1XWJ852NOX2OQ \
  --paths '/index.html' '/admin/*'
```

### 4.5 GitHub repo inaccesible

- Tu Mac es la fuente alternativa
- Crea repo nuevo en otro provider (Bitbucket, GitLab, AWS CodeCommit si aún funciona, self-hosted Gitea)
- `git remote set-url origin <new-url> && git push --all && git push --tags`
- Si tienes git bundle en S3: ver §3.1

### 4.6 AWS account comprometido

1. Login con root account (creds en password manager con MFA)
2. **IAM**: rotar/desactivar Access Keys del IAM user comprometido
3. **CloudTrail**: auditar últimas 24h por accesos sospechosos
   ```bash
   aws cloudtrail lookup-events --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%S)" --output json | jq '.Events[] | {EventTime, EventName, Username}'
   ```
4. Si datos sensibles posiblemente exfiltrados:
   - Rotar **todos** los secretos en Secrets Manager
   - Rotar Resend API key
   - Forzar logout de sesiones admin (rotar `FLASK_SECRET_KEY` invalida cookies)
   - Considerar restore de RDS desde snapshot anterior al incidente
5. Actualizar password de root account

### 4.7 Pérdida de ADMIN_TOKEN

**Si tienes acceso al email registrado (MAIL_TO):**
1. Ve a `https://monoulabs.ai/admin/`
2. Click "¿Olvidé mi token?"
3. Recibe magic link en tu inbox (válido 15 min)
4. Click el link → auto-login

**Si no tienes acceso al email:**
```bash
aws secretsmanager get-secret-value --secret-id monou/prod/app \
  --query 'SecretString' --output text | jq -r .ADMIN_TOKEN
```

### 4.8 Quiero migrar a otro proveedor (lock-in)

Toda la infra es estándar y portable:

| Componente | Cómo migrarlo |
|---|---|
| Source code | Ya está en Git (clone en cualquier lado) |
| Frontend HTML/CSS/JS | Static — copy a cualquier S3-compatible (R2, Backblaze B2, GCS) |
| Backend Python | Cualquier Linux con Python 3.11 + las env vars correctas |
| RDS data | `pg_dump` → restore en cualquier Postgres 18+ (managed o self-hosted) |
| Secrets | Manualmente importar a HashiCorp Vault, Doppler, etc. |
| DNS | Apuntar nameservers en el registrar a otro DNS provider |
| Email | Resend o cualquier transactional email API |

Tiempo estimado de migración: 1-2 días si tienes los exports listos.

---

## 5. Cómo regenerar `monou-vars.sh` desde cero

Si pierdes el archivo, todos los IDs y endpoints son recuperables del API de AWS:

```bash
mkdir -p ~/aws-monou-migration && cd ~/aws-monou-migration

cat > monou-vars.sh <<'VARSEOF'
export AWS_PROFILE=monou-prod
export ACCOUNT_ID=325907670798
export AWS_REGION=us-east-1

# IDs estables (no cambian)
export INSTANCE_ID=i-0dd84a9059f047b53
export DIST_ID=E1XWJ852NOX2OQ
export DIST_DOMAIN=d1fsmvccut9qvt.cloudfront.net
export CERT_ARN=arn:aws:acm:us-east-1:325907670798:certificate/82230df2-4bb4-4961-81c6-8b241e30c002

# IDs/endpoints recuperables del API
VARSEOF

# VPC + subnets
echo "export VPC_ID=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=monou-vpc --query 'Vpcs[0].VpcId' --output text)" >> monou-vars.sh
echo "export PRIV_SN_A=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=monou-private-a --query 'Subnets[0].SubnetId' --output text)" >> monou-vars.sh
echo "export PRIV_SN_B=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=monou-private-b --query 'Subnets[0].SubnetId' --output text)" >> monou-vars.sh
# (más vars similares...)

# Backend SG, DB SG
echo "export BACKEND_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=monou-backend-sg --query 'SecurityGroups[0].GroupId' --output text)" >> monou-vars.sh
echo "export DB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=monou-db-sg --query 'SecurityGroups[0].GroupId' --output text)" >> monou-vars.sh

# RDS endpoint
echo "export DB_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier monou-postgres-prod --query 'DBInstances[0].Endpoint.Address' --output text)" >> monou-vars.sh
echo "export DB_PORT=5432" >> monou-vars.sh

# ALB DNS + HZID
echo "export ALB_DNS=$(aws elbv2 describe-load-balancers --names monou-alb --query 'LoadBalancers[0].DNSName' --output text)" >> monou-vars.sh
echo "export ALB_HZID=$(aws elbv2 describe-load-balancers --names monou-alb --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)" >> monou-vars.sh

# Route 53 hosted zone
echo "export HZ_ID=$(aws route53 list-hosted-zones --query \"HostedZones[?Name=='monoulabs.ai.'].Id\" --output text | sed 's|/hostedzone/||')" >> monou-vars.sh

source monou-vars.sh
```

---

## 6. Acciones preventivas mensuales (checklist)

- [ ] Tomar snapshot manual de RDS antes de cambios mayores
- [ ] Verificar git bundle reciente en S3 (`aws s3 ls s3://monou-deploy-artifacts-prod/git-bundles/`)
- [ ] Export de Route 53 hosted zone (§3.2)
- [ ] Audit CloudTrail por accesos no esperados de los últimos 30d
- [ ] Verificar que `monou-landing-deployer` Access Keys siguen activas (rotar cada 90d en Fase 9)
- [ ] Verificar quota de Resend (free tier: 3K/mes, después facturable)
- [ ] Verificar billing dashboard de AWS por gastos anómalos

---

## 7. Contactos de soporte

| Servicio | Contacto |
|---|---|
| AWS Support (Basic) | https://console.aws.amazon.com/support/ — solo billing/cuenta |
| AWS Support (upgrade a Developer $29/mo) | Recomendado para issues técnicos no-billing |
| GitHub Support | https://support.github.com/ |
| Resend Support | support@resend.com |
| Domain registrar (Route 53) | A través de AWS Support |

---

## 8. Notas finales

- **Esta guía debe revisarse cada 6 meses** o cuando hay cambios mayores en infraestructura.
- **El KMS key `alias/monou-key-01` es el single point of failure más crítico.** Sin él, todos los secretos quedan inutilizables. Considerar eventualmente: replicar a otra región o cambiar a key sin schedule deletion.
- **Para migración de proveedor (§4.8)**, considerar mantener IaC (Terraform/CloudFormation) en el repo en una iteración futura — facilita re-crear infra en otro account.
