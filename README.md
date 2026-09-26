# Snow Academico

Aplicacion de prueba para generar borradores academicos. Usa OpenRouter para generar contenido y Firebase para cuentas y almacenamiento privado.

## Variables de entorno en Render

- `OPENROUTER_API_KEY`: clave privada; guardarla solo como secreto en Render.
- `OPENROUTER_MODEL`: modelo principal (por defecto `google/gemma-4-26b-a4b-it:free`).
- `FIREBASE_PROJECT_ID`: `snow-academico`.
- `ADMIN_UID`: UID Firebase de la cuenta autorizada como administradora.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: JSON de la cuenta de servicio guardado como secreto de Render. Necesario para el control atomico de creditos. No publicarlo en GitHub ni enviarlo por chat.
- `DEFAULT_DAILY_CREDIT_LIMIT`: limite predeterminado por persona y dia UTC (5).

El servidor requiere Node.js 22 o posterior. Sin la credencial de Firebase Admin, las rutas de creditos fallan de forma cerrada y no permiten iniciar generaciones.

## Panel administrador y creditos

El administrador define un limite diario de 0 a 50 por usuario y consulta el consumo del dia. Una generacion completada o cancelada consume un credito; un error tecnico libera la reserva y no cuenta. Las reservas se hacen en una transaccion de Firestore para impedir exceder el limite en varias pestañas. El dia se calcula en UTC.

En Firebase Console, crea una clave JSON de cuenta de servicio. En Render > servicio `snow-academico` > Environment, agrega `FIREBASE_SERVICE_ACCOUNT_JSON` y pega el contenido completo como secreto. No subas ese archivo a GitHub ni lo pegues en mensajes. Publica tambien `firestore.rules` en Firebase Console.

## Recuperacion de generacion

Si el proveedor interrumpe el flujo o alcanza su limite, el navegador conserva el borrador y reintenta continuar el mismo trabajo. Cada respuesta de reintento se combina con el texto guardado y se eliminan solapamientos para reducir duplicados. La vista previa se actualiza menos a menudo para evitar congelamientos. Los proveedores gratuitos pueden demorar, limitar o interrumpir solicitudes; no se puede garantizar disponibilidad absoluta.

## Seguridad

Los trabajos y perfiles son privados para cada usuario. El administrador puede ver resumenes y errores tecnicos, pero no trabajos ni contrasenas. La recuperacion de contrasena usa el correo de Firebase. Revisa y corrige el contenido, las citas y las fuentes antes de entregar un trabajo.

## Ejecucion local

Requiere Node.js 22 o posterior. Copia `.env.example` a `.env`, agrega la clave de OpenRouter y configura `FIREBASE_SERVICE_ACCOUNT_JSON` si usaras el control de creditos localmente. Ejecuta `npm start` y abre `http://127.0.0.1:3000`. No subas `.env` ni la clave de servicio a GitHub.
