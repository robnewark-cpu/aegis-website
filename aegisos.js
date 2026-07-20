(() => {
  "use strict";

  const navToggle = document.querySelector(".nav-toggle");
  const siteNav = document.querySelector(".site-nav");

  if (navToggle && siteNav) {
    navToggle.addEventListener("click", () => {
      const isOpen = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!isOpen));
      siteNav.classList.toggle("is-open", !isOpen);
    });

    siteNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        navToggle.setAttribute("aria-expanded", "false");
        siteNav.classList.remove("is-open");
      });
    });
  }

  document.querySelectorAll("[data-prefill]").forEach((field) => {
    const value = new URLSearchParams(window.location.search).get(field.dataset.prefill);
    if (value) field.value = value;
  });

  const form = document.querySelector("[data-demo-form]");
  if (!form) return;

  const status = form.querySelector(".form-status");
  const submitButton = form.querySelector('button[type="submit"]');

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.source = "aegisos-book-demo";
    payload.submittedAt = new Date().toISOString();

    submitButton.disabled = true;
    submitButton.textContent = "Sending request…";
    status.className = "form-status";
    status.textContent = "";

    try {
      const response = await fetch("https://aegis-form-worker.robert-bb6.workers.dev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error("Request failed");

      form.reset();
      status.textContent = "Thanks — your demo request is in. Our team will be in touch shortly.";
      status.className = "form-status is-visible";
    } catch (error) {
      status.innerHTML = 'We could not send your request. Please email <a href="mailto:info@aegisglobalholdings.com">info@aegisglobalholdings.com</a>.';
      status.className = "form-status is-visible is-error";
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Request My Demo";
    }
  });
})();
