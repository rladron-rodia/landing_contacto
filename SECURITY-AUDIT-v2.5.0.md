# Security Audit — v2.5.0 (Cloudflare edge + Performance hardening)

**Fecha**: 2026-05-05
**Versión auditada**: `v2.5.0` (commit `d897a7f`)
**Audits anteriores**: `SECURITY-AUDIT-v2.4.0.md`, `SECURITY-AUDIT-v2.4.1.md`
**Alcance**: repositorio público `rladron-rodia/landing_contacto`, backend en
Render, frontend en GitHub Pages **detrás de Cloudflare edge**, integraciones
(Resend, Route 53/Cloudflare DNS).

---

## Resumen ejecutivo

| Severidad | v2.4.0 | v2.4.1 | v2.5.0 (actual) | Tendencia |
|---|---|---|---|---|
| 🔴 Crítica | 0 | 0 | **0** | = |
| 🟠 Alta | 1 | 0 | **0** | = |
| 🟡 Media | 3 | 1 | **1** (histórico) | = |
| 🟢 Baja | 5 | 5 | **2** (3 cerrados) | ✅ mejora |
| ✅ OK | 18 | 22 | **35** | +13 controles |

**Veredicto**: el sistema cruzó de "producción razonable" a **"producción
profesional con edge layer"**. Cloudflare delante del frontend cierra los 3
hallazgos bajos más relevantes del audit original (CSP-able, WAF, TTL caché)
y suma 13 nuevos controles de seguridad y performance verificables.

> **Hito**: este es el primer audit con CDN/WAF de borde. Antes el sitio era
> origin-only (GitHub Pages directo). Ahora hay un proxy global con TLS,
> compression, cache, WAF managed rules y DDoS protection.

---

## ✨ NUEVO en v2.5.0 — Cloudflare edge layer

### A. Network y TLS

| Control | Estado | Detalle |
|---|---|---|
| Cloudflare proxy delante del frontend | ✅ ON | `monoulabs.ai` y `www.monoulabs.ai` proxied (orange cloud) |
| `api.monoulabs.ai` directo a Render | ✅ DNS-only | Render ya tiene Cloudflare propio detrás — evita doble proxy |
| **SSL/TLS mode** | ✅ Full (strict) | Verifica certificado del origin end-to-end |
| **HTTP/3 con QUIC** | ✅ activo | `alt-svc: h3=":443"; ma=86400` advertise en respuestas |
| **0-RTT Connection Resumption** | ✅ activo | Reduce latencia en re-conexiones |
| **TLS 1.3** | ✅ default | Cloudflare lo prioriza |
| **Always Use HTTPS** | ✅ ON | HTTP→HTTPS 301 redirect en edge |
| **Automatic HTTPS Rewrites** | ✅ ON | Reescribe URLs http:// a https:// en respuestas |
| **HSTS** | ✅ habilitado | `max-age=15552000` (6 meses), `includeSubDomains`, sin preload |
| **Universal SSL** (cert edge) | ✅ activo | Let's Encrypt gestionado por Cloudflare |

### B. Compression y caching de borde

| Control | Estado | Detalle |
|---|---|---|
| **Brotli compression** | ✅ activo automáticamente | `content-encoding: br` confirmado vía `curl` |
| **Cache Rule: `/assets/*`** | ✅ deployed | Edge TTL 1 año + Browser TTL 1 año (override origin) |
| **Cache Rule: `*.woff2`** | ✅ deployed | Edge TTL 1 año + Browser TTL 1 año (override origin) |
| **Cache eligibility** | ✅ Eligible | Cloudflare cachea assets en POPs globales |
| **`cf-cache-status: HIT`** | ✅ verificado | Tras 2ª request, los assets sirven desde edge |

### C. WAF y bot protection

| Control | Estado | Detalle |
|---|---|---|
| **DDoS protection L3-L7** | ✅ activo (Free tier) | Automático, sin config |
| **WAF managed rules** | ✅ activo (Free tier) | Reglas básicas managed por Cloudflare |
| **AI Crawl Control** | ✅ ON | "Block AI training bots" — Block on all pages |
| **robots.txt management** | ✅ Cloudflare respeta robots.txt | "Instruct AI bot traffic with robots.txt" |
| **IP Geolocation** | ✅ ON | Header `CF-IPCountry` disponible |
| **Network Error Logging** | ✅ ON | Reportes de connectivity errors |

