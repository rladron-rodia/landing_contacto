# Migración Render → AWS — Cuestionario + Guía paso a paso

**Proyecto:** monoulabs.ai landing (Flask + Postgres + GitHub Pages → AWS)
**Versión origen:** v2.3.0 (en Render + GitHub Pages + Resend)
**Versión destino:** AWS-native con Aurora PostgreSQL

---

## Cómo usar este documento

1. Lee la **Parte 1 — Cuestionario**. Cada sección tiene preguntas con
   opciones marcadas con `[ ]`. Responde escribiendo tu elección o
   tachando lo que no aplica.
2. Cuando termines, mándame el cuestionario lleno y personalizo la
   **Parte 2 — Guía paso a paso** con valores concretos (region, VPC CIDR,
   tipos de instancia, etc.)
3. La guía actual es el esqueleto genérico — útil ya como referencia
   conceptual, pero los comandos concretos se rellenan tras tu input.

---

# PARTE 1 — CUESTIONARIO

## A. Objetivos de la migración

**A.1** ¿Por qué migrar a AWS? (marca los que apliquen)

- [ ] Costo (Render free tier ya no alcanza)
- [ ] Performance (cold starts del free tier matan UX)
- [ ] Control / customización (necesito instalar X, configurar Y)
- [ ] Compliance / requerimiento de cliente (SOC2, ISO, contractual)
- [ ] Escala (esperas más tráfico del que Render aguanta)
- [ ] Estandarización (resto de la stack ya está en AWS)
- [ ] Otro: _______________

**A.2** ¿Cuál es la urgencia? (timeline)

- [ ] Inmediato (1–2 semanas)
- [ ] Corto plazo (1 mes)
- [ ] Medio plazo (1–3 meses)
- [ ] Sin prisa, planeación

**A.3** ¿Quién va a operar AWS después de la migración?

- [ ] Sólo yo (Rodrigo)
- [ ] Yo + 1 persona técnica
- [ ] Equipo dedicado de DevOps / SRE
- [ ] Tercero (consultora, MSP)

**A.4** ¿Cuál es el SLA / disponibilidad objetivo?

- [ ] Best-effort (~99%)
- [ ] Producción seria (~99.9%, single AZ ok)
- [ ] Crítico (99.95%+, Multi-AZ obligatorio)

---

## B. Cuenta AWS

**B.1** Estado de la cuenta:

- [ ] No tengo cuenta AWS — necesito crear una
- [ ] Tengo cuenta personal sin nada en producción
- [ ] Tengo cuenta(s) en AWS Organizations
- [ ] Tengo cuenta corporativa de Monou Labs ya creada

**B.2** Identidades / acceso:

- [ ] Voy a usar root user (no recomendado pero rápido)
- [ ] Crearé IAM Identity Center (SSO) — recomendado
- [ ] Usaré IAM users tradicionales con MFA
- [ ] Federación con Google Workspace / Okta / Azure AD: ___________

**B.3** Region principal:

- [ ] us-east-1 (Virginia) — cheaper, más servicios primero
- [ ] us-east-2 (Ohio)
- [ ] us-west-2 (Oregon) — más barato que us-east-1 a veces
- [ ] sa-east-1 (São Paulo) — si tu usuario está en LATAM
- [ ] mx-central-1 (Mexico) — más cercano para audiencia LATAM
- [ ] Otro: ___________
- [ ] No sé / sin preferencia

**B.4** ¿Cuentas separadas para entornos? (organizaciones)

- [ ] No, todo en una cuenta (más simple)
- [ ] Cuenta separada para prod vs dev/staging
- [ ] Estructura completa: management + prod + staging + dev + log archive

**B.5** Presupuesto mensual aproximado AWS:

- [ ] < $20 USD/mes (proyecto chico)
- [ ] $20–$100 USD/mes
- [ ] $100–$500 USD/mes
- [ ] $500+ USD/mes (escala real)
- [ ] Sin límite, pero con visibilidad

**B.6** ¿Quieres alertas de billing?

- [ ] Sí, con AWS Budgets a $X umbral (decir cuánto: __________)
- [ ] No por ahora

---

## C. Frontend

**C.1** ¿Qué hacer con el frontend (HTML estático)?

- [ ] Mantener en GitHub Pages, sólo migrar backend (más simple)
- [ ] Migrar a S3 + CloudFront (CDN + control de cabeceras + WAF)
- [ ] Migrar a AWS Amplify Hosting (PaaS para sitios estáticos)

**C.2** Si migras a S3+CloudFront:

