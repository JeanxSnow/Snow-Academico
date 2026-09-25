# Snow Académico

Aplicación de apoyo para generar borradores académicos con OpenRouter. Firebase Authentication administra las cuentas y Cloud Firestore conserva el perfil, las sugerencias de asignatura/facilitador y los trabajos generados bajo el espacio privado de cada usuario.

## Configuración

- `OPENROUTER_API_KEY`: clave privada de OpenRouter. Guárdala únicamente en el entorno del servidor (por ejemplo, Render), nunca en GitHub ni en `index.html`.
- `OPENROUTER_MODEL`: modelo principal de generación.
- `FIREBASE_PROJECT_ID`: ID del proyecto Firebase (`snow-academico`). El servidor usa este ID para verificar los tokens de Firebase con los certificados públicos de Google; no requiere una clave privada de servicio.
- `HOST` y `PORT`: dirección y puerto HTTP.

La configuración web de Firebase que aparece en `index.html` identifica el proyecto y la app, pero no contiene la contraseña de OpenRouter ni una clave privada. Firestore aplica reglas para que cada usuario lea y escriba solo en `/users/{uid}` y sus subcolecciones.

## Render

Configura `OPENROUTER_API_KEY` como secreto y `FIREBASE_PROJECT_ID=snow-academico` como variable del servicio. En Firebase Authentication, el dominio del servicio Render debe aparecer en **Dominios autorizados**. `/health` comprueba que el servidor está disponible.

## Cuentas y datos

El registro usa correo y contraseña, sin verificación obligatoria del correo. Firebase mantiene la sesión en ese navegador hasta que el usuario cierre sesión o borre los datos del sitio. Para usar otra computadora o teléfono, el usuario inicia sesión una vez en ese dispositivo. El correo debe tener formato válido; la recuperación de contraseña requiere acceso a su bandeja.

Cada usuario tiene un perfil y un historial de trabajos aislados. Los campos de asignatura y facilitador también se sincronizan con su cuenta. Snow Académico está en etapa de pruebas: revisa y corrige el contenido, las fuentes y los requisitos de la asignatura antes de entregar el trabajo.

## Ejecución local

Requiere Node.js 20 o superior y una clave de OpenRouter. Copia `OPENROUTER_API_KEY` a tu entorno local y ejecuta `npm start`; visita `http://127.0.0.1:3000`. Firebase ya tiene `localhost` en los dominios autorizados.
