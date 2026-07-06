# Radar de Vacante — weleap

Lead magnet para departamentos de RRHH: escanean una vacante y reciben un informe con benchmark salarial, tiempo de cobertura, índice de escasez y diagnóstico del JD con reescritura skills-based. Cada análisis genera un lead cualificado (email corporativo obligatorio) que llega a tu n8n.

## Estructura

```
radar-vacante/
├── index.html        → landing + formulario + informe (front completo)
├── api/analizar.js   → función serverless Vercel → Claude API
└── README.md
```

## Seguridad (importante: se publica como lead magnet público en LinkedIn)

Al ser un formulario público expuesto en LinkedIn, se han añadido estas protecciones:

- **CORS restringido**: la función solo acepta peticiones desde `https://weleapinternational.com` y el propio dominio de Vercel — no desde cualquier web. Si mueves el proyecto a otro dominio, añádelo a `ORIGENES_PERMITIDOS` en `api/analizar.js`.
- **Honeypot anti-bots**: un campo invisible (`web_empresa`) que solo rellenan los bots automáticos. Si llega relleno, se responde 200 sin llamar a la API de Anthropic (evita coste y abuso).
- **Límites de longitud por campo** tanto en el HTML (`maxlength`) como en el backend (doble validación, nunca confíes solo en el frontend).
- **Filtro de email corporativo**: bloquea Gmail/Hotmail/Outlook/etc., pensado para que solo rellenen el formulario perfiles de empresa reales.
- La `ANTHROPIC_API_KEY` nunca se expone al navegador — vive solo en las variables de entorno del servidor.

**Recomendación adicional (fuera del código, en el dashboard de Vercel):** activa **Deployment Protection / Attack Challenge Mode** en Settings → Deployment Protection para añadir un desafío automático si detecta tráfico anómalo (picos de bots). No hay rate-limiting por IP en el código porque las funciones serverless no mantienen estado entre peticiones; si el volumen de abuso lo justifica, la vía correcta es Vercel Firewall o un contador en Vercel KV/Upstash — dímelo si llega ese punto y lo añadimos.

## Marca

