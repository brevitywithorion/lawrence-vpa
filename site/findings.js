const KEY = "lawrenceVpaHideExempt";
function money(n) {
  if (n == null || !isFinite(n)) return "—";
  return "$" + Math.round(n).toLocaleString();
}
function render(findings, hide) {
  const block = hide ? findings.exclude_tax_exempt : findings.all;
  const rule = findings.filter_rule || {};
  document.getElementById("sCount").textContent = block.with_vpa.toLocaleString();
  document.getElementById("sExempt").textContent = hide
    ? (findings.all.exempt_count || 0).toLocaleString()
    : "0";
  document.getElementById("sMedApr").textContent = money(block.median_appraised);
  document.getElementById("sMedVpa").textContent = money(block.median_vpa);
  const body = document.getElementById("classBody");
  const order = ["R","C","E","V","A","U","N","F","O"];
  body.innerHTML = "";
  for (const cls of order) {
    const row = block.by_class[cls];
    if (!row) continue;
    if (hide && cls === "E") continue;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${cls}</td><td>${row.count.toLocaleString()}</td><td>${money(row.median_vpa)}</td><td>${money(row.median_appraised)}</td>`;
    body.appendChild(tr);
  }
  document.getElementById("filterNote").textContent = rule.rationale || document.getElementById("filterNote").textContent;
}
fetch("data/stats.json").then(r => r.json()).then(stats => {
  const findings = stats.findings;
  if (!findings) return;
  let hide = false;
  try { hide = localStorage.getItem(KEY) === "1"; } catch (_) {}
  const box = document.getElementById("hideExemptFindings");
  box.checked = hide;
  render(findings, hide);
  box.addEventListener("change", () => {
    hide = box.checked;
    try { localStorage.setItem(KEY, hide ? "1" : "0"); } catch (_) {}
    render(findings, hide);
  });
});