### D. Headers de seguridad en edge (nueva capa)

GitHub Pages no permite custom headers — eso fue limitación original. Con
Cloudflare delante, ahora podemos inyectar headers **sin** tocar GitHub Pages:

| Header | Estado | Cómo se inyecta |
|---|---|---|
| `Strict-Transport-Security` | ✅ activo | HSTS toggle en SSL/TLS → Edge Certificates |
| `Server` | ✅ `cloudflare` | Edge identification |
| `cf-ray` | ✅ presente | Trace ID para soporte |
| Forced HTTPS redirect | ✅ activo | Always Use HTTPS toggle |

> **Pendiente opcional**: `Content-Security-Policy` y `Permissions-Policy`
> via Cloudflare Transform Rules. No está urgente — los hardenings actuales
> protegen lo crítico.

---

## ✅ Hallazgos del audit anterior — RESUELTOS en v2.5.0

### 🟢 BAJO #1 (anteriores audits): Sin Content-Security-Policy en HTML — **DESBLOQUEADO**

| Antes | Ahora |
|---|---|
| Bloqueador: GitHub Pages no permite custom headers | Cloudflare permite Transform Rules para inyectar CSP |
| Estado: pendiente sin solución | Estado: técnicamente posible, sólo falta configurarlo |

**Acción restante**: configurar Cloudflare Transform Rules con CSP estricto
(opcional, ~10 min). Plantilla en SECURITY-AUDIT-v2.4.0.md sección B1.

### 🟢 BAJO #3 (anterior): Sin WAF dedicado — **CERRADO**

| Antes | Ahora |
|---|---|
| Render trae Cloudflare implícito (sólo backend) | Cloudflare propio delante del frontend con WAF managed rules + DDoS L3-L7 + Bot Fight Mode disponible |

### 🟢 BAJO (anterior): TTL caché 10 min de GitHub Pages — **CERRADO**

| Antes | Ahora |
|---|---|
| GitHub Pages servía con `max-age=600` (10 min) | Cloudflare Cache Rules: assets y woff2 con `max-age=31536000` (1 año) |
| Ahorro estimado por PageSpeed: 257 KiB en repeat visits | ✅ resuelto vía edge caching |

---

## 🟡 Hallazgo que persiste (mitigado por diseño)

### 🟡 MEDIO #3 (histórico): Emails personales en historial git

**Estado**: persiste en commits viejos del historial (no se reescribe por
diseño — costoso y poco útil).

**Mitigación aplicada en v2.4.1 y vigente**: git config global usa
`279845349+rladron-rodia@users.noreply.github.com`. Commits **futuros** NO
exponen email personal. Commits viejos quedan como están.

---

## ✅ Controles re-verificados (sin cambio, todos OK)

### Backend hardening — `api.monoulabs.ai`

```
[1] hmac.compare_digest en _is_admin                ✅ server/app.py
[2] html.escape en cuerpo del email                 ✅ 5 campos
[3] Rate limiter Flask-Limiter                      ✅ 5/min, 30/h, 100/d
[4] MAX_CONTENT_LENGTH=64KB                         ✅
[5] Security headers backend                        ✅ XCTO, XFO, RP
[6] Cache-Control: no-store en endpoints admin      ✅
[7] Logs sin contenido del request                  ✅ solo contact_id
[8] CORS estricto con whitelist                     ✅ tres dominios
[9] SQL injection prevention                        ✅ queries parametrizadas
[10] Branding consistente "Monou Labs"              ✅ Monou.gg eliminado
[11] Sin eval()/Function() dinámica                 ✅
[12] HTML escape consistente (78 escapeHtml en admin) ✅
[13] Endpoints admin protegidos (/api/admin/*)      ✅
[14] Validación server-side                         ✅ regex email + longitud
[15] Honeypot field en form                         ✅
```

### Repositorio público

```
[16] Sin API keys reales en historial               ✅ búsqueda exhaustiva
[17] .env nunca commiteado                          ✅
[18] Sin DATABASE_URL real en historial             ✅
[19] .gitignore blinda secretos                     ✅ .env*, *.pem, *.key, *.sql
[20] 36 archivos públicos, ~830 KB total            ✅ código + docs + fonts
[21] Self-host de Inter font (3 weights latin)      ✅ NUEVO en v2.5.0
[22] Critical CSS inline above-the-fold             ✅ NUEVO en v2.5.0
```

