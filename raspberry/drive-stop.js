"use strict";
// FR-F740: 40009, bit 10 MRS. Parametry: numer Pr. + 41000; adresy biblioteki od 0.
async function stopDrive(drive, mode = "lagodny") {
  if (!["lagodny", "natychmiastowy"].includes(mode)) throw new Error("Nieznany tryb STOP");
  if (mode === "lagodny") {
    await drive.writeRegister(8, 0); // zdjęcie STF: hamowanie według Pr.8, bez zmiany parametrów napędu
    return;
  }
  try {
    const logic = (await drive.readHoldingRegisters(1016, 1)).data[0]; // Pr.17
    const assignment = (await drive.readHoldingRegisters(1186, 1)).data[0]; // Pr.187
    if (logic !== 0 || assignment !== 24) throw new Error("Niepotwierdzona konfiguracja MRS (Pr.17=0, Pr.187=24)");
    await drive.writeRegister(8, 1024); // MRS=1, STF=STR=0; bez automatycznego kasowania ani restartu
  } catch (error) {
    // Jeśli MRS nie można zweryfikować, zdejmij start. Nie zgłaszaj tego jako wykonanie MRS.
    try {
      await drive.writeRegister(8, 0);
    } catch {
      throw new Error("STOP niepotwierdzony — użyj lokalnego zatrzymania");
    }
    throw new Error("Wysłano zatrzymanie po rampie, odcięcie MRS NIEPOTWIERDZONE: " + error.message);
  }
}
module.exports = { stopDrive };
