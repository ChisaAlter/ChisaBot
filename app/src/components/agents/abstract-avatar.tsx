import Avatar from "boring-avatars";

/** A cropped portrait stored in the avatar seed, rather than a generated face. */
export function portraitSrc(seed: string | null | undefined): string | null {
  return seed?.startsWith("data:image/") ? seed : null;
}

export function AbstractAvatar({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  const portrait = portraitSrc(seed);
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      {portrait ? (
        <img
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          src={portrait}
        />
      ) : (
        /* The drawing carries its own role; hidden so the coworker is announced once, by name. */
        <span aria-hidden="true" className="contents">
          <Avatar name={seed} size={size} />
        </span>
      )}
    </span>
  );
}