- Color principal: `#130030` — Color secundario: `#FF0068` — Tipografía: Montserrat
- Dominio: [weleapinternational.com](https://weleapinternational.com)
- Contacto: sergio@weleapinternational.com
- Posicionado bajo la línea **weleapHUNT** (executive search) de weleap

## Límite de gasto (3 informes/día por email o IP)

**Paso 1 — el más importante, hazlo hoy mismo, no depende del código:**
En [console.anthropic.com](https://console.anthropic.com) → Settings → Limits, fija un **límite de gasto mensual** en tu API key. Esta es tu red de seguridad real; todo lo demás es para dar buena experiencia, pero esto es lo que evita el desastre si algo falla.

**Paso 2 — activar Vercel KV (gratis, 2 minutos):**
1. En tu proyecto de Vercel → pestaña **Storage** → **Create Database** → elige **KV**
2. Conéctala a tu proyecto (Vercel te ofrece hacerlo automático)
3. Esto crea solo dos variables de entorno automáticamente: `KV_REST_API_URL` y `KV_REST_API_TOKEN` — no tienes que copiarlas a mano
4. Redeploy

Sin este paso, el código sigue funcionando pero **sin límite** — el aviso te lo recordará en los Logs. No lo dejes sin configurar antes de publicar en LinkedIn.

**Configuración del límite:** por defecto son 3 informes por email y 3 por IP cada 24h (variable `LIMITE_DIARIO`, editable). Si alguien lo supera, ve un mensaje claro invitándole a escribirte directamente en vez de un error — sigue siendo una oportunidad de contacto, no un muro.

## Placements propios de weleap (opcional, sube mucho la precisión)

En `api/analizar.js`, la constante `WELEAP_PLACEMENTS` está vacía por defecto. Si añades cierres reales:

```js
const WELEAP_PLACEMENTS = [
  { puesto: "Director de Operaciones Logísticas", sector: "Logística y transporte", ubicacion: "Madrid", salario: 78000, semanas_cierre: 9 },
];
```

El modelo los usa como **ancla prioritaria por encima de cualquier guía pública** cuando el sector o puesto coincide, y lo indica explícitamente en el informe ("basado en nuestros propios cierres recientes"). Es tu dato más valioso: nadie más lo tiene.

## Leads guardados (obligatorio para que esto sea un lead magnet de verdad)

Cada informe generado guarda automáticamente el lead (nombre, email, empresa, vacante, informe completo) en la misma base de datos Redis que ya usas para el límite diario. No necesitas configurar nada más para que empiece a guardar — ya funciona en cuanto subas `api/analizar.js` y `api/leads.js`.

**Para consultarlos:**
1. Añade la variable `ADMIN_SECRET` en Vercel con una contraseña que elijas (algo largo y random, no "1234")
2. Visita `https://analiza-vacante.vercel.app/api/leads?secret=TU_CONTRASEÑA` → te devuelve todos los leads en JSON
3. Añade `&format=csv` a la URL → te descarga un CSV listo para abrir en Excel o importar a Google Sheets

**Importante:** no compartas esa URL con el secreto en ningún sitio público (ni en LinkedIn, ni en capturas) — cualquiera con ese enlace puede ver todos los leads.

Si más adelante quieres subir esto a Google Sheets automáticamente en vez de consultarlo a mano, configura también `LEADS_WEBHOOK_URL` apuntando a un webhook de n8n — el código ya envía ahí una copia de cada lead en paralelo al guardado en Redis.

## Despliegue en Vercel (5 minutos)



1. Sube la carpeta a un repo de GitHub (o `vercel deploy` directo desde CLI).
2. Importa el proyecto en Vercel. No necesita build: es HTML estático + función en `/api`.
3. Configura las variables de entorno en Vercel → Settings → Environment Variables:

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Tu API key de Anthropic |
| `CLAUDE_MODEL` | No | Por defecto `claude-sonnet-5` (configurado así para las pruebas; súbelo a `claude-fable-5` u `claude-opus-4-8` cuando quieras más profundidad de análisis) |
| `FALLBACK_MODEL` | No | Por defecto `claude-opus-4-8` (se usa si el modelo principal rechaza o falla) |
| `LEADS_WEBHOOK_URL` | No | Webhook de n8n que recibe cada lead + informe completo en JSON |
| `ENABLE_WEB_SEARCH` | No | Activa por defecto. Ponlo a `false` para desactivarla (respuesta más rápida y barata, pero el benchmark salarial deja de ser en tiempo real) |
| `MAX_TOKENS` | No | Por defecto 4000 (subido porque la búsqueda web consume turnos extra) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Recomendado | Las crea Vercel/Upstash automáticamente al conectar la base de datos Redis (ver sección "Límite de gasto" arriba). Sin ellas, no hay límite diario. |
| `LIMITE_DIARIO_EMAIL` | No | Por defecto 3 (informes máximos por el mismo email cada 24h — control fino real) |
| `LIMITE_DIARIO_IP` | No | Por defecto 15 (informes máximos por IP cada 24h — más alto a propósito para no bloquear a varias personas de la misma oficina/red compartida) |
| `DOMINIOS_SIN_LIMITE` | No | Por defecto `weleapinternational.com` — cualquier email de ese dominio queda exento del límite diario, para que el equipo pueda probar sin restricción. Añade más separados por coma. |

Además, cruza el benchmark con INE Encuesta de Estructura Salarial (la fuente pública más fiable de España) y, si has rellenado `WELEAP_PLACEMENTS` en el código, con tus propios cierres reales — ver sección dedicada más abajo.

### Benchmark salarial con guías públicas reales

El modelo busca en la web y cruza al menos 3 de estas fuentes por cada vacante: Hays Guía del Mercado Laboral, Michael Page Estudio de Remuneración, Robert Half Salary Guide, Randstad, Adecco, PageGroup. Calcula una media ponderada dando más peso a las fuentes con datos más específicos para ese sector/puesto y descarta outliers. Las fuentes realmente consultadas se muestran en el informe (`fuentes_consultadas`) — es un argumento de credibilidad frente al lead, no solo un dato técnico. Para perfiles muy nicho donde ninguna guía baja a ese nivel de detalle, el modelo lo indica y extrapola desde el perfil más cercano.

4. Redeploy y listo.

## Flujo del lead en n8n

Cada análisis hace un POST a `LEADS_WEBHOOK_URL` con:

```json
{
  "origen": "radar-vacante",
  "timestamp": "...",
  "lead": { "nombre", "email", "empresa", "puesto", "sector", "ubicacion", "salario" },
  "informe": { ...informe completo... },
  "modelo": "claude-fable-5"
}
```

Ideas de workflow: guardar en Supabase/Sheets → enviar el informe por email al lead (refuerza el gate) → notificarte por Telegram si la escasez es "alta/critica" (lead caliente para búsqueda difícil) → secuencia de nurturing.

## Notas de coste y modelo

- Cada informe consume ~2.500-3.500 tokens de salida. Con Fable ($10/$50 por millón) sale a ~0,15-0,20 € por informe. Si el volumen crece, cambia `CLAUDE_MODEL` a `claude-sonnet-4-6` y baja el coste ~10x con calidad muy similar para esta tarea.
- Fable 5 tiene clasificadores de seguridad: si alguno salta (raro con vacantes), la función reintenta automáticamente con el modelo de respaldo.
- `ENABLE_WEB_SEARCH=true` mejora la frescura de los benchmarks salariales pero añade latencia y coste. Pruébalo con perfiles nicho.

## Mejoras v2 (la ventaja que nadie puede copiar)

- Conectar el índice de escasez a tus datos reales de Jarvis/Supabase (candidatos scrapeados por sector) en vez de estimación del modelo → benchmark propietario weleap.
- Enviar el informe en PDF maquetado por email (reutiliza la infraestructura del CV optimizer).
- Rate limiting por IP en la función si empieza a haber abuso.

## Personalización rápida

- Email de contacto del CTA: busca `hola@weleap.es` en `index.html` (2 apariciones).
- Colores y tipografías: variables CSS en `:root` al inicio de `index.html`.
- Tono/criterios del análisis: `SYSTEM_PROMPT` en `api/analizar.js`.
