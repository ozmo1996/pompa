"use strict";
// Co najwyżej jedna wysyłka. Niedostępna chmura nie blokuje lokalnych odczytów.
class CloudSync {
  constructor(statusRef, history, getSnapshot, log) {
    Object.assign(this, { statusRef, history, getSnapshot, log });
    this.busy = false;
  }
  tick() {
    if (this.busy) return;
    this.busy = true;
    return Promise.resolve()
      .then(() => this.statusRef.update(this.getSnapshot()))
      .then(() => this.history.flush())
      .catch((e) => this.log("Synchronizacja:", e.message))
      .finally(() => {
        this.busy = false;
      });
  }
}
module.exports = { CloudSync };
