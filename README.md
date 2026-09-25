# Snow Académico

Aplicación de prueba para generar borradores académicos. Usa OpenRouter para la generación y Firebase Authentication/Cloud Firestore para cuentas, perfiles, sugerencias e historial privado por usuario.

## Variables de entorno en Render

- `OPENROUTER_API_KEY`: clave privada de OpenRouter. Guárdala solo como secreto en Render; no la publiques en GitHub ni en `index.html`.
- `OPENROUTER_MODEL`: modelo principal. El valor inicial es `google/gemma-4-26b-a4b-it:free`; se solicitan proveedores de menor latencia y se conservan modelos alternativos.
- `FIREBASE_PROJECT_ID`: `snow-academico`.
- `ADMIN_UID`: UID Firebase de la única cuenta autorizada para el panel. No uses solo el correo ni aceptes un indicador de administrador editable por el navegador.

El servidor valida los tokens de Firebase con certificados públicos; no requiere una clave de servicio.

## Panel de administración

El panel presenta correos y resúmenes limitados de las cuentas, actividad aproximada, trabajos guardados y errores técnicos recientes. No muestra trabajos ni contraseñas. La recuperación envía el enlace oficial de Firebase al correo del usuario; el administrador no lee ni cambia contraseñas. Puede suspender o reactivar una cuenta; la suspensión bloquea la generación desde el servidor y no borra sus trabajos.

Publica las reglas de `firestore.rules` en Firebase Console. Esas reglas limitan los perfiles y trabajos a cada propietario; el administrador solo puede listar `adminUsers` y `userAccess` y leer `adminLogs`. Cada cuenta solo puede escribir su propio resumen y sus propios errores técnicos. Solo la cuenta administradora puede crear o cambiar el estado de suspensión.

## Seguridad y pruebas

El registro no exige verificación de correo. La recuperación de contraseña requiere acceso al buzón asociado. El plan gratuito de Render puede tardar en despertar y los proveedores gratuitos de OpenRouter pueden limitar, demorar o interrumpir solicitudes; no se puede garantizar disponibilidad absoluta.

Revisa, corrige y verifica los trabajos, las fuentes y los requisitos de la asignatura antes de enviarlos al docente o a la universidad.

## Ejecución local

Requiere Node.js 20 o superior. Copia `.env.example` a `.env`, agrega tu clave de OpenRouter sin compartirla y ejecuta `npm start`; después abre `http://127.0.0.1:3000`. No subas `.env` a GitHub.
