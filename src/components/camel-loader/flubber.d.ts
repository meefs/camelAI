/**
 * Type declarations for flubber (Noah Veltman's path-interpolation library).
 * The package ships without TypeScript types, so add this file to your
 * project to silence the implicit-any warning on `import "flubber"`.
 */

declare module "flubber" {
  type Interpolator = (t: number) => string;

  type Options = {
    maxSegmentLength?: number;
    string?: boolean;
    single?: boolean;
  };

  export function interpolate(
    fromShape: string | ReadonlyArray<readonly [number, number]>,
    toShape: string | ReadonlyArray<readonly [number, number]>,
    options?: Options,
  ): Interpolator;

  export function interpolateAll(
    fromShapes: ReadonlyArray<string | ReadonlyArray<readonly [number, number]>>,
    toShapes: ReadonlyArray<string | ReadonlyArray<readonly [number, number]>>,
    options?: Options & { match?: boolean },
  ): Interpolator[];

  export function separate(
    fromShape: string | ReadonlyArray<readonly [number, number]>,
    toShapes: ReadonlyArray<string | ReadonlyArray<readonly [number, number]>>,
    options?: Options & { single?: boolean },
  ): Interpolator[];

  export function combine(
    fromShapes: ReadonlyArray<string | ReadonlyArray<readonly [number, number]>>,
    toShape: string | ReadonlyArray<readonly [number, number]>,
    options?: Options & { single?: boolean },
  ): Interpolator[];

  export function toCircle(
    fromShape: string | ReadonlyArray<readonly [number, number]>,
    x: number,
    y: number,
    radius: number,
    options?: Options,
  ): Interpolator;

  export function toRect(
    fromShape: string | ReadonlyArray<readonly [number, number]>,
    x: number,
    y: number,
    width: number,
    height: number,
    options?: Options,
  ): Interpolator;

  const flubber: {
    interpolate: typeof interpolate;
    interpolateAll: typeof interpolateAll;
    separate: typeof separate;
    combine: typeof combine;
    toCircle: typeof toCircle;
    toRect: typeof toRect;
  };

  export default flubber;
}
