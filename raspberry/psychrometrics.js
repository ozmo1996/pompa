// Wspólne obliczenia aplikacji i alarmów. Mokry termometr nad ciekłą wodą,
// także przechłodzoną poniżej 0°C (nie termometr oblodzony).
// Magnus/WMO + równanie psychrometryczne FAO, Appendix 3, Eq. 3.10.
(function (root) {
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  function stationPressure(w, fallback = 920) {
    const p = w?.cisnienieStacjiHpa;
    if (finite(p) && p >= 500 && p <= 1100) return p;
    // PWS Current Conditions v2: `pressure` to ciśnienie na poziomie morza.
    // 800 m n.p.m. potwierdzone przez właściciela stacji IBYSTR6.
    const sea = w?.cisnieniePoziomMorzaHpa ?? (w?.stacja === "IBYSTR6" ? w.cisnienie : null);
    if (finite(sea) && sea >= 850 && sea <= 1100) return sea * Math.pow(1 - (0.0065 * 800) / 288.15, 5.25588);
    return fallback;
  }
  function wetBulb(t, rh, p = 920) {
    if (!finite(t) || t < -45 || t > 60 || !finite(rh) || rh <= 0 || rh > 100 || !finite(p) || p < 500 || p > 1100)
      return null;
    const es = (x) => 6.112 * Math.exp((17.62 * x) / (243.12 + x));
    const e = (rh / 100) * es(t);
    let lo = -80,
      hi = t;
    for (let i = 0; i < 50; i++) {
      const m = (lo + hi) / 2;
      if (es(m) - 0.00066 * (1 + 0.00115 * m) * p * (t - m) > e) hi = m;
      else lo = m;
    }
    return (lo + hi) / 2;
  }
  const api = Object.freeze({ wetBulb, stationPressure });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.POMPA_PSYCHROMETRICS = api;
})(globalThis);