- [ ] Necesito que sirva `monoulabs.ai` (ápex)
- [ ] Necesito que sirva `www.monoulabs.ai` (subdominio)
- [ ] Necesito ambos con redirect ápex→www o www→ápex (cuál: _______)
- [ ] CloudFront WAF habilitado (recomendado)
- [ ] HTTP→HTTPS redirect forzado (recomendado)

**C.3** ¿Vas a usar el subdominio `admin.monoulabs.ai` separado o seguirá
siendo `/admin` en la landing?

- [ ] Mantener `/admin` (igual que hoy)
- [ ] Mover a `admin.monoulabs.ai` (más limpio, separa cookies/CSP)

---

## D. Backend (Flask)

**D.1** Plataforma de cómputo (la decisión más importante):

- [ ] **App Runner** — PaaS, parecido a Render, mínima ops, ~$25/mo
- [ ] **ECS Fargate** — containers serverless, más control, ~$15–40/mo según uso
- [ ] **EC2 con Auto Scaling Group + ALB** — máximo control, más ops
- [ ] **Elastic Beanstalk** — PaaS clásico de AWS, queda casi descontinuado
- [ ] **Lambda + API Gateway** — serverless, requiere refactor a WSGI
  adapter (Mangum/Zappa), pero pago sólo por uso real
- [ ] No sé, ayúdame a decidir

> **Mi sugerencia para tu caso**: **App Runner** si quieres "set & forget"
> con flujo similar al actual de Render. **ECS Fargate** si quieres más
> control y mejor escalado para crecer. Lambda sólo si tu tráfico es
> muy esporádico y no te molesta cold starts.

**D.2** Tamaño esperado:

- [ ] Tráfico bajo: <100 req/min sostenido — instancia mínima
- [ ] Tráfico medio: 100–1000 req/min
- [ ] Tráfico alto: >1000 req/min
- [ ] Picos esporádicos pero generalmente bajo

**D.3** ¿Auto-scaling?

- [ ] Sí, escalar entre 1 y N instancias según CPU/req
- [ ] No, una instancia fija (más predecible en costo)

**D.4** ¿Container o código directo?

- [ ] Container (Dockerfile) — recomendado, portabilidad total
- [ ] Código directo (App Runner / Beanstalk lo soportan)

---

## E. Base de datos (PostgreSQL)

**E.1** Tipo de Aurora:

- [ ] **Aurora Serverless v2** — escala automático, paga por uso
  (mínimo 0.5 ACU = ~$45/mo si está siempre vivo)
- [ ] **Aurora provisioned** — instancia fija (db.t4g.medium = ~$50/mo)
- [ ] **RDS for PostgreSQL** (no Aurora) — más barato, sin features Aurora,
  desde db.t4g.micro $15/mo
- [ ] No sé, ayúdame a decidir

> **Mi sugerencia para tu caso**: **RDS for PostgreSQL db.t4g.micro**
> (~$15/mo, single-AZ) es más que suficiente para una landing con form.
> Aurora vale la pena cuando creces o necesitas Multi-AZ con failover
> rápido. Aurora Serverless v2 nunca baja de 0.5 ACU = más caro que t4g.micro.

**E.2** Engine version: PostgreSQL 16 (latest stable). ¿OK?

- [ ] Sí, lo más nuevo
- [ ] Otro: __________

**E.3** Multi-AZ (alta disponibilidad)?

- [ ] No, single AZ (más barato, suficiente para landing)
- [ ] Sí, Multi-AZ (failover automático, ~2x el costo)

**E.4** Backup retention:

- [ ] 7 días (default)
- [ ] 14 días
- [ ] 30 días
- [ ] Más: __________

**E.5** Tamaño actual de la DB:

- Estimado en MB/GB: __________
- (Si no sabes, te ayudo a medirlo desde Render)

**E.6** Encriptación:

- [ ] Encriptar at-rest con KMS (recomendado, default)
- [ ] Sin encriptación (no recomendado)

**E.7** ¿Cómo migrar los datos de Render a AWS?

- [ ] `pg_dump` + `pg_restore` (downtime corto, ~minutos)
- [ ] AWS DMS (Database Migration Service) — sin downtime, más complejo
- [ ] Empezar de cero (sin migrar datos — sólo si los contactos
  acumulados no son críticos)

---

## F. Email (SMTP / transactional)

**F.1** ¿Mantener Resend o migrar a SES?

- [ ] Mantener Resend (sin cambio, sigue funcionando)
- [ ] Migrar a SES (AWS native, más barato a escala, requiere setup)
- [ ] Usar SES como fallback de Resend
- [ ] No sé, ayúdame a decidir

