// /api/leads.js — Consulta de leads guardados por el Radar de Vacante
// Uso: https://tu-dominio.vercel.app/api/leads?secret=TU_ADMIN_SECRET
//      Añade &format=csv para descargarlo como CSV (listo para abrir en Excel/Sheets)
//
// Variables de entorno necesarias:
//   ADMIN_SECRET        -> contraseña que tú eliges para proteger este endpoint (obligatoria)
//   KV_REST_API_URL / KV_REST_API_TOKEN -> las mismas que usa api/analizar.js

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Método no permitido" });

  const secretoConfigurado = process.env.ADMIN_SECRET;
  if (!secretoConfigurado) {
    return res.status(500).json({ error: "ADMIN_SECRET no configurado en Vercel. Añádelo antes de usar este endpoint." });
  }
  if (req.query.secret !== secretoConfigurado) {
    return res.status(401).json({ error: "No autorizado." });
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return res.status(500).json({ error: "KV no configurado." });
  }

  try {
    const resp = await fetch(`${url}/lrange/radar:leads/0/-1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    const crudos = data.result || [];
    const leads = crudos.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return { raw: s };
      }
    });

    if (req.query.format === "csv") {
      const cabecera = ["fecha", "nombre", "email", "empresa", "puesto", "sector", "ubicacion", "salario", "veredicto", "escasez_indice", "modelo"];
      const filas = leads.map((l) => [
        l.timestamp || "",
        l.lead?.nombre || "",
        l.lead?.email || "",
        l.lead?.empresa || "",
        l.vacante?.puesto || "",
        l.vacante?.sector || "",
        l.vacante?.ubicacion || "",
        l.vacante?.salario || "",
        l.informe?.veredicto?.nivel || "",
        l.informe?.escasez_talento?.indice ?? "",
        l.modelo || "",
      ]);
      const csv = [cabecera, ...filas]
        .map((fila) => fila.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=leads-radar-vacante.csv");
      return res.status(200).send(csv);
    }

    return res.status(200).json({ total: leads.length, leads });
  } catch (e) {
    console.error("Error leyendo leads:", e.message);
    return res.status(500).json({ error: "Error leyendo los leads." });
  }
};
