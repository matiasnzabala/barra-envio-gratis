const express = require("express");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- CORS (widget.js y /config se llaman desde el dominio de la tienda) ----
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const {
  TN_CLIENT_ID,
  TN_CLIENT_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  APP_URL, // https://barra.hacecrecertutienda.com
  TRIAL_DIAS = "7",
  MP_PREAPPROVAL_PLAN_ID = "69232628e4754d9a8b484df4257f45fb",
  PORT = 3000,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------------- Helpers cookie firmada (mismo patrón que Ruleta/Aviso Stock) ----------------
function firmar(storeId) {
  const h = crypto.createHmac("sha256", TN_CLIENT_SECRET).update(String(storeId)).digest("hex");
  return `${storeId}.${h}`;
}
function verificarCookie(req, storeId) {
  const val = req.cookies?.tn_session;
  if (!val) return false;
  return val === firmar(storeId);
}

// ---------------- OAuth callback ----------------
app.get("/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Falta code");

    const tokenResp = await fetch("https://developers.tiendanegocio.com/v1/oauth/app/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: TN_CLIENT_ID,
        client_secret: TN_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });
    const tokenJson = await tokenResp.json();
    const tokenData = tokenJson.data || tokenJson; // TN anida la respuesta en .data
    if (!tokenData.access_token) {
      console.error("Error token:", tokenJson);
      return res.status(500).send("No se pudo autenticar con Tienda Negocio");
    }

    const storeId = String(tokenData.store_id);
    if (!storeId || storeId === "undefined") {
      console.error("No vino store_id en el token:", tokenJson);
      return res.status(500).send("La respuesta de Tienda Negocio no trajo store_id");
    }
    const trialEnds = new Date(Date.now() + Number(TRIAL_DIAS) * 24 * 60 * 60 * 1000).toISOString();

    const { data: existente } = await supabase
      .from("barra_tiendas")
      .select("store_id")
      .eq("store_id", storeId)
      .maybeSingle();

    if (!existente) {
      await supabase.from("barra_tiendas").insert({
        store_id: storeId,
        access_token: tokenData.access_token,
        trial_ends_at: trialEnds,
        pago: false,
      });
    } else {
      await supabase.from("barra_tiendas").update({ access_token: tokenData.access_token }).eq("store_id", storeId);
    }

    res.cookie("tn_session", firmar(storeId), {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
    res.redirect(`/admin/${storeId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error interno");
  }
});

// ---------------- Admin (sin storeId: redirige usando cookie, para "Aplicaciones integradas") ----------------
app.get("/admin", (req, res) => {
  const val = req.cookies?.tn_session;
  if (!val) return res.status(401).send("No autenticado. Entrá desde el panel de Tienda Negocio.");
  const storeId = val.split(".")[0];
  res.redirect(`/admin/${storeId}`);
});

app.get("/admin/:storeId", async (req, res) => {
  const { storeId } = req.params;
  if (!verificarCookie(req, storeId)) {
    return res.status(401).send("No autorizado. Entrá desde el panel de Tienda Negocio.");
  }
  const { data: tienda } = await supabase.from("barra_tiendas").select("*").eq("store_id", storeId).maybeSingle();
  if (!tienda) return res.status(404).send("Tienda no encontrada");
  const vistas = await contarVistas(storeId);
  res.send(renderAdminHtml(tienda, vistas));
});

// ---------------- Guardar config ----------------
app.post("/api/config/:storeId", async (req, res) => {
  const { storeId } = req.params;
  if (!verificarCookie(req, storeId)) return res.status(401).json({ error: "No autorizado" });

  const { umbral, texto_falta, texto_listo, color_barra, color_fondo, activo } = req.body;
  const { error } = await supabase
    .from("barra_tiendas")
    .update({
      umbral: Number(umbral),
      texto_falta,
      texto_listo,
      color_barra,
      color_fondo,
      activo: !!activo,
    })
    .eq("store_id", storeId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------------- Config pública para el widget (con chequeo de trial/pago) ----------------
app.get("/config", async (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).json({ activo: false });

  const { data: tienda } = await supabase.from("barra_tiendas").select("*").eq("store_id", store_id).maybeSingle();
  if (!tienda) return res.json({ activo: false });

  const trialVigente = tienda.trial_ends_at && new Date(tienda.trial_ends_at) > new Date();
  const habilitado = tienda.activo && (tienda.pago || trialVigente);

  if (!habilitado) return res.json({ activo: false });

  res.json({
    activo: true,
    umbral: Number(tienda.umbral || 50000),
    texto_falta: tienda.texto_falta || "¡Te faltan {monto} para tu ENVÍO GRATIS! 🚚",
    texto_listo: tienda.texto_listo || "¡Felicitaciones! Tenés ENVÍO GRATIS 🎉",
    color_barra: tienda.color_barra || "#E8A33D",
    color_fondo: tienda.color_fondo || "#12201B",
  });
});

// ---------------- Estadísticas: vista de la barra (fire-and-forget) ----------------
app.options("/track", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(204).end();
});

app.post("/track", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(204).end();
  const { storeId, tipo } = req.body || {};
  if (!storeId || tipo !== "vista") return;
  const { error } = await supabase.from("barra_eventos").insert({ store_id: storeId, tipo });
  if (error) console.error("Error guardando evento:", error);
});

async function contarVistas(storeId) {
  const { count, error } = await supabase
    .from("barra_eventos").select("*", { count: "exact", head: true }).eq("store_id", storeId);
  if (error) { console.error("Error contando vistas:", error); return 0; }
  return count || 0;
}

// ---------------- widget.js ----------------
app.get("/widget.js", (req, res) => {
  res.type("application/javascript");
  res.send(WIDGET_JS(APP_URL));
});

app.get("/", (req, res) => res.send("Barra de Envío Gratis — OK"));

app.listen(PORT, () => console.log(`Barra Envío Gratis escuchando en ${PORT}`));

// ================= Banner trial/pago =================
function renderBannerTrialPago(t) {
  const linkPago = `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=${MP_PREAPPROVAL_PLAN_ID}&external_reference=barra:${t.store_id}`;
  if (t.pago) {
    return `<div class="banner banner--ok">✅ Suscripción activa. ¡Gracias por confiar en nosotros!</div>`;
  }
  const diasRestantes = t.trial_ends_at
    ? Math.ceil((new Date(t.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24))
    : 0;
  if (diasRestantes > 0) {
    return `<div class="banner banner--warn">
      ⏳ Te quedan <b>${diasRestantes} día${diasRestantes === 1 ? "" : "s"}</b> de prueba gratis.
      Para no perder la barra, activá tu suscripción acá: <a href="${linkPago}" target="_blank">Pagar suscripción</a>
    </div>`;
  }
  return `<div class="banner banner--off">
    🚫 Tu prueba gratis terminó y la barra está desactivada en tu tienda.
    Activá tu suscripción para reactivarla: <a href="${linkPago}" target="_blank">Pagar suscripción</a>
  </div>`;
}

// ================= Catálogo cruzado de apps =================
const APPS_CATALOGO = [
  {
    nombre: 'Ruleta WhatsApp',
    descripcion: 'Ruleta de premios para captar leads y dar cupones a cambio de un giro.',
    icono: '🎡',
  },
  {
    nombre: 'Raspadita',
    descripcion: 'Raspadita de premios para captar leads y dar cupones a cambio de jugar.',
    icono: '🎟️',
  },
  {
    nombre: 'Aviso de Stock',
    descripcion: 'Avisa por email a tus clientes cuando un producto agotado vuelve a tener stock.',
    icono: '📦',
  },
  {
    nombre: 'Caja Sorpresa',
    descripcion: 'Caja sorpresa de premios para captar leads y dar cupones a cambio de abrirla.',
    icono: '🎁',
  },
  {
    nombre: 'Popup Ventas',
    descripcion: 'Popup de compras recientes para generar confianza en tiempo real.',
    icono: '🛒',
  },
  {
    nombre: 'Popup de Salida',
    descripcion: 'Popup que detecta cuándo el visitante se va y le ofrece un cupón para que no abandone la tienda.',
    icono: '👋',
  },
  {
    nombre: 'Venta Inteligente',
    descripcion: 'Cross-sell y upsell automáticos para subir el ticket promedio.',
    icono: '🧠',
  },
  {
    nombre: 'Cuenta Regresiva',
    descripcion: 'Timer de urgencia para ofertas, que motiva a comprar antes de que se acabe el tiempo.',
    icono: '⏳',
  },
  {
    nombre: 'Tragamonedas',
    descripcion: 'Máquina tragamonedas de premios para captar leads y dar cupones al instante.',
    icono: '🎰',
  },
];

function generarAppsHTML() {
  const cards = APPS_CATALOGO.map((a) => `
      <a class="app-card" href="https://hacecrecertutienda.com" target="_blank" rel="noopener">
        <div class="app-icon">${a.icono}</div>
        <div class="app-info">
          <div class="app-top"><span class="app-name">${a.nombre}</span><span class="app-badge">Activa</span></div>
          <p class="app-desc">${a.descripcion}</p>
        </div>
      </a>`).join('');
  return `
<div class="section-label">Más herramientas para tu tienda</div>
<div class="apps-grid">${cards}</div>`;
}

// ================= HTML admin =================
function renderAdminHtml(t, vistas) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Barra de Envío Gratis</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#fdf9f0;--bg-alt:#f4f0e4;--pink:#ff3d81;--mint:#3ddc97;--canary:#ffd23f;--coral:#ff6b5e;--ink:#111111;--ink-dim:#5b5648;--card:#ffffff;--sh:4px 4px 0px 0px #111111}
  body{background:var(--bg);color:var(--ink);font-family:'Space Grotesk',sans-serif;font-weight:500;padding:32px;max-width:560px;margin:0 auto}
  h1{font-family:'Archivo Black',sans-serif;font-weight:400;text-transform:uppercase;font-size:1.4rem}
  .eyebrow{font-family:'Space Mono',monospace;text-transform:uppercase;letter-spacing:0.08em;font-size:0.72rem;color:var(--pink);font-weight:700;display:block;margin-bottom:6px}
  .status-hero{background:var(--card);border:2px solid var(--ink);border-radius:16px;box-shadow:var(--sh);padding:22px 24px;margin-bottom:16px}
  .status-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .status-hero-stats-label{font-family:'Space Mono',monospace;text-transform:uppercase;letter-spacing:0.08em;font-size:0.72rem;font-weight:700;color:var(--ink-dim);margin-top:20px}
  .status-hero-stats{display:flex;gap:12px;margin-top:8px;flex-wrap:wrap}
  .stat-tile{flex:1;min-width:100px;background:var(--bg);border:2px solid var(--ink);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
  .stat-num{font-family:'Archivo Black',sans-serif;font-size:1.6rem;line-height:1}
  .stat-label{font-family:'Space Mono',monospace;text-transform:uppercase;letter-spacing:0.06em;font-size:0.68rem;color:var(--ink-dim);font-weight:700}
  label{display:block;margin-top:16px;font-size:14px;font-weight:700;color:var(--ink-dim)}
  input[type=text],input[type=number]{width:100%;padding:10px;border-radius:8px;border:2px solid var(--ink);background:var(--card);color:var(--ink);margin-top:4px;box-sizing:border-box;font-family:'Space Grotesk',sans-serif;font-weight:600}
  input[type=text]:focus,input[type=number]:focus{outline:none;border-color:var(--pink)}
  input[type=color]{margin-top:4px;border:2px solid var(--ink);border-radius:8px}
  .switch-wrap{display:flex;align-items:center;gap:10px;cursor:pointer;background:var(--card);border:2px solid var(--ink);box-shadow:var(--sh);border-radius:999px;padding:10px 16px 10px 10px;flex:none;width:fit-content}
  .switch-wrap input{display:none}
  .switch-track{width:40px;height:22px;border-radius:999px;background:#e3ddc9;border:2px solid var(--ink);position:relative;transition:background .2s ease;flex:none}
  .switch-track::after{content:'';position:absolute;top:1px;left:1px;width:16px;height:16px;border-radius:50%;background:var(--ink);transition:transform .2s ease}
  .switch-wrap input:checked + .switch-track{background:var(--mint)}
  .switch-wrap input:checked + .switch-track::after{transform:translateX(18px)}
  .switch-label{font-size:0.88rem;font-weight:700;white-space:nowrap}
  button{margin-top:24px;width:100%;background:var(--pink);color:var(--ink);border:2px solid var(--ink);padding:15px 28px;border-radius:8px;font-weight:700;font-size:1rem;cursor:pointer;box-shadow:var(--sh);transition:transform .1s ease,box-shadow .1s ease;font-family:'Space Grotesk',sans-serif}
  button:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0px 0px var(--ink)}
  button:active{transform:translate(2px,2px);box-shadow:0px 0px 0px 0px var(--ink)}
  .toast{display:none;margin-top:12px;color:var(--ink);font-weight:700;background:var(--mint);border:2px solid var(--ink);border-radius:999px;padding:8px 16px;box-shadow:var(--sh)}
  .banner{padding:14px 16px;border-radius:14px;margin-bottom:20px;font-size:14px;line-height:1.5;border:2px solid var(--ink);box-shadow:var(--sh);font-weight:600}
  .banner--ok{background:var(--mint)}
  .banner--warn{background:var(--canary)}
  .banner--off{background:var(--coral)}
  .banner a{color:var(--ink);font-weight:700;text-decoration:underline}
  .banner .storeid{opacity:.75;font-family:'Space Mono',monospace;font-size:12px}
  .section-label{font-family:'Space Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-dim);margin-top:32px;margin-bottom:12px}
  .install-card{background:var(--card);border:2px solid var(--ink);box-shadow:var(--sh);border-radius:16px;padding:20px 24px}
  .install-text{color:var(--ink-dim);font-size:0.88rem;line-height:1.5;margin-bottom:14px;font-weight:500}
  .install-text code{background:var(--canary);padding:1px 5px;border-radius:4px;border:1px solid var(--ink);font-family:'Space Mono',monospace;font-size:0.82rem;color:var(--ink)}
  .code-box{display:flex;align-items:center;gap:10px;background:var(--bg-alt);border:2px solid var(--ink);border-radius:10px;padding:12px 14px}
  .code-box code{flex:1;font-family:'Space Mono',monospace;font-size:0.78rem;color:var(--ink);overflow-x:auto;white-space:nowrap}
  .btn-copy{flex:none;background:var(--pink);color:var(--ink);border:2px solid var(--ink);padding:8px 16px;border-radius:999px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:'Space Grotesk',sans-serif;box-shadow:var(--sh);transition:transform .1s ease,box-shadow .1s ease}
  .btn-copy:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0px 0px var(--ink)}
  .btn-copy:active{transform:translate(2px,2px);box-shadow:0px 0px 0px 0px var(--ink)}
  .apps-grid{display:grid;grid-template-columns:1fr;gap:12px}
  .app-card{display:flex;gap:14px;align-items:flex-start;background:var(--card);border:2px solid var(--ink);box-shadow:var(--sh);border-radius:16px;padding:16px 18px;text-decoration:none;color:var(--ink);transition:transform .12s ease,box-shadow .12s ease}
  .app-card:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0px 0px var(--ink)}
  .app-icon{font-size:1.5rem;line-height:1;flex:none;margin-top:2px}
  .app-info{flex:1;min-width:0}
  .app-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
  .app-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:1rem}
  .app-desc{color:var(--ink-dim);font-size:0.85rem;line-height:1.4;font-weight:500}
  .app-badge{font-family:'Space Mono',monospace;font-size:0.62rem;text-transform:uppercase;letter-spacing:.06em;padding:3px 9px;border-radius:999px;flex:none;border:1.5px solid var(--ink);font-weight:700;background:var(--mint);color:var(--ink)}
  .admin-footer{margin-top:36px;padding-top:20px;border-top:2px solid var(--ink);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px}
  .admin-footer .brand{font-family:'Space Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-dim)}
  .admin-footer .brand a{color:var(--ink);font-weight:700;text-decoration:underline}
  .admin-footer .soporte{display:inline-flex;align-items:center;gap:6px;background:var(--mint);color:var(--ink);border:2px solid var(--ink);padding:8px 16px;border-radius:999px;font-weight:700;font-size:13px;box-shadow:var(--sh);text-decoration:none;transition:transform .1s ease}
  .admin-footer .soporte:hover{transform:translate(-1px,-1px)}
</style></head>
<body>
${renderBannerTrialPago(t)}
<form id="f">
  <div class="status-hero">
    <div class="status-hero-top">
      <div>
        <span class="eyebrow">Barra Envío Gratis · Tienda ${t.store_id}</span>
        <h1>🚚 Barra de Envío Gratis</h1>
      </div>
      <label class="switch-wrap">
        <input type="checkbox" name="activo" ${t.activo !== false ? "checked" : ""} onchange="actualizarEstado(this)" />
        <span class="switch-track"></span>
        <span class="switch-label" id="switch-label-txt">${t.activo !== false ? "Barra activa" : "Barra desactivada"}</span>
      </label>
    </div>
    <div class="status-hero-stats-label">Estadísticas</div>
    <div class="status-hero-stats">
      <div class="stat-tile"><span class="stat-num">${vistas || 0}</span><span class="stat-label">Vistas</span></div>
    </div>
  </div>
  <label>Monto para envío gratis ($)
    <input type="number" name="umbral" value="${t.umbral || 50000}">
  </label>
  <div class="banner banner--warn" style="margin-top:10px">
    ⚠️ Este monto es solo el <b>cartel visual</b>. Para que el envío realmente salga gratis en el checkout,
    configurá el mismo monto en tu tienda: <b>Administración → Configuraciones → Métodos de envío → Costo →
    "Envío gratis a partir de un monto"</b>.
  </div>
  <label>Texto cuando falta (usá {monto})
    <input type="text" name="texto_falta" value="${(t.texto_falta || "¡Te faltan {monto} para tu ENVÍO GRATIS! 🚚").replace(/"/g,'&quot;')}">
  </label>
  <label>Texto cuando se alcanza
    <input type="text" name="texto_listo" value="${(t.texto_listo || "¡Felicitaciones! Tenés ENVÍO GRATIS 🎉").replace(/"/g,'&quot;')}">
  </label>
  <label>Color barra <input type="color" name="color_barra" value="${t.color_barra || "#E8A33D"}"></label>
  <label>Color fondo <input type="color" name="color_fondo" value="${t.color_fondo || "#12201B"}"></label>
  <button type="submit">Guardar</button>
  <div class="toast" id="toast">Guardado ✅</div>
</form>
<div class="section-label">Instalación</div>
<div class="install-card">
  <p class="install-text">Pegá este código una sola vez en tu tienda: Administración → Configuraciones → Código Externo → <code>Códigos dentro del &lt;head&gt;</code>.</p>
  <div class="code-box">
    <span id="snippet-code" style="flex:1;font-family:'Space Mono',monospace;font-size:0.78rem;color:#111111;">&lt;script src="${APP_URL}/widget.js?store=${t.store_id}"&gt;&lt;/script&gt;</span>
    <button type="button" class="btn-copy" onclick="copiarSnippet()">Copiar</button>
  </div>
</div>
${generarAppsHTML()}
<div class="admin-footer">
  <span class="brand">Una app de <a href="https://hacecrecertutienda.com" target="_blank" rel="noopener">hacecrecertutienda.com</a></span>
  <a class="soporte" href="https://wa.me/5490000000000" target="_blank" rel="noopener">💬 Soporte por WhatsApp</a>
</div>
<script>
function actualizarEstado(checkbox) {
  document.getElementById('switch-label-txt').textContent = checkbox.checked ? 'Barra activa' : 'Barra desactivada';
}
function copiarSnippet() {
  const texto = document.getElementById('snippet-code').textContent;
  navigator.clipboard.writeText(texto).then(() => {
    const btn = document.querySelector('.btn-copy');
    const original = btn.textContent;
    btn.textContent = '¡Copiado!';
    setTimeout(() => { btn.textContent = original; }, 1800);
  });
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.activo = fd.get('activo') === 'on';
  const r = await fetch('/api/config/${t.store_id}', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if (r.ok) { document.getElementById('toast').style.display='block'; setTimeout(()=>document.getElementById('toast').style.display='none',2000); }
});
</script>
</body></html>`;
}

// ================= widget.js (client side, corre en la tienda) =================
function WIDGET_JS(APP_URL) {
  return `(function(){
  var API = "${APP_URL}";

  // El store_id viaja en el propio <script src=".../widget.js?store=68310">
  // (mismo patrón que embed.js de Ruleta y widget.js de Aviso Stock)
  function obtenerStoreId(){
    var thisScript = document.currentScript;
    if(!thisScript){
      var scripts = document.querySelectorAll('script[src*="widget.js"]');
      thisScript = scripts[scripts.length - 1];
    }
    if(!thisScript) return null;
    try {
      var url = new URL(thisScript.src);
      return url.searchParams.get('store');
    } catch(e){ return null; }
  }

  var storeId = obtenerStoreId();
  if(!storeId){ console.warn('[BarraEnvioGratis] falta ?store=ID en el script src'); return; }

  function track(tipo){
    try {
      fetch(API + "/track", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: storeId, tipo: tipo }), keepalive: true,
      });
    } catch(e){}
  }

  var cfg = null;
  var barEl = null;

  fetch(API + "/config?store_id=" + storeId).then(r=>r.json()).then(function(c){
    if(!c.activo) return;
    cfg = c;
    montarBarra();
    actualizar();
    // Observar cambios en el carrito (agregar/quitar productos actualiza el DOM via AJAX).
    // Se re-conecta al contenedor real del carrito cuando aparece (Angular lo monta async).
    observarCarrito();
    setInterval(actualizar, 4000); // fallback por si el observer no llega a tiempo
  }).catch(function(e){ console.warn('[BarraEnvioGratis]', e); });

  function observarCarrito(){
    var target = document.querySelector('app-shopping-cart') || document.body;
    var obs = new MutationObserver(function(){ actualizar(); });
    obs.observe(target, {childList:true, subtree:true, characterData:true});
  }

  function montarBarra(){
    track('vista');
    barEl = document.createElement('div');
    barEl.id = 'barra-envio-gratis';
    barEl.style.cssText = 'position:sticky;top:0;z-index:9999;padding:10px 16px;font-family:sans-serif;font-size:14px;text-align:center;background:' + cfg.color_fondo + ';color:#fff;';
    barEl.innerHTML = '<div id="beg-texto" style="margin-bottom:6px;font-weight:600"></div>' +
      '<div style="background:rgba(255,255,255,.2);border-radius:6px;height:8px;overflow:hidden;max-width:420px;margin:0 auto">' +
      '<div id="beg-fill" style="height:100%;width:0%;background:' + cfg.color_barra + ';transition:width .4s ease"></div></div>';
    document.body.prepend(barEl);
  }

  function obtenerTotalCarrito(){
    // Selector real calibrado en la tienda de prueba: subtotal SIN envío
    // (no queremos que el costo de envío cuente para el umbral)
    var selectores = ['.content__subtotal', 'app-text-subtotal', '.subtotal', '[data-cart-total]','.cart-total','.js-cart-total'];
    for (var i=0;i<selectores.length;i++){
      var el = document.querySelector(selectores[i]);
      if (el){
        var n = parsearMonto(el.textContent);
        if (n !== null) return n;
      }
    }
    return null; // carrito vacío o sin dato confiable: no mostramos la barra
  }

  function parsearMonto(txt){
    if(!txt) return null;
    var m = txt.replace(/[^0-9.,]/g,'').replace(/\\./g,'').replace(',', '.');
    var n = parseFloat(m);
    return isNaN(n) ? null : n;
  }

  function actualizar(){
    if(!cfg || !barEl) return;
    var total = obtenerTotalCarrito();
    if (total === null) { barEl.style.display = 'none'; return; }
    barEl.style.display = 'block';
    var pct = Math.min(100, (total / cfg.umbral) * 100);
    var fill = document.getElementById('beg-fill');
    var texto = document.getElementById('beg-texto');
    if (fill) fill.style.width = pct + '%';
    if (texto){
      if (total >= cfg.umbral) {
        texto.textContent = cfg.texto_listo;
      } else {
        var falta = (cfg.umbral - total).toLocaleString('es-AR', {style:'currency', currency:'ARS', maximumFractionDigits:0});
        texto.textContent = cfg.texto_falta.replace('{monto}', falta);
      }
    }
  }
})();`;
}
