// /api/analizar.js — Radar de Vacante (weleap)
// Función serverless para Vercel. Node 18+, sin dependencias externas (usa fetch nativo).
//
// Variables de entorno necesarias en Vercel:
//   ANTHROPIC_API_KEY   -> tu API key de Anthropic (obligatoria)
//   CLAUDE_MODEL        -> opcional, por defecto "claude-sonnet-5"
//   FALLBACK_MODEL      -> opcional, por defecto "claude-opus-4-8"
//   LEADS_WEBHOOK_URL   -> webhook de n8n. Si está configurado, cada lead recibe un email personalizado con el PDF adjunto (ver sección "Email automático" en el README). Si no está, el lead solo se guarda en Redis, sin email.
//   ENABLE_WEB_SEARCH   -> opcional, "false" para desactivar la búsqueda de guías salariales (activa por defecto, es la base del benchmark real)
//   MAX_TOKENS          -> opcional, por defecto 5000 (subido porque la búsqueda web y la comparativa internacional consumen turnos extra)
//   KV_REST_API_URL     -> URL de Vercel KV (Storage → Create Database → KV). Necesaria para el límite de 3 informes/día.
//   KV_REST_API_TOKEN   -> Token de Vercel KV. Si no está configurado, el límite queda desactivado (no rompe la app, pero no protege el gasto).
//   LIMITE_DIARIO_EMAIL -> opcional, por defecto 3 (informes máximos por email al día — control fino real)
//   LIMITE_DIARIO_IP    -> opcional, por defecto 15 (informes máximos por IP al día — más alto para no penalizar oficinas con IP compartida)
//   DOMINIOS_SIN_LIMITE -> opcional, por defecto "weleapinternational.com" (dominios de email exentos del límite diario, separados por coma)
//   ADMIN_SECRET        -> contraseña para consultar los leads guardados vía /api/leads (obligatoria si quieres usar ese endpoint)

