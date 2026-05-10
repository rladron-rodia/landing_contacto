# Changelog

All notable changes to this project will be documented in this file.

El formato sigue [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
y este proyecto adhiere a [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.1.0] — 2026-05-10

### 🚀 Email migration: Resend → AWS SES (cierra promesa 100% AWS-native)

Toda la integración de email ahora va por AWS SES con `boto3` y autenticación
vía IAM instance role. Resend queda completamente fuera del stack productivo.

### Added

- **`_send_via_ses()` helper** en `server/app.py` que usa `boto3.client('ses')`.
  Sin secrets externos: credenciales toman del IAM role del EC2 via instance
  metadata (IMDSv2). Mismas exceptions semantics (EmailAuthError /
  EmailValidationError / EmailError) que el código previo de Resend.
- **IAM policy `SendEmailViaSES`** en `monou-backend-ec2-role`: permite
  `ses:SendEmail` y `ses:SendRawEmail` scope-limited a los identity ARNs
  de `monoulabs.ai` y `send.monoulabs.ai`.
- **DKIM completo en Route 53** (3 CNAMEs `_domainkey.monoulabs.ai`)
  validados por SES (`DkimAttributes.Status: SUCCESS`).
- **Custom MAIL FROM domain** `send.monoulabs.ai` configurado en SES
  (los registros MX/SPF ya existían en Route 53 desde antes).

### Changed

- **`server/app.py`**: `send_email()` y `_send_simple_email()` llaman directo
  a `_send_via_ses()`. Stack simplificado de un solo proveedor (no más
  dispatcher pattern con feature flag).
- **`deploy/start-monou.sh`**: ya no exporta `EMAIL_PROVIDER` — código solo
  soporta SES.

### Removed

- **`_send_via_resend()` function** y constante `RESEND_ENDPOINT` de `app.py`.
- **`_dispatch_send()` function**: dispatcher transitorio, ya no necesario.
- **`RESEND_API_KEY` field** de `monou/prod/app` Secrets Manager (rotated out).
- **`/monou/prod/EMAIL_PROVIDER` parameter** de Parameter Store (transitorio).
- **`resend._domainkey.monoulabs.ai` TXT record** de Route 53 (DNS de Resend).

### Validation

- E2E confirmado: form submission → SES → email entregado a `MAIL_TO` con
  `mailed-by: send.monoulabs.ai` (SPF align), `signed-by: monoulabs.ai`
  (DKIM válido), TLS encryption en transit.

### Costs

- Resend (era): plan free hasta 3K/mes, después $20/mo
- AWS SES (ahora): $0.10 por 1000 emails outbound = **~$0.01/mes** para
  el volumen actual del contact form (<100 emails/mes).

---

## [3.0.0] — 2026-05-09

### 🚀 Major: Migración Render → AWS

Toda la infraestructura migrada a AWS. A partir de esta versión, los deploys
se hacen exclusivamente al stack AWS. Render queda como standby de rollback
durante ~48h y luego se suspende.

### Added

- **AWS deployment pipeline** (`deploy.sh` + `deploy/install.sh` via SSM Run Command).
  Comando `./deploy.sh [version-tag]` builda artifact, sube a S3, dispara install
  remoto en EC2 y valida ALB target health.
- **systemd service** `monou-backend.service` corriendo gunicorn 2 workers como user
  `monou` con hardening (NoNewPrivileges, PrivateTmp, ProtectHome, ProtectSystem=full).
- **Magic-link admin token recovery**: flow vía email cuando se olvida ADMIN_TOKEN.
  Endpoints `/api/admin/request-token-recovery` y `/api/admin/exchange-recovery`.
  Rate-limited, signed-stateless con HMAC-SHA256, expiry 15 min.
- **CloudFront Function** `monou-url-rewriter` (viewer-request) que reescribe paths
  de subdirectorios (`/admin/` → `/admin/index.html`) requerido para S3 origins via OAC.
- **Documentación operacional** completa en `AWS-DEPLOY.md` (arquitectura, recursos,
  deploy workflow, troubleshooting, costos).
- **Plan original de migración** archivado en `docs/MIGRACION-AWS-PLAN.md` con
  disclaimer de discrepancias contra la realidad final.
- **Disaster recovery runbook** en `docs/DISASTER-RECOVERY.md`: inventario crítico,
  backups automáticos vs manuales, 8 escenarios de recuperación con comandos,
  checklist preventivo mensual. Defensa en profundidad para retomar el proyecto
  rápido si algo falla.

### Changed

- **Backend**: hosted en EC2 t4g.micro (us-east-1) en vez de Render free tier.
  Gunicorn 2 workers @ 0.0.0.0:8080 detrás de ALB con cert wildcard `*.monoulabs.ai`.
- **Database**: RDS Postgres 18.3 (db.t4g.micro, single-AZ, 20GB gp3, encrypted)
  en VPC privado, accesible solo desde EC2.
- **Frontend**: S3 + CloudFront con OAC + WAF v2. Sirve apex `monoulabs.ai`,
  `www.monoulabs.ai` y subdomains via cert wildcard.
- **Secrets**: AWS Secrets Manager (`monou/prod/database`, `monou/prod/app`)
  encriptados con KMS custom key (`alias/monou-key-01`). Parameter Store para
  config no-secreta (MAIL_FROM, MAIL_TO, ALLOWED_ORIGIN, S3_BUCKET, S3_REGION).
- **DNS**: 3 records actualizados en Route 53 (apex, www, api → AWS aliases).
- **Email**: Resend con dominio `monoulabs.ai` verificado (DKIM). `MAIL_FROM`
  cambió de `monou.gg` (no verificado) a `noreply@monoulabs.ai`.
- **Admin login UI**: textos actualizados (sin referencia a Render Environment).

### Fixed

- `/admin/` y otros subdirectorios servían el HOME por bug S3 OAC + CloudFront
  CustomErrorResponses (404 → /index.html). Resuelto con CloudFront Function.
- libpq fallaba con `EACCES /home/monou/.postgresql/postgresql.crt` por systemd
  `ProtectHome=true`. Resuelto con `HOME=/tmp` en wrapper de gunicorn.

### Infrastructure

- **AWS account**: `325907670798` (us-east-1)
- **IAM user deploy**: `monou-landing-deployer` (profile CLI: `monou-prod`)
- **Costo estimado**: ~$45-55/mes (incluye always-warm, full control, security hardening).
  Detalle en `AWS-DEPLOY.md`.

### Migration trace (resumen de fases ejecutadas)

- **Fase 1** — Bootstrap IAM + KMS custom key
- **Fase 2** — VPC, subnets públicas/privadas, NAT, route tables
- **Fase 3** — ALB, target group, listener HTTPS, EC2 ASG min=max=1
- **Fase 4** — S3 frontend + CloudFront + WAF v2 + OAC
- **Fase 5A** — RDS Postgres (rebuild a 18.3 para version-match con Render)
- **Fase 5B** — Secrets Manager + IAM least-privilege para EC2 role
- **Fase 5C** — Migración de datos (8 tablas, 108 rows) con MATCH PERFECTO
- **Fase 6** — Deploy de Flask app via SSM Run Command + `deploy.sh`
- **Fase 7** — DNS cutover Route 53 + smoke tests E2E end-to-end

### Render shutdown — completado el 2026-05-10

- ✅ Render web service `landing-contacto-backend` suspended
- ✅ Render Postgres `landing-contacto-db` suspended
- Stack productivo 100% en AWS para hosting + DB
- `render.yaml` queda en el repo por ahora; eliminar definitivamente en commit
  de cleanup futuro (tras 30-60 días sin issues)

### Pending (post-v3.0.0)

- **v3.1.0 — Email Resend → AWS SES**: completar la promesa "100% AWS-native".
  Verify monoulabs.ai en SES, DKIM en Route 53, production access (sacar del
  sandbox), refactor de `_send_simple_email()` y `send_email()` para usar
  `boto3.client('ses')`, IAM policy `ses:SendEmail` al EC2 role, cleanup de
  `RESEND_API_KEY` en Secrets Manager y record `resend._domainkey.monoulabs.ai`
  en Route 53. Costo estimado pasa de Resend (free tier hasta 3K/mes) a SES
  (~$0.10 por 1000 emails, prácticamente free para este volumen).
- **v3.2.0 — Sistema multi-usuario** con roles, permisos e invitaciones por
  email. Replace ADMIN_TOKEN single-token por users + sessions.
- **v3.3.0 (Fase 8) — Monitoring**: CloudWatch alarms + dashboard
  (5xx rate, ALB latency, DB connections, EC2 CPU). SNS topic para alertas.
- **v3.4.0 (Fase 9) — IAM hardening**: downgrade `monou-landing-deployer`
  de AdministratorAccess a custom least-privilege policy basada en CloudTrail
  de los últimos 30 días.
- **Auto-renew domain** `monoulabs.ai` en Route 53 (expira 2028-04-28).

---

## [2.7.1] — 2026-04-30 (untagged)

### Security
- Bump Pillow 11.3.0 → 12.2.0 (cierra 6 CVEs)

## [2.7.0] — 2026-04-XX

### Added
- Image upload UI en admin
- Rendering de `<picture>` element en frontend
- Persistencia de `image_webp_url` en DB

## [2.6.0 y anteriores]

Para versiones previas, consultar `git log` o tags individuales:
- v2.6.0, v2.5.0, v2.4.x, v2.3.0, v2.2.x, v2.1.x, v2.0.0
- v1.x: iteraciones del backend (SMTP → Resend, admin dashboard, stats, etc.)
