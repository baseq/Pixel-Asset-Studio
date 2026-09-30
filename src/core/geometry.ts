export type Point = [number, number]

/** Bresenham line, inclusive of both endpoints. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const pts: Point[] = []
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let x = x0
  let y = y0
  for (;;) {
    pts.push([x, y])
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
  return pts
}

export function rectPoints(x: number, y: number, w: number, h: number, filled: boolean): Point[] {
  const pts: Point[] = []
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (filled || i === 0 || j === 0 || i === w - 1 || j === h - 1) pts.push([x + i, y + j])
    }
  }
  return pts
}

/** Ellipse inscribed in the w x h box whose top-left pixel is (x, y). */
export function ellipsePoints(x: number, y: number, w: number, h: number, filled: boolean): Point[] {
  const cx = w / 2
  const cy = h / 2
  const inside = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= w || j >= h) return false
    const nx = (i + 0.5 - cx) / cx
    const ny = (j + 0.5 - cy) / cy
    return nx * nx + ny * ny <= 1
  }
  const pts: Point[] = []
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!inside(i, j)) continue
      if (filled || !inside(i - 1, j) || !inside(i + 1, j) || !inside(i, j - 1) || !inside(i, j + 1)) {
        pts.push([x + i, y + j])
      }
    }
  }
  return pts
}
