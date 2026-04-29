# Workflow de desarrollo

`main` siempre representa producción. Cualquier merge a `main` activa
auto-deploy del backend en Render y republica la landing en GitHub Pages.

Por eso **NO se commiteamos directamente en `main`**. Cada cambio vive en
su propia rama hasta que se mergea vía Pull Request.

## Convenciones de nombres de rama

| Prefijo            | Para qué                              |
|--------------------|---------------------------------------|
| `feature/<nombre>` | Nuevas funcionalidades                |
| `fix/<nombre>`     | Bugfixes                              |
| `chore/<nombre>`   | Refactor, deps, config, docs sueltos  |
| `hotfix/<nombre>`  | Fix urgente directo a `main`          |

Ejemplos: `feature/admin-dashboard`, `fix/cors-prod-domain`,
`chore/upgrade-flask`.

## Flujo paso a paso

### 1. Crear la rama desde main actualizado

```bash
git checkout main
git pull origin main
git checkout -b feature/<nombre>
```

### 2. Trabajar y commitear

```bash
git add <archivos>
git commit -m "feat(scope): qué hiciste"
git push -u origin feature/<nombre>
```

### 3. Abrir Pull Request en GitHub

- Ve a https://github.com/rladron-rodia/landing_contacto
- Banner amarillo "Compare & pull request" o pestaña **Pull requests** → **New**
- Base: `main` ← Compare: `feature/<nombre>`
- Título: descripción corta
- Descripción: qué cambia, cómo probarlo, screenshots si aplica
- **Create pull request**

### 4. Revisar y mergear

- Cuando quede listo: pulsa **Merge pull request** → **Confirm merge**
- Marca **Delete branch** para mantener limpio el repo

### 5. Producción se actualiza sola

- Render detecta el commit nuevo en `main` → redespliega backend (~3 min)
- GitHub Pages republica la landing (~1 min)

## Cómo previsualizar una rama antes de mergear

GitHub Pages solo sirve `main`, así que para ver una rama en vivo tienes
dos opciones:

**Opción A — Probar localmente:**

```bash
git checkout feature/<nombre>
python3 -m http.server 8000      # sirve la landing/admin
# en otra terminal: cd server && python app.py  # backend
```

**Opción B — Render preview environments** (requiere upgrade a Pro,
no disponible en el free tier).

## Versiones estables

Cuando una versión en `main` está en buen estado, etiquétala:

```bash
git tag -a v1.1.0 -m "descripción"
git push origin v1.1.0
```

Ver tags: https://github.com/rladron-rodia/landing_contacto/tags

Volver a una versión anterior si algo se rompe en producción:

```bash
git checkout main
git reset --hard v1.0.0
git push --force-with-lease origin main
```

(Solo en caso de emergencia. Lo normal es hacer un nuevo commit que
revierta el problema.)

## Estructura de ramas activas

- `main` → producción
- `feature/admin-dashboard` → dashboard CRM-style para ver contactos
  (en progreso, ver `admin/` folder)