> **Mi sugerencia para tu caso**: si tu volumen de envíos es bajo
> (<3000/mes), **mantén Resend** — son $0 los primeros 3000 emails y la
> integración ya funciona. SES vale la pena si creces a >10K emails/mes
> ($0.10 por mil). Migrar a SES requiere salir del sandbox de SES
> (~24h aprobación).

**F.2** Si SES:

- [ ] Necesito verificar `monoulabs.ai` para enviar como `contacto@...`
- [ ] DKIM + SPF + DMARC (recomendado para deliverability)
- [ ] Solicitar salida del sandbox (default: sólo emails verificados)
- [ ] Volumen estimado mensual: __________

---

## G. Dominio y DNS

**G.1** Estado del dominio `monoulabs.ai`:

- [ ] Ya lo compré (registrar: __________)
- [ ] No lo he comprado todavía
- [ ] Lo compré pero no recuerdo dónde

**G.2** ¿Migrar el dominio a Route 53?

- [ ] Sí, transferir el registro completo a Route 53 (~$13/año, más control)
- [ ] No, dejar en el registrador y solo apuntar nameservers a Route 53
- [ ] No, mantener todo el DNS en el registrador actual

> Recomendación: Route 53 hosted zone (sin transferir el dominio) es lo
> mejor — pagas $0.50/mes por la zona, control total, integración con
> ACM para certificados.

**G.3** Subdominios que necesitas:

- [ ] `monoulabs.ai` (ápex) — landing
- [ ] `www.monoulabs.ai` — landing (con redirect ápex/www)
- [ ] `api.monoulabs.ai` — backend Flask
- [ ] `admin.monoulabs.ai` — admin (opcional)
- [ ] `staging.monoulabs.ai` — entorno staging (opcional)
- [ ] Otros: __________

---

## H. Certificados TLS

**H.1** ACM (AWS Certificate Manager) — gratis para todos:

- [ ] Cert para `monoulabs.ai` + `*.monoulabs.ai` (wildcard, lo más
  cómodo) en us-east-1 (CloudFront lo requiere) y en region principal
  (ALB)
- [ ] Cert por subdominio (más granular, más mantenimiento)

> Recomendación: **wildcard cert en us-east-1** para CloudFront +
> wildcard cert en tu region principal para ALB. Mismo dominio, dos certs
> porque ACM es per-region.

---

## I. CI/CD

**I.1** Pipeline de despliegue:

- [ ] **GitHub Actions → AWS** vía OIDC (recomendado, sin AWS access keys
  en GitHub Secrets)
- [ ] AWS CodePipeline + CodeBuild + CodeDeploy (todo nativo AWS)
- [ ] Deploy manual (sólo `aws ecs update-service` cuando cambies código)

**I.2** Disparadores:

- [ ] Push a `main` → deploy a producción
- [ ] Push a `staging` → deploy a staging, push a `main` → deploy a prod
- [ ] Tag `vX.Y.Z` → deploy a prod (más controlado)

**I.3** ¿Mantener la regla `protect-main` de GitHub?

- [ ] Sí, exactamente como está (PR + CodeQL gate)
- [ ] Sí, agregando además check de "build pasa"
- [ ] No, simplificar (no recomendado)

---

## J. Secretos

**J.1** Dónde guardar `RESEND_API_KEY`, `ADMIN_TOKEN`, `DATABASE_URL`:

- [ ] **AWS Secrets Manager** — rotación nativa, $0.40/secret/mo
- [ ] **AWS Systems Manager Parameter Store (SecureString)** — gratis,
  sin rotación nativa
- [ ] Variables de entorno del servicio directamente (menos seguro)

> Recomendación: Secrets Manager para `DATABASE_URL` (rotación de password
> nativa con Aurora) y `RESEND_API_KEY`. Parameter Store para
> `ADMIN_TOKEN` (rotación manual). Ambos accedidos desde la task con IAM role.

**J.2** Rotación:

- [ ] Cada 30 días automático (Secrets Manager)
- [ ] Cada 90 días manual (calendar reminder)
- [ ] Sólo cuando me dé la gana

---

## K. Observabilidad

**K.1** Logs:

- [ ] **CloudWatch Logs** (default, gratis hasta 5 GB/mo)
- [ ] CloudWatch Logs + export a S3 long-term
- [ ] Logs externo (Datadog, Loggly, Logtail, ___________)

**K.2** Métricas:

- [ ] CloudWatch metrics nativas (suficiente para empezar)
- [ ] CloudWatch + dashboards custom
- [ ] Datadog / New Relic / similar

**K.3** Alarmas:

- [ ] Sí, alertas básicas (CPU>80%, error rate>5%, db connections>80%)
- [ ] Alertas + on-call (PagerDuty / Opsgenie)
- [ ] No, sólo veo logs cuando pasa algo

