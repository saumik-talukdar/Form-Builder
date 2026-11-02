const GROUP = 5;
/** Beyond this many marks the row stops growing; the number beside it keeps counting. */
export const TALLY_CAP = 100;

interface Props {
  count: number;
  /** Increments each time a live response arrives; redraws the newest stroke. */
  pulse?: number;
}

export function TallyMarks({ count, pulse = 0 }: Props) {
  const shown = Math.min(count, TALLY_CAP);
  const groups = Math.ceil(shown / GROUP);
  const hidden = count - shown;

  return (
    <div
      className="tally"
      role="img"
      aria-label={`${count} ${count === 1 ? "response" : "responses"}, drawn as tally marks`}
    >
      {Array.from({ length: groups }, (_, g) => {
        const inGroup = Math.min(GROUP, shown - g * GROUP);
        const lastGroup = g === groups - 1;
        const newest = shown - 1; // index of the most recent stroke
        return (
          <svg
            key={g}
            width="44"
            height="40"
            viewBox="0 0 44 40"
            aria-hidden="true"
            className={lastGroup && pulse > 0 ? "fresh-wrap" : undefined}
          >
            {Array.from({ length: Math.min(inGroup, 4) }, (_, i) => {
              const x = 6 + i * 10;
              const isNew = pulse > 0 && g * GROUP + i === newest;
              return (
                <path
                  key={isNew ? `n${pulse}` : i}
                  d={`M${x} 4V36`}
                  className={isNew ? "stroke new" : "stroke"}
                />
              );
            })}
            {inGroup === GROUP && (
              <path
                key={
                  pulse > 0 && g * GROUP + 4 === newest ? `n${pulse}` : "slash"
                }
                d="M1 31L42 9"
                className={
                  pulse > 0 && g * GROUP + 4 === newest
                    ? "stroke new"
                    : "stroke"
                }
              />
            )}
          </svg>
        );
      })}
      {hidden > 0 && (
        <span className="tally-more">+{hidden.toLocaleString()} more</span>
      )}
    </div>
  );
}
