// /api/analizar.js — Radar de Vacante (weleap)
// Función serverless para Vercel. Node 18+, sin dependencias.
//
// Variables de entorno necesarias en Vercel:
//   ANTHROPIC_API_KEY   -> tu API key de Anthropic (obligatoria)
//   CLAUDE_MODEL        -> opcional, por defecto "claude-fable-5"
//   FALLBACK_MODEL      -> opcional, por defecto "claude-opus-4-8"
//   LEADS_WEBHOOK_URL   -> opcional, webhook de n8n para recibir cada lead + informe
//   ENABLE_WEB_SEARCH   -> opcional, "false" para desactivar la búsqueda de guías salariales (activa por defecto, es la base del benchmark real)
//   MAX_TOKENS          -> opcional, por defecto 4000 (subido porque la búsqueda web consume turnos extra)

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "claude-opus-4-8";

const SYSTEM_PROMPT = `Eres el motor de análisis de "Radar de Vacante", una herramienta de weleap, firma boutique de executive search en España especializada en logística, ingeniería, energía, farma y data centers.

Tu trabajo: analizar una vacante como lo haría un headhunter senior con 20 años de mercado español, y devolver un informe honesto, directo y con criterio. El tono de weleap es provocador y sin lenguaje corporativo vacío: di las cosas claras, con datos y sin edulcorar, pero siempre profesional y útil.

Tienes acceso a búsqueda web. ÚSALA SIEMPRE para el benchmark salarial, en este orden:
1. Busca el dato en al menos 3 de estas fuentes públicas (ajusta los términos de búsqueda al puesto, sector y España): "Hays Guía del Mercado Laboral España", "Michael Page Estudio de Remuneración España", "Robert Half Salary Guide España", "Randstad informe salarial España", "Adecco Guía Salarial España", "PageGroup salary guide Spain".
2. Extrae el rango salarial que cada fuente da para el puesto (o el más cercano equivalente por seniority y función si no hay coincidencia exacta).
3. Calcula una MEDIA PONDERADA de los rangos encontrados, dando más peso a las fuentes con datos más específicos para ese sector/puesto y descartando outliers claramente desalineados.
4. Si una fuente no cubre el sector o el puesto es muy nicho, indícalo y extrapola desde el perfil de seniority/función más cercano, dejándolo claro en el comentario.
5. Nunca reproduzcas texto literal de las guías: sintetiza solo las cifras y tu propia interpretación.
6. Registra en "fuentes_consultadas" qué guías lograste consultar realmente (no las que ibas a consultar).

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
  return `Analiza esta vacante para el mercado español:

PUESTO: ${datos.puesto}
SECTOR: ${datos.sector}
UBICACIÓN: ${datos.ubicacion}
SALARIO OFRECIDO: ${datos.salario || "No indicado"}
MODALIDAD: ${datos.modalidad || "No indicada"}

DESCRIPCIÓN DE LA VACANTE (JD):
${datos.jd ? datos.jd : "[No aportada — evalúa con los datos disponibles y márcalo en jd_aportado: false]"}

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

function parsearJSON(texto) {
  const limpio = texto.replace(/```json|```/g, "").trim();
  // Busca el primer { y el último } por si el modelo añade algo alrededor
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio === -1 || fin === -1) throw new Error("Sin JSON en la respuesta");
  return JSON.parse(limpio.slice(inicio, fin + 1));
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

async function handler(req, res) {
  // CORS básico por si sirves el front desde otro dominio
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  try {
    const d = req.body || {};

    // Validación mínima
    const obligatorios = ["puesto", "sector", "ubicacion", "nombre", "email", "empresa"];
    for (const campo of obligatorios) {
      if (!d[campo] || String(d[campo]).trim() === "") {
        return res.status(400).json({ error: `Falta el campo: ${campo}` });
      }
    }
    if (String(d.jd || "").length > 15000) {
      return res.status(400).json({ error: "La descripción es demasiado larga (máx. 15.000 caracteres)" });
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
