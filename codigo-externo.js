(function () {
  if (!window.TN || !window.TN.store || !window.TN.store.id) return;

  var storeId = window.TN.store.id;
  var API = "https://barra.hacecrecertutienda.com";

  function track(tipo) {
    try {
      fetch(API + "/track", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: storeId, tipo: tipo }), keepalive: true,
      });
    } catch (e) {}
  }

  var cfg = null;
  var barEl = null;

  fetch(API + "/config?store_id=" + storeId).then(function (r) { return r.json(); }).then(function (c) {
    if (!c.activo) return;
    cfg = c;
    montarBarra();
    actualizar();
    observarCarrito();
    setInterval(actualizar, 4000);
  }).catch(function (e) { console.warn("[BarraEnvioGratis]", e); });

  function observarCarrito() {
    var target = document.querySelector("app-shopping-cart") || document.body;
    var obs = new MutationObserver(function () { actualizar(); });
    obs.observe(target, { childList: true, subtree: true, characterData: true });
  }

  function montarBarra() {
    track("vista");
    barEl = document.createElement("div");
    barEl.id = "barra-envio-gratis";
    barEl.style.cssText = "position:sticky;top:0;z-index:9999;padding:10px 16px;font-family:sans-serif;font-size:14px;text-align:center;background:" + cfg.color_fondo + ";color:#fff;";
    barEl.innerHTML = '<div id="beg-texto" style="margin-bottom:6px;font-weight:600"></div>' +
      '<div style="background:rgba(255,255,255,.2);border-radius:6px;height:8px;overflow:hidden;max-width:420px;margin:0 auto">' +
      '<div id="beg-fill" style="height:100%;width:0%;background:' + cfg.color_barra + ';transition:width .4s ease"></div></div>';
    document.body.prepend(barEl);
  }

  function obtenerTotalCarrito() {
    var selectores = [".content__subtotal", "app-text-subtotal", ".subtotal", "[data-cart-total]", ".cart-total", ".js-cart-total"];
    for (var i = 0; i < selectores.length; i++) {
      var el = document.querySelector(selectores[i]);
      if (el) {
        var n = parsearMonto(el.textContent);
        if (n !== null) return n;
      }
    }
    return null;
  }

  function parsearMonto(txt) {
    if (!txt) return null;
    var m = txt.replace(/[^0-9.,]/g, "").replace(/\./g, "").replace(",", ".");
    var n = parseFloat(m);
    return isNaN(n) ? null : n;
  }

  function actualizar() {
    if (!cfg || !barEl) return;
    var total = obtenerTotalCarrito();
    if (total === null) { barEl.style.display = "none"; return; }
    barEl.style.display = "block";
    var pct = Math.min(100, (total / cfg.umbral) * 100);
    var fill = document.getElementById("beg-fill");
    var texto = document.getElementById("beg-texto");
    if (fill) fill.style.width = pct + "%";
    if (texto) {
      if (total >= cfg.umbral) {
        texto.textContent = cfg.texto_listo;
      } else {
        var falta = (cfg.umbral - total).toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
        texto.textContent = cfg.texto_falta.replace("{monto}", falta);
      }
    }
  }
})();
