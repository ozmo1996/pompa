// Atrapa Firebase (app/auth/database/messaging) do testów w przeglądarce.
// Test podmienia nią moduły z gstatic.com, więc aplikacja działa bez sieci i bez prawdziwej bazy.
// Sterowanie z testu: window.__fb (store, setConnected, setServerOffset, emit, writes).
const M = (globalThis.__fb ??= (() => {
  const seed = globalThis.__FB_SEED || {};
  const fb = {
    store: structuredClone(seed.data || {}),
    user: seed.user === undefined ? { uid: "u1", email: "test@example.com" } : seed.user,
    connected: seed.connected ?? true,
    serverOffset: seed.serverOffset ?? 0,
    failPaths: seed.failPaths || [],
    writes: [],
    listeners: new Set(),
    authListeners: new Set(),
  };
  const parts = (p) => String(p).split("/").filter(Boolean);
  fb.read = (path) => {
    if (path === ".info/connected") return fb.connected;
    if (path === ".info/serverTimeOffset") return fb.serverOffset;
    let v = fb.store;
    for (const k of parts(path)) v = v == null ? undefined : v[k];
    return v === undefined ? null : structuredClone(v);
  };
  fb.write = (path, value) => {
    const ks = parts(path);
    let o = fb.store;
    ks.slice(0, -1).forEach((k) => (o = o[k] = o[k] && typeof o[k] === "object" ? o[k] : {}));
    if (value === null) delete o[ks.at(-1)];
    else o[ks.at(-1)] = structuredClone(value);
  };
  fb.emit = () => fb.listeners.forEach((l) => l.fire());
  fb.setConnected = (c) => ((fb.connected = c), fb.emit());
  fb.setServerOffset = (o) => ((fb.serverOffset = o), fb.emit());
  fb.set = (path, value) => (fb.write(path, value), fb.emit());
  return fb;
})());

class Snap {
  constructor(key, value, children) {
    this.key = key;
    this._v = value;
    this._c = children;
  }
  val() {
    return this._v;
  }
  exists() {
    return this._v !== null;
  }
  forEach(cb) {
    for (const [k, v] of this._c || Object.entries(this._v && typeof this._v === "object" ? this._v : {}))
      if (cb(new Snap(k, v)) === true) return true;
    return false;
  }
}
function snapshot(q) {
  const path = q.path,
    v = M.read(path),
    key = path.split("/").filter(Boolean).at(-1) ?? null;
  if (!q.c?.length) return new Snap(key, v);
  let ent = Object.entries(v && typeof v === "object" ? v : {});
  const ord = q.c.find((c) => c.t === "order")?.k;
  const val = (e) => (ord ? e[1]?.[ord] : e[0]);
  if (ord) ent = ent.filter((e) => e[1]?.[ord] !== undefined);
  ent.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0));
  for (const c of q.c) {
    if (c.t === "start") ent = ent.filter((e) => val(e) >= c.v);
    if (c.t === "end") ent = ent.filter((e) => val(e) <= c.v);
  }
  const lim = q.c.find((c) => c.t === "last");
  if (lim) ent = ent.slice(-lim.n);
  return new Snap(key, ent.length ? Object.fromEntries(ent) : null, ent);
}
const failing = (path) => M.failPaths.some((p) => path === p || path.startsWith(p + "/"));
const permErr = () => Object.assign(new Error("PERMISSION_DENIED"), { code: "PERMISSION_DENIED" });

// ---- firebase-app ----
export const initializeApp = (cfg) => ({ options: cfg });
// ---- firebase-auth ----
export const getAuth = () => (M.auth ??= { currentUser: M.user, languageCode: "" });
export function onAuthStateChanged(auth, cb) {
  M.authListeners.add(cb);
  queueMicrotask(() => cb(auth.currentUser));
  return () => M.authListeners.delete(cb);
}
const setUser = (u) => {
  M.auth.currentUser = u;
  M.authListeners.forEach((cb) => cb(u));
};
export async function signInWithEmailAndPassword(auth, email, password) {
  if (password !== "haslo123") throw Object.assign(new Error("bad"), { code: "auth/invalid-credential" });
  setUser({ uid: "u1", email });
}
export async function signOut() {
  setUser(null);
}
export async function sendPasswordResetEmail() {}
// ---- firebase-database ----
export const getDatabase = () => ({});
export const ref = (db, path = "") => ({ path });
export const query = (r, ...c) => ({ path: r.path, c });
export const orderByChild = (k) => ({ t: "order", k });
export const startAt = (v) => ({ t: "start", v });
export const endAt = (v) => ({ t: "end", v });
export const limitToLast = (n) => ({ t: "last", n });
export function onValue(q, cb, err) {
  if (failing(q.path)) {
    queueMicrotask(() => err?.(permErr()));
    return () => {};
  }
  const l = { fire: () => cb(snapshot(q)) };
  M.listeners.add(l);
  queueMicrotask(l.fire);
  return () => M.listeners.delete(l);
}
export async function get(q) {
  if (failing(q.path)) throw permErr();
  M.gets = (M.gets || []).concat({ path: q.path, c: q.c || [] });
  return snapshot(q);
}
export async function set(r, value) {
  if (failing(r.path)) throw permErr();
  M.writes.push({ op: "set", path: r.path, value: structuredClone(value) });
  M.set(r.path, value);
}
export async function update(r, obj) {
  if (failing(r.path)) throw permErr();
  M.writes.push({ op: "update", path: r.path, value: structuredClone(obj) });
  for (const [k, v] of Object.entries(obj)) M.write(r.path + "/" + k, v);
  M.emit();
}
export async function remove(r) {
  M.writes.push({ op: "remove", path: r.path });
  M.set(r.path, null);
}
// ---- firebase-messaging ----
export const isSupported = async () => false;
export const getMessaging = () => ({});
export const onMessage = () => () => {};
export const getToken = async () => "token";
export const deleteToken = async () => true;
