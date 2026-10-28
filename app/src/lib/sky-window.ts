/**
 * 天空引擎（wallpaper_core.html）看到的 window：只把 devicePixelRatio 换成降采样后的值，其余原样转给真正的 window。
 *
 * window 自己的方法（requestAnimationFrame、setTimeout、addEventListener……）脱离 window 调用会报 Illegal invocation，
 * 所以要绑回 window。但 Date、Promise、Float32Array 这类构造函数不能 bind：bind 出来的函数没有 Date.now、
 * Promise.resolve 这些静态方法。区分办法：带 prototype 的是构造函数，原样返回；没有 prototype 的才 bind。
 */
export function createSkyWindow<T extends object>(
  target: T,
  renderScale: number,
): T {
  const bound = new WeakMap<object, unknown>();
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "devicePixelRatio") {
        const dpr = Reflect.get(obj, prop, obj);
        return (
          Math.min(typeof dpr === "number" && dpr > 0 ? dpr : 1, 1) *
          renderScale
        );
      }
      const value: unknown = Reflect.get(obj, prop, obj);
      if (typeof value !== "function" || Object.hasOwn(value, "prototype"))
        return value;
      let fn = bound.get(value);
      if (!fn) {
        fn = (value as (...args: unknown[]) => unknown).bind(obj);
        bound.set(value, fn);
      }
      return fn;
    },
    set(obj, prop, value) {
      return Reflect.set(obj, prop, value, obj);
    },
  });
}
