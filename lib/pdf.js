// /lib/pdf.js — Genera el PDF del Radar de Vacante en el servidor (Node),
// con el mismo diseño que la versión que se descarga desde el navegador.
// Se usa para adjuntarlo al email personalizado que se envía al lead.
//
// IMPORTANTE: si cambias el diseño del PDF en index.html (función generarPDF),
// replica el mismo cambio aquí para que la versión descargada y la enviada por
// email no queden desincronizadas.

function generarPDFBuffer(inf, datos) {
  const { jsPDF } = require("jspdf");
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PAGE_W = 210;
  const MARGIN = 18;
  const COL_W = PAGE_W - MARGIN * 2;
  const INK = [19, 0, 48];      // #130030
  const ACCENT = [255, 0, 104]; // #FF0068
  const GRIS = [92, 84, 112];
  let y = 0;

  const salto = (alturaNecesaria) => {
    if (y + alturaNecesaria > 285) { doc.addPage(); cabeceraPagina(); }
  };
  const cabeceraPagina = () => {
    doc.setFillColor(...INK);
    doc.rect(0, 0, PAGE_W, 16, 'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.text('weleap', MARGIN, 10.5);
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    doc.setTextColor(220,214,232);
    doc.text('Radar de Vacante', PAGE_W - MARGIN, 10.5, { align: 'right' });
    y = 26;
  };
  const titulo = (texto) => {
    salto(14);
    doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.setTextColor(...INK);
    doc.text(texto.toUpperCase(), MARGIN, y);
    doc.setDrawColor(...ACCENT); doc.setLineWidth(0.6);
    doc.line(MARGIN, y+1.5, MARGIN+10, y+1.5);
    y += 8;
  };
  const parrafo = (texto, opts={}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size || 10);
    doc.setTextColor(...(opts.color || GRIS));
    const lineas = doc.splitTextToSize(String(texto || ''), COL_W);
    salto(lineas.length * 5 + 2);
    doc.text(lineas, MARGIN, y);
    y += lineas.length * 5 + (opts.espacio ?? 4);
  };

  cabeceraPagina();

  doc.setFont('helvetica','bold'); doc.setFontSize(17);
  doc.setTextColor(...INK);
  const tituloLineas = doc.splitTextToSize(datos.puesto || 'Vacante', COL_W);
  doc.text(tituloLineas, MARGIN, y);
  y += tituloLineas.length * 7 + 2;
  doc.setFont('helvetica','normal'); doc.setFontSize(10);
  doc.setTextColor(...GRIS);
  doc.text(`${datos.ubicacion || ''} · ${datos.sector || ''} · ${new Date().toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})}`, MARGIN, y);
  y += 10;

  const v = inf.veredicto || {};
  doc.setFillColor(245, 243, 249);
  const vLineasTxt = doc.splitTextToSize(v.texto || '', COL_W - 10);
  const vAltura = 10 + (v.titular ? 7 : 0) + vLineasTxt.length * 5 + 6;
  salto(vAltura);
  doc.roundedRect(MARGIN, y, COL_W, vAltura, 2, 2, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(9);
  doc.setTextColor(...ACCENT);
  doc.text('VEREDICTO', MARGIN + 5, y + 6);
  doc.setFont('helvetica','bold'); doc.setFontSize(12);
  doc.setTextColor(...INK);
  const vTitLineas = doc.splitTextToSize(v.titular || '', COL_W - 10);
  doc.text(vTitLineas, MARGIN + 5, y + 13);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
  doc.setTextColor(...GRIS);
  doc.text(vLineasTxt, MARGIN + 5, y + 13 + vTitLineas.length * 5.5 + 3);
  y += vAltura + 8;

  const b = inf.benchmark_salarial || {};
  titulo('Benchmark salarial');
  if (b.rango_mercado_min && b.rango_mercado_max) {
    parrafo(`${b.rango_mercado_min.toLocaleString('es-ES')}€ – ${b.rango_mercado_max.toLocaleString('es-ES')}€ brutos/año`, { bold:true, size:13, color: INK, espacio: 3 });
  }
  parrafo(b.comentario || '', { espacio: 2 });
  if (Array.isArray(b.fuentes_consultadas) && b.fuentes_consultadas.length) {
    parrafo('Fuentes cruzadas: ' + b.fuentes_consultadas.join(' · '), { size: 8.5, color: ACCENT, espacio: 6 });
  }

  const t = inf.tiempo_cobertura || {};
  titulo('Tiempo estimado de cobertura');
  if (t.semanas_min && t.semanas_max) {
    parrafo(`${t.semanas_min}–${t.semanas_max} semanas`, { bold:true, size:13, color: INK, espacio: 3 });
  }
  parrafo(t.comentario || '', { espacio: 6 });

  const es = inf.escasez_talento || {};
  titulo('Escasez de talento');
  parrafo(`Índice ${es.indice ?? '—'}/100 · Nivel: ${es.nivel || '—'}`, { bold:true, size:11, color: INK, espacio: 3 });
  if (es.candidatos_estimados) parrafo(es.candidatos_estimados, { size: 9, espacio: 2 });
  parrafo(es.comentario || '', { espacio: 6 });

  const j = inf.diagnostico_jd || {};
  titulo('Diagnóstico del job description');
  parrafo(`Puntuación: ${j.puntuacion ?? '—'}/10`, { bold:true, size:11, color: INK, espacio: 3 });
  if (Array.isArray(j.problemas) && j.problemas.length) {
    j.problemas.forEach(p => parrafo('X ' + p, { size: 9.5, espacio: 2 }));
  }
  if (j.version_mejorada) {
    y += 2;
    parrafo('Versión skills-based sugerida:', { bold: true, size: 9.5, color: INK, espacio: 2 });
    parrafo(j.version_mejorada, { size: 9, espacio: 6 });
  }

  titulo('Acciones recomendadas');
  (inf.recomendaciones || []).forEach(r => parrafo('> ' + r, { size: 9.5, espacio: 3 }));

  const comp = inf.comparativa_internacional || {};
  const paisesPdf = Array.isArray(comp.paises) ? comp.paises : [];
  if (paisesPdf.length) {
    titulo('Comparativa internacional: dónde es más fácil encontrar este perfil');
    const nivelColorPdf = { facil: [47,191,113], media: [255,176,32], dificil: [230,57,80], muy_dificil: [230,57,80] };
    paisesPdf.forEach(p => {
      const idx = Math.max(0, Math.min(100, Number(p.indice_disponibilidad) || 0));
      const color = nivelColorPdf[p.nivel] || GRIS;
      salto(14);
      doc.setFont('helvetica','bold'); doc.setFontSize(10);
      doc.setTextColor(...INK);
      doc.text(String(p.pais || ''), MARGIN, y);
      doc.setFont('helvetica','bold'); doc.setFontSize(10);
      doc.setTextColor(...color);
      doc.text(String(idx), PAGE_W - MARGIN, y, { align: 'right' });
      y += 4;
      doc.setFillColor(230,226,238);
      doc.roundedRect(MARGIN, y, COL_W, 2.5, 1, 1, 'F');
      doc.setFillColor(...color);
      doc.roundedRect(MARGIN, y, COL_W * (idx / 100), 2.5, 1, 1, 'F');
      y += 6;
      parrafo(p.comentario || '', { size: 8.5, espacio: 5 });
    });
    if (comp.conclusion) {
      y += 2;
      parrafo(comp.conclusion, { size: 9, bold: true, color: INK, espacio: 6 });
    }
  }

  salto(16);
  y += 4;
  doc.setDrawColor(220,214,232); doc.setLineWidth(0.3);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;
  doc.setFont('helvetica','normal'); doc.setFontSize(8);
  doc.setTextColor(...GRIS);
  doc.text('Estimaciones generadas con IA a partir de fuentes públicas y criterio de weleapHUNT. Para datos verificados de candidatos reales, contacta con sergio@weleapinternational.com', MARGIN, y, { maxWidth: COL_W });

  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { generarPDFBuffer };