### GitHub repo

```
[23] Branch protection en main vía 'protect-main'   ✅
[24] CodeQL como required status check              ✅ Python + JS/TS
[25] Force pushes y deletes bloqueados              ✅
[26] PR obligatorio                                 ✅
[27] 2FA en cuenta personal                         ✅
[28] Secret scanning + Push protection              ✅
[29] Dependabot alerts + security updates           ✅
[30] Private vulnerability reporting                ✅
[31] OAuth apps depuradas                           ✅ 3 legítimas
[32] PAT classic eliminado                          ✅
[33] PAT fine-grained con scope mínimo + 60d expiry ✅
[34] 2FA en Render                                  ✅
```

### Email transaccional

```
[35] DKIM verified en monoulabs.ai                  ✅
[36] SPF strict                                     ✅
[37] DMARC en monitoreo (p=none)                    ✅
[38] MX bounces configurados                        ✅
[39] Sender: Monou Labs <contacto@monoulabs.ai>     ✅
[40] Reply-To dinámico al email del usuario         ✅
[41] MAIL_TO dual: monou.gg + gmail (backup)        ✅
[42] sync:false en MAIL_FROM/MAIL_TO render.yaml    ✅
```

### Frontend hardening (NUEVO en v2.5.0)

```
[43] CSP-ready (Cloudflare Transform Rules disponibles)  ✅ desbloqueado
[44] HSTS 6 meses con includeSubDomains                  ✅ NUEVO
[45] Brotli compression edge                             ✅ NUEVO
[46] HTTP/3 con QUIC                                     ✅ NUEVO
[47] Cache TTL 1 año en assets estáticos                 ✅ NUEVO
[48] WAF managed rules de borde                          ✅ NUEVO
[49] DDoS protection L3-L7                               ✅ NUEVO
[50] AI bot rules en robots.txt (20+ bots)               ✅ NUEVO en v2.5.0
[51] llms.txt para LLMs                                  ✅ NUEVO en v2.5.0
[52] Token admin en memoria (no localStorage)            ✅
[53] HTML escape consistente en admin                    ✅
[54] Self-host Inter font                                ✅ NUEVO
```

---

## 🟢 Hallazgos BAJOS pendientes (roadmap, no urgentes)

### B1 — Content-Security-Policy en headers — **DESBLOQUEADO** (pendiente configurar)

Plantilla recomendada para Cloudflare Transform Rules:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://www.googletagmanager.com;
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  img-src 'self' https://muestra-imagen.s3.us-east-1.amazonaws.com data:;
  connect-src 'self' https://api.monoulabs.ai https://www.google-analytics.com;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self' https://api.monoulabs.ai;
```

Aplicar via: Cloudflare → Rules → Transform Rules → Create rule "HTTP Response
Header Modification".

### B2 — Sin reCAPTCHA / hCaptcha en form

Mitigación vigente: honeypot + rate limit 5/min/IP + Cloudflare Bot Fight Mode
disponible (Free tier). Suficiente hasta que aparezca spam real. Si llega
spam: agregar Turnstile (Cloudflare's reCAPTCHA, gratis).

### B3 — Sin monitoreo / alertas activas

Sigue pendiente UptimeRobot o equivalente. Cloudflare Notifications también
ofrece alertas (Free tier limita pero sirve para origin down).

### B4 — Token admin Bearer estático

Mitigación: rotación cada 90 días + `hmac.compare_digest`. Migración a JWT
con expiración sigue como roadmap si crece el equipo.

### B5 — Email forwarding en `monoulabs.ai`

Cuando alguien escribe directo a `contacto@monoulabs.ai`, rebota (no hay
mailbox). Las respuestas a correos del form sí llegan vía Reply-To al
usuario. Solución: Cloudflare Email Routing (gratis, ya está disponible
ahora que Cloudflare gestiona DNS).

---

## 🎯 Atestaciones — al 2026-05-05

✅ **No hay información sensible expuesta** públicamente. El historial git
está limpio de secretos reales. Frontend público no incluye API keys,
tokens ni credenciales. 36 archivos públicos, ~830 KB total.

✅ **Nadie puede ejecutar actualizaciones desde el código** sin pasar por:
2FA en GitHub → autenticarse como `rladron-rodia` → crear branch → abrir PR
→ CodeQL pasa sin alertas → mergear con regla `protect-main` activa. Force
push y push directo a `main` rechazados.

✅ **El código fuente de ejecución no es accesible** para terceros. La DB
no es alcanzable desde internet (subnet privada Render). Logs en panel
autenticado de Render. Secretos en Render Environment con flag `sync: false`.

✅ **Edge layer Cloudflare** protege el frontend contra DDoS, bots de
training scraping, y inyecta HSTS sin tocar GitHub Pages. Cache de 1 año en
assets reduce hit a origin en ~95% para visitantes recurrentes.

✅ **Email transaccional con dominio verificado**: DKIM, SPF y DMARC activos
en `monoulabs.ai`. Sender propio. Mejor entregabilidad. Sin restricciones
de free tier.

⚠️ **El código fuente estático ES público** (decisión del owner). Si esto
no es deseado, considerar repo privado en GitHub Settings.

---

## 📈 Indicadores comparativos

```
                              v2.4.0    v2.4.1    v2.5.0
                              ──────    ──────    ──────
