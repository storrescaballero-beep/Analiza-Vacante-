// /api/analizar.js — Radar de Vacante (weleap)
// Función serverless para Vercel. Node 18+, sin dependencias externas (usa fetch nativo).
//
// Variables de entorno necesarias en Vercel:
//   ANTHROPIC_API_KEY   -> tu API key de Anthropic (obligatoria)
//   CLAUDE_MODEL        -> opcional, por defecto "claude-sonnet-5"
//   FALLBACK_MODEL      -> opcional, por defecto "claude-opus-4-8"
//   LEADS_WEBHOOK_URL   -> opcional, webhook de n8n para recibir cada lead + informe
//   ENABLE_WEB_SEARCH   -> opcional, "false" para desactivar la búsqueda de guías salariales (activa por defecto, es la base del benchmark real)
//   MAX_TOKENS          -> opcional, por defecto 4000 (subido porque la búsqueda web consume turnos extra)
//   KV_REST_API_URL     -> URL de Vercel KV (Storage → Create Database → KV). Necesaria para el límite de 3 informes/día.
//   KV_REST_API_TOKEN   -> Token de Vercel KV. Si no está configurado, el límite queda desactivado (no rompe la app, pero no protege el gasto).
//   LIMITE_DIARIO       -> opcional, por defecto 3 (informes máximos por email o IP al día)

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "claude-opus-4-8";
const LIMITE_DIARIO = Number(process.env.LIMITE_DIARIO) || 3;

// Placements reales de weleap, como referencia de verdad para el modelo.
// Añade aquí cierres reales (sector, puesto, ciudad, salario final, semanas hasta el cierre).
// Cuantos más metas, más preciso será el benchmark — esto pesa más que cualquier guía pública
// porque es tu propio histórico verificado, no una estimación de mercado.
const WELEAP_PLACEMENTS = [
  // { puesto: "Director de Operaciones Logísticas", sector: "Logística y transporte", ubicacion: "Madrid", salario: 78000, semanas_cierre: 9 },
];