**K.4** Tracing distribuido:

- [ ] No por ahora
- [ ] AWS X-Ray
- [ ] OpenTelemetry hacia Datadog / Honeycomb / Jaeger

---

## L. Seguridad y red

**L.1** VPC:

- [ ] Default VPC de AWS (rápido, suficiente para empezar)
- [ ] VPC custom con subnets públicas y privadas (recomendado para prod)
- [ ] Multi-AZ con NAT Gateways (paga ~$32/mo por NAT, escala real)

**L.2** WAF (Web Application Firewall):

- [ ] No por ahora
- [ ] AWS WAF v2 con managed rules (~$5/mo + $1 por millón de requests)
- [ ] Cloudflare delante de todo (gratis, alternativa)

**L.3** DDoS protection:

- [ ] AWS Shield Standard (gratis, automático)
- [ ] AWS Shield Advanced ($3000/mo, sólo si lo necesitas)

**L.4** Bastion / acceso a DB:

- [ ] No, DB en subnet privada, conexión sólo desde el backend
- [ ] AWS Systems Manager Session Manager (sin SSH key, gratis,
  recomendado)
- [ ] EC2 bastion tradicional con SSH

**L.5** Compliance:

- [ ] Ninguno por ahora
- [ ] GDPR (datos de usuarios EU)
- [ ] SOC2 (clientes B2B)
- [ ] HIPAA (datos médicos) — requiere BAA
- [ ] Otro: __________

---

## M. Plan de migración

**M.1** Estrategia de cutover:

- [ ] **Big bang** — un día apagas Render, prendes AWS (downtime ~1h)
- [ ] **Blue-green** — AWS arriba en paralelo, switch DNS al final
  (downtime ~minutos por TTL)
- [ ] **Gradual / canary** — % de tráfico a AWS, ir subiendo

> Recomendación: **Blue-green** vía DNS. Más seguro, fácil rollback.

**M.2** Ventana de mantenimiento aceptable:

- [ ] Menos de 5 min (zero-downtime real, requiere DMS replication)
- [ ] 5–30 min (cutover normal con pg_dump)
- [ ] 30 min – 2h (más relajado)
- [ ] No importa (proyecto sin tráfico en producción)

**M.3** Plan de rollback:

- [ ] DNS apunta de vuelta a Render — Render queda corriendo en paralelo
  X días
- [ ] Sin rollback formal — confío en el cutover
- [ ] DMS replication bidireccional (más complejo)

**M.4** ¿Cuándo apagar Render?

- [ ] Inmediatamente tras cutover exitoso
- [ ] 7 días después
- [ ] 30 días después (más seguro)
- [ ] Cuando Aurora demuestre estabilidad (1+ semanas sin issues)

---

## N. Datos faltantes que necesito de ti

Estos son valores específicos que me harán falta para personalizar
los comandos del Paso 2:

- [ ] **AWS Account ID**: __________
- [ ] **Region final elegida**: __________
- [ ] **Tipo de instancia DB**: __________
- [ ] **Tipo de cómputo backend** (App Runner / Fargate / EC2): __________
- [ ] **Tamaño de container Fargate** (0.25/0.5/1 vCPU, 0.5/1/2 GB): __________
- [ ] **Hosted zone Route 53 ID** (después de crearla): __________
- [ ] **VPC CIDR** (default 10.0.0.0/16): __________

---

# PARTE 2 — GUÍA PASO A PASO (esqueleto genérico)

> Esta parte se afina con tus respuestas del cuestionario. Lo de aquí
> es la versión "para todos" y ya sirve como mapa conceptual.

## Fase 0 — Preparativos (1–2 días antes)

### 0.1 Cuenta AWS lista

- Crear cuenta AWS si no existe → https://aws.amazon.com
- Activar **MFA en root user** y **bloquear root** (no usarlo nunca más)
- Configurar **IAM Identity Center** o crear IAM admin con MFA
- Activar **AWS Budgets** con alerta a $X
- Habilitar **CloudTrail** (auditoría) en region principal + global

### 0.2 Herramientas locales

```bash
# AWS CLI v2
brew install awscli  # macOS
aws configure sso    # si usas Identity Center
# o aws configure   # si usas IAM user

# Terraform o CDK (recomendado para infra-as-code)
brew install terraform
# o npm install -g aws-cdk

# Docker (para containerizar el backend)
brew install --cask docker

# Verificar
aws sts get-caller-identity
```

### 0.3 Auditoría del estado actual