const { generarPDFBuffer } = require("../lib/pdf.js");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "claude-opus-4-8";
const LIMITE_DIARIO_EMAIL = Number(process.env.LIMITE_DIARIO_EMAIL) || 3;
const LIMITE_DIARIO_IP = Number(process.env.LIMITE_DIARIO_IP) || 15;
// Dominios de email exentos del límite diario (para pruebas internas sin restricción).
// Añade más separándolos por coma en la env var, ej: "weleapinternational.com,otraempresa.com"
const DOMINIOS_SIN_LIMITE = (process.env.DOMINIOS_SIN_LIMITE || "weleapinternational.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

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
7. LÍMITE DE BÚSQUEDAS: no hagas más de 8 búsquedas web en total para todo el informe (incluyendo la comparativa internacional de abajo). Agrupa: una búsqueda tipo "salario [puesto] Europa 2026" o "talent shortage [puesto] international" puede darte datos de varios países a la vez — prefiere eso a una búsqueda por país.

Analiza teniendo en cuenta:
1. BENCHMARK SALARIAL: rango de mercado en España para ese puesto, sector y ubicación (ajusta por ciudad: Madrid/Barcelona vs resto), calculado como media ponderada de las guías salariales públicas que hayas consultado por búsqueda web. Si el salario ofrecido está por debajo de mercado, dilo sin rodeos.
2. TIEMPO DE COBERTURA: semanas realistas para cubrir la posición según escasez del perfil, atractivo de la oferta y ubicación.
3. ESCASEZ DE TALENTO: índice 0-100 (100 = casi imposible de encontrar). Considera cuántos profesionales con ese perfil existen en España, cuántos están en búsqueda activa vs pasiva, y competencia por ellos.
4. DIAGNÓSTICO DEL JOB DESCRIPTION: puntuación 0-10. Los mejores JD son skills-based (habilidades demostrables) en vez de títulos + años de experiencia. Penaliza: listas interminables de requisitos, "unicornios" (perfiles que no existen), jerga interna, ausencia de rango salarial, cero propuesta de valor al candidato. Si no aportan JD, evalúa con lo que tengas y márcalo.
5. VEREDICTO: un titular provocador estilo weleap que resuma la situación real de esta vacante en el mercado. Ejemplos de tono: "Buscáis un unicornio con sueldo de poni", "Vacante bien planteada, pero llegáis tarde: ese perfil ya lo están cazando otros tres", "Con este salario en Asturias, prepárate para 5 meses de búsqueda".
6. COMPARATIVA INTERNACIONAL: weleap opera en 8 países, así que esto es una ventaja real frente a un headhunter local. Elige los 4-5 países MÁS RELEVANTES para este sector/puesto concreto (considera: dónde hay más concentración de esa industria, dónde weleap tiene más actividad, mercados limítrofes obvios). Incluye siempre España como referencia aunque no sea el país más fácil. Para cada país, busca en la web (agrupando países en la misma búsqueda cuando puedas, respetando el límite de 8 búsquedas totales) y estima un índice de disponibilidad de talento 0-100 (100 = talento abundante y fácil de encontrar, 0 = extremadamente escaso). Ordena de más fácil a más difícil. Si el puesto/sector no tiene sentido fuera de España (ej. muy regulatorio/local), dilo y limita la comparativa a España + 1-2 países limítrofes con nota aclaratoria.

REGLAS DE SALIDA:
- Responde ÚNICAMENTE con un objeto JSON válido, sin markdown, sin backticks, sin texto antes o después.
- Todos los textos en español de España.
- Los salarios en euros brutos anuales.
- Sé específico con números, nunca vago.
- Tu respuesta final DEBE ser una llamada a la herramienta "entregar_informe" con todos los campos completos. No respondas con texto libre en ningún momento: investiga con web_search todo lo que necesites, y cuando tengas todo, entrega el resultado únicamente a través de esa herramienta.`;

const HERRAMIENTA_INFORME = {
  name: "entregar_informe",
  description: "Entrega el informe final estructurado del Radar de Vacante. Llama a esta herramienta una única vez, como tu respuesta final, después de haber investigado con web_search todo lo necesario.",
  input_schema: {
    type: "object",
    properties: {
      veredicto: {
        type: "object",
        properties: {
          titular: { type: "string", description: "Máx 90 caracteres, provocador, estilo weleap" },
          texto: { type: "string", description: "2-3 frases que expliquen la situación real" },
          nivel: { type: "string", enum: ["verde", "ambar", "rojo"] },
        },
        required: ["titular", "texto", "nivel"],
      },
      benchmark_salarial: {
        type: "object",
        properties: {
          rango_mercado_min: { type: "number" },
          rango_mercado_max: { type: "number" },
          posicion_oferta: { type: "string", enum: ["por_debajo", "en_linea", "por_encima", "no_indicado"] },
          comentario: { type: "string" },
          fuentes_consultadas: { type: "array", items: { type: "string" }, description: "Nombres de las guías realmente consultadas, máx 5" },
        },
        required: ["rango_mercado_min", "rango_mercado_max", "posicion_oferta", "comentario", "fuentes_consultadas"],
      },
      tiempo_cobertura: {
        type: "object",
        properties: {
          semanas_min: { type: "number" },
          semanas_max: { type: "number" },
          comentario: { type: "string" },
        },
        required: ["semanas_min", "semanas_max", "comentario"],
      },
      escasez_talento: {
        type: "object",
        properties: {
          indice: { type: "number", description: "0-100" },
          nivel: { type: "string", enum: ["baja", "media", "alta", "critica"] },
          candidatos_estimados: { type: "string" },
          comentario: { type: "string" },
        },
        required: ["indice", "nivel", "candidatos_estimados", "comentario"],
      },
      diagnostico_jd: {
        type: "object",
        properties: {
          puntuacion: { type: "number", description: "0-10" },
          jd_aportado: { type: "boolean" },
          problemas: { type: "array", items: { type: "string" }, description: "Máx 4, los más graves" },
          version_mejorada: { type: "string", description: "Reescritura skills-based del titular + 4-6 requisitos clave, con saltos de línea reales (aquí SÍ puedes usarlos, es un campo de herramienta, no JSON de texto)" },
          comentario: { type: "string" },
        },
        required: ["puntuacion", "jd_aportado", "problemas", "version_mejorada", "comentario"],
      },
      recomendaciones: { type: "array", items: { type: "string" }, description: "3 acciones concretas y accionables" },
      comparativa_internacional: {
        type: "object",
        properties: {
          paises: {
            type: "array",
            description: "4-5 países ordenados de más fácil a más difícil, España siempre incluida",
            items: {
              type: "object",
              properties: {
                pais: { type: "string" },
                indice_disponibilidad: { type: "number", description: "0-100, 100 = talento abundante y fácil" },
                nivel: { type: "string", enum: ["facil", "media", "dificil", "muy_dificil"] },
                comentario: { type: "string" },
              },
              required: ["pais", "indice_disponibilidad", "nivel", "comentario"],
            },
          },
          conclusion: { type: "string", description: "Lectura estratégica: dónde buscaría weleap si el cliente está abierto a otros mercados" },
        },
        required: ["paises", "conclusion"],
      },
      email_personalizado: {
        type: "object",
        properties: {
          asunto: { type: "string", description: "Máx 70 caracteres, específico de esta vacante, no genérico" },
          cuerpo: { type: "string", description: "3-4 frases en tono weleap, dirigido a la persona por su nombre, destacando el hallazgo más interesante del análisis, cerrando con invitación a responder o hablar con weleap" },
        },
        required: ["asunto", "cuerpo"],
      },
    },
    required: ["veredicto", "benchmark_salarial", "tiempo_cobertura", "escasez_talento", "diagnostico_jd", "recomendaciones", "comparativa_internacional", "email_personalizado"],
  },
};

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
    max_tokens: Number(process.env.MAX_TOKENS) || 5000,
    system: SYSTEM_PROMPT,
    messages: mensajes,
    tools: conBusqueda
      ? [{ type: "web_search_20250305", name: "web_search" }, HERRAMIENTA_INFORME]
      : [HERRAMIENTA_INFORME],
    // "auto" y no forzado: así el modelo puede investigar con web_search primero
    // y entregar el resultado con la herramienta al final, en vez de forzarla desde el turno 1.
    tool_choice: { type: "auto" },
  };

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

// Busca el bloque tool_use de "entregar_informe" en la respuesta — su "input" ya
// viene como objeto validado por la API, sin necesidad de parsear texto nunca.
function extraerInformeDeToolUse(data) {
  const bloque = (data.content || []).find((b) => b.type === "tool_use" && b.name === "entregar_informe");
  if (bloque && bloque.input) return bloque.input;
  return null;
}

function extraerTexto(data) {
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function repararJSON(texto) {
  // El modelo a veces mete un salto de línea/tab sin escapar, o cita una palabra
  // entre comillas dobles dentro de un valor string (rompiendo el JSON en ambos casos).
  // Recorremos el texto carácter a carácter arreglando ambos problemas SOLO dentro
  // de cadenas, sin tocar nada que ya sea JSON válido.
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
      if (!dentroString) {
        dentroString = true;
        resultado += ch;
        continue;
      }
      // Dentro de un string: ¿es el cierre legítimo o una comilla suelta en el texto?
      let j = i + 1;
      while (j < texto.length && /\s/.test(texto[j])) j++;
      const siguiente = texto[j];
      const pareceCierre = siguiente === undefined || [",", "}", "]", ":"].includes(siguiente);
      if (pareceCierre) {
        dentroString = false;
        resultado += ch;
      } else {
        resultado += '\\"'; // comilla suelta dentro del texto: la escapamos
      }
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
    // Reintento reparando comillas sueltas y saltos de línea sin escapar
    return JSON.parse(repararJSON(bruto));
  }
}

async function enviarLeadWebhook(lead, informe, modeloUsado, datosVacante) {
  const url = process.env.LEADS_WEBHOOK_URL;
  if (!url) return;
  try {
    // Genera el PDF aquí, justo antes de mandarlo — si falla, el lead y el
    // informe igualmente llegan a n8n (sin adjunto) en vez de perderse todo.
    let pdfBase64 = null;
    try {
      const buffer = generarPDFBuffer(informe, datosVacante);
      pdfBase64 = buffer.toString("base64");
    } catch (e) {
      console.error("No se pudo generar el PDF para el email:", e.message);
    }

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
        email_personalizado: informe.email_personalizado || null,
        pdf_base64: pdfBase64,
        pdf_nombre_archivo: "radar-vacante-" + (lead.puesto || "informe").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) + ".pdf",
      }),
    });
  } catch (e) {
    // El webhook nunca debe romper la respuesta al usuario
    console.error("Webhook leads falló:", e.message);
  }
}

// Guarda cada lead en Redis (misma base de datos Upstash que el límite diario).
// Se almacena en una lista ("radar:leads") como JSON, más reciente primero.
// Consulta los leads guardados vía /api/leads?secret=TU_ADMIN_SECRET
async function guardarLeadEnRedis(payload) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn("KV no configurado: el lead NO se ha guardado. Configura KV_REST_API_URL/TOKEN.");
    return;
  }
  try {
    await fetch(`${url}/lpush/radar:leads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Guardar el lead nunca debe romper la respuesta al usuario
    console.error("Error guardando lead en Redis:", e.message);
  }
}