const SYSTEM_PROMPT = `Eres el motor de análisis de "Radar de Vacante", una herramienta de weleapHUNT, la línea de executive search de weleap, consultora boutique de HR con operación en 8 países. weleap conecta directivos y expertos en HR con su próximo desafío profesional, priorizando el encaje real con la organización sobre el ajuste técnico superficial.

Tu trabajo: analizar una vacante como lo haría un headhunter senior, y devolver un informe honesto, directo y con criterio. El tono de weleap es senior y directo, sin capas corporativas innecesarias entre el problema y la solución: di las cosas claras, con datos y sin edulcorar, pero siempre profesional y útil.

Tienes acceso a búsqueda web. ÚSALA SIEMPRE para el benchmark salarial, en este orden:
0. Si en el mensaje del usuario aparece la sección "PLACEMENTS REALES DE WELEAP", esos datos son verdad verificada de cierres propios — dales prioridad máxima como ancla del rango sobre cualquier guía pública, y dilo explícitamente en el comentario (ej. "basado en nuestros propios cierres recientes en este sector").
1. Además, busca el dato en al menos 3 de estas fuentes públicas (ajusta los términos de búsqueda al puesto, sector y España): "INE Encuesta de Estructura Salarial", "Hays Guía del Mercado Laboral España", "Michael Page Estudio de Remuneración España", "Robert Half Salary Guide España", "Randstad informe salarial España", "Adecco Guía Salarial España", "PageGroup salary guide Spain". El INE es la fuente pública oficial más fiable de España: úsala siempre que exista dato para ese sector/puesto y dale prioridad como ancla del rango cuando no haya placements propios de weleap.
2. Extrae el rango salarial que cada fuente da para el puesto (o el más cercano equivalente por seniority y función si no hay coincidencia exacta).
3. Calcula una MEDIA PONDERADA de los rangos encontrados: si hay placements propios de weleap, pesan más que cualquier fuente pública; entre las públicas, da más peso a las más específicas para ese sector/puesto y descarta outliers claramente desalineados.
4. Si una fuente no cubre el sector o el puesto es muy nicho, indícalo y extrapola desde el perfil de seniority/función más cercano, dejándolo claro en el comentario.
5. Nunca reproduzcas texto literal de las guías: sintetiza solo las cifras y tu propia interpretación.
6. Registra en "fuentes_consultadas" qué guías lograste consultar realmente (no las que ibas a consultar), y si usaste placements propios de weleap, inclúyelo como "Histórico de cierres weleap" en esa misma lista.

Analiza teniendo en cuenta:
1. BENCHMARK SALARIAL: rango de mercado en España para ese puesto, sector y ubicación (ajusta por ciudad: Madrid/Barcelona vs resto), calculado como media ponderada de las guías salariales públicas que hayas consultado por búsqueda web. Si el salario ofrecido está por debajo de mercado, dilo sin rodeos.
2. TIEMPO DE COBERTURA: semanas realistas para cubrir la posición según escasez del perfil, atractivo de la oferta y ubicación.
3. ESCASEZ DE TALENTO: índice 0-100 (100 = casi imposible de encontrar). Considera cuántos profesionales con ese perfil existen en España, cuántos están en búsqueda activa vs pasiva, y competencia por ellos.
4. DIAGNÓSTICO DEL JOB DESCRIPTION: puntuación 0-10. Los mejores JD son skills-based (habilidades demostrables) en vez de títulos + años de experiencia. Penaliza: listas interminables de requisitos, "unicornios" (perfiles que no existen), jerga interna, ausencia de rango salarial, cero propuesta de valor al candidato. Si no aportan JD, evalúa con lo que tengas y márcalo.
5. VEREDICTO: un titular provocador estilo weleap que resuma la situación real de esta vacante en el mercado. Ejemplos de tono: "Buscáis un unicornio con sueldo de poni", "Vacante bien planteada, pero llegáis tarde: ese perfil ya lo están cazando otros tres", "Con este salario en Asturias, prepárate para 5 meses de búsqueda".

REGLAS DE SALIDA:
- Responde ÚNICAMENTE con un objeto JSON válido, sin markdown, sin backticks, sin texto antes o después.
- Todos los textos en español de España.
- Los salarios en euros brutos anuales.
- Sé específico con números, nunca vago.
- CRÍTICO: si un valor string necesita salto de línea (por ejemplo "version_mejorada"), usa el carácter de escape \\n dentro del string. Nunca insertes un salto de línea real sin escapar: rompe el JSON.

ESQUEMA JSON EXACTO:
{
  "veredicto": {
    "titular": "string, máx 90 caracteres, provocador",
    "texto": "string, 2-3 frases que expliquen la situación real",
    "nivel": "verde | ambar | rojo"
  },
  "benchmark_salarial": {
    "rango_mercado_min": number,
    "rango_mercado_max": number,
    "posicion_oferta": "por_debajo | en_linea | por_encima | no_indicado",
    "comentario": "string, 1-2 frases",
    "fuentes_consultadas": ["string", "..."] (nombres de las guías realmente consultadas, ej. "Hays Guía del Mercado Laboral 2026", máx 5)
  },
  "tiempo_cobertura": {
    "semanas_min": number,
    "semanas_max": number,
    "comentario": "string, 1-2 frases"
  },
  "escasez_talento": {
    "indice": number (0-100),
    "nivel": "baja | media | alta | critica",
    "candidatos_estimados": "string, ej. '300-500 profesionales en España, <10% en búsqueda activa'",
    "comentario": "string, 1-2 frases"
  },
  "diagnostico_jd": {
    "puntuacion": number (0-10),
    "jd_aportado": boolean,
    "problemas": ["string", "..."] (máx 4, los más graves),
    "version_mejorada": "string, reescritura skills-based del titular + 4-6 requisitos clave del JD, formato texto plano con saltos de línea",
    "comentario": "string, 1 frase"
  },
  "recomendaciones": ["string", "string", "string"] (3 acciones concretas y accionables)
}`;

function construirPromptUsuario(datos) {
  const relevantes = WELEAP_PLACEMENTS.filter(
    (p) => p.sector === datos.sector || (datos.puesto && p.puesto.toLowerCase().includes(String(datos.puesto).toLowerCase().split(" ")[0]))
  );
  const bloquePlacements = relevantes.length
    ? `\n\nPLACEMENTS REALES DE WELEAP (verdad verificada, úsalos como ancla prioritaria):\n${relevantes
        .map((p) => `- ${p.puesto} · ${p.sector} · ${p.ubicacion} · ${p.salario}€ brutos/año · cerrado en ${p.semanas_cierre} semanas`)
        .join("\n")}`
    : "";

  return `Analiza esta vacante para el mercado español:

PUESTO: ${datos.puesto}
SECTOR: ${datos.sector}
UBICACIÓN: ${datos.ubicacion}
SALARIO OFRECIDO: ${datos.salario || "No indicado"}
MODALIDAD: ${datos.modalidad || "No indicada"}

DESCRIPCIÓN DE LA VACANTE (JD):
${datos.jd ? datos.jd : "[No aportada — evalúa con los datos disponibles y márcalo en jd_aportado: false]"}${bloquePlacements}

Devuelve el informe JSON.`;
}