```bash
# Tamaño de tu DB en Render (desde el dashboard de Render):
#   landing-contacto-db → Metrics → Storage Used

# Tráfico promedio de /api/contact (desde Render → Logs):
#   contar requests del último mes
```

---

## Fase 1 — Red y dominio

### 1.1 Crear Hosted Zone en Route 53

```bash
aws route53 create-hosted-zone \
  --name monoulabs.ai \
  --caller-reference $(date +%s)
```

Te devuelve 4 nameservers (`ns-XX.awsdns-XX.{com,net,org,co.uk}`).

### 1.2 Cambiar nameservers en tu registrador

En el panel de tu registrador (donde compraste `monoulabs.ai`), cambia los
NS records a los 4 que te dio Route 53. Propaga en 30 min – 48 h.

Verificar:
```bash
dig +short NS monoulabs.ai @8.8.8.8
```

### 1.3 (Opcional) VPC custom

Si elegiste VPC custom (no default):

```bash
# Mejor: hacerlo con Terraform o CDK
# Esquema:
#   VPC 10.0.0.0/16
#   Public  subnets:  10.0.1.0/24, 10.0.2.0/24 (multi-AZ)
#   Private subnets:  10.0.11.0/24, 10.0.12.0/24
#   IGW para públicas
#   NAT Gateway para privadas (~$32/mo)
#   Route tables apropiadas
```

### 1.4 Certificados ACM

```bash
# CloudFront SIEMPRE en us-east-1
aws acm request-certificate \
  --region us-east-1 \
  --domain-name monoulabs.ai \
  --subject-alternative-names '*.monoulabs.ai' \
  --validation-method DNS

# Para ALB (en region principal)
aws acm request-certificate \
  --region <TU_REGION> \
  --domain-name '*.monoulabs.ai' \
  --validation-method DNS
```

ACM te da CNAME records para validar. Crearlos en Route 53. Validación
dura 5–10 min.

---

## Fase 2 — Base de datos (Aurora / RDS)

### 2.1 Crear DB subnet group

```bash
aws rds create-db-subnet-group \
  --db-subnet-group-name monou-db-subnets \
  --db-subnet-group-description "DB subnets monoulabs" \
  --subnet-ids subnet-aaa subnet-bbb
```

### 2.2 Crear security group para DB

```bash
# SG sólo permite ingreso desde el SG del backend
aws ec2 create-security-group --group-name monou-db-sg ...
aws ec2 authorize-security-group-ingress \
  --group-id sg-db-XXX \
  --protocol tcp --port 5432 \
  --source-group sg-backend-XXX
```

### 2.3 Crear RDS o Aurora

**Opción A — RDS PostgreSQL t4g.micro (recomendado para tu uso):**

```bash
aws rds create-db-instance \
  --db-instance-identifier monou-postgres \
  --db-instance-class db.t4g.micro \
  --engine postgres \
  --engine-version 16.3 \
  --master-username monou \
  --master-user-password <strong_password_o_secrets_manager> \
  --allocated-storage 20 \
  --storage-type gp3 \
  --storage-encrypted \
  --db-subnet-group-name monou-db-subnets \
  --vpc-security-group-ids sg-db-XXX \
  --backup-retention-period 7 \
  --no-publicly-accessible \
  --enable-iam-database-authentication
```

**Opción B — Aurora PostgreSQL serverless v2:**

```bash
aws rds create-db-cluster \
  --db-cluster-identifier monou-aurora \
  --engine aurora-postgresql \
  --engine-version 16.4 \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=2 \
  --master-username monou \
  --manage-master-user-password \
  --db-subnet-group-name monou-db-subnets \
  --vpc-security-group-ids sg-db-XXX \
  --storage-encrypted

aws rds create-db-instance \
  --db-instance-identifier monou-aurora-1 \
  --db-cluster-identifier monou-aurora \
  --db-instance-class db.serverless \
  --engine aurora-postgresql
```

### 2.4 Migrar datos desde Render

```bash
# 1. Dump desde Render (el DATABASE_URL de Render → Connection Info)
DATABASE_URL_RENDER="postgresql://monou:...@dpg-...render.com/monou_contacts"
pg_dump --no-owner --no-acl --clean --if-exists \
  -d "$DATABASE_URL_RENDER" \
  -f monou_dump.sql

# 2. Conectar a Aurora vía Session Manager + port forwarding
#    (porque Aurora está en subnet privada)
aws ssm start-session \
  --target i-bastion-XXX \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["monou-aurora.cluster-XXX.<region>.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5433"]}'

# 3. Restore en Aurora (en otra terminal)
DATABASE_URL_AWS="postgresql://monou:...@localhost:5433/monou_contacts"
psql -d "$DATABASE_URL_AWS" -f monou_dump.sql

# 4. Verificar
psql -d "$DATABASE_URL_AWS" -c "SELECT count(*) FROM contacts;"
psql -d "$DATABASE_URL_AWS" -c "SELECT count(*) FROM stats;"
```

