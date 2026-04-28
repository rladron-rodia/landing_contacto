# Estadísticas dinámicas desde Google Sheets

Las cifras del bloque "10k+ / 2.5M / 50+" de la landing se cargan al vuelo
desde un Google Sheet publicado como CSV. Cualquier persona con permiso de
edición sobre el Sheet puede actualizarlas — la landing las refleja al
recargar (caché de 5 min).

## 1. Crear el Sheet

1. Ve a https://sheets.new (crea uno en blanco).
2. Renómbralo a `Monou Landing Stats`.
3. Pega exactamente esta cabecera y datos en la primera hoja (4 columnas):

| key            | value | label_es           | label_en        |
|----------------|-------|--------------------|-----------------|
| capture_hours  | 10k+  | Horas de Captura   | Capture Hours   |
| indexed_videos | 2.5M  | Videos Indexados   | Indexed Videos  |
| games_covered  | 50+   | Juegos Cubiertos   | Games Covered   |

> Las columnas `label_es` y `label_en` son **opcionales**. Si las dejas
> vacías, los rótulos del HTML se quedan tal cual y solo se actualizan los
> valores. Si las rellenas, los rótulos también cambian (en ambos idiomas).

> El `key` debe coincidir exactamente con el del HTML
> (`capture_hours`, `indexed_videos`, `games_covered`). Si renombras
> alguno, también hay que cambiarlo en `index.html`.

## 2. Publicar como CSV

1. En el Sheet abierto: menú **Archivo** → **Compartir** → **Publicar en la web**
   (en inglés: **File** → **Share** → **Publish to web**).
2. En el diálogo:
   - **Link** → "Toda la hoja" o "Hoja 1"
   - Formato → **Valores separados por comas (.csv)**
3. Pulsa **Publicar** → confirma con **Aceptar**.
4. Copia la URL que te genera. Tendrá esta forma:

   ```
   https://docs.google.com/spreadsheets/d/e/2PACX-1vR.../pub?output=csv
   ```

> ⚠️ Esa URL es **pública** (cualquiera con el link puede leer el contenido
> del sheet). Para stats de marketing está bien — son cifras que ya muestras
> en la landing. Nunca pongas información sensible ahí.

## 3. Pegar la URL en `index.html`

Abre `index.html` y busca esta línea cerca del final (~línea 1399):

```html
<meta name="stats-csv-url" content="">
```

Pega tu URL en el atributo `content`:

```html
<meta name="stats-csv-url" content="https://docs.google.com/spreadsheets/d/e/2PACX-1vR.../pub?output=csv">
```

Commit y push:

```bash
git add index.html
git commit -m "config: stats CSV URL"
git push
```

GitHub Pages redespliega en 1-2 min. Listo.

## 4. Actualizar las cifras

Para cambiar `10k+` a `15k+`, abre el Sheet, edita la celda B2, guarda
(Cmd+S o automático). En tu navegador, recarga la landing — verás `15k+`.

> Si no quieres esperar el caché de 5 min de Google, abre con `?nocache`
> al final de la URL para forzar una recarga: `https://...github.io/landing_contacto/?nocache`

## 5. Cómo funciona por dentro

- `server/stats-loader.js` se carga al final del HTML.
- Lee la URL del meta tag, hace `fetch()` con cache-buster.
- Parsea el CSV (incluyendo soporte para celdas con comillas y comas).
- Busca elementos en el HTML con `data-stat-value="<key>"` y los reemplaza
  con la columna `value`.
- Si hay `label_es` / `label_en`, también actualiza el rótulo
  (respetando el idioma activo del switch ES/EN).
- Cachea en `localStorage` para que la próxima carga no parpadee.
- Si Google está caído o el CSV no responde, los valores hardcodeados del
  HTML (`10k+ / 2.5M / 50+`) se quedan en pantalla. Falla seguro.

## 6. Añadir nuevas estadísticas

Para sumar una cuarta cifra (ej. "DEVELOPERS USING IT"):

1. Añade una fila al Sheet:

   ```
   developers | 200+ | Desarrolladores | Developers
   ```

2. En `index.html`, dentro del bloque de stats, añade un nuevo `<div>`
   copiando uno de los existentes. En el `<h3>` y `<p>` añade:

   ```html
   <h3 data-stat-value="developers" ...>200+</h3>
   <p  data-stat-label="developers" data-es="Desarrolladores"
       data-en="Developers" ...>Desarrolladores</p>
   ```

3. Commit + push. La nueva cifra ya se actualiza desde el Sheet.

## Solución de problemas

| Síntoma | Causa | Fix |
|---|---|---|
| Las cifras no cambian al editar el Sheet | Caché de Google (5 min) o caché del navegador | Recarga con `Cmd+Shift+R` o espera 5 min |
| `[stats-loader] fetch falló` en consola | URL mal pegada o Sheet despublicado | Verifica que la URL termine en `?output=csv` y siga publicada |
| Cargan los 3 stats pero el cuarto que añadí no | El `key` del HTML no coincide con el del Sheet | Revisa que coincidan exactamente (mayúsculas/minúsculas/guiones) |
| Cambian valores pero no labels | Faltan columnas `label_es` / `label_en` en el Sheet | Añádelas (son opcionales pero necesarias para actualizar rótulos) |
