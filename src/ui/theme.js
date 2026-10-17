export const CAT_COLORS = {
  Input: '#4fb3d9',
  Noise: '#7b8cff',
  Pattern: '#9d7bff',
  Shape: '#b06bd9',
  Color: '#e0679f',
  Paint: '#e0574a',
  Filter: '#43b581',
  Blend: '#4aa8d8',
  Adjust: '#d9a44a',
  Normal: '#57c2b0',
  Output: '#f0a44a'
}

export function catColor(cat) {
  return CAT_COLORS[cat] || '#8b93a1'
}

export const RESOLUTIONS = [512, 1024, 2048, 4096]

export const PROXIES = [
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' }
]

export const SHAPES = [
  { id: 'sphere', label: 'Sphere' },
  { id: 'plane', label: 'Plane' },
  { id: 'cube', label: 'Cube' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'torus', label: 'Torus' }
]