### 2.5 Guardar `DATABASE_URL` en Secrets Manager

```bash
aws secretsmanager create-secret \
  --name monou/prod/database-url \
  --secret-string "postgresql://monou:...@monou-aurora.cluster-XXX.<region>.rds.amazonaws.com:5432/monou_contacts?sslmode=require"
```

---

## Fase 3 — Backend (App Runner / Fargate)

### 3.1 Containerizar Flask (necesario para Fargate, opcional para App Runner)

Crear `server/Dockerfile`:

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8080", "app:app"]
```

Build y test local:

```bash
cd server
docker build -t monou-backend:local .
docker run -p 8080:8080 \
  -e RESEND_API_KEY=re_xxx \
  -e MAIL_FROM='Monou Labs <onboarding@resend.dev>' \
  -e MAIL_TO=rladron@gmail.com \
  -e ADMIN_TOKEN=test \
  -e ALLOWED_ORIGIN='*' \
  monou-backend:local
curl http://localhost:8080/api/health
```

### 3.2 ECR (registry de Docker en AWS)

```bash
# Crear repo
aws ecr create-repository --repository-name monou-backend

# Login
aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin \
  <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

# Build con tag remoto y push
ECR_URI=<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/monou-backend
docker buildx build --platform linux/amd64 -t $ECR_URI:v2.3.0 -t $ECR_URI:latest --push .
```

### 3.3a Si elegiste App Runner

```bash
aws apprunner create-service \
  --service-name monou-backend \
  --source-configuration file://apprunner-source.json \
  --instance-configuration Cpu=0.25vCPU,Memory=0.5GB \
  --health-check-configuration file://apprunner-health.json \
  --auto-scaling-configuration-arn <ASC_ARN>
```

`apprunner-source.json`:
```json
{
  "ImageRepository": {
    "ImageIdentifier": "<ECR_URI>:latest",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "8080",
      "RuntimeEnvironmentSecrets": {
        "DATABASE_URL": "arn:aws:secretsmanager:...:secret:monou/prod/database-url",
        "RESEND_API_KEY": "arn:aws:secretsmanager:...:secret:monou/prod/resend-api-key",
        "ADMIN_TOKEN": "arn:aws:secretsmanager:...:secret:monou/prod/admin-token"
      },
      "RuntimeEnvironmentVariables": {
        "MAIL_FROM": "Monou Labs <contacto@monoulabs.ai>",
        "MAIL_TO": "contacto@monoulabs.ai",
        "ALLOWED_ORIGIN": "https://monoulabs.ai,https://www.monoulabs.ai"
      }
    }
  },
  "AutoDeploymentsEnabled": true,
  "AuthenticationConfiguration": {
    "AccessRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/AppRunnerECRAccessRole"
  }
}
```

### 3.3b Si elegiste ECS Fargate

Más complejo: necesitas ECS cluster, task definition, service, ALB,
target group, listener rules, security groups. Recomendado armarlo con
Terraform o CDK. Esqueleto en Terraform al final del documento.

### 3.4 Custom domain en el backend

Para App Runner:
```bash
aws apprunner associate-custom-domain \
  --service-arn <SERVICE_ARN> \
  --domain-name api.monoulabs.ai \
  --enable-www-subdomain false
```

App Runner devuelve registros CNAME → agregarlos en Route 53.

---

## Fase 4 — Frontend (S3 + CloudFront)

### 4.1 Bucket S3 privado

```bash
aws s3api create-bucket \
  --bucket monoulabs-landing-prod \
  --region <REGION> \
  --create-bucket-configuration LocationConstraint=<REGION>

aws s3api put-public-access-block \
  --bucket monoulabs-landing-prod \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

### 4.2 CloudFront distribution

Crear distribution con:
- **Origin**: bucket S3 con OAC (Origin Access Control, no OAI legacy)
- **Default behavior**: redirect HTTP→HTTPS, allowed methods GET/HEAD
- **Alternate domain names**: `monoulabs.ai`, `www.monoulabs.ai`
- **SSL cert**: el wildcard de ACM en us-east-1
- **Default root object**: `index.html`
- **Custom error responses**: 403/404 → `/index.html` con 200 (SPA-style si aplica)
- **WAF**: opcional, attach managed rule group `AWSManagedRulesCommonRuleSet`

```bash
# Mejor con Terraform — la creación CLI es 30+ flags
```

### 4.3 Subir contenido

