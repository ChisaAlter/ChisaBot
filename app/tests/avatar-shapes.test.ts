import { describe, expect, test } from "bun:test";
import { AVATAR_SHAPES, isAvatarShape, isShapeColor, SHAPE_COLORS } from "../../shared/bot-avatars";
import { mixShapes, SHAPE_ANCHORS, SHAPE_COLOR_HEX, SHAPE_COLOR_LABEL, SHAPE_LABEL, SHAPES, shapePath } from "@/lib/agents/avatar-shapes";

/** 形象头像的几何（DESIGN.md §81）：所有形状同结构，才能互相变形。 */
describe("avatar shapes", () => {
  test("every shape has a geometry, a label, and stays inside the 100x100 canvas", () => {
    expect(Object.keys(SHAPES).sort()).toEqual([...AVATAR_SHAPES].sort());
    for (const shape of AVATAR_SHAPES) {
      const geometry = SHAPES[shape];
      expect(geometry.radii).toHaveLength(SHAPE_ANCHORS);
      expect(SHAPE_LABEL[shape]).toBeTruthy();
      for (const r of geometry.radii) {
        expect(r).toBeGreaterThanOrEqual(12);
        expect(r).toBeLessThanOrEqual(47);
      }
      for (const n of shapePath(geometry).match(/-?\d+\.\d+/g)!.map(Number)) {
        expect(n).toBeGreaterThan(-3);
        expect(n).toBeLessThan(103);
      }
    }
  });

  test("all paths share one command structure, which is what makes any pair morphable", () => {
    const structure = (shape: (typeof AVATAR_SHAPES)[number]) => shapePath(SHAPES[shape]).replace(/-?\d+(\.\d+)?/g, "#");
    const first = structure(AVATAR_SHAPES[0]);
    for (const shape of AVATAR_SHAPES) expect(structure(shape)).toBe(first);
  });

  test("shapes are centred on the canvas by their bounding box", () => {
    for (const shape of AVATAR_SHAPES) {
      const points = shapePath(SHAPES[shape]).match(/-?\d+\.\d+/g)!.map(Number);
      const xs = points.filter((_, i) => i % 2 === 0);
      const ys = points.filter((_, i) => i % 2 === 1);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(50, 0);
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(50, 0);
    }
  });

  test("mixing hits both ends exactly and moves the eyes with the body", () => {
    const a = SHAPES.round;
    const b = SHAPES.pill;
    expect(mixShapes(a, b, 0).radii).toEqual(a.radii);
    expect(mixShapes(a, b, 1).radii).toEqual(b.radii);
    expect(mixShapes(a, b, 1).face.gap).toBe(b.face.gap);
    expect(mixShapes(a, b, 0.5).face.gap).toBeCloseTo((a.face.gap + b.face.gap) / 2, 6);
  });

  test("every colour has a hex value and a label, and the validators agree with the lists", () => {
    for (const color of SHAPE_COLORS) {
      expect(SHAPE_COLOR_HEX[color]).toMatch(/^#[0-9a-f]{6}$/);
      expect(SHAPE_COLOR_LABEL[color]).toBeTruthy();
      expect(isShapeColor(color)).toBe(true);
    }
    for (const shape of AVATAR_SHAPES) expect(isAvatarShape(shape)).toBe(true);
    for (const bad of ["", "circle", "ROUND", null, 3, "round "]) expect(isAvatarShape(bad)).toBe(false);
    for (const bad of ["", "sky", "#fff", null]) expect(isShapeColor(bad)).toBe(false);
  });
});