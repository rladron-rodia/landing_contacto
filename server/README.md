# Backend SMTP — Formulario de contacto Monou.gg

Este backend recibe los datos del formulario de la landing (frame `ixmppy`)
y envía un correo a través de **SMTP de Gmail**.

## 1. Instalación

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. Configurar credenciales

Gmail **NO** acepta tu contraseña habitual desde aplicaciones externas. Debes
generar una **Contraseña de aplicación** (App Password):

1. Activa la verificación en 2 pasos en tu cuenta Google.
2. Ve a https://myaccount.google.com/apppasswords
3. Crea una nueva clave (16 caracteres).
4. Copia `.env.example` a `.env` y pégala en `SMTP_PASSWORD`.

```bash
cp .env.example .env
# Edita .env con tus valores
```

Configuración SMTP:

| Variable      | Valor recomendado                                  |
|---------------|----------------------------------------------------|
| `SMTP_HOST`   | `smtp.gmail.com`                                   |
| `SMTP_PORT`   | `587` (TLS) **o** `465` (SSL)                      |
| `SMTP_MODE`   | `tls` para 587, `ssl` para 465                     |
| `SMTP_USER`   | `rladron@gmail.com`                                |
| `SMTP_PASSWORD` | App Password de Google                           |
| `MAIL_TO`     | Destinatario(s) separados por coma                 |

## 3. Ejecutar el servidor

```bash
python app.py
# Servidor en http://localhost:5000
```

Endpoints:

- `POST /api/contact` — recibe JSON con `nombre, email, empresa, caso_uso, mensaje`
- `GET  /api/health`  — chequeo de estado

Prueba rápida:

```bash
curl -X POST http://localhost:5000/api/contact \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Test","email":"test@example.com","mensaje":"Hola"}'
```

## 4. Conectar el formulario de la landing

En el HTML, antes de `</body>`, añade:

```html
<script>
  // Cambia esto si tu backend corre en otro lugar
  window.MONOU_API_URL = "http://localhost:5000/api/contact";
</script>
<script src="server/contact-form.js" defer></script>
```

Y asegúrate de que el `<form>` tenga `id="ixmppy"` y de que cada campo tenga
su atributo `name`:

```html
<form id="ixmppy">
  <input name="nombre"   type="text"  required>
  <input name="email"    type="email" required>
  <input name="empresa"  type="text">
  <select name="caso_uso"> ... </select>
  <textarea name="mensaje"></textarea>
  <!-- honeypot anti-bot, oculto -->
  <input name="website" type="text" tabindex="-1" autocomplete="off"
         style="position:absolute;left:-9999px" aria-hidden="true">
  <button type="submit">Enviar</button>
</form>
```

> El script ya hace fallback por orden de campos, así que funcionará incluso
> si todavía no añadiste los `name`, pero es muy recomendable hacerlo.

## 5. Producción

- Usa un servidor WSGI real (Gunicorn / uWSGI) detrás de Nginx.
  ```bash
  pip install gunicorn
  gunicorn -w 2 -b 0.0.0.0:5000 app:app
  ```
- Limita `ALLOWED_ORIGIN` al dominio real (no uses `*`).
- Nunca subas el archivo `.env` a un repositorio público.
- Considera añadir reCAPTCHA o rate-limiting (Flask-Limiter) si recibes spam.

## Solución de problemas

| Error                                     | Causa probable                                      |
|-------------------------------------------|-----------------------------------------------------|
| `SMTPAuthenticationError`                 | App Password incorrecta o no usaste App Password    |
| `Connection refused` puerto 587/465       | Firewall corporativo bloqueando SMTP                |
| Llega el correo a SPAM                    | Configura SPF/DKIM si usas dominio propio           |
| `CORS policy` en consola                  | Ajusta `ALLOWED_ORIGIN` al origen de la landing     |
