# Despliegue — Monou.gg landing

Frontend (HTML estático) → **GitHub Pages**
Backend (Flask + SMTP) → **Render**

URL final:
- Landing: `https://rladron-rodia.github.io/landing_contacto/`
- API: `https://landing-contacto-backend.onrender.com/api/contact`

## 1. Backend en Render (5 min)

### 1.1 Crea la cuenta
1. Ve a https://render.com y haz **Sign up with GitHub**.
2. Autoriza Render a leer tu repo `rladron-rodia/landing_contacto`.

### 1.2 Crea el servicio
1. En el dashboard de Render pulsa **New +** → **Blueprint**.
2. Selecciona el repo `rladron-rodia/landing_contacto`.
3. Render detectará el archivo `render.yaml` y mostrará el servicio
   `landing-contacto-backend`.
4. Pulsa **Apply**.

### 1.3 Configura el secret de Gmail
Render te pedirá el valor de la única variable marcada `sync: false` —
`SMTP_PASSWORD`. Pega tu **App Password** de Gmail (16 caracteres, sin
espacios). Luego pulsa **Apply**.

> Genera la App Password en https://myaccount.google.com/apppasswords
> (requiere verificación en 2 pasos activada en tu cuenta Google).

### 1.4 Espera el primer build (~3 min)
Cuando el deploy termine verás en verde:

```
==> Your service is live at https://landing-contacto-backend.onrender.com
```

Verifica:

```bash
curl https://landing-contacto-backend.onrender.com/api/health
# {"ok":true,"service":"monou-contact"}
```

> ⚠️ Free tier de Render: el servicio "duerme" tras 15 min de inactividad.
> El primer request lo "despierta" (3-5s). Los siguientes son instantáneos.

## 2. Frontend en GitHub Pages (2 min)

1. Ve a https://github.com/rladron-rodia/landing_contacto/settings/pages
2. **Source**: `Deploy from a branch`
3. **Branch**: `main` / **Folder**: `/ (root)`
4. Pulsa **Save**.
5. Espera 1-2 min — la URL final es:

   **https://rladron-rodia.github.io/landing_contacto/**

El JS del formulario detecta automáticamente que está en un dominio
distinto a `localhost` y enruta los envíos a la URL pública del backend.

## 3. Probar el formulario en producción

Abre https://rladron-rodia.github.io/landing_contacto/, llena el formulario
y pulsa **Enviar Solicitud**.

- ✅ Mensaje verde "¡Gracias! Tu solicitud fue enviada correctamente."
- ✅ Llega el correo a `rodrigo.ladron@monou.gg`
- ✅ Si abres la consola del navegador (F12) ves un POST 200 a la URL de Render

## 4. Solución de problemas

| Síntoma | Diagnóstico |
|---|---|
| "Failed to fetch" en consola | El backend de Render está dormido — espera 5s y reintenta |
| 500 "Autenticación SMTP fallida" | App Password mal pegada en Render — edítala en *Environment* del servicio |
| 403 / CORS | En Render, en *Environment*, confirma `ALLOWED_ORIGIN=*` (o pon tu dominio exacto) |
| El formulario sigue abriendo Outlook | Tu navegador tiene cacheado el HTML antiguo — Cmd+Shift+R |

## 5. Hardening en producción

Cuando esté todo funcionando, restringe el CORS:

En Render → tu servicio → **Environment** → `ALLOWED_ORIGIN`:
```
https://rladron-rodia.github.io,https://monou.gg,https://www.monou.gg
```

Y considera añadir reCAPTCHA o rate-limiting si recibes spam.
