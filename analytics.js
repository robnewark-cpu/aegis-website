/**
 * Google Analytics 4 (gtag.js), loaded on every page via
 * <script src="analytics.js"></script>.
 *
 * Also fires a generate_lead event on submit for every lead-capture form on
 * the site, tagged with the form's id so GA can break out which forms are
 * converting. Uses transport_type "beacon" so the hit survives the page
 * navigating away right after submit.
 */
(function () {
  var GA_ID = "G-9Y9R724BNK";

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag("js", new Date());
  gtag("config", GA_ID, { transport_type: "beacon" });

  // Lead-capture forms across the site. Add new form ids here as pages ship.
  var LEAD_FORM_IDS = [
    "proposal-form",   // index.html
    "demo-form",       // book-demo.html
    "scan-form",       // ai-visibility-check.html
  ];
  var LEAD_FORM_CLASSES = ["accessform", "ctaform"]; // aegisos-early-access.html, aegis-founding-rate.html

  function trackLeadSubmit(form) {
    gtag("event", "generate_lead", {
      form_id: form.id || form.className || "unknown",
      page_path: location.pathname,
    });
  }

  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      var isLeadForm =
        LEAD_FORM_IDS.indexOf(form.id) !== -1 ||
        LEAD_FORM_CLASSES.some(function (c) { return form.classList.contains(c); });
      if (isLeadForm) trackLeadSubmit(form);
    },
    true,
  );
})();
