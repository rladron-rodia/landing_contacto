# Gestión de usuarios — Monoulabs admin

Sistema multi-usuario activo desde **v3.2.0** (2026-05-10). Reemplaza el
`ADMIN_TOKEN` único por cuentas reales con email + password, roles, y
permisos granulares por pestaña.

---

## Roles

Tres roles fijos, jerárquicos:

| Rol            | Acceso                                             | Gestiona usuarios          |
|----------------|----------------------------------------------------|----------------------------|
| `super_admin`  | Todo, incluyendo audit log y otros super_admins    | super_admin, admin, editor |
| `admin`        | Todas las pestañas excepto audit log               | Solo `editor`              |
| `editor`       | Acceso granular según `user_permissions`           | Ninguno                    |

**Reglas anti-escalada:**

- Un `admin` NO puede crear, editar ni disable a otros `admin`s ni
  `super_admin`s. Solo gestiona `editor`s.
- Un `super_admin` no puede:
  - Cambiar su propio rol
  - Disable a sí mismo
  - Disable o demote al **último** super_admin activo

---

## Recursos y acciones (permissions matrix)

8 pestañas + 1 meta-recurso:

| Recurso             | Pestaña en admin           |
|---------------------|----------------------------|
| `contacts`          | Contactos                  |
| `stats`             | Estadísticas               |
| `games_f2p`         | Juegos F2P                 |
| `games_publishers`  | Juegos Publishers          |
| `site_links`        | Configuración URLs         |
| `delivery`          | Formatos & Entrega         |
| `info_columns`      | Bloques Info               |
| `analytics`         | Analytics & GTM            |
| `users`             | (meta — gestión usuarios)  |

Cada recurso tiene 3 acciones: `read`, `write`, `delete`.

`super_admin` y `admin` tienen los 3 sobre los 9 recursos por convención
(no se almacena fila por fila). `editor` lee de la tabla
`user_permissions` — cualquier (recurso, acción) sin fila explícita = sin
acceso.

**Gating del frontend**: el sidebar oculta automáticamente las pestañas
que el user no tiene `read`. Botones de "Guardar" requieren `write`.
Botones de "Borrar" requieren `delete`.

---

## Flujos comunes

### Invitar un usuario nuevo

1. Login como `super_admin` o `admin` → pestaña **Usuarios**
2. Click "Invitar usuario"
3. Llenar email + nombre (opcional) + rol
4. Si rol = `editor`, marcar checkboxes de la matriz de permisos
5. Click "Enviar invitación"

El backend genera un token de 32 bytes hex, lo guarda en
`user_invitations` (TTL 7 días, single-use), y manda email vía SES con un
link a `https://monoulabs.ai/admin/invitation/?id=<token>`.

El usuario invitado:
1. Abre el email, click el link
2. Ve la página de bienvenida con quién lo invitó y su rol
3. Setea su contraseña (mín 8 caracteres)
4. Auto-login + redirect a `/admin/`

Si el invitado no completa en 7 días, el token expira y hay que re-invitar
(botón "Reenviar invitación" en la fila del user pending).

### Cambiar rol o permisos de un usuario

1. Pestaña **Usuarios** → click el lápiz en la fila
2. Cambiar rol o ajustar matriz de permisos
3. Guardar

Cambios surten efecto en la próxima request del user (decoradores leen
permissions en cada call).

### Deshabilitar (soft delete) un usuario

1. Click el icono `<i class="fa-solid fa-ban">` en la fila
2. Confirmar

Side effects:
- `users.status` → `'disabled'`
- **Todas sus sesiones activas** se invalidan (force logout inmediato en
  cualquier dispositivo donde estuviera logueado)
- El user queda en DB para audit trail; no se hard-delete

Reactivar con el botón verde junto al disabled.

### Recuperar contraseña olvidada

1. En `/admin/`, ingresar email
2. Click "¿Olvidé mi contraseña?"
3. Aceptar confirm
4. Email magic link llega a la dirección del user (15 min TTL)
5. Abrir link → `/admin/reset-password/?id=<token>`
6. Setear nueva password
7. Auto-login + redirect

Side effect del reset: **todas las sesiones del user en otros dispositivos
quedan revocadas** (defense-in-depth — si el password fue comprometido, el
attacker pierde acceso).

### Re-bootstrappear (caso DB wipe / reinstalación)

Solo si `system_settings.bootstrap_done = false` (o tabla vacía):

```bash
# Desde EC2 o local con SSM tunnel:
ADMIN_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id monou/prod/app --query SecretString --output text \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ADMIN_TOKEN"])')

curl -X POST https://api.monoulabs.ai/api/auth/bootstrap \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "tu@email.com",
    "full_name": "Tu Nombre",
    "password": "min-8-chars"
  }'
```

Marca `bootstrap_done=true`. El UI público de `/admin/` no permite
rebootstrap — solo `curl` con ADMIN_TOKEN.

---

## Audit log

Tabla `audit_log` registra acciones críticas. Visible en pestaña **Audit
log** (super_admin only).

### Acciones registradas

| Acción                       | Cuando                                    |
|------------------------------|-------------------------------------------|
| `login.success`              | Login exitoso                              |
| `login.failed`               | Email o password incorrecto / disabled     |
| `logout`                     | Logout                                     |
| `bootstrap`                  | Primer setup del super_admin               |
| `user.invite`                | Invitación creada                          |
| `user.update`                | Cambio de role/status/permissions          |
| `user.disable`               | Soft delete                                |
| `user.resend_invitation`     | Re-invite                                  |
| `invitation.accept`          | Invitado acepta y crea cuenta              |
| `password.forgot_request`    | User solicita magic link                   |
| `password.reset`             | User cambia password vía magic link        |
| `audit_log.cleanup`          | Purga manual de entries > 90d              |

