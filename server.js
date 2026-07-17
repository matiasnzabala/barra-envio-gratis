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
  MP_PAYMENT_LINK = "",
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
  res.send(renderAdminHtml(tienda));
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

// ---------------- widget.js ----------------
app.get("/widget.js", (req, res) => {
  res.type("application/javascript");
  res.send(WIDGET_JS(APP_URL));
});

app.get("/", (req, res) => res.send("Barra de Envío Gratis — OK"));

app.listen(PORT, () => console.log(`Barra Envío Gratis escuchando en ${PORT}`));

// ================= Banner trial/pago =================
function renderBannerTrialPago(t) {
  if (t.pago) {
    return `<div class="banner banner--ok">✅ Suscripción activa. ¡Gracias por confiar en nosotros!</div>`;
  }
  const diasRestantes = t.trial_ends_at
    ? Math.ceil((new Date(t.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24))
    : 0;
  if (diasRestantes > 0) {
    return `<div class="banner banner--warn">
      ⏳ Te quedan <b>${diasRestantes} día${diasRestantes === 1 ? "" : "s"}</b> de prueba gratis.
      Para no perder la barra, activá tu suscripción acá: <a href="${MP_PAYMENT_LINK}" target="_blank">Pagar suscripción</a><br>
      <span class="storeid">ID de tienda (indicalo al pagar): ${t.store_id}</span>
    </div>`;
  }
  return `<div class="banner banner--off">
    🚫 Tu prueba gratis terminó y la barra está desactivada en tu tienda.
    Activá tu suscripción para reactivarla: <a href="${MP_PAYMENT_LINK}" target="_blank">Pagar suscripción</a><br>
    <span class="storeid">ID de tienda (indicalo al pagar): ${t.store_id}</span>
  </div>`;
}

// ================= HTML admin =================
function renderAdminHtml(t) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Barra de Envío Gratis</title>
<style>
  :root{--bg:#12201B;--amber:#E8A33D;--coral:#E8632C;--text:#F2EDE4}
  body{background:var(--bg);color:var(--text);font-family:'Public Sans',sans-serif;padding:32px;max-width:560px;margin:0 auto}
  h1{font-family:'Fraunces',serif;font-weight:600}
  label{display:block;margin-top:16px;font-size:14px;opacity:.85}
  input[type=text],input[type=number]{width:100%;padding:10px;border-radius:8px;border:1px solid #3a4a41;background:#1a2a22;color:var(--text);margin-top:4px;box-sizing:border-box}
  input[type=color]{margin-top:4px}
  button{margin-top:24px;background:var(--amber);color:#12201B;border:none;padding:12px 20px;border-radius:8px;font-weight:700;cursor:pointer}
  .toast{display:none;margin-top:12px;color:#7CD992}
  .banner{padding:14px 16px;border-radius:8px;margin-bottom:20px;font-size:14px;line-height:1.5}
  .banner--ok{background:#1e3a2a;border:1px solid #2f5c40}
  .banner--warn{background:#3a2a1e;border:1px solid #5c4a2f}
  .banner--off{background:#3a1e1e;border:1px solid #5c2f2f}
  .banner a{color:var(--amber);font-weight:700}
  .banner .storeid{opacity:.7;font-family:monospace;font-size:12px}
</style></head>
<body>
<h1>🚚 Barra de Envío Gratis</h1>
${renderBannerTrialPago(t)}
<form id="f">
  <label>Monto para envío gratis ($)
    <input type="number" name="umbral" value="${t.umbral || 50000}">
  </label>
  <label>Texto cuando falta (usá {monto})
    <input type="text" name="texto_falta" value="${(t.texto_falta || "¡Te faltan {monto} para tu ENVÍO GRATIS! 🚚").replace(/"/g,'&quot;')}">
  </label>
  <label>Texto cuando se alcanza
    <input type="text" name="texto_listo" value="${(t.texto_listo || "¡Felicitaciones! Tenés ENVÍO GRATIS 🎉").replace(/"/g,'&quot;')}">
  </label>
  <label>Color barra <input type="color" name="color_barra" value="${t.color_barra || "#E8A33D"}"></label>
  <label>Color fondo <input type="color" name="color_fondo" value="${t.color_fondo || "#12201B"}"></label>
  <label><input type="checkbox" name="activo" ${t.activo !== false ? "checked" : ""} style="width:auto;display:inline"> Activo</label>
  <button type="submit">Guardar</button>
  <div class="toast" id="toast">Guardado ✅</div>
</form>
<script>
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
