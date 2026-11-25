// Motion and small conveniences for the Connections page, run in the browser. Written as a real
// function (so it is linted like any other code) and inlined into the page as its source text.
// Uses Anime.js v4 (window.anime) when it loaded; without it, or when the reader asks for reduced
// motion, every element simply shows its final state and every action still works.
function pageScript() {
  const A = window.anime;
  const motion = Boolean(A) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const CHECK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  // Starts an animation; elements that fade in get their starting opacity first, so nothing flickers.
  const run = (targets, params) => {
    if (!motion || !targets || ("length" in targets && !targets.length)) return null;
    if (Array.isArray(params.opacity)) for (const element of "length" in targets ? targets : [targets]) element.style.opacity = String(params.opacity[0]);
    return A.animate(targets, params);
  };

  // Draws SVG strokes from nothing, as if traced (the success tick, the failure cross).
  const draw = (paths, delay = 0) => {
    if (!motion || !paths.length) return;
    run(A.svg.createDrawable(paths), { draw: ["0 0", "0 1"], duration: 520, delay: A.stagger(90, { start: delay }), ease: "inOutQuad" });
  };
  // A short horizontal shake for something that failed.
  const shake = (element, delay = 0) => {
    if (!motion || !element) return;
    const timeline = A.createTimeline({ delay, defaults: { ease: "inOutQuad", duration: 70 } });
    for (const x of [-10, 9, -7, 5, -3, 0]) timeline.add(element, { translateX: x });
  };
  const spinner = button => {
    const spin = document.createElement("span");
    spin.className = "spin";
    button.prepend(spin);
    if (motion) A.animate(spin, { rotate: 360, duration: 750, loop: true, ease: "linear" });
    else spin.animate?.([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 750, iterations: Infinity });
  };
  const busy = (button, text) => {
    if (!button) return;
    button.classList.add("busy");
    button.setAttribute("aria-busy", "true");
    $$(".ico", button).forEach(icon => icon.remove());
    const label = $("span", button);
    if (label && text) label.textContent = text;
    spinner(button);
  };

  /* ---------- Entrance ---------- */
  if (motion) {
    run($$(".hero > *"), { opacity: [0, 1], translateY: [14, 0], duration: 760, delay: A.stagger(90), ease: "outExpo" });
    run($$(".stats > div"), { opacity: [0, 1], translateY: [18, 0], scale: [0.96, 1], duration: 760, delay: A.stagger(70, { start: 140 }), ease: "outExpo" });
    run($$(".section-head, .steps li"), { opacity: [0, 1], translateY: [10, 0], duration: 640, delay: A.stagger(50, { start: 220 }), ease: "outExpo" });
    run($$(".pcard, .profile"), { opacity: [0, 1], translateY: [26, 0], scale: [0.97, 1], duration: 820, delay: A.stagger(65, { start: 260 }), ease: "outExpo" });
    run($$(".pcard .tile .logo"), { scale: [0.3, 1], rotate: [-16, 0], opacity: [0, 1], duration: 900, delay: A.stagger(65, { start: 420 }), ease: "outBack" });
    run($$(".products .mini"), { scale: [0, 1], opacity: [0, 1], duration: 500, delay: A.stagger(45, { start: 700 }), ease: "outBack" });
    run($$(".acct .dot"), { scale: [0, 1], duration: 600, delay: A.stagger(40, { start: 650 }), ease: "outBack" });
    run($$(".meter span"), { scaleX: [0, 1], duration: 1100, delay: A.stagger(80, { start: 700 }), ease: "outExpo" });
    run($$(".tip"), { opacity: [0, 1], translateY: [10, 0], duration: 700, delay: 900, ease: "outExpo" });
    if ($(".toast")) $(".toast").style.opacity = "0";
  }
  // The page hid its content until this point (see "pre" in _page.js); everything now has its start state.
  document.documentElement.classList.remove("pre");
  // Count the summary figures up.
  for (const figure of $$("[data-count]")) {
    const target = Number(figure.dataset.count);
    if (!motion || !target) continue;
    const counter = { value: 0 };
    figure.textContent = "0";
    A.animate(counter, { value: target, duration: 1200, delay: 300, ease: "outExpo", onUpdate: () => { figure.textContent = String(Math.round(counter.value)); } });
  }

  /* ---------- Result toast (connected, failed, refreshed…) ---------- */
  const toast = $(".toast");
  if (toast) {
    const card = toast.dataset.provider ? document.getElementById(`p-${toast.dataset.provider}`) : null;
    const success = toast.classList.contains("success"), failed = toast.classList.contains("error");
    let hideTimer;
    const hide = () => {
      clearTimeout(hideTimer);
      if (!motion) return toast.remove();
      A.animate(toast, { opacity: 0, translateY: 30, scale: 0.96, duration: 380, ease: "inQuad", onComplete: () => toast.remove() });
    };
    $(".toast-close", toast)?.addEventListener("click", hide);
    if (motion) {
      A.animate(toast, { opacity: [0, 1], translateY: [48, 0], scale: [0.92, 1], duration: 760, delay: 350, ease: "outBack" });
      A.animate($(".toast-icon", toast), { scale: [0, 1], rotate: [-120, 0], duration: 700, delay: 520, ease: "outBack" });
      draw($$(".toast-icon path", toast), 760);
      if (failed) shake(toast, 1150);
    }
    if (card) {
      card.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "center" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 2600);
      if (failed) shake(card, 650);
      if (success && motion) {
        const tile = $(".tile", card);
        A.createTimeline({ delay: 650 }).add(tile, { scale: [1, 1.18], duration: 220, ease: "outQuad" }).add(tile, { scale: 1, duration: 520, ease: "outElastic(1, .5)" });
        // A small burst of dots from the logo: the connection is done.
        const box = tile.getBoundingClientRect(), cardBox = card.getBoundingClientRect();
        for (let i = 0; i < 14; i++) {
          const dot = document.createElement("i");
          const angle = (i / 14) * Math.PI * 2, distance = 38 + Math.random() * 34;
          Object.assign(dot.style, { position: "absolute", width: "7px", height: "7px", borderRadius: "50%", pointerEvents: "none",
            left: `${box.left - cardBox.left + box.width / 2 - 3.5}px`, top: `${box.top - cardBox.top + box.height / 2 - 3.5}px`,
            background: ["#25bd63", "#4285F4", "#FBBC05", "#EA4335"][i % 4] });
          card.append(dot);
          A.animate(dot, { translateX: Math.cos(angle) * distance, translateY: Math.sin(angle) * distance, scale: [1, 0], opacity: [1, 0],
            duration: 900 + Math.random() * 300, delay: 700, ease: "outExpo", onComplete: () => dot.remove() });
        }
      }
    }
    if (!failed) hideTimer = setTimeout(hide, 7000);
    // Keep the private link but drop the one-time result, so a refresh doesn't show it again.
    const url = new URL(location.href);
    for (const key of [...url.searchParams.keys()]) if (key !== "t") url.searchParams.delete(key);
    history.replaceState(null, "", url);
  }

  /* ---------- Loading states ---------- */
  for (const form of $$("form[data-loading]")) {
    form.addEventListener("submit", () => busy($("button[type=submit]", form), form.dataset.loading));
  }
  // Sign-in platforms: a full-screen "Opening Google…" while the browser leaves for the consent screen.
  const overlay = $(".redirect");
  for (const link of $$("a[data-redirect]")) {
    link.addEventListener("click", event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || !overlay) return;
      event.preventDefault();
      const logo = $(".tile .logo", link.closest(".pcard"));
      $(".tile", overlay).innerHTML = logo ? logo.outerHTML : "";
      $("b", overlay).textContent = link.dataset.redirect === "YouTube" || link.dataset.redirect === "Google account" ? "Google" : link.dataset.redirect.replace(/ account$/, "");
      overlay.classList.add("on");
      busy(link, "Opening…");
      if (motion) {
        A.animate(overlay, { opacity: [0, 1], duration: 260, ease: "outQuad" });
        A.animate($(".tile", overlay), { scale: [0.6, 1], rotate: [-10, 0], duration: 600, ease: "outBack" });
        A.animate($$(".dots i", overlay), { translateY: -9, duration: 360, loop: true, alternate: true, delay: A.stagger(120), ease: "inOutQuad" });
      }
      setTimeout(() => { location.href = link.href; }, motion ? 380 : 0);
    });
  }
  // Coming back with the Back button shows the page from cache: clear the loading states.
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    overlay?.classList.remove("on");
    for (const button of $$(".busy")) { button.classList.remove("busy"); button.removeAttribute("aria-busy"); $(".spin", button)?.remove(); }
  });

  /* ---------- Confirm before disconnecting or deleting ---------- */
  const dialog = $("dialog.confirm");
  for (const form of $$("form[data-confirm]")) {
    form.addEventListener("submit", event => {
      if (form.dataset.confirmed) return;
      event.preventDefault();
      const proceed = () => {
        form.dataset.confirmed = "1";
        const row = form.closest(".acct, .profile");
        const submit = () => { busy($("button", form)); form.submit(); };
        if (motion && row) A.animate(row, { opacity: 0, translateX: 24, duration: 320, ease: "inQuad", onComplete: submit });
        else submit();
      };
      if (!dialog?.showModal) { if (window.confirm(`${form.dataset.confirm} ${form.dataset.confirmDetail || ""}`)) proceed(); return; }
      $("#confirm-title", dialog).textContent = form.dataset.confirm;
      $(".confirm-detail", dialog).textContent = form.dataset.confirmDetail || "";
      $("button[value=ok]", dialog).textContent = form.dataset.confirmAction || "Disconnect";
      dialog.returnValue = "";
      dialog.showModal();
      if (motion) {
        A.animate(dialog, { opacity: [0, 1], scale: [0.9, 1], translateY: [16, 0], duration: 480, ease: "outBack" });
        A.animate($(".confirm-icon", dialog), { rotate: [-25, 0], scale: [0.5, 1], duration: 600, delay: 80, ease: "outElastic(1, .6)" });
      }
      dialog.addEventListener("close", () => { if (dialog.returnValue === "ok") proceed(); }, { once: true });
    });
  }

  /* ---------- Opening a form ---------- */
  for (const details of $$("details.keyform, details.edit")) {
    details.addEventListener("toggle", () => {
      if (details.open) run($$(".form > *", details), { opacity: [0, 1], translateY: [10, 0], duration: 520, delay: A?.stagger?.(40) ?? 0, ease: "outExpo" });
      if (details.open) $("input:not([type=hidden]):not([type=checkbox]), select", details)?.focus({ preventScroll: true });
    });
  }

  /* ---------- Copy a connector URL ---------- */
  for (const button of $$("button[data-copy]")) {
    button.addEventListener("click", async () => {
      const value = button.dataset.copy;
      try { await navigator.clipboard.writeText(value); }
      catch { const input = button.parentElement.querySelector("input"); input?.select(); document.execCommand?.("copy"); }
      const original = button.innerHTML;
      button.classList.add("done");
      button.innerHTML = `${CHECK}<span>Copied</span>`;
      draw($$("path", button));
      run(button, { scale: [0.9, 1], duration: 500, ease: "outBack" });
      setTimeout(() => { button.classList.remove("done"); button.innerHTML = original; }, 2200);
    });
  }

  /* ---------- Private link countdown ---------- */
  const expiry = $(".expiry[data-expires]");
  if (expiry) {
    const ends = Date.parse(expiry.dataset.expires), left = $(".left", expiry);
    let warned = false;
    const tick = () => {
      const seconds = Math.max(0, Math.round((ends - Date.now()) / 1000));
      if (!seconds) {
        expiry.classList.remove("soon");
        expiry.classList.add("over");
        $("span", expiry).textContent = "Link expired. Ask your assistant for a new one.";
        shake(expiry);
        return;
      }
      left.textContent = ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
      if (seconds <= 300 && !warned) {
        warned = true;
        expiry.classList.add("soon");
        if (motion) A.createTimeline().add(expiry, { scale: 1.07, duration: 260, ease: "outQuad" }).add(expiry, { scale: 1, duration: 520, ease: "outElastic(1, .5)" });
      }
      setTimeout(tick, 1000);
    };
    tick();
  }
}

// Deferred scripts (Anime.js) have run by DOMContentLoaded; if the page is already past it, run now.
export const PAGE_SCRIPT = `(() => { const start = ${pageScript.toString()}; document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start(); })();`;
