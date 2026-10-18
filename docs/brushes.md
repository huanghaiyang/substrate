# Custom brushes — import format

**English** · [简体中文](zh/brushes.md)

The Paint Studio supports importing brushes from JSON: open **绘制工作室 → 导入笔刷** and choose a
`.json` file, or import the same structure programmatically with
`importCustomBrushJson(text)` from `src/engine/brushes.js`. Imported brushes are stored in
`localStorage` (`substrate.customBrushes`), appear under a **Custom / 自定义笔刷** group, persist
across reloads and can be deleted with the × on the brush tile.

## File formats accepted

A single brush object, an array of brush objects, or `{ "brushes": [...] }`:

```json
{
  "brushes": [
    {
      "name": "Dry Gouache",
      "shape": "round",
      "hardness": 0.55,
      "spacing": 0.08,
      "flow": 0.7,
      "grain": 0.6,
      "scatter": 0.25,
      "angle": 0,
      "flatness": 1,
      "rotateJitter": 0,
      "scaleJitter": 0.1,
      "sizeScale": 1,
      "pressureSize": true,
      "pressureFlow": true
    },
    {
      "name": "Angled Marker",
      "shape": "flat",
      "hardness": 0.8,
      "spacing": 0.04,
      "flow": 0.5,
      "angle": 35,
      "flatness": 0.35,
      "sizeScale": 1
    }
  ]
}
```

## Fields

| Field | Type | Range | Notes |
| --- | --- | --- | --- |
| `name` | string (required) | ≤ 48 chars | unique display name |
| `shape` | enum | `round`, `flat`, `spray`, `flora` | stamp shape |
| `hardness` | number | 0–0.999 | falloff (1 = hard edge) |
| `spacing` | number | 0.01–1 | stamp distance relative to brush diameter |
| `flow` | number | 0.01–1 | per-stamp alpha / build-up |
| `grain` | number | 0–1 | punched-out texture holes |
| `scatter` | number | 0–2 | random offset per dab |
| `angle` | number | -360–360 | stamp rotation (flat/flora) |
| `flatness` | number | 0.05–1 | ellipse squash for `flat` |
| `rotateJitter` | number | 0–360 | per-dab random rotation |
| `scaleJitter` | number | 0–1 | per-dab random scale variation |
| `sizeScale` | number | 0.1–4 | effective stamp size multiplier |
| `pressureSize` | boolean | – | pen pressure modulates size (default true) |
| `pressureFlow` | boolean | – | pen pressure modulates alpha (default false) |
| `dots` / `dotScale` | number | 1–40 / 0.01–1 | spray-shape droplets |
| `motif` | enum | `grass`, `leaf`, `flower`, `tree`, `fern`, `branch` | required for `flora` |

Unknown fields are ignored; invalid values are clamped or replaced with sensible defaults. Invalid
JSON or a missing `name` produces an inline error in the Paint Studio and nothing is imported.