// ---- Límite diario (3 informes/día por email o por IP) vía Vercel KV ----
// Usa la API REST de Vercel KV directamente con fetch, sin dependencias npm.
// Si no hay KV configurado, no limita (para no romper la app si aún no lo has montado),
// pero deja aviso en logs — recuerda configurarlo antes de publicar en LinkedIn.
async function incrementarYComprobar(clave, ttlSegundos, tope) {
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
    return { limitado: contador > tope, contador, kvActivo: true };
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

    // Límite diario: email tiene un tope estricto (LIMITE_DIARIO_EMAIL), la IP uno
    // más permisivo (LIMITE_DIARIO_IP) para no penalizar oficinas con IP compartida.
    // Los dominios internos (DOMINIOS_SIN_LIMITE) quedan exentos, para poder probar sin restricción.
    // Se comprueba ANTES de llamar a Claude para no gastar si ya está agotado.
    const dominioEmail = String(d.email).trim().toLowerCase().split("@")[1] || "";
    const esInterno = DOMINIOS_SIN_LIMITE.includes(dominioEmail);

    if (!esInterno) {
      const hoy = new Date().toISOString().slice(0, 10);
      const ip = obtenerIP(req);
      const claveEmail = `radar:limite:email:${String(d.email).trim().toLowerCase()}:${hoy}`;
      const claveIp = `radar:limite:ip:${ip}:${hoy}`;
      const [limiteEmail, limiteIp] = await Promise.all([
        incrementarYComprobar(claveEmail, 86400, LIMITE_DIARIO_EMAIL),
        incrementarYComprobar(claveIp, 86400, LIMITE_DIARIO_IP),
      ]);
      if (limiteEmail.limitado) {
        return res.status(429).json({
          error: `Ya has generado ${LIMITE_DIARIO_EMAIL} informes hoy con este email (contador: ${limiteEmail.contador}). Vuelve mañana o escríbenos directamente a sergio@weleapinternational.com.`,
        });
      }
      if (limiteIp.limitado) {
        return res.status(429).json({
          error: `Se ha alcanzado el límite de informes gratuitos hoy desde esta red (contador: ${limiteIp.contador}). Vuelve mañana o escríbenos directamente a sergio@weleapinternational.com.`,
        });
      }
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

    // Vía principal: el informe llega ya estructurado y validado en el tool_use.
    // Red de seguridad: si por lo que sea el modelo respondiera en texto libre
    // (no debería, pero por si acaso), intentamos parsear igual que antes.
    let informe = extraerInformeDeToolUse(data);
    if (!informe) {
      informe = parsearJSON(extraerTexto(data));
    }

    const leadInfo = {
      nombre: d.nombre,
      email: d.email,
      empresa: d.empresa,
      puesto: d.puesto,
      sector: d.sector,
      ubicacion: d.ubicacion,
      salario: d.salario || null,
    };

    // Guardar el lead en Redis (siempre) y, si está configurado, mandarlo también a n8n.
    // Ninguno de los dos bloquea ni rompe la respuesta al usuario si falla.
    await guardarLeadEnRedis({
      origen: "radar-vacante",
      timestamp: new Date().toISOString(),
      lead: leadInfo,
      vacante: {
        puesto: leadInfo.puesto,
        sector: leadInfo.sector,
        ubicacion: leadInfo.ubicacion,
        salario: leadInfo.salario,
      },
      informe,
      modelo: modeloUsado,
    });
    await enviarLeadWebhook(leadInfo, informe, modeloUsado, d);

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