```bash
cd ~/Documents/Claude/Projects/landing/Landing
# Sin la carpeta server (que es backend) ni admin si lo separas
aws s3 sync . s3://monoulabs-landing-prod/ \
  --exclude 'server/*' \
  --exclude '.git/*' \
  --exclude 'node_modules/*' \
  --exclude '*.md' \
  --cache-control 'public, max-age=3600'

# index.html sin cache (para que cambios reflejen rápido)
aws s3 cp index.html s3://monoulabs-landing-prod/index.html \
  --cache-control 'public, max-age=60' \
  --content-type 'text/html'

# Invalidar CloudFront
aws cloudfront create-invalidation \
  --distribution-id <DIST_ID> \
  --paths '/*'
```

### 4.4 DNS apuntando a CloudFront

```bash
# Records en Route 53 (vía consola o CLI):
# - monoulabs.ai      → A alias → CloudFront distribution
# - www.monoulabs.ai  → A alias → CloudFront distribution
# - api.monoulabs.ai  → CNAME → App Runner default URL (o ALB DNS)
```

---

## Fase 5 — Email (SES, si migras desde Resend)

### 5.1 Verificar dominio

```bash
aws ses verify-domain-identity --domain monoulabs.ai
aws ses verify-domain-dkim --domain monoulabs.ai
```

Te da un TXT record para verificación + 3 CNAMEs DKIM. Agregarlos en
Route 53.

### 5.2 SPF + DMARC (TXT records en Route 53)

```
TXT @  "v=spf1 include:amazonses.com -all"
TXT _dmarc  "v=DMARC1; p=none; rua=mailto:dmarc@monoulabs.ai"
```

### 5.3 Salir del sandbox

Por defecto, SES en sandbox solo permite enviar a emails verificados.
Para producción:

1. AWS Console → SES → Account dashboard → "Request production access"
2. Llenar formulario: caso de uso, volumen, gestión de bounces
3. Aprueban en 24h típico

### 5.4 Cambiar el código de Resend a SES (opcional)

Mejor: **wrapper que soporte ambos** y cambiar via env var. Requiere
modificar `server/app.py` — armable como `chore/email-provider-abstraction`.

---

## Fase 6 — CI/CD (GitHub Actions → AWS)

### 6.1 OIDC entre GitHub y AWS (sin access keys)

Crear IAM identity provider para GitHub:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

Crear IAM role asumible por GitHub Actions:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:rladron-rodia/landing_contacto:ref:refs/heads/main"
      }
    }
  }]
}
```

Adjuntar políticas mínimas (ECR push, App Runner update, S3 sync,
CloudFront invalidate).

### 6.2 Workflow `.github/workflows/deploy.yml`

```yaml
name: deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/GitHubActionsDeploy
          aws-region: <REGION>
      - uses: aws-actions/amazon-ecr-login@v2
      - run: |
          IMAGE=<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/monou-backend:${{ github.sha }}
          docker buildx build --platform linux/amd64 \
            -t $IMAGE -t <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/monou-backend:latest \
            --push ./server
      - run: |
          aws apprunner start-deployment --service-arn <SERVICE_ARN>

  deploy-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/GitHubActionsDeploy
          aws-region: <REGION>
      - run: |
          aws s3 sync . s3://monoulabs-landing-prod/ \
            --exclude 'server/*' --exclude '.git/*' --exclude '*.md' \
            --cache-control 'public, max-age=3600'
          aws s3 cp index.html s3://monoulabs-landing-prod/index.html \
            --cache-control 'public, max-age=60'
          aws cloudfront create-invalidation \
            --distribution-id <DIST_ID> --paths '/*'
