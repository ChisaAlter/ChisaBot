import { type SVGProps, useId } from "react";

// Pre-baked 64×64 seamless grain tiles replacing expensive runtime 1200×755 feTurbulence filters.
const COLOR_GRAIN_TILE =
  "data:image/png;base64,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";

const DARK_GRAIN_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAgMAAADXB5lNAAAABlBMVEVMaXEAAACaXKEdAAAAAnRSTlMAQABPjKgAAAAJcEhZcwAAA+gAAAPoAbV7UmsAAAJkSURBVDjLHZNBDgVBBERJ2JO0+3Qn7Em4/1W++atJJuiqpwBodGNbHwtlaQgdy5Lr7oNhAc/zXbXg9xohDWKKla/fUbrDA7ca8HHo7VevE8ahtXLrJVTuhffIyQaoBwY84Rxp3QJOZL8HgbhOrhSeDDn9wHHIH83r8QeEgFZwO0cv1qraf+2xLWGdfc9RwNlnsucyUhEivNGnUHUTT5oYvJPTwifdsfI2EMycOXYKOB4EMHOE1U6HGxAMXm8FeE6Y+gGBiRtq06Ylc73htTqvEniXQFLAp0t96vEFoXCo6SfmyaBzmGZp0RlripgrEgYqygwnpMSa11/Dp2/a5bEfVABbR2oLTGZQFXpsh54okyBZt1irTShhN2PmAmqlwEcIvKtF93MLws5TQ+z1XD5DbAxRycG5FlSE6F5sPWsB2PyJ7JaP1XlFsN1NRsJ68ooPqO7GCjMbtWXNca4yso2Jejk75EnQJaH+0HwDY7MqgxonTvNxwAWNirSk4C2jjdkYS97jtHl8vpHihVqwcRRUWvu2ooItuk6Q+aL9EgbCwEX8lXbUS41toPyI+jm47YTDm5jcGcffcW3afTi+s2wE/XskDw7CPouIVxPr2G6BAA7t7BenXDIWwB+nrVyVskXfIOvhgt1Lu9ubDhbutSLDy77UgeAJDdrLA6agTYVeY3e45Iy555GLRY/uWcZ7mQ9mT2IPwEs3/JvvJYbnUfTdHGCZwuSXj9zbTd/ENlimb8fE03hMF2hp1p6RmD3jDR265WqPN5O5czbuqXjfTabiWeqUn/s9umuaXxEuCom9a5mnjOcHHeKxqd3B4lEAAAAASUVORK5CYII=";

/**
 * Decorative waiting artwork for the fixed-size computer frame.
 */
export function ComputerPlaceholder(props: SVGProps<SVGSVGElement>) {
  const uid = useId().replace(/:/g, "");
  const clipId = `clip0_${uid}`;
  const linearId = `paint0_${uid}`;
  const radialId = `paint1_${uid}`;
  const grainColorId = `grain0_${uid}`;
  const grainDarkId = `grain1_${uid}`;
  return (
    <svg
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMin slice"
      fill="none"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath={`url(#${clipId})`}>
        <path fill="#fff" d="M0 0H1200V800H0z" />
        <path fill={`url(#${linearId})`} d="M0 0H1200V754H0z" />
        <g
          opacity={0.93}
          style={{
            mixBlendMode: "lighten",
          }}
        >
          <path
            transform="rotate(180 1201 754)"
            fill={`url(#${radialId})`}
            d="M1201 754H2402V1509H1201z"
          />
          <rect width={1200} height={754} fill={`url(#${grainColorId})`} />
        </g>
        <g
          style={{
            mixBlendMode: "color-burn",
          }}
        >
          <path fill="#F0F0F0" fillOpacity={0.84} d="M0 0H1200V754H0z" />
          <rect width={1200} height={754} fill={`url(#${grainDarkId})`} />
        </g>
      </g>
      <defs>
        <pattern
          id={grainColorId}
          width={83}
          height={83}
          patternUnits="userSpaceOnUse"
        >
          <image
            href={COLOR_GRAIN_TILE}
            width={83}
            height={83}
            preserveAspectRatio="none"
          />
        </pattern>
        <pattern
          id={grainDarkId}
          width={32}
          height={32}
          patternUnits="userSpaceOnUse"
        >
          <image
            href={DARK_GRAIN_TILE}
            width={32}
            height={32}
            preserveAspectRatio="none"
          />
        </pattern>
        <linearGradient
          id={linearId}
          x1={1200}
          y1={-53.8571}
          x2={-274.518}
          y2={423.589}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFB8E7" />
          <stop offset={1} stopColor="#2EE297" />
        </linearGradient>
        <radialGradient
          id={radialId}
          cx={0}
          cy={0}
          r={1}
          gradientTransform="matrix(229.838 -1654.36 2337.29 481.415 2278.37 2408.36)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset={0.420388} stopColor="#9DF200" />
          <stop offset={0.66} stopColor="#0099A9" />
          <stop offset={1} stopColor="#fff" />
        </radialGradient>
        <clipPath id={clipId}>
          <path fill="#fff" d="M0 0H1200V800H0z" />
        </clipPath>
      </defs>
    </svg>
  );
}
