# Snow Académico

Aplicación de prueba que sirve la página y la ruta `/api/generate` desde el mismo servidor Node. La clave de OpenRouter se lee únicamente desde `OPENROUTER_API_KEY`; nunca debe guardarse en `index.html`, GitHub ni en el navegador.

## Despliegue en Render

`render.yaml` define un servicio Node gratuito. Para publicarlo:

1. Sube al repositorio `index.html`, `api-server.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md` y `run-local.ps1`.
2. Inicia sesión en Render y crea un **Blueprint** desde `JeanxSnow/Snow-Academico`.
3. Cuando Render solicite `OPENROUTER_API_KEY`, introduce una clave nueva en el panel de Render como variable secreta. No la escribas en archivos ni en el repositorio.
4. Al terminar el despliegue, abre el dominio HTTPS `*.onrender.com` que Render asigne. La página y la API quedan bajo el mismo dominio.
5. Comprueba que `/health` responda `{"ok":true}` y prueba una generación desde la página.

Cada cambio subido al repo puede activar un nuevo despliegue. El plan gratuito duerme tras 15 minutos sin tráfico y el primer acceso después puede tardar cerca de un minuto. OpenRouter también puede aplicar límites o tener interrupciones; los modelos de respaldo ayudan, pero no garantizan disponibilidad absoluta.

## Ejecución local

Requiere Node.js 20 o superior y una clave propia de OpenRouter. Abre PowerShell en esta carpeta y ejecuta:

```powershell
.\run-local.ps1
```

Copia la clave al portapapeles cuando el lanzador lo solicite. Deja la ventana abierta y visita `http://127.0.0.1:3000`. El lanzador usa Node del sistema o la copia de Node incluida en Codex si está disponible.

## Alcance de esta prueba

El registro y el inicio de sesión actuales se guardan localmente en cada navegador; no son cuentas reales compartidas. El acceso de Google tampoco está conectado. No introduzcas contraseñas reales ni información sensible.
