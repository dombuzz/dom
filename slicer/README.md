# Slicer-Bibliotheken für slice.html

- `cura-wasm.js` – [cura-wasm](https://github.com/Cloud-CNC/cura-wasm) 1.5.2 (ES-Build, enthält CuraEngine als WebAssembly). Lizenz: MIT / LGPL-3.0+ / AGPL-3.0+, siehe `cura-wasm.LICENSE`. Quellcode CuraEngine: https://github.com/Ultimaker/CuraEngine
- `ender3v2neo.def.json` – Druckerprofil, erzeugt aus `cura-wasm-definitions` (`creality_ender3`) mit Druckraum 220 × 220 × 250 mm. Start-/End-G-Code setzt `slice.html` beim Slicen ein.
- `three/` – [three.js](https://threejs.org) r170 (MIT) mit STL-, OBJ- und 3MF-Loader sowie OrbitControls.

Hinweis: CuraEngine liest über die Kommandozeile nur feste Werte, keine Cura-Formeln. Deshalb rechnet `slice.html` abgeleitete Werte (z. B. `infill_line_distance`, `brim_line_count`, Deckel-/Bodenschichten) selbst aus.