async function llamarClaude(modelo, mensajes, conBusqueda) {
  const body = {
    model: modelo,
    max_tokens: Number(process.env.MAX_TOKENS) || 4000,
    system: SYSTEM_PROMPT,
    messages: mensajes,
  };
  if (conBusqueda) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${err}`);
  }
  return resp.json();
}

function extraerTexto(data) {
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function sanearControlEnStrings(texto) {
  // Si el modelo mete un salto de línea/tab literal dentro de un valor string
  // (p.ej. en la reescritura del CV), JSON.parse falla porque no van escapados.
  // Recorremos el texto carácter a carácter y escapamos los caracteres de
  // control SOLO cuando estamos dentro de una cadena JSON.
  let resultado = "";
  let dentroString = false;
  let escapando = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    const code = texto.charCodeAt(i);
    if (escapando) {
      resultado += ch;
      escapando = false;
      continue;
    }
    if (ch === "\\" && dentroString) {
      resultado += ch;
      escapando = true;
      continue;
    }
    if (ch === '"') {
      dentroString = !dentroString;
      resultado += ch;
      continue;
    }
    if (dentroString && code < 0x20) {
      if (ch === "\n") resultado += "\\n";
      else if (ch === "\r") resultado += "\\r";
      else if (ch === "\t") resultado += "\\t";
      else resultado += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    resultado += ch;
  }
  return resultado;
}

function parsearJSON(texto) {
  const limpio = texto.replace(/```json|```/g, "").trim();
  // Busca el primer { y el último } por si el modelo añade algo alrededor
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio === -1 || fin === -1) throw new Error("Sin JSON en la respuesta");
  const bruto = limpio.slice(inicio, fin + 1);
  try {
    return JSON.parse(bruto);
  } catch (e) {
    // Reintento saneando caracteres de control dentro de strings (saltos de línea sin escapar, etc.)
    return JSON.parse(sanearControlEnStrings(bruto));
  }
}

async function enviarLeadWebhook(lead, informe, modeloUsado) {
  const url = process.env.LEADS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origen: "radar-vacante",
        timestamp: new Date().toISOString(),
        lead,
        vacante: {
          puesto: lead.puesto,
          sector: lead.sector,
          ubicacion: lead.ubicacion,
          salario: lead.salario,
        },
        informe,
        modelo: modeloUsado,
      }),
    });
  } catch (e) {
    // El webhook nunca debe romper la respuesta al usuario
    console.error("Webhook leads falló:", e.message);
  }
}

// ---- Límite diario (3 informes/día por email o por IP) vía Vercel KV ----
// Usa la API REST de Vercel KV directamente con fetch, sin dependencias npm.
// Si no hay KV configurado, no limita (para no romper la app si aún no lo has montado),
// pero deja aviso en logs — recuerda configurarlo antes de publicar en LinkedIn.
async function incrementarYComprobar(clave, ttlSegundos) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn("KV no configurado: el límite diario está DESACTIVADO. Configura KV_REST_API_URL/TOKEN antes de publicar.");
    return { limitado: false, contador: 0, kvActivo: false };
  }
  try {
    const incrResp = await fetch(`${url}/incr/${encodeURIComponent(clave)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const incrData = await incrResp.json();
    const contador = Number(incrData.result) || 0;
    if (contador === 1) {
      // primera vez que se usa esta clave hoy: fija la expiración a 24h
      await fetch(`${url}/expire/${encodeURIComponent(clave)}/${ttlSegundos}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return { limitado: contador > LIMITE_DIARIO, contador, kvActivo: true };
  } catch (e) {
    console.error("Error consultando KV, dejando pasar la petición:", e.message);
    return { limitado: false, contador: 0, kvActivo: false };
  }
}

function obtenerIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "desconocida";
}

// Dominios desde los que se permite llamar a esta función.
// Al publicarse en LinkedIn como lead magnet público, restringimos el origen
// para que la API no pueda ser invocada masivamente desde cualquier web.
const ORIGENES_PERMITIDOS = [
  "https://weleapinternational.com",
  "https://www.weleapinternational.com",
  "https://analiza-vacante.vercel.app",
];

async function handler(req, res) {
  const origen = req.headers.origin || "";
  if (ORIGENES_PERMITIDOS.includes(origen)) {
    res.setHeader("Access-Control-Allow-Origin", origen);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  try {
    const d = req.body || {};

    // Honeypot: si el campo trampa viene relleno, es un bot. Respondemos
    // 200 con éxito falso para no darle pistas de que fue detectado, pero
    // no llamamos a la API (nos ahorramos el coste y el abuso).
    if (d.web_empresa && String(d.web_empresa).trim() !== "") {
      return res.status(200).json({
        informe: {
          veredicto: { titular: "Recibido", texto: "", nivel: "verde" },
          benchmark_salarial: {}, tiempo_cobertura: {}, escasez_talento: {},
          diagnostico_jd: {}, recomendaciones: [],
        },
        modelo: "n/a",
      });
    }

    // Validación mínima + límites de longitud (evita payloads abusivos)
    const obligatorios = ["puesto", "sector", "ubicacion", "nombre", "email", "empresa"];
    for (const campo of obligatorios) {
      if (!d[campo] || String(d[campo]).trim() === "") {
        return res.status(400).json({ error: `Falta el campo: ${campo}` });
      }
    }
    const limites = { puesto: 150, sector: 80, ubicacion: 100, salario: 60, modalidad: 40, empresa: 120, nombre: 100, email: 150, jd: 15000 };
    for (const [campo, max] of Object.entries(limites)) {
      if (String(d[campo] || "").length > max) {
        return res.status(400).json({ error: `El campo ${campo} supera el límite permitido.` });
      }
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email).trim())) {
      return res.status(400).json({ error: "El email no es válido." });
    }

    // Límite diario: máximo LIMITE_DIARIO informes por email y por IP en 24h.
    // Se comprueba ANTES de llamar a Claude para no gastar si ya está agotado.
    const hoy = new Date().toISOString().slice(0, 10);
    const ip = obtenerIP(req);
    const claveEmail = `radar:limite:email:${String(d.email).trim().toLowerCase()}:${hoy}`;
    const claveIp = `radar:limite:ip:${ip}:${hoy}`;
    const [limiteEmail, limiteIp] = await Promise.all([
      incrementarYComprobar(claveEmail, 86400),
      incrementarYComprobar(claveIp, 86400),
    ]);
    if (limiteEmail.limitado || limiteIp.limitado) {
      return res.status(429).json({
        error: `Has alcanzado el límite de ${LIMITE_DIARIO} informes gratuitos hoy. Vuelve mañana o escríbenos directamente a sergio@weleapinternational.com.`,
      });
    }

    const mensajes = [{ role: "user", content: construirPromptUsuario(d) }];
    const conBusqueda = process.env.ENABLE_WEB_SEARCH !== "false"; // activa por defecto

    let data;
    let modeloUsado = MODEL;
    try {
      data = await llamarClaude(MODEL, mensajes, conBusqueda);
      // Fable 5 puede devolver stop_reason "refusal" si salta un clasificador.
      // En ese caso reintentamos con el modelo de respaldo.
      if (data.stop_reason === "refusal") {
        modeloUsado = FALLBACK_MODEL;
        data = await llamarClaude(FALLBACK_MODEL, mensajes, conBusqueda);
      }
    } catch (e) {
      // Si el modelo principal falla (p.ej. sin acceso a Fable), respaldo automático
      modeloUsado = FALLBACK_MODEL;
      data = await llamarClaude(FALLBACK_MODEL, mensajes, conBusqueda);
    }

    const informe = parsearJSON(extraerTexto(data));

    // Enviar lead a n8n (no bloqueante para el usuario)
    await enviarLeadWebhook(
      {
        nombre: d.nombre,
        email: d.email,
        empresa: d.empresa,
        puesto: d.puesto,
        sector: d.sector,
        ubicacion: d.ubicacion,
        salario: d.salario || null,
      },
      informe,
      modeloUsado
    );

    return res.status(200).json({ informe, modelo: modeloUsado });
  } catch (e) {
    console.error("Error en /api/analizar:", e);
    return res.status(500).json({
      error: "No hemos podido generar el informe. Inténtalo de nuevo en unos segundos.",
    });
  }
}

// Sube el límite de ejecución (por defecto 10s en plan Hobby) para dar
// margen a la búsqueda web de guías salariales, que puede tardar 15-30s.
// En plan Hobby el máximo permitido es 60s.
module.exports = handler;
module.exports.config = { maxDuration: 60 };