### Retention

90 días. Para purgar:

- **Manualmente desde UI**: pestaña Audit log → botón "Purgar > 90d"
  (super_admin only)
- **Vía SSM/cron** (futuro): programar EventBridge → SSM Run Command que
  haga `curl -X POST /api/admin/audit-cleanup -H "..."`

### Filtros disponibles

- Por acción (dropdown con actions distinct presentes en el log)
- Por usuario (dropdown con users existentes)
- Por rango de fechas
- Pagination (50 por página)

### Detalle de evento

Click el icono de ojo en una fila para ver el JSON completo de `metadata`
(payload context guardado por la acción — IP, email afectado, conteo de
sesiones revocadas, etc.).

---

## Seguridad

### Password storage

bcrypt con cost factor 12. ~250ms por hash en EC2 t4g.micro — suficiente
para login UX, costoso para fuerza bruta offline.

### Sessions

- DB-backed en tabla `user_sessions`
- Cookie `monou_session` HttpOnly + Secure + SameSite=Lax
- Sliding TTL 30 días — cada request bumpea `expires_at`
- Logout: borra la fila → cookie inutilizable
- Cambio de password: revoke de TODAS las sesiones del user

### Rate limits

| Endpoint                          | Límite                    |
|-----------------------------------|---------------------------|
| `/api/auth/login`                 | 10/min, 30/hora           |
| `/api/auth/forgot-password`       | 3/hora, 1 cada 5 min      |
| `/api/auth/reset-password`        | 10/hora, 5/5min           |
| `/api/auth/bootstrap`             | 3/hora                    |
| `/api/users/invite`               | 20/hora                   |
| `/api/users/:id/resend-invitation`| 10/hora                   |
| `/api/invitations/:token`         | 60/hora                   |
| `/api/invitations/:token/accept`  | 10/hora, 30/día           |

Implementado con `Flask-Limiter`, key = IP del request (X-Forwarded-For
del ALB).

### Anti-enumeration

`/api/auth/forgot-password` siempre devuelve 200 con mensaje genérico,
exista o no el email. Evita que un attacker descubra qué emails están
registrados probando uno por uno.

### CORS

`supports_credentials=True` requiere `ALLOWED_ORIGIN` allowlist explícito
(no `"*"`). Configurado en Parameter Store
`/monou/prod/ALLOWED_ORIGIN = "https://monoulabs.ai,https://www.monoulabs.ai"`.

---

## Operations / SRE

### Eliminar `ADMIN_TOKEN` del Secret (post-bootstrap)

Una vez bootstrappeado, `ADMIN_TOKEN` NO se usa para autenticar requests
(solo el endpoint `/api/auth/bootstrap` lo lee, y solo si
`bootstrap_done=false`). Se puede borrar con seguridad:

```bash
# 1. Lee el secret actual
aws secretsmanager get-secret-value --secret-id monou/prod/app \
  --query SecretString --output text > /tmp/app-secret.json

# 2. Edita /tmp/app-secret.json y borra la entrada "ADMIN_TOKEN"
# (deja FLASK_SECRET_KEY y otras claves intactas)
nano /tmp/app-secret.json

# 3. Aplica el cambio
aws secretsmanager update-secret --secret-id monou/prod/app \
  --secret-string file:///tmp/app-secret.json

# 4. Borra el archivo temporal
shred -u /tmp/app-secret.json

# 5. Reinicia el service para que recargue (deploy.sh hace systemctl reload)
./deploy.sh v3.2.0
```

Si después necesitás re-bootstrappear (DB wipe), tendrás que volver a
generar un ADMIN_TOKEN y agregarlo al Secret. No es un caso esperado.

### DB schema

5 tablas v3.2.0 + 1 settings singleton. Ver `server/db.py::SCHEMA_SQL`
para definiciones completas con constraints y indexes.

### Backups

RDS automated backups: 7 días retention. Para restore manual:

```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier monou-postgres-restored \
  --db-snapshot-identifier <snapshot-id>
```

Las tablas de v3.2.0 (users, sessions, invitations, audit_log) se
restauran junto con los datos de contacts/games/etc.

---

## API reference rápida

### Auth (público)

- `POST /api/auth/login` — `{email, password}` → cookie + user
- `POST /api/auth/logout` — invalida session
- `GET /api/auth/me` — user actual + permissions
- `POST /api/auth/forgot-password` — `{email}` → magic link al email
- `POST /api/auth/reset-password` — `{token, password}` → set new + login
- `POST /api/auth/bootstrap` — Bearer ADMIN_TOKEN, `{email, full_name, password}`
- `GET /api/auth/bootstrap-status` — `{bootstrap_done: bool}`

### Users (super_admin/admin)

- `GET /api/users` — list
- `GET /api/users/:id` — detail
- `PATCH /api/users/:id` — update role/status/permissions
- `DELETE /api/users/:id` — soft delete
- `POST /api/users/invite` — `{email, full_name, role, permissions}`
- `POST /api/users/:id/resend-invitation`

### Invitations (público)

- `GET /api/invitations/:token` — info
- `POST /api/invitations/:token/accept` — `{password}` → cookie + user

### Audit log (super_admin)

- `GET /api/audit-log?action=&user_id=&since=&until=&limit=&offset=`
- `GET /api/audit-log/actions` — distinct actions para filter
- `POST /api/admin/audit-cleanup` — `{retention_days: 90}`
