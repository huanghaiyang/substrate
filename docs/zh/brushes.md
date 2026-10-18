# 自定义笔刷——导入格式

[English](../brushes.md) · **简体中文**

绘制工作室支持从 JSON 导入笔刷：打开 **绘制工作室 → 导入笔刷** 选择 `.json` 文件，或调用
`src/engine/brushes.js` 中的 `importCustomBrushJson(text)` 以编程方式导入相同结构。导入的笔刷保存在
`localStorage`（`substrate.customBrushes`），显示在 **自定义笔刷（Custom）** 分组中，刷新后仍然保留，
点击笔刷卡片上的 × 可单独删除。

## 支持的文件格式

单个笔刷对象、笔刷对象数组，或 `{ "brushes": [...] }`：

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

## 字段

| 字段 | 类型 | 范围 | 说明 |
| --- | --- | --- | --- |
| `name` | string（必填） | ≤ 48 字符 | 唯一显示名称 |
| `shape` | enum | `round`、`flat`、`spray`、`flora` | 笔刷印章形状 |
| `hardness` | number | 0–0.999 | 边缘衰减（1 = 硬边） |
| `spacing` | number | 0.01–1 | 印章间距，相对笔刷直径 |
| `flow` | number | 0.01–1 | 每个印章的 alpha / 叠加速度 |
| `grain` | number | 0–1 | 颗粒镂空强度 |
| `scatter` | number | 0–2 | 每个笔点的随机偏移 |
| `angle` | number | -360–360 | 印章旋转角（flat/flora） |
| `flatness` | number | 0.05–1 | `flat` 形状的椭圆压扁程度 |
| `rotateJitter` | number | 0–360 | 每个笔点的随机旋转 |
| `scaleJitter` | number | 0–1 | 每个笔点的随机缩放幅度 |
| `sizeScale` | number | 0.1–4 | 印章有效尺寸倍率 |
| `pressureSize` | boolean | – | 压感控制大小（默认 true） |
| `pressureFlow` | boolean | – | 压感控制透明度（默认 false） |
| `dots` / `dotScale` | number | 1–40 / 0.01–1 | `spray` 形状的飞溅点数量/大小 |
| `motif` | enum | `grass`、`leaf`、`flower`、`tree`、`fern`、`branch` | `flora` 形状必填 |

未知字段会被忽略；非法数值会被限制到允许范围或替换为合理默认值。JSON 无效或缺少 `name` 时，
绘制工作室会显示行内错误并且不会导入任何内容。