```

---

## Fase 7 — Cutover (el día D)

Pre-checks:
- [ ] AWS infra desplegada y respondiendo en URLs internas
- [ ] DB en AWS poblada con datos de Render (último dump fresco)
- [ ] Smoke tests pasando contra `api.monoulabs.ai` directo (no DNS)
- [ ] Render sigue corriendo (rollback ready)

Día D (orden recomendado):

1. **Frizar cambios en Render** — no más pushes que toquen DB
2. **Dump final + restore** (5–15 min de downtime aceptable)
   ```bash
   pg_dump $DATABASE_URL_RENDER > final.sql
   psql $DATABASE_URL_AWS -f final.sql
   ```
3. **Smoke test del backend AWS** contra los datos nuevos
4. **Cambiar DNS** de los 3 records:
   - `monoulabs.ai` → CloudFront
   - `www.monoulabs.ai` → CloudFront
   - `api.monoulabs.ai` → App Runner / ALB
   - **Bajar TTL a 60s previamente** (24h antes del cutover)
5. **Monitorear logs CloudWatch + Resend dashboard** primeras 24h
6. **Validar formulario en producción** desde múltiples browsers/devices
7. **Subir TTL de vuelta** a 3600s a la semana

Rollback (si algo sale mal):
- Cambiar DNS de vuelta a Render → 60s TTL = vuelve rápido
- Render sigue corriendo, no perdió nada

---

## Fase 8 — Post-cutover (semana 1–4)

### 8.1 Observabilidad

- [ ] CloudWatch alarms configuradas (ver L.4 de la guía)
- [ ] Dashboard CloudWatch con métricas clave
- [ ] Logs limpios (sin errores recurrentes)

### 8.2 Validar backups

```bash
# RDS / Aurora hace snapshots automáticos
aws rds describe-db-snapshots --db-instance-identifier monou-postgres
# Restore de prueba en una instancia temporal cada trimestre
```

### 8.3 Cost review

- [ ] AWS Cost Explorer primeros 30 días
- [ ] Identificar gastos no esperados (NAT GW + datos suelen ser sorpresa)
- [ ] Considerar Savings Plans si el patrón es estable

### 8.4 Decommission Render

Sólo después de 7–30 días estables:

1. Pausar el web service de Render
2. Esperar 7 días más → si nada se rompió, suspender el plan
3. Borrar la DB de Render (después de confirmar dump local guardado)

### 8.5 Actualizar `PASES.md`

El flujo cambia: branches y PR siguen igual, pero el cutover de código va
por GitHub Actions → ECR → App Runner. Documentar.

---

## Fase 9 — Limpieza (mes 2+)

- [ ] Render service borrado
- [ ] Render DB borrada (con backup local)
- [ ] DNS records viejos (si quedan) limpiados
- [ ] `PASES.md` actualizado a la realidad AWS
- [ ] `DEPLOY.md` actualizado o archivado
- [ ] `render.yaml` archivado o borrado del repo

---

# ANEXOS

## Anexo A — Estimación de costos AWS (mensuales aproximados)

Para un proyecto de este tamaño:

| Servicio | Mínimo | Razonable | Notas |
|---|---|---|---|
| Route 53 hosted zone | $0.50 | $0.50 | + queries (~$0.40/M) |
| ACM certs | $0.00 | $0.00 | Gratis |
| CloudFront | $1–5 | $5–15 | Según tráfico |
| S3 (landing) | $0.50 | $1 | Pocos GB |
| App Runner (backend) | $25 | $40 | 0.25 vCPU, 0.5 GB |
| RDS db.t4g.micro | $15 | $20 | Single-AZ + storage |
| Secrets Manager | $1.20 | $2 | 3 secrets |
| CloudWatch | $0 | $5 | Logs + métricas básicas |
| SES (si usas) | $0 | $1 | $0.10 por 1000 emails |
| Data transfer | $0–2 | $5 | Depende de tráfico |
| **TOTAL** | **~$45** | **~$95** | |

Vs Render free tier ($0) o starter ($7+$7=$14/mo). AWS típicamente
**6–10x más caro** que Render para este tamaño, pero te da:
- Sin cold starts
- Multi-AZ disponible
- Mejor performance bajo carga
- Stack profesional para crecer

## Anexo B — Terraform skeleton (referencia rápida)

Cuando llenes el cuestionario, te genero el `main.tf` completo. Esqueleto:

```hcl
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket = "monoulabs-tfstate"
    key    = "prod/terraform.tfstate"
    region = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.region
}

module "vpc" { source = "terraform-aws-modules/vpc/aws" }
module "rds" { source = "terraform-aws-modules/rds/aws" }
module "s3_cloudfront" { ... }
module "app_runner" { ... }
module "route53" { ... }
module "acm" { ... }
```

## Anexo C — Secrets requeridos al final

```
monou/prod/database-url        → postgresql://...rds.amazonaws.com/...
monou/prod/resend-api-key      → re_... (si mantienes Resend)
monou/prod/admin-token         → token aleatorio (rotar 90 días)
monou/prod/ses-smtp-username   → solo si usas SES vía SMTP
monou/prod/ses-smtp-password   → solo si usas SES vía SMTP
```

## Anexo D — Endpoints finales esperados

| Servicio | URL |
|---|---|
| Landing | `https://monoulabs.ai` y `https://www.monoulabs.ai` |
| API | `https://api.monoulabs.ai` |
| Admin | `https://monoulabs.ai/admin/` (o `https://admin.monoulabs.ai`) |

---

## Última actualización

2026-04-30 — creación inicial. Pendiente de personalizar tras llenar
el cuestionario de la Parte 1.