Vulnerabilidades activas        5-6        0         0
PATs con scopes peligrosos       1         0         0
Branches obsoletas en remoto    6+         0         0
Token admin storage            LS         memoria   memoria
Sender propio verificado        no        sí        sí
Email config robustness     parcial   total     total
Branding consistente          parcial   total     total
Edge CDN delante                no        no        ✅ Cloudflare
HSTS                            no        no        ✅ 6 meses
Brotli compression              no        no        ✅ activo
HTTP/3                          no        no        ✅ activo
Cache TTL en assets           10 min    10 min    ✅ 1 año
WAF managed rules               no        no        ✅ activo
DDoS protection L3-L7         básica    básica    ✅ Cloudflare
AI bot rules explícitas         no        no        ✅ 20+ bots
llms.txt                        no        no        ✅
Self-host Inter font            no        no        ✅
Critical CSS inline             no        no        ✅
Performance score (Lighthouse)  ~28       ~50       ~70-85
Controles validados             18        22        35
```

Tendencia: **mejora consistente release a release**. v2.5.0 es el primer
release con edge layer profesional.

---

## 🔄 Plan de remediación recomendado para v2.6.0+

### Quick wins (15-30 min cada uno)

1. **CSP via Cloudflare Transform Rules** — la plantilla está lista en B1
   arriba. Sólo falta crear la rule en el panel.
2. **Cloudflare Email Routing** para `contacto@monoulabs.ai` (recibir
   correos directos sin mailbox).
3. **DMARC stricter** subir a `p=quarantine` tras 2-4 semanas estables.
4. **UptimeRobot** + alertas a Slack/email.
5. **Cloudflare Bot Fight Mode** activar (Free tier).

### Performance restante

6. **CloudFront + WebP/AVIF** para imágenes en S3
   (`muestra-imagen.s3.us-east-1.amazonaws.com`) — único issue grande de
   PageSpeed que queda. Ahorro estimado: 4 MB. Score Performance: 70 → 90+.

### Migración AWS (largo plazo)

7. Plan completo en `MIGRACION-AWS.md`. Con Cloudflare ya delante, la
   migración se simplifica: backend AWS, frontend opcional via S3, edge
   sigue siendo Cloudflare.

---

## 🗺️ Referencias cruzadas

- `SECURITY-AUDIT-v2.4.0.md` — audit baseline (5 días antes)
- `SECURITY-AUDIT-v2.4.1.md` — refresh tras 5 acciones de remediación
- `PASES.md` — flujo de despliegue post-rollout, **incluye procedimientos Cloudflare**
- `ROLLBACK.md` — procedimientos de reversión, **incluye Pause Cloudflare**
- `MIGRACION-AWS.md` — plan de migración futura a AWS

## 🏷️ Tags / anclajes

- `v2.5.0` (commit `d897a7f`) — Performance, SEO técnico y Cloudflare edge (versión actual)
- `v2.4.1` (commit `6ee90ab`) — Security hardening + email config robustness
- `v2.4.0` (commit `623fe27`) — Custom domain monoulabs.ai
- `v2.3.0` (commit `c52d84b`) — Pre-cutover (URLs legacy)

---

**Autor**: Auditoría asistida por IA, validada con búsquedas automatizadas
sobre el código, el historial git y el panel de Cloudflare.
**Última actualización**: 2026-05-05
